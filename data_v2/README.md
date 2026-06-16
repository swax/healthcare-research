# data_v2 — observations-first flow model

`data_v2/` is the **v2 source of truth**, built in parallel with `data/` (v1). It regenerates the
flow-of-funds Excel workbook from a richer model. v1 is left untouched and keeps working; nothing in
`src/` imports `data_v2/`. The core change: an edge no longer has a single `amount` — it carries a
set of **observations**, one per source, because following the same flow across disparate sources
_is_ the project.

For the design narrative (why v2, the circular-flow story, roadmap) see
[`../docs/v2.md`](../docs/v2.md). This file is the field-by-field schema + how-to.

## Building & viewing

```
npm run check:v2     # validate + list the multi-source edges (sources & value used)
npm run build:v2     # write dist/2023_healthcare_spending_v2.xlsx
```

`build:v2` validates first (see [Validation](#validation-v2-owns-it--validategraphv2)), then writes
one workbook. Sheets:

- **Overview** (front page) — model-at-a-glance counts + total traced flow, a node summary linking
  to each node's sheet, and a multi-source snapshot (each multi-observation edge, the value used, and
  what else was reported). Doubles as a light coverage dashboard.
- **`<node>` ledgers** — one per **top-level** node, in the v1 INFLOWS/OUTFLOWS/NET layout, via the
  shared pour-in (`src/workbook.ts`). Built straight from the graph edges; a node with a
  `data_v2/sheets/<node>.json` overlay also gets curated labels/notes/checks (see
  [Editorial overlay](#editorial-overlay-data_v2sheetsnodejson)). **Sub-node children render nested
  inside their parent's sheet** — they get no separate tab.
- **Nodes / Edges / Observations** — audit sheets: per-node inflow/outflow/throughput/net; one row
  per edge (canonical value, `# Obs`, other sources reported); one row per source
  measurement (★ = canonical).
- **Glossary** — acronyms and the v2 model vocabulary (hand-authored), plus the data sources
  (`sources{}`) and model structure (layers, groups) generated from the graph.

Every flow amount is a **clickable cross-sheet link** to the same edge's other end (an outflow jumps
to the payee's matching inflow, and back), so you can trace a dollar hop by hop. It uses Excel's
`HYPERLINK()` with the value as the friendly name, so the cell stays numeric and `SUM`/`%` keep
working; the blue text marks it clickable. Where an edge has more than one source, the Notes column
lists the others as neutral context (`also reported: $619.9B modeled (macpac_macstats)`).

How a section renders depends on the data: flat by default, **grouped** when its edges carry 2+
[categories](#row-categories--grouped-sections-edgecategory), with indented
[split](#edge-splits--line-item-breakdown-edgesplit) sub-rows where an edge has line items, and as
stacked child blocks + a roll-up for a [sub-node](#sub-nodes--a-node-made-of-sub-entities-nodeparent)
parent.

If Excel holds the workbook open (exclusive lock on Windows), build to a temp path:
`XLSX_V2_OUT=dist/_v2tmp.xlsx npm run build:v2`.

## What changed vs v1

A v1 edge was:

```jsonc
{
  "id": "medicare_hi_ma",
  "from": "medicare",
  "to": "health_insurance",
  "amount": 539,
  "channel": "MA Part C capitation",
  "source": "medpac_kff",
  "confidence": "reported",
}
```

A v2 edge is:

```jsonc
{
  "id": "medicare_hi_ma",
  "from": "medicare",
  "to": "health_insurance",
  "channel": "MA Part C capitation",
  "observations": [
    {
      "value": 539,
      "source": "medpac_kff",
      "basis": "modeled",
      "confidence": "reported",
      "canonical": true,
      "note": "Gross MA capitation (includes premiums, rebates)",
    },
    {
      "value": 454,
      "source": "kff_ma_2024",
      "basis": "national",
      "confidence": "reported",
      "note": "MA federal spending NET of premiums — different basis, not a disagreement",
    },
  ],
}
```

`id`, `from`, `to`, `channel` are unchanged. `amount` / `source` / `confidence` moved **into** each
observation. `meta`, `layers`, `groups`, `sources` keep the v1 shape. Three things are genuinely new
in v2 and have no v1 analogue: edge `split[]`, edge `category`, and `node.parent` (sub-nodes) — each
documented below.

## The `observations[]` model

Each observation is one source's measurement of the same flow:

| Field        | Meaning                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `value`      | Dollars in **billions**. Positive finite number.                                                                            |
| `source`     | A key into `sources{}` — the citation.                                                                                      |
| `basis`      | The **lens** the figure is measured on: `modeled` (this model's traced flow) or `national` (all-payer NHE-basis reference). |
| `confidence` | `reported` (sourced figure) or `estimate` (author-derived/split).                                                           |
| `canonical`  | `true` on the one observation that **is** the model's number. Optional — see rule below.                                    |
| `note`       | Free text: what makes this observation's basis/source distinct.                                                             |

### Canonical observation

Every edge has exactly one canonical observation — the value the totals and balance checks use (the
v1 `amount`).

- **One observation** → it is canonical implicitly (no flag needed). This is most edges.
- **More than one** → exactly one must carry `"canonical": true`.

So a downstream `amount(edge)` is just "the canonical observation's `value`."

### `basis` — why two numbers can both be right

`basis` carries forward the `modeled` vs `national` distinction that `reconcile.ts` _infers from
sheet names_ in v1. Making it explicit is the whole point:

- Two observations with **different `basis`** describing the same flow measure **different things on
  purpose** — e.g. `medicare_hi_ma` gross capitation ($539B, modeled) vs MA spending net of premiums
  ($454B, national).
- Two observations with the **same `basis`** that still differ are just two sources a bit apart —
  e.g. `fed_medicaid_fmap` $614B (CMS-64) vs $619.9B (MACPAC MACStats). We record both, use one, and
  note why. **No flag.** At $B scale on a flow model a few-$B gap is a footnote, not an error to
  resolve — this is a big-picture model, not a reconciliation engine.

### Worked examples already in `graph.json`

Four edges carry a second observation so the model is exercised, not just renamed:

| Edge                   | Value used            | Also reported                   | Reads as                                  |
| ---------------------- | --------------------- | ------------------------------- | ----------------------------------------- |
| `medicare_hi_ma`       | 539 (modeled, gross)  | 454 (national, net of premiums) | different basis — both right, using gross |
| `medicaid_hi_mco`      | 508 (modeled)         | 508 (modeled, MACStats)         | two sources land on the same number       |
| `state_medicaid_share` | 280 (modeled)         | 280.4 (modeled, MACStats)       | ~$0.4B apart — using 280                  |
| `fed_medicaid_fmap`    | 614 (modeled, CMS-64) | 619.9 (modeled, MACStats)       | ~$6B apart — using the CMS-64 figure      |

The graph has **75 edges**; only these four carry a second source today. The model already holds
every source per edge — adding more (and a one-line note on which value we use and why) is the main
open work. It stays a notes-and-sources exercise; there's no discrepancy machinery to build.

## Validation (v2 owns it — `validateGraphV2`)

v2 validates its **own** shape and is **fully independent of v1's model**: `data_v2/graph.ts` imports
nothing from `src/graph.ts`. It defines its own node/layer/group types and flow arithmetic
(`computeFlowsV2`), and `validateGraphV2` re-asserts every v1 rule that still matters plus the
v2-specific ones:

1. Reference integrity — edge ids unique, `from`/`to` exist, no self-loop, no duplicate
   `(from, to, channel)`; every `observation.source` is a key in `sources{}`.
2. Every edge has ≥ 1 observation; exactly one is canonical (implicit if only one).
3. `confidence ∈ {reported, estimate}`; `basis ∈ {modeled, national}`; every observation `value`
   positive & finite.
4. **Split** parts are positive & finite and **sum to the canonical value within $1B**.
5. **Sub-nodes** — a child's `parent` exists, child layer == parent layer, and a parent carries no
   direct edges (flows go through its children).
6. Role / balance sanity on canonical amounts — a `source` has no inflow, a `sink` no outflow, no
   node is isolated.

There is **no discrepancy / spread check**. Multiple sources are recorded on the edge as
observations and one is chosen canonical; differing values are surfaced as context, never gated.
This is a big-picture flow model — see the `basis` section above. Don't add a tolerance/flag back.

**Deliberately NOT enforced** (unlike v1): _forward-flow_ and _acyclicity_. Those were v1's
**Sankey-only** constraints — a Sankey must be a layered DAG. v2 renders Excel, so an edge may point
to any node, **including a feedback edge back to an earlier layer**. That freedom is what lets v2
model the **circular flow of funds**.

> **Feedback edges (live).** Every taxable provider/insurer node routes **corporate income tax →
> Federal Government** (channel `"Corporate income tax"`). Each is _carved out of_ that node's
> `capital_margin` (the margin edge drops by the tax, a new edge to Government adds it back), so the
> node's total outflow is **conserved** — money moves from Capital to Government, the grand total is
> unchanged. These are backward edges (layer 3/2 → 1) that v1 would reject as "backward flow" /
> "cycle"; v2 accepts them. The tax amounts are `confidence: estimate` first-pass figures (effective
> rate on the for-profit / C-corp share) — easy to refine. (`toV1()` is **gone** — v2 no longer
> projects to the v1 shape at all.)

## Editorial overlay (`data_v2/sheets/<node>.json`)

The auto-ledger gives every top-level node a sheet; an overlay adds the curated detail v1's best
sheets had, **on top of** the graph rather than restating it. It's how v1 data is ported into v2 —
node by node.

```jsonc
{
  "node": "medicare",
  "subtitle": "…", // optional header override
  "rows": {
    // curated label / note / category for an edge id
    "medicare_hi_ma": { "label": "Medicare Advantage (Part C) capitation" },
    "medicare_ltc_homehealth": { "label": "Home health & hospice (FFS)", "note": "…" },
  },
  "extraInflows": [
    { "id": "other_in", "label": "Other …", "amount": 112, "source": "cms_nhe_trustees" },
  ],
  "extraOutflows": [
    { "id": "admin", "label": "Administration …", "amount": 72, "source": "cms_nhe" },
  ],
  "checks": [
    // independent-source validations of derived quantities, rendered as live Excel formulas
    {
      "metric": "Total Medicare (CMS NHE)",
      "independent": 1030,
      "model": { "sum": ["total:inflows"] },
      "emphasis": true,
    },
    {
      "metric": "Part B (MedPAC)",
      "independent": 493,
      "model": {
        "sum": [
          "edge:medicare_providers_physician_ffs",
          "edge:medicare_providers_other_ffs",
          "extra:dme_other",
          "extra:admin",
        ],
      },
    },
    {
      "metric": "Personal HC (MedPAC)",
      "independent": 956,
      "model": { "sum": ["total:outflows"], "minus": ["extra:admin"] },
    },
    {
      "metric": "% of NHE",
      "independent": 0.212,
      "fmt": "pct",
      "model": { "sum": ["total:inflows"], "over": 4867 },
    },
  ],
}
```

- **`rows`** — curated `label` / `note` / `category` for an edge's row (else the auto
  "Counterparty — channel" label and the edge's own category).
- **`extraInflows` / `extraOutflows`** — flows the graph doesn't model (admin, DME, "Other"); the
  amount lives here, the row gets no hyperlink, and a check can reference it as `extra:<id>`.
- **`checks`** — a VALIDATION row whose model value is a live Excel formula: a signed sum of refs
  (`total:inflows` · `total:outflows` · `edge:<id>` · `extra:<id>`), optionally `/over`.

> **The v2 improvement:** a single-edge independent figure does **not** go in `checks` — it becomes
> that edge's second observation in `graph.json` (e.g. MA net $454B on `medicare_hi_ma`) and surfaces
> automatically in the flow's Notes as neutral "also reported" context. Only genuinely composite/total
> checks are hand-authored. So each number lives once.

**Ported so far:** Medicare, Medicaid, Health Insurance, Hospitals, Pharma & Rx (full overlays with
curated labels + checks); Individuals (section grouping). The remaining source/sink nodes are fine as
auto-ledgers. Long-Term Care and Providers & Clinicians are modeled as
[sub-nodes](#sub-nodes--a-node-made-of-sub-entities-nodeparent). Porting another node = add its
`data_v2/sheets/<node>.json` — no code change.

## Edge splits — line-item breakdown (`edge.split[]`)

A coarse outflow can carry a finer breakdown without changing the graph topology. An edge keeps its
single flow to its sink, but `split[]` lists the line items that compose it — recovering v1's detail
(e.g. Pharma labor → R&D / manufacturing / SG&A) as structured, **validated** data:

```jsonc
{
  "id": "pharma_workers_labor",
  "from": "pharma_rx",
  "to": "healthcare_workers",
  "channel": "Labor",
  "observations": [
    { "value": 116.5, "source": "estimate", "basis": "modeled", "confidence": "estimate" },
  ],
  "split": [
    { "label": "R&D — scientists, clinical, CROs", "value": 50, "confidence": "estimate" },
    { "label": "Manufacturing & quality labor", "value": 30, "confidence": "estimate" },
    {
      "label": "SG&A — sales force, market access, admin",
      "value": 36.5,
      "confidence": "estimate",
    },
  ],
}
```

- The parts **must sum to the canonical value within $1B** (a `validateGraphV2` rule) — so each
  number still lives once; the parent is the flow, the parts are its anatomy.
- In the ledger the parent stays the real row (summed in the section total, cross-linked); the parts
  render as **indented sub-rows** showing "% of parent", deliberately left out of the section SUM so
  they're detail, not a second count.
- The audit **Edges/Observations** sheets are unaffected — `split` is ledger detail, not a separate
  flow. Parts are usually `confidence: "estimate"`.

Live on Pharma & Rx (labor, non-labor, margin). The same machinery would carry, e.g., Hospitals'
labor-by-worker-type breakdown (currently a row note).

## Row categories — grouped sections (`edge.category`)

An edge can carry a **`category`** — a grouping key. When a node's INFLOWS (or OUTFLOWS) section
contains **2+ distinct categories**, it renders **grouped**: each category gets a labeled sub-header
and a subtotal, and the section TOTAL sums the subtotals. With fewer than two categories the section
stays flat, so adding a category only changes the sheets where it actually creates structure.

```jsonc
// Federal Government inflows split into two groups:
{ "id": "ind_fed_medicare_genrev", "category": "General revenue", ... } // + medicaid, aca
{ "id": "pharma_fed_tax",          "category": "Corporate income tax", ... } // + the other taxes
```

renders as:

```
INFLOWS (Funding Sources)
  General revenue
     Individuals — General revenue (Medicare)        437
     Individuals — General revenue (Medicaid)        614
     Individuals — General revenue (ACA subsidies)    80
  Subtotal — General revenue                        1,131
  Corporate income tax
     Pharma & Rx — Corporate income tax              17.5
     … (one per taxable entity)
  Subtotal — Corporate income tax                    39.5
  TOTAL INFLOWS                                     1,171   (= sum of subtotals)
```

- The category is **intrinsic to the edge** (a corporate income tax is a tax wherever it appears), so
  it lives once on the edge. An overlay row may override it per sheet (`rows.<id>.category`), and
  `extra` rows can set one too.
- Uncategorised rows, when grouping is active, collect under a trailing **"Other"** bucket.
- Splits still work inside a group: a parent row keeps its indented child sub-rows.

Where grouping is live (a section needs 2+ categories, and the split has to be meaningful — 4-row
provider sheets and single-type sinks read better flat):

| Sheet              | Section  | Groups                                                         |
| ------------------ | -------- | -------------------------------------------------------------- |
| Federal Government | inflows  | General revenue · Corporate income tax                         |
| Individuals        | outflows | Taxes & payroll · Insurance premiums · Out-of-pocket           |
| Medicare           | inflows  | Payroll taxes (HI trust fund) · Premiums & general revenue     |
| Health Insurance   | inflows  | Commercial / private · Public managed care                     |
| Health Insurance   | outflows | Claims paid (medical) · Operating, margin & tax (the MLR view) |

The Government and Individuals categories live on the edges / a thin overlay; Medicare and Health
Insurance use overlay category overrides so the same edge can group differently on its _other_
endpoint (e.g. the MA capitation edge is "Public managed care" on the insurer's sheet but an ordinary
outflow on Medicare's).

## Sub-nodes — a node made of sub-entities (`node.parent`)

Some nodes are really several little businesses (Long-Term Care = nursing facilities + home health;
Providers = physician / dental / other). A **child** node sets `"parent": "<id>"`; **edges attach to
the child**, and the **parent becomes a pure aggregate** — it carries no direct edges, and its
inflow/outflow/net roll up from its children (`computeFlowsV2`).

```jsonc
{ "id": "ltc_nursing",    "label": "Nursing Facilities",    "parent": "long_term_care", ... }
{ "id": "ltc_homehealth", "label": "Home Health & Hospice", "parent": "long_term_care", ... }
// the payer edges point at the children, e.g.:
{ "id": "medicare_ltc_nursing_snf", "from": "medicare", "to": "ltc_nursing", ... }
```

The parent's sheet renders **each child as its own nested in/out/net block, then a COMBINED roll-up**
that sums the children's section totals. Children get no separate tab. Everything else (observations,
splits, categories, hyperlinks, the "also reported" notes) works **per child**, unchanged — a payer's
outflow links straight to the child block it pays. The grand total is conserved by summing **leaf** nodes
only (`leafNodeIds`) so a parent and its children are never double-counted.

**Live on:** Long-Term Care (nursing / home health) and Providers & Clinicians (physician / dental /
other professional). The per-child splits are `confidence: estimate` (no source gives a clean
payer×entity matrix) — LTC's outflow split reproduces v1's $205B nursing / $154B home-health cost
totals as a sanity check, and the Providers split isolates the big physician imbalance (the
hospital-employed-physician comp counted in both Hospital and Physician revenue) into the physician
child, leaving dental nearly balanced.

## Deliberately deferred

Ideas from the design discussion left out so far, captured here so they aren't lost:

- **More feedback categories** — payroll / income tax on wages (Healthcare Workers → Government),
  investment returns, etc., extending the circular flow beyond corporate income tax.
- **Named leakage** — turning `extra` sheet rows (admin, DME) into explicit edges to a named sink, so
  conservation is honest while keeping the documented traced-subset decision intact.
- **Node-level observations** — independent _totals_ (Medicare $1,030B vs model $1,037B; Medicaid
  $900B vs $894B) are observations of a node's throughput, not of one edge. They need an observation
  slot on nodes (or on a derived total), which the edge-only model doesn't add.
- **Per-node graph fragments** — sharding sub-node / observation detail into `data_v2/nodes/<id>.json`
  files merged at load, so the canonical top-level graph stays small and reviewable.
