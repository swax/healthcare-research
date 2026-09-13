# Healthcare Flow Graph

Where does the money go in U.S. healthcare? This repo models the flow of funds through the
U.S. healthcare system for 2023 as a graph — payers → government programs → insurers →
providers → workers, suppliers, capital and taxes — with every dollar traced to a cited
source. One hand-edited data file drives both an Excel workbook and the Sankey diagram below.

![U.S. Healthcare Flow of Funds, 2023 — Sankey diagram](diagrams/healthcare-flows-sankey.png)

_Node height and ribbon width share one dollar scale. Roughly $13.9T of traced flow across 22
nodes and 97 edges. Corporate income tax is drawn as a terminal Taxes sink rather than a loop
back to government._

## What it is

- **A traced-subset model, not closed national accounting.** It follows specific
  payer → provider → worker / supplier / capital / tax flows (about $3.86T of the $4.69T in
  national health consumption spending reaches a provider node). A node's inflow need not equal
  its outflow; that's intentional. See [docs/data-model.md](docs/data-model.md) for the design
  and [docs/coverage.md](docs/coverage.md) for exactly what is and isn't covered.
- **Observations-first.** Each edge carries one observation per source that measures that flow.
  Exactly one is canonical (the value used); the others stay as context, not discrepancies to
  resolve. Following the same flow across CMS, MedPAC, MACPAC, KFF, BLS, and company filings is
  built into the edge, not a side table.
- **One source of truth.** `data/graph.json` is the only file you edit. The workbook, the
  diagram, the checks, and the cross-sheet hyperlinks are all regenerated from it, so numbers
  can never drift apart.

```
data/graph.json ──┬──> src/build.ts              ──> dist/2023_healthcare_spending.xlsx
data/sheets/*.json ┘ └──> scripts/build_sankey.mjs ──> diagrams/healthcare-flows-sankey.jg / .png
```

## Quick start

Requires Node 22.6+ (designed for Node 24; native TypeScript, no compile step).

```bash
npm install
npm run build          # Excel workbook → dist/2023_healthcare_spending.xlsx
npm test               # structural, observation, conservation and rendering tests
npm run check          # console readout: total traced flow + every multi-source edge
npm run build:sankey   # Sankey .jg diagram → diagrams/
```

The workbook opens with an **Overview** page, has one ledger sheet per node (inflows, outflows,
splits, sources, and links to the counterpart sheet for every amount), a **Labor Cross-Check
(BLS)** sheet, and ends with a **Glossary**. If Excel holds the file open on Windows, build to a
temp path with `XLSX_OUT=dist/_tmp.xlsx npm run build`.

## Editing the model

- **Change an amount or add a flow:** edit the `edges` array in `data/graph.json` (add or adjust
  an observation), then `npm run build`. Node totals are derived automatically.
- **Add curated detail to a node's sheet:** edit or add its `data/sheets/<node>.json` overlay —
  curated labels, `extra` rows, and independent-source validation checks. No code change.
- **The build fails loudly on an invalid graph** (`validateGraph`), so a broken edit never
  produces a silently wrong workbook.

The field-by-field schema (observations, `split[]`, categories, sub-nodes, overlays) is in
[`data/README.md`](data/README.md).

## What the tests guard

- **Structure:** unique ids, every edge endpoint resolves, valid layers / groups / sources,
  sub-node parent rules.
- **Observations:** at least one per edge, exactly one canonical, a `split[]` sums to its
  parent within $1B.
- **Conservation:** summing leaf nodes, total inflow equals total outflow equals a pinned grand
  total. Splitting a node or carving tax out of a margin moves value without changing the whole.
- **Rendering:** every node produces a ledger; grouping, splits, roll-ups, hyperlinks, Overview
  and Glossary all produce the expected cells.

## Sankey diagram

`scripts/build_sankey.mjs` lays out the graph as a Sankey with an overlap-minimizing algorithm:
long flows are routed through lanes, and node order within a column is chosen to minimize
ribbon overlap area rather than crossing count. The writeup is in
[docs/sankey-layout.md](docs/sankey-layout.md).

