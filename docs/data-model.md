# Data model — the observations-first flow model

_Design narrative for the engine under `src/`, driven by `data/graph.json`. For the
field-by-field schema and build commands, see [`data/README.md`](../data/README.md). For the
audit that motivated the design, see [data-audit.md](data-audit.md)._

## The premise

The motivating problem (see [data-audit.md](data-audit.md)): when the same dollar figure
lives in several places — a graph edge, a sheet's outflow row, another sheet's payer-mix
row, a validation side-table — those copies drift, and you end up needing a reconciliation
pass just to detect the drift. This model takes the opposite stance:

> **Each number lives once, and every source it came from rides on the edge — pick one,
> note why, move on. Following the flow across disparate sources is built in, not a side-table.**

## The core idea: observations

An edge carries a **set of observations** — one per source measuring the same flow:

```jsonc
{
  "id": "medicare_hi_ma",
  "channel": "MA Part C capitation",
  "observations": [
    {
      "value": 539,
      "source": "medpac_kff",
      "basis": "modeled",
      "confidence": "reported",
      "canonical": true,
    },
    { "value": 454, "source": "kff_ma_2024", "basis": "national", "confidence": "reported" },
  ],
}
```

- **`canonical`** — the one observation that _is_ the model's number (implicit when there's
  only one). Everything downstream treats `canonical.value` as the edge amount.
- **`basis`** — the lens the figure is measured on: `modeled` (this model's traced flow)
  or `national` (all-payer NHE reference).
- **The pick** — one observation is `canonical` (the value the model uses); the others stay on the
  edge as context. When sources differ you choose one and say why in its `note` ("…using $614").

**This is a big-picture flow model, not a reconciliation engine.** We follow money at the $B scale,
so sources a few $B apart are a **footnote, not a discrepancy to flag**. There is no tolerance, no
spread/flag, no pass/fail gate. Multiple sources are simply recorded; the one in use is marked, and
the others render as neutral "also reported: …" context. `basis` (modeled vs national) records _why_
two numbers differ when they do — gross vs net, traced vs all-payer — so a gap reads as context.

## The model owns its shape

`src/graph.ts` defines its own node/layer/group types, its own flow arithmetic
(`computeFlows`), and its own validation (`validateGraph`).

`validateGraph` asserts the structural rules that matter (reference integrity, positive
amounts, role/balance sanity) plus the observation- and split-level rules — but it
deliberately has **no Sankey-only constraints**: there is no _forward-flow_ rule and no
_acyclicity_ rule. A Sankey must be a layered DAG; the Excel output needs neither. Dropping
them keeps the door open for **feedback edges** — a flow back to an earlier layer — should
the model ever need one.

**Corporate income tax as a terminal sink.** Every taxable provider/insurer node routes
**corporate income tax → Taxes** (`pharma_fed_tax`, `hi_fed_tax`, `hospitals_fed_tax`,
`providers_*_fed_tax`, `ltc_*_fed_tax`) — a terminal `factors`-group sink (`role: sink`)
that sits alongside Healthcare Workers and Capital & Shareholders and holds the dollars that
leave the traced circuit as government revenue. Each is _carved out of_ that node's
`capital_margin` — the margin edge drops by the tax and the tax edge adds it back — so each
node's total outflow is **conserved**: money simply moves from Capital to Taxes, and the grand
total is unchanged (a property the conservation test locks in). The tax figures are
`confidence: estimate` first-pass values (effective rate on the for-profit / C-corp share),
meant to be refined. Modeling tax as a terminal factor rather than a loop back to Government
keeps the flow a clean one-way layered tree — the same reason Healthcare-Workers wages are a
terminal sink rather than a loop back to Households.

## File map

```
src/
  graph.ts              types, loadGraph, canonicalObservation, computeFlows, validateGraph
  ledger.ts             per-node ledger renderer (auto + overlay modes), loadOverlays
  xlsx.ts               assembles the workbook: ledgers + Nodes/Edges/Observations + cross-sheet links
  build.ts              validate + write dist/2023_healthcare_spending.xlsx        (npm run build)
  check.ts              validate + list the multi-source edges to the console      (npm run check)
  workbook.ts           Sheet → ExcelJS pour-in, citation footnoting, style application
  sheet-model.ts        the Sheet / Cell / Style cell model the renderers emit
data/
  graph.json            source of truth — nodes, edges with observations[], sources, layers, groups
  sheets/<node>.json    editorial overlays (curated labels, extras, checks)
  README.md             schema reference + how-to
```

The rendering infra is split out so the graph model and the Excel pour-in stay independent:
`src/sheet-model.ts` is the pure `Sheet`/`Cell`/`Style` model, and `src/workbook.ts` pours
that model into ExcelJS (plus citation footnoting and style application).

## The workbook

`npm run build` writes one workbook, every sheet derived from `data/graph.json` plus any
editorial overlays in `data/sheets/`:

- **Overview** (front page) — model-at-a-glance counts + total traced flow, a node summary linked to
  each node's sheet, and a multi-source snapshot (each multi-observation edge, the value used, and
  what else was reported). Doubles as a light coverage dashboard.
