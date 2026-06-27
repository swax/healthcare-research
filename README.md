# Healthcare Flow Graph

One hand-edited data file → an Excel workbook modeling the flow of money through the U.S.
healthcare system (FY 2023, USD billions). Built with native TypeScript on Node 24 — no
compile step; Node strips the types and runs `src/build.ts` directly.

## The idea

The data lives in `data/`, an **observations-first flow model**:

- **`data/graph.json`** (the one you edit) — `meta`, three small lookup tables
  (`layers`, `groups`, `sources`), plus the flow model: a `nodes` list and an `edges` list.
  Nodes carry a stable slug `id` and a display `label`; an edge references nodes by `id` and
  carries a set of **observations** — one per source measuring that flow — of which exactly
  one is `canonical` (the value the model uses). Following the same flow across disparate
  sources is built into the edge, not a side-table.
- **`data/sheets/<node>.json`** (optional) — thin editorial overlays that add curated
  labels, `extra` rows, and independent-source validation checks on top of a node's
  auto-generated ledger.

`src/build.ts` reads the graph and regenerates the workbook into `dist/`, so the numbers and
the sheets can never drift apart.

```
data/graph.json ──> src/build.ts ──> dist/2023_healthcare_spending.xlsx
data/sheets/*.json ─┘
```

The model is a **traced subset**, not closed national accounting: it follows specific
payer → provider → worker / supplier / capital / tax flows, so a node's inflow need not equal
its outflow. That's intentional — see [docs/data-model.md](docs/data-model.md).

## Use

```bash
npm install        # once — installs exceljs
npm run build      # = node src/build.ts   (needs Node >= 22.6; designed for Node 24)
```

Output lands in `dist/` (git-ignored). Open the `.xlsx` in Excel; tabs lead with an
**Overview** front page and end with a **Glossary**.

If Excel holds the file open (exclusive lock on Windows), build to a temp path:
`XLSX_OUT=dist/_tmp.xlsx npm run build`.

## Editing

- **Change a flow / amount / add a connection:** edit the `edges` array in `data/graph.json`
  (add or adjust an observation), then `npm run build`. Node sizes and the per-node
  throughput totals are derived automatically (max of inflow/outflow).
- **Add curated detail to a node's sheet:** edit or add its `data/sheets/<node>.json` overlay
  — no code change.
- The build **fails loudly if the graph is invalid** (`validateGraph`), so a broken
  `data/graph.json` never produces a silently-wrong workbook.

The full field-by-field schema (observations, `split[]`, `category`, sub-nodes, overlays) is
in [`data/README.md`](data/README.md).

## Tests & checks

Zero-dependency, native Node test runner (`node --test`). After any edit to `data/graph.json`:

```bash
npm test          # structural + observation invariants + ledger/workbook rendering
npm run check     # human-readable readout: total flow + every multi-source edge
```

What the tests guard:

- **Structural / reference** — unique node & edge ids; every edge endpoint resolves to a real
  node; observation values are positive numbers; valid layers/groups/sources; sub-node parent
  rules; role/balance sanity.
- **Observations** — every edge has at least one observation and exactly one canonical; a
  `split[]` sums to its canonical value within $1B.
- **Conservation** — summing leaf nodes, total inflow == total outflow == the grand total, so
  splitting a node or carving tax out of a margin into the Taxes sink moves value without changing the whole.
- **Rendering** — every node renders a ledger; section grouping, splits, sub-node roll-ups,
  cross-sheet hyperlinks, and the Overview/Glossary all produce the expected cells.

`npm run check` prints the total traced flow and lists each edge that carries more than one
source (the value used and what else was reported) — context, not a discrepancy to resolve.

## Labor cross-check (complementary)

The workbook's **Labor Cross-Check (BLS)** sheet looks _inside_ the ten labor edges that feed
the Healthcare Workers sink: headcount, wage bill and the top job functions per edge, from
**BLS OEWS May 2023**. Each model dollar links back to its inflow row on the Healthcare Workers
sheet. This is a traced-subset cross-check — divergences (self-employed income, BLS wage
top-coding, contract labor, headcount scope, the pharma/insurer 50% labor split) are explained,
not flagged. There is no gate.

```bash
npm run reconcile:labor   # rebuild data/labor_bls.json from references/bls2023 (BLS source files, git-ignored)
```

The numbers are derived offline into the committed `data/labor_bls.json` (the ~30 MB BLS source
files stay git-ignored under `references/bls2023/`); `npm run build` renders that file, and also
refreshes it automatically when the BLS files are present locally. The model dollars are read
live from `data/graph.json`, so the sheet can never drift from the graph.

## Flow diagram (Sankey)

A separate generator renders the same graph as a Sankey-style flow diagram:

```bash
node scripts/build_sankey.mjs   # → diagrams/healthcare-flows-sankey.jg
```

The `.jg` opens in the [Jumpgate](https://github.com/swax/jumpgate) VS Code extension. Node
heights and ribbon widths share one honest `$/pixel` scale; the layout places nodes and routes
ribbons to minimize **ribbon overlap area** (the muddy stretches that hurt readability), not
crossing count. The algorithm — lanes for long flows, overlap-driven ordering, spacing knobs —
is written up in [docs/sankey-layout.md](docs/sankey-layout.md).

## Files

| Path                           | Role                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `data/graph.json`              | **source of truth you edit** (nodes + edges with observations)                       |
| `data/sheets/<node>.json`      | optional editorial overlays (curated labels, extras, checks)                         |
| `data/labor_bls.json`          | committed derived artifact (BLS headcount/wages by edge); built by `reconcile:labor` |
| `data/README.md`               | field-by-field schema + how-to                                                       |
| `src/build.ts`                 | generator → xlsx                                                                     |
| `src/check.ts`                 | console readout: total + multi-source edges                                          |
| `src/graph.ts`                 | loader, types, flow arithmetic, `validateGraph`                                      |
| `src/ledger.ts`                | per-node ledger renderer (auto + overlay)                                            |
| `src/xlsx.ts`                  | assembles the workbook (ledgers + audit sheets + links)                              |
| `src/workbook.ts`              | `Sheet → ExcelJS` pour-in + citation footnoting                                      |
| `src/sheet-model.ts`           | the `Sheet`/`Cell`/`Style` cell model                                                |
| `scripts/derive_hi_claims.mjs` | offline helper: derive insurer→provider claim amounts from the CMS NHE CSV           |
| `scripts/reconcile_labor.mjs`  | offline helper: cross-check labor edges vs BLS OEWS → `data/labor_bls.json`          |
| `scripts/build_sankey.mjs`     | offline helper: render the graph as a Sankey `.jg` flow diagram                      |
| `diagrams/*.jg`                | generated Jumpgate flow diagrams (open in the Jumpgate VS Code extension)            |
| `docs/data-model.md`           | design narrative (why observations, the traced-subset flow model)                    |
| `docs/data-audit.md`           | the historical audit that motivated the model                                        |
| `docs/sankey-layout.md`        | design narrative (the Sankey overlap-minimizing layout algorithm)                    |
| `dist/`                        | generated output (git-ignored)                                                       |
| `tsconfig.json`                | editor/type-check config (`erasableSyntaxOnly`)                                      |