The output is a [Jumpgate](https://github.com/swax/jumpgate) `.jg` file. To view or render it:

```bash
npm run serve:sankey   # rebuild and open in the browser (expects a sibling ../jumpgate checkout)

# or render to PNG, from packages/jumpgate in the Jumpgate repo:
npm run render -- ../../../healthcare-research/diagrams/healthcare-flows-sankey.jg --width 1800 --height 1000 --scale 2
```

The `.jg` also opens directly in the Jumpgate VS Code extension.

## Complementary analyses

These read the graph or the source data but are not part of the flow model.

- **Labor cross-check (BLS OEWS May 2023).** Looks inside the ten labor edges that feed the
  Healthcare Workers sink: headcount, wage bill, and top job functions per edge. Divergences
  (self-employment income, wage top-coding, contract labor) are explained, not flagged.
  `npm run reconcile:labor` rebuilds the committed `data/labor_bls.json` from the BLS files.
- **Finkelstein (2005) Section 5, extended to 2024.** Reproduces the paper's back-of-the-envelope
  on how much of the long-run rise in health spending the spread of insurance can explain, using
  the CMS NHE 1960–2024 series. `npm run derive:finkelstein` writes `data/finkelstein_s5.json`.
- **Insurer claims derivation.** `npm run derive:claims` derives insurer → provider claim amounts
  from the CMS NHE source-of-funds tables.

These need the source datasets under `references/` (git-ignored; see below).

## Sources and reproducibility

Every observation in `data/graph.json` names a source from the `sources` table, each with a
citation. Primary sources are the CMS National Health Expenditure Accounts (2024 release),
MedPAC, MACPAC, KFF, AMA, ADA, BLS OEWS, NBER working paper w11619, and public-company 10-K
filings. The source files themselves are not redistributed. To run the offline derivation
scripts, download them into `references/`:

| Folder                          | What                                                                      |
| ------------------------------- | ------------------------------------------------------------------------- |
| `references/nhe2024/`           | CMS "NHE Tables" download, `NHE2024.csv` (by service and source of funds) |
| `references/bls2023/`           | BLS OEWS May 2023 national and industry tables                            |
| `references/2023_plan_payment/` | CMS Medicare Part C / D plan payment data                                 |
| `references/w11619.pdf`         | Finkelstein (2005), NBER w11619                                           |

## Repository layout

| Path                                     | Role                                                        |
| ---------------------------------------- | ----------------------------------------------------------- |
| `data/graph.json`                        | **source of truth** — nodes, edges, observations, sources   |
| `data/sheets/<node>.json`                | optional editorial overlays per node                        |
| `data/labor_bls.json`                    | committed derived artifact (BLS headcount / wages by edge)  |
| `data/finkelstein_s5.json`               | committed derived artifact (Finkelstein §5 extension)       |
| `data/README.md`                         | field-by-field schema                                       |
| `src/graph.ts`                           | loader, types, flow arithmetic, `validateGraph`             |
| `src/ledger.ts` · `src/xlsx.ts`          | per-node ledger renderer · workbook assembly                |
| `src/workbook.ts` · `src/sheet-model.ts` | cell model and ExcelJS pour-in with citation footnoting     |
| `src/build.ts` · `src/check.ts`          | CLI entry points                                            |
| `scripts/build_sankey.mjs`               | Sankey layout → `.jg`                                       |
| `scripts/serve_sankey.mjs`               | rebuild and preview the Sankey in a browser                 |
| `scripts/build_flow_diagram.mjs`         | earlier non-Sankey flow diagram (14 major nodes)            |
| `scripts/derive_hi_claims.mjs`           | insurer → provider claims from CMS NHE                      |
| `scripts/reconcile_labor.mjs`            | labor cross-check against BLS OEWS                          |
| `scripts/extend_finkelstein_s5.mjs`      | Finkelstein §5 extension                                    |
| `diagrams/`                              | generated `.jg` diagrams and the rendered Sankey PNG        |
| `docs/data-model.md`                     | design narrative: the observations-first flow model         |
| `docs/coverage.md`                       | what the traced model captures vs. national health spending |
| `docs/data-audit.md`                     | the audit that motivated the model                          |
| `docs/sankey-layout.md`                  | the overlap-minimizing Sankey layout algorithm              |
| `test/`                                  | native `node --test` suite                                  |
| `dist/` · `references/`                  | generated output · local source datasets (both git-ignored) |

## License

- **Code** (`src/`, `scripts/`, `test/`, build config): [MIT](LICENSE).
- **Data, docs, and diagrams** (`data/`, `docs/`, `diagrams/`, README narrative):
  [CC BY 4.0](LICENSE-DATA) — reuse freely with attribution.
- **Cited sources** keep their publishers' terms; their files are deliberately not committed.

To cite: _"Healthcare Flow Graph" by swax, https://github.com/swax/healthcare-research, CC BY 4.0._