- **Per-node ledgers** — one per **top-level** node, in an INFLOWS/OUTFLOWS/NET layout. How a
  section renders depends on the data:
  - **auto** — inflows = incoming edges, outflows = outgoing edges, straight from the graph.
    Source-only nodes are OUTFLOWS-only, sink-only nodes INFLOWS-only, so every top-level node gets
    a sheet.
  - **overlay** — a node with a `data/sheets/<node>.json` adds curated labels, `extra` rows for
    flows not in the graph, and an independent-source VALIDATION section.
  - **grouped** — when a section's edges carry 2+ `category` values it splits into labeled
    sub-groups, each with a subtotal (e.g. Government inflows → "General revenue" vs "Corporate
    income tax").
  - **split** — an edge with `split[]` shows indented line-item sub-rows ("% of parent"), left out
    of the section SUM (Pharma labor → R&D / manufacturing / SG&A).
  - **sub-nodes** — a parent node (`node.parent` children) renders each child as its own nested
    in/out/net block, then a COMBINED roll-up; children get no separate tab (Long-Term Care,
    Providers & Clinicians).
  - Either way, multi-observation edges list their other sources in Notes ("also reported: …"), and every flow amount
    is a **clickable cross-sheet hyperlink** to the same edge's other end (outflow ↔ inflow), via
    Excel's `HYPERLINK()` with the value as the friendly name, so the cell stays numeric and
    `SUM`/`%` keep working.
- **Nodes / Edges / Observations** — audit sheets: per-node inflow/outflow/throughput/net; one row
  per flow (canonical value, observation count, other sources reported); one row per source
  measurement, ★ marking the canonical one.
- **Glossary** — acronyms + the model vocabulary (hand-authored), plus data sources and model
  structure generated from the graph.

The schema for `category`, `split[]`, and `node.parent` is in
[`data/README.md`](../data/README.md).

## The overlay pattern

Curating a node is **data-only** — add `data/sheets/<node>.json`; no code change. The rule
that keeps the data clean:

- A **single-edge** independent figure becomes that **edge's observation** in `graph.json`
  (e.g. MA net $454B on `medicare_hi_ma`) and surfaces automatically in the flow's Notes.
- Only **composite/total** checks (a node total, or `a + b − c`) stay hand-authored in the
  overlay's `checks`, rendered as live Excel formulas against the rows they land on.

Medicaid is the sharpest demonstration: three of its five validation rows (federal share,
state share, MCO) are single-edge cross-checks that already exist as edge observations, so
only two composite checks remain.

**Curated so far:** Medicare, Medicaid, Health Insurance, Hospitals, Pharma & Rx (full overlays);
Individuals and Federal Government (section grouping); Long-Term Care and Providers & Clinicians
(sub-nodes). The remaining source/sink nodes are fine as auto-ledgers. (Health Insurance shows the
national-lens tension: its ledger renders the graph's _modeled_ flows, while the CMS NHE PHI total
$1,511B is a composite check with an `other employer` extra plugging the residual; its
public/commercial split is handled with row categories.)

Hospitals and Pharma & Rx were clean single-entity overlays: each already had its full graph skeleton
(inflow claims from every payer; outflows decomposed into labor / non-labor / capital-margin), so
the overlay only added curated labels, the cost-structure detail as row notes, and two-to-three
independent-source checks (e.g. hospital labor share ≈ 54% of the $1,501B NHE national total; pharma
net margin ≈ 17% on the rebate-net $433B). No graph or code change.

### Edge splits — line-item detail without changing the flow

A coarse outflow often has a known internal breakdown (Pharma labor → R&D / manufacturing /
SG&A; non-labor → COGS / distribution; margin → net profit / taxes). An **`edge.split[]`** carries
that as optional child components on the edge that **must sum to its canonical value** (a
`validateGraph` rule). The edge stays one flow to its sink — totals, balance and hyperlinks are
unchanged — but the ledger renders the parts as indented sub-rows showing "% of parent", left out
of the section SUM so they're detail, not a second count. Pharma is decomposed by destination sink
(labor / suppliers / capital), so a split re-buckets the P&L-function lines (COGS / R&D / SG&A / tax
/ profit) under their destination edges. The same machinery will carry Hospitals' labor-by-worker-type
breakdown. See
[`data/README.md`](../data/README.md#edge-splits--line-item-breakdown-edgesplit).

## Design principles

1. **Big picture, not reconciliation** — this follows money at the $B scale. When sources differ,
   record each as an observation, pick one as canonical, and note why. A few-$B gap is a footnote,
   **not a discrepancy to flag** — there is no tolerance, spread engine, or pass/fail gate. Don't
   add one back.
2. **Each number lives once** — disparate sources go on the edge as observations, not into
   restated side-tables.
3. **The model owns its shape** — its own types, validation (`validateGraph`, no Sankey DAG
   constraint), and flow arithmetic (`computeFlows`). The only rendering infra is the pure
   `src/workbook.ts` Excel pour-in + `src/sheet-model.ts` cell model, so rendering doesn't fork.
4. **Self-contained** — the build depends only on `data/graph.json` plus the pure render infra.
5. **Test-locked** — capability is covered by `test/graph.test.ts` and `test/ledger.test.ts`.

## Roadmap

- **Next:** the big mission-work, still open — exercise the multi-source observations engine on the
  ~70 single-source edges (the original reason the engine exists; only 4 of 75 edges carry a second
  source today). Then refine the `confidence: estimate` first-pass figures (sub-node splits, tax carves).
- **Done so far:**
  - `edge.split[]` — line-item breakdown of a single edge, validated to sum to its canonical value
    (live on Pharma).
  - **Terminal Taxes sink** — corporate income tax across all taxable nodes routed to a terminal
    `Taxes` factor (`role: sink`), carved from each margin so totals are conserved (first-pass
    `estimate` values to refine). Modeled as a terminal leakage, not a loop back to Government.
  - **Row categories** — `edge.category` groups a section into labeled sub-headers + subtotals when
    2+ categories are present (e.g. Individuals outflows → "Taxes & payroll" / "Insurance premiums" /
    "Out-of-pocket").
  - **Sub-nodes (`node.parent`)** — a node renders each child as a nested in/out/net block + a
    combined roll-up. Edges attach to children; the parent is a pure aggregate; totals conserved via
    leaf-summing. Live on Long-Term Care (nursing / home health) and Providers & Clinicians
    (physician / dental / other professional).
  - **Framing sheets** — a front-page **Overview** (counts, total, linked node summary, cross-source
    snapshot) and a **Glossary** (acronyms, model terms, generated sources + structure).
- **Deferred concepts** (captured in `data/README.md`): more flows into the Taxes sink (e.g.
  payroll/income tax on wages, investment returns); named leakage edges (turn `extra`
  rows into edges to a sink so conservation is explicit); and node-level observations (independent
  _totals_ like Medicare $1,030B as observations of a node, not an edge).

## Commands

```
npm run build     # write dist/2023_healthcare_spending.xlsx
npm run check     # validate + list the multi-source edges (sources & value used)
npm test          # graph + ledger tests
```

If Excel holds the workbook open (exclusive lock on Windows), build to a temp path:
`XLSX_OUT=dist/_tmp.xlsx npm run build`.
