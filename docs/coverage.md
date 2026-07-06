# Coverage — what the traced model captures vs. national health spending

_2026-06-28. Quantifies the model's deliberate traced-subset boundary (see
[data-model.md](data-model.md) and the 2026-06-15 decision in [data-audit.md](data-audit.md)).
The gap below is **by design, not a defect** — this is a traced-flow model, not closed
national accounting. The point of this page is to make the boundary explicit and auditable._

> **Vintage:** figures here are the **CMS NHE 2024 release (CY2023)**, taken from the in-repo
> `references/nhe2024/NHE2024.csv`. That release **revised 2023 up** to **$4,925.3B** total NHE
> (from the $4,866.5B the project's `data/sheets/*.json` still cite — an older vintage). Trueing
> those sheets to this vintage is a separate follow-up; this page uses the in-repo data so the
> per-service and by-source-of-funds numbers reconcile exactly.

## The headline number

The model traces **~$3.86T** of care-delivery spending. Measured against **Health Consumption
Expenditures (HCE) = $4,691.9B** (total NHE less capital investment), that leaves **~$836B
untraced** — almost entirely in categories the model has no delivery node for (see below).

```
CMS NHE 2023 (NHE2024 release), total        $4,925.3B
  − Investment (research $71.4B +
    structures & equipment $162.0B)            ~$233.4B    ← excluded by design (not care delivery)
  = Health Consumption Expenditures (HCE)     $4,691.9B
      − Traced to care-delivery providers     $3,855.8B    ← what the model follows
      = Untraced                                ~$836.1B
```

> **History of this figure.** A note once recorded "**missing $1.221T of $4.541T**" — the same
> identity on the older vintage when the model traced $3,320.5B to providers ($4,541.5 − $3,320.5
> = $1,221.0). Two things changed it: (1) the **2026-06-28** edges that close Hospitals, Physician
> & Clinical and Other Professional to their cost base raised traced to **$3,855.8B**; (2) moving
> to the NHE2024 vintage raised HCE to **$4,691.9B**. Net gap is now **~$836B**, and it is now
> almost all "no delivery node" categories rather than under-tracing.

## Coverage by service category

National figures are CMS NHE 2024 release (CY2023), by type of service; traced figures are the
model's exact canonical provider inflows (`npm run check`).

| NHE service category (2023)                                | National | Model node           | Traced  | Untraced |
| ---------------------------------------------------------- | -------: | -------------------- | ------: | -------: |
| Hospital care                                              |  1,501.1 | Hospitals            | 1,501.0 |    ~0    |
| Physician & clinical services                              |  1,026.9 | Physician & Clinical |   984.3 |   ~43 ¹  |
| Dental services                                            |    177.5 | Dental               |   176.3 |    ~1    |
| Other professional services                                |    166.9 | Other Professional   |   167.4 |    ~0    |
| Retail prescription drugs                                  |  432.9 ² | Pharma & Rx          |   418.4 |   ~14    |
| Nursing + home health + other residential/personal care    |  652.3 ³ | Long-Term Care       |   608.4 |   ~44    |
| **Subtotal — categories with a delivery node**             | **3,957.6** |                   | **3,855.8** | **~102** |
| Net cost of private health insurance                       |    313.4 | (HI → sinks) ⁴       |    —    |  ~313    |
| Other non-durable medical products                         |    123.3 | — none —             |    —    |  ~123    |
| Durable medical equipment (DME)                            |     81.9 | — none —             |    —    |   ~82    |
| Government public health activities                        |    158.0 | (partial) ⁵          |    —    |  ~158    |
| Government administration                                  |     57.7 | — none —             |    —    |   ~58    |
| **Subtotal — no delivery node**                            |  **734.3** |                    |  **—**  | **~734** |
| **TOTAL Health Consumption Expenditures**                  | **4,691.9** |                   | **3,855.8** | **~836** |

¹ Physician traces to its **outflow cost base ($984B)**, which sits ~$43B below the NHE total
  ($1,027B). That residual is on the *outflow* (cost-structure) side, not a missing payer — the
  inflow side is closed (see the residual decomposition below).
² Retail Rx is traced **net of manufacturer rebates** (~$200B rebates net out of the ~$633B
  gross list); $432.9B is the NHE net figure. The ~$14B gap is other-payer (VA/DoD). See `pharma_rx.json`.
³ The model's **Long-Term Care** node folds three NHE lines into one: nursing care facilities &
  CCRC ($205.0B), home health ($153.6B), and most of "other health, residential & personal care"
  ($293.7B). On that combined basis it traces ~93%.
⁴ Net cost of private insurance **is** in the flow model — as Health-Insurance-node outflows to
  the labor / capital / tax sinks (premiums in − claims out), not as a care-delivery category. Not
  "missing," just not counted in the traced-to-providers total.
⁵ Government public health is partly traced via the federal/state direct-spending edges.

## Inside the closing residual — anchored to NHE source-of-funds

The 2026-06-28 edges that close Hospitals / Physician / Other-Professional on the inflow side
total **$603B**. Rather than a single vague "Other Payers" plug, they are split into **two
NHE-anchored components** (CMS NHE 2024, by source of funds — `references/nhe2024/NHE2024.csv`):

| Source node | What it is | Hospital | Physician | Other-Prof | Total |
| ----------------------- | -------------------------------------------------- | ----: | ----: | ---: | -----: |
| **Other Third-Party Payers** | real NHE "Other Third Party Payers & Programs" (net traced workers' comp) | 136 | 79.5 | 16 | **231.5** |
| **Unattributed Insurer Claims** | reconciliation: NHE insurer receipts − the traced insurer/program chain | 202 | 119.5 | 50 | **371.5** |

**Other Third-Party Payers** carries a sourced `split[]` naming the real programs — for hospitals:
*other private revenues (philanthropy / non-patient income) $107B · other state & local $19B · IHS
$3B · general assistance $3B · other federal (SAMHSA, MCH, voc-rehab) $3B.*

**Unattributed Insurer Claims** (formerly "Untraced Managed Care") is **not a distinct payer** —
it is a model-reconciliation line. For hospitals: NHE insurer receipts (private HI $506B +
Medicare $411B + Medicaid $294B + CHIP $6B = $1,217B) less the model's traced insurer/program
chain (HI claims $820.5B + Medicare FFS $150B + Medicaid FFS+DSH $45B = $1,015.5B) ≈ **$202B**.
It stays on the inflow side because the insurer chain (premiums → claims) is **sourced and
balanced** and can't absorb it without inflating the sourced premium/capitation figures — i.e.
routing it "properly" through the insurer node is the full national rebalance that
[data-audit.md](data-audit.md) scopes out. In the diagram the node now sits beside Health
Insurance (not among the layer-0 payers), since it supplements the insurer chain rather than
being a source of funds in its own right.

Each of its edges now carries a `split[]` attributing the residual **by program**, allocated
pro-rata to that program's NHE receipts net of the traced direct-FFS edges (the bundled claims
edge isn't split by line of business, so the allocation assumes it undercounts each program
proportionally):

| Edge | Commercial / PHI | Medicare Advantage | Medicaid & CHIP MC | Household OOP | Total |
| ------------------ | ---: | ---: | ---: | ---: | ----: |
| → Hospitals        | 100.0 | 51.7 | 50.3 | — | **202** |
| → Physician        |  79.4 | 25.5 | 14.6 | — | **119.5** |
| → Other Professional | 12.1 |  7.6 |  2.8 | 27.5 | **50** |

The other-professional edge is the exception worth knowing about: the NHE identity shows only
~$22B of its $50B is insurer-chain gap. The other **~$27B is a household out-of-pocket
undercount** (NHE other-professional OOP $40.5B vs the $13.3B traced OOP edge — part of the
deliberately-traced OOP subset noted in `data/sheets/individuals.json`). It rode in under the
old "managed care" label; the split now names it, and re-routing it from this reconciliation
node to Individuals is a candidate follow-up (a value change, so a deliberate model-shape
decision, not part of the relabel).

## The remaining gap is "no delivery node", by design

The ~$836B left is essentially the **no-delivery-node** subtotal ($734B) plus the small
in-category remainders (Rx basis, LTC, physician cost-base). The big absent categories: net cost
of private insurance ($313B, *already* in the model as insurer overhead → sinks, just not a
provider), other non-durable products ($123B), DME ($82B), government public health ($158B,
partly modeled), government administration ($58B). Whether to add terminal/delivery nodes for the
genuinely-absent ones is the open **"decide the leakage"** decision in
[data-audit.md](data-audit.md) — a model-shape change to make deliberately, not drift into.

## What this is not

Not a reconciliation target. This is a big-picture flow model (see [data-model.md](data-model.md),
design principle #1); a few $B between sources is a footnote, and the ~$836B boundary is the honest
scope of a traced subset. The closing edges were added because that gap was genuine under-tracing
against an outflow base already built to national totals — closing it *improved* conservation —
and they are split into a real sourced payer bucket plus an honestly-labeled reconciliation line,
not one black box. The remaining categories are left out deliberately, not force-fit.

## Sources

- **In-repo:** `references/nhe2024/NHE2024.csv` — CMS NHE 2024 release (CY1960–2024) by type of
  service **and source of funds**; the 2023 column anchors every figure on this page.
- CMS, [National Health Expenditure Data](https://www.cms.gov/data-research/statistics-trends-and-reports/national-health-expenditure-data) (release landing page).
- Repo cross-checks: `data/sheets/hospitals.json`, `pharma_rx.json`, `individuals.json` (each
  provider sheet's VALIDATION section reports its traced share of the NHE national total — on the
  older $4,866.5B vintage until those sheets are trued up).
