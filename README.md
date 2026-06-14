# Healthcare Flow Graph

Single source of truth → both the Excel workbook **and** the Sankey diagram, built with
native TypeScript on Node 24 (no compile step — Node strips the types and runs `build.ts` directly).

## The idea

The data lives in two files, split by how often you touch them:

- **`data/graph.json`** (~8 KB, the one you edit) — `meta` plus the canonical flow model:
  a `nodes` list and an `edges` list. Each edge = `{from, to, amount, channel, source}`;
  the edge row *is* the declarative connection — an adjacency list, the standard way to
  store a graph.
- **`data/workbook.json`** (~630 KB, bulk) — the full 16-sheet workbook content (cells,
  formulas, styles). Generated; you rarely open it by hand.

`src/build.ts` reads both and regenerates everything into `dist/`, so the workbook and the
visualization can never drift apart.

```
data/graph.json ────┐
                    ├─> src/build.ts ──┬──> dist/2023_healthcare_spending.xlsx
data/workbook.json ─┘                  └──> dist/healthcare_flow_sankey.html
```

## Use

```bash
npm install        # once — installs exceljs
npm run build      # = node src/build.ts   (needs Node >= 22.6; designed for Node 24)
```

Outputs land in `dist/`. Open the `.html` in any browser; the `.xlsx` in Excel.

## Editing

- **Change a flow / amount / add a connection:** edit the `edges` array in
  `data/graph.json` (small, readable), then `npm run build`. The Sankey and the generated **Graph Data**
  sheet update together. Node sizes and the per-node throughput totals are derived
  automatically (max of inflow/outflow).
- **Change workbook text/numbers:** edit the relevant entry in `data/workbook.json` and rebuild.
- The build **fails loudly if the graph has a cycle**, because a Sankey must be acyclic.

## Regenerating data.json from an existing workbook

`extract.py` (Python + openpyxl) re-serializes a `.xlsx` back into `data/graph.json` + `data/workbook.json`.
Only needed if you make heavy edits directly in Excel and want to fold them back into
the source of truth. Day-to-day, edit `data/data.json` and ignore this.

## Tests & checks

Zero-dependency, native Node test runner (`node --test`). After any edit to `data/graph.json`:

```bash
npm test          # structural + invariant + snapshot + build smoke tests
npm run check     # human-readable per-node reconciliation (in / out / net)
```

What the tests guard:

- **Structural** — unique node ids; every edge endpoint resolves to a real node (catches
  typos like `Medicaure`); amounts are positive numbers; valid layers/colors.
- **Invariants** — flows never go backward across layers; the graph stays acyclic
  (a Sankey requires a DAG); declared `source` nodes have no inflow and `sink` nodes no outflow.
- **Snapshot** — every node's throughput and the grand total are pinned in
  `test/expected.json`. If a data edit shifts a number, the test shows exactly which node
  moved and by how much. When the change is intentional, run `npm run test:update` to re-pin.
- **Build smoke** — `node src/build.ts` runs clean and the workbook loads with all 17 sheets
  plus the Sankey html.

`npm run check` prints inflow/outflow/net per node and flags imbalances. Note the known ones
(e.g. Health Insurance shows a large positive net because insurer→provider claims aren't
itemized in the source flow map) — these are expected, not bugs.

`build.ts` also runs `validateGraph` itself, so a broken `data/graph.json` fails the build
loudly instead of producing a silently-wrong diagram.

## Files

| Path | Role |
|------|------|
| `data/graph.json` | **source of truth you edit** (canonical nodes + edges) |
| `data/workbook.json` | bulk 16-sheet content (generated) |
| `src/build.ts`   | generator → xlsx + Sankey html |
| `extract.py`     | one-way importer: xlsx → data.json |
| `dist/`          | generated output (git-ignored) |
| `tsconfig.json`  | editor/type-check config (`erasableSyntaxOnly`) |
