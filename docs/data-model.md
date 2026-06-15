# Data model

What's in the two data files, what every field means, and where the numbers come
from. The model describes the **flow of funds through U.S. healthcare in FY 2023**,
in USD billions.

## The two files

| File | Size | You edit it? | Contents |
| --- | --- | --- | --- |
| `data/graph.json` | ~11 KB | **Yes** | The canonical flow model: nodes + edges, plus small lookup tables. |
| `data/workbook.json` | ~630 KB | Rarely | Full content of the 16 narrative workbook sheets (cells, formulas, styles). Generated. |

Everything below is about `graph.json` — the file you actually maintain.

## `graph.json` structure

```jsonc
{
  "meta":    { ... },          // title, year, units, source list, notes
  "layers":  [ ... ],          // the 5 columns of the Sankey
  "groups":  [ ... ],          // color + label buckets for nodes
  "sources": { ... },          // citation key -> human-readable citation
  "graph":   { "nodes": [...], "edges": [...] }   // the flow model itself
}
```

### `meta`

Free-form descriptive header — `title`, `year` (2023), `units` (USD billions),
a summary `sources` string, and a `generatedNote`. Not validated; documentation
for humans.

### `layers[]` — the columns

Five layers, left to right, modeling money moving from those who pay to the
factors of production it ultimately buys.

| `n` | `name` | `x` | What sits here |
| --- | --- | --- | --- |
| 0 | Payers / Households | 0.02 | Individuals, Employers |
| 1 | Government | 0.26 | Federal, State |
| 2 | Programs & Insurers | 0.50 | Medicare, Medicaid, Health Insurance |
| 3 | Providers | 0.74 | Hospitals, Providers & Clinicians, Pharma & Rx, Long-Term Care |
| 4 | Factors of Production | 0.98 | Healthcare Workers, Suppliers & Vendors |

- `n` — integer layer number; nodes reference it via `node.layer`.
- `x` — horizontal position (0–1) of the column in the Sankey.
- `annotation` — short header label drawn above the column.

A core invariant: **edges may only flow forward** (`layer[to] >= layer[from]`).

### `groups[]` — color buckets

Each node belongs to a `group`, which supplies its color and a display label.
Five groups, one per layer theme: `payers`, `government`, `programs_insurers`,
`providers`, `factors`. Each has an `id`, a `label`, and a 6-hex `color` (no `#`).

### `sources{}` — citation table

A map from a short **citation key** to the human-readable citation text. Edges
reference a key in their `source` field; the build expands it and numbers it as a
`[n]` footnote in the Graph Data sheet's **Source** column, keyed to a numbered
source list at the bottom of that sheet (see [architecture.md](architecture.md)).
The expanded text is also shown in the Sankey tooltip. Keys include `cms_nhe`,
`cms_nhe_t7/t8/t16`, `trustees`, `macpac`, `kff_ehbs_2023`, `nhe2024`,
`estimate`, etc. Every edge's `source` **must** exist here or validation fails.

### `graph.nodes[]` — the entities

13 nodes. Each:

```jsonc
{ "id": "medicare", "label": "Medicare", "layer": 2,
  "group": "programs_insurers", "role": "intermediary" }
```

| Field | Meaning |
| --- | --- |
| `id` | Stable kebab/slug identifier. Edges reference nodes by this, never by label. Renaming the display name never breaks edges. |
| `label` | Display name (workbook + diagram). |
| `layer` | Which `layers[].n` column it sits in. |
| `group` | Which `groups[].id` bucket (drives color). |
| `role` | `source` (out only), `intermediary`, or `sink` (in only). Optional, but enforced when present. |

The 13 nodes: Individuals, Employers (sources) → Federal Government, State
Governments → Medicare, Medicaid, Health Insurance → Hospitals, Providers &
Clinicians, Pharma & Rx, Long-Term Care → Healthcare Workers, Suppliers &
Vendors (sinks).

### `graph.edges[]` — the flows (adjacency list)

40 edges. Each edge **is** a directed money flow — the declarative connection,
stored as a standard adjacency list:

```jsonc
{ "id": "medicare_hi_ma", "from": "medicare", "to": "health_insurance",
  "amount": 539, "channel": "MA Part C capitation",
  "source": "medpac_kff", "confidence": "reported" }
```

| Field | Meaning |
| --- | --- |
| `id` | Unique, stable edge identifier. |
| `from` / `to` | Node `id`s of the endpoints. Both must exist; must flow forward across layers. |
| `amount` | Dollars in **billions**. Positive finite number. |
| `channel` | What kind of flow this is (e.g. "FFS", "ESI premiums", "Out-of-pocket"). The `(from, to, channel)` triple must be unique — multiple flows between the same pair are allowed only with distinct channels. |
| `source` | A key into `sources{}` — the citation. |
| `confidence` | `reported` (sourced figure) or `estimate` (author-derived/split). |

## Derived quantities (not stored)

These are computed at build time by `computeFlows`, never written into the data:

- **inflow / outflow** per node — sum of incoming / outgoing edge amounts.
- **throughput** per node — `max(inflow, outflow)`. Drives node size in the
  diagram and the **Throughput ($B)** column in the Graph Data sheet.

The `total` and per-node throughputs are snapshotted in `test/expected.json` so
any drift is caught. Note the grand total (~$11,956B) is the **sum of every
ribbon**, so dollars are counted once per layer they cross — it is a flow total,
not the ~$4.9T of total U.S. health spending.

## Confidence and the open reconciliation thread

Most edges are `reported` (CMS NHE, MedPAC, MACPAC, AHA, KFF, Trustees). The
ones marked `estimate` are where the model splits an aggregate by assumption:

- **The four `health_insurance → provider` claim edges** (Hospitals, Providers,
  Pharma, Long-Term Care) are derived by `scripts/derive_hi_claims.mjs` from the
  CMS NHE 2024 release. The "Health Insurance" node aggregates commercial private
  insurance + Medicare Advantage + Medicaid managed care; the script blends each
  program's service-category mix and scales the result so the node balances.
  Because it assumes MA/MCO category mix tracks the parent program, these are
  `estimate`. With them modeled, **Health Insurance balances**.
- **The labor / non-labor splits** at the provider layer (Pharma & Insurance
  admin in particular) are rough estimates. The remaining ~$417B net imbalance
  sits here: Hospitals and Providers net negative while Pharma and Long-Term Care
  net positive. Reconciling these provider outflows against NHE category totals
  is the known open task — see the README's reconciliation note.

## Reference data (`references/`, git-ignored)

Source spreadsheets the numbers are derived from, kept out of git:

- `references/nhe2024/` — `NHE2024.csv` / `.xls`: CMS National Health
  Expenditure 2024 release (CY2023), by type of service and source of funds.
  The input to `derive_hi_claims.mjs`.
- `references/2023_plan_payment/` — CMS Part C/D plan- and county-level payment
  data and reconciliation files (Medicare Advantage / Part D).

## Editing rules of thumb

- Add or change a flow → edit `edges` in `graph.json`, then `npm run build`.
  The diagram and Graph Data sheet update together.
- Reference nodes by `id`, never by `label`. Add a new `source` key before using
  it in an edge.
- Run `npm test` (catches typos, dangling refs, cycles, backward flows, snapshot
  drift) and `npm run check` (per-node balance) after any edit.
