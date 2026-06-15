# Architecture

How this repo turns one hand-edited data file into both an Excel workbook and a
Sankey diagram, and why it's structured that way.

## The core idea: one source of truth, two outputs

The whole project exists to keep a spreadsheet and a flow diagram from drifting
apart. They are not edited independently — they are both **generated** from the
same data, every build.

```
data/graph.json ────┐
                    ├─> src/build.ts ──┬──> dist/2023_healthcare_spending.xlsx
data/workbook.json ─┘                  └──> dist/healthcare_flow_sankey.html
```

- **`data/graph.json`** — the canonical flow model you actually edit (nodes,
  edges, and small lookup tables). Small and readable.
- **`data/workbook.json`** — bulk workbook content (~630 KB: every cell, formula,
  and style for the 16 narrative sheets). Generated; rarely hand-edited.
- **`src/build.ts`** — reads both, validates the graph, and writes the two
  outputs into `dist/`.

Because both outputs come from the same build, the **Graph Data** sheet in the
workbook and the Sankey diagram can never disagree about the numbers.

## Runtime: native TypeScript on Node, no build step

There is no compiler in the loop. The `.ts` files are written in
**erasable-syntax-only** TypeScript (no enums, no parameter properties, no
runtime-affecting constructs), so Node ≥ 22.6 strips the type annotations and
runs the source directly:

```bash
npm run build      # = node src/build.ts
```

`tsconfig.json` sets `erasableSyntaxOnly` so the editor/type-checker enforces
the same constraint. The only runtime dependency is **exceljs** (writes the
`.xlsx`); Plotly is loaded from a CDN inside the generated HTML, so the diagram
has no build-time dependency at all.

## Modules

| File | Role |
| --- | --- |
| `src/graph.ts` | **The shared, testable core.** Types (`GNode`, `Edge`, `GraphFile`, …) plus `loadGraph`, `computeFlows`, `findCycles`, and `validateGraph`. No I/O beyond reading the JSON. Imported by everything else. |
| `src/build.ts` | The generator. Maps `workbook.json` → exceljs worksheets, footnotes their citations (see below), appends a generated **Graph Data** sheet, then emits the Plotly Sankey HTML. Calls `validateGraph` and `findCycles` first and **throws on any problem**. |
| `src/check.ts` | `npm run check` — human-readable per-node reconciliation (inflow / outflow / net), flags imbalances > $1B. |
| `scripts/derive_hi_claims.mjs` | Offline helper that derives the four `health_insurance → provider` claim amounts from the CMS NHE CSV. Not part of the build; outputs numbers you paste into `graph.json`. |
| `extract.py` | One-way importer (openpyxl): serializes an existing `.xlsx` back into `graph.json` + `workbook.json`. Only needed if you make heavy edits directly in Excel. |

`graph.ts` is the seam: build, check, and all tests import the same functions, so
the diagram, the spreadsheet, and the test suite reason about the graph
identically.

## Validation: the build fails loudly

`validateGraph` is the gatekeeper. `build.ts` runs it before writing anything, so
a broken `graph.json` produces an error, not a silently-wrong diagram. It checks
three families of invariants:

1. **Structural** — unique node/edge ids; every edge endpoint resolves to a real
   node; positive finite amounts; valid layers, groups, colors, roles, and
   confidence values; no self-loops or duplicate `(from, to, channel)` triples.
2. **Graph invariants** — flows never go backward across layers; the graph is a
   **DAG** (a Sankey cannot render a cycle); `role: source` nodes have no inflow
   and `role: sink` nodes no outflow; no isolated nodes.
3. **Accounting** (via `check.ts`) — per-node inflow vs. outflow reconciliation.

## Source footnoting

Citations are collapsed into footnotes at build time, so `workbook.json` stays a
faithful extract. For each narrative sheet, `footnoteSources` finds every "Source"
column that sits to the right of a "Notes" column (a "Source" header *left* of
Notes is a row-label column — e.g. the funding sources on **Federal Gov** — and is
left alone). For each row it splits the citation cell on `;`, assigns each distinct
citation a per-sheet number, appends the `[n]` markers to that row's **Notes** cell,
and drops the **Source** column. The numbered list is written at the bottom of the
sheet. The generated **Graph Data** sheet has no Notes column, so its **Source**
column itself becomes the `[n]` markers, with the same numbered list beneath the
table. Numbering restarts on every sheet.

## Output: the Sankey layout

`build.ts` places nodes by **layer** (x-position from `layers[].x`) and spreads
each layer's members evenly on the y-axis. Node and ribbon widths are
proportional to dollars. Node color comes from its `group`; throughput (max of
inflow/outflow) drives node size and shows in the hover tooltip. The result is a
single self-contained HTML file that loads Plotly from a CDN.

## Tests

Zero-dependency, native Node test runner (`node --test`, run via `npm test`):

| Test | Guards |
| --- | --- |
| `test/graph.test.ts` | All structural + invariant checks pass; ids unique; no dangling edges; acyclic; sources/sinks behave. |
| `test/snapshot.test.ts` | Every node's throughput and the grand total are pinned in `test/expected.json`. A data edit that shifts a number fails here, naming the node and the delta. Re-pin intentional changes with `npm run test:update`. |
| `test/build.test.ts` | Smoke test: `build.ts` runs clean, the workbook loads with all 17 sheets, and the Sankey HTML contains a Plotly plot. |

`npm run lint` (ESLint flat config) and `npm run format` (Prettier) round out the
checks.

## Typical workflow

1. Edit the `edges` (or `nodes`) array in `data/graph.json`.
2. `npm test` — structural, invariant, snapshot, and build-smoke checks.
3. `npm run check` — eyeball the per-node reconciliation.
4. `npm run build` — regenerate `dist/`.
5. If a snapshot change was intentional, `npm run test:update` to re-pin.

## `dist/` is disposable

Everything in `dist/` (and `references/`, and `node_modules/`) is git-ignored.
The outputs are reproducible from the two data files at any time, so they are
never committed.
