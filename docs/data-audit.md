# Flow-of-Funds Data Audit

_2026-06-15. A content audit of `data/workbook.json` against the project's actual
goal: **modeling the flow of money through the U.S. healthcare system.** It came
out of the sheet-generation work (see [architecture.md](architecture.md)), which
turned out to be an unexpectedly good diagnostic — see "Method" below._

> **Decision (2026-06-15):** of the two model types this audit surfaces (see "The
> structural finding"), the project is a **traced-flow model**, not closed national
> accounting. So: the **Capital & Shareholders** node was added as an _insight_ sink
> (it names where ~$223B of sector profit lands) but the node imbalances are
> **accepted as inherent and documented**, not "fixed" — `check.ts` now reports them
> as expected context. The "complete the conservation model" / national-rebalance
> options below are therefore **not being pursued**; they're retained as the record
> of the alternative. The non-flow cuts (Healthcare Workers/Suppliers detail,
> Glossary, validation tables) remain valid and open.

## The diagnostic

> **Does this row describe money moving from one actor to another?**
> If yes, it's flow-of-funds — it belongs in the graph (`data/graph.json`), as an
> edge or a finer split of one. If no — a headcount, a wage, a validation
> cross-check, an occupational breakdown, a definition, a prose insight — it is
> something else, and it does not belong in the model.

**"Can the sheet be generated from the graph?" is a near-perfect proxy for that
test.** The sheets that reproduce cleanly from `graph.json` (Medicare, Medicaid)
are dense with inter-node flows. The sheets that resisted generation resisted
_because they are mostly not flow-of-funds._ A content fingerprint makes this
concrete (counts of: rows with a `→` flow, payer-mix `%` rows, literal `$`
amounts, cross-sheet formula refs, long prose rows, validation/QA rows):

| Sheet                  | rows |  flow | x-ref | prose | val | reads as                 |
| ---------------------- | ---: | ----: | ----: | ----: | --: | ------------------------ |
| Healthcare Workers     |   95 | **0** |    25 |    12 |  14 | labor-market analysis    |
| Suppliers & Vendors    |   89 | **0** |    25 |     2 |   4 | cost analysis            |
| Glossary               |  102 | **0** |     0 |     — |   2 | reference                |
| Providers & Clinicians |  139 |     3 |     — |     2 |  10 | sector analysis          |
| Individuals            |   34 |    13 |    13 |     2 |   1 | **flow**                 |
| Health Insurance       |   44 |     9 |     5 |     1 |   1 | **flow**                 |
| Capital Markets        |   39 |     9 |     7 |     1 |   1 | **flow (not in graph!)** |

Zero-flow + high cross-ref/prose/validation = not a flow sheet.

## The structural finding: the model doesn't conserve money

A flow-of-funds model should conserve — every dollar into a node flows out. The
current graph doesn't, by hundreds of billions (`npm run check`):

```
Medicaid +$101B   Medicare +$11B
Hospitals −$417B  Providers −$329B   Pharma +$154B   Long-Term Care +$249B
```

**The bespoke sheets exist largely to paper over that gap in prose and side-tables.**
Two distinct causes, two distinct fixes:

1. **Missing flow that belongs in the graph.** Every provider sheet internally
   balances revenue into `labor + non-labor + margin` (Hospitals §43–64,
   Pharma §34–43, LTC §33–56). The graph captures labor (→ Healthcare Workers)
   and non-labor (→ Suppliers & Vendors) — but **not margin.** That margin is
   exactly the **Capital Markets** sheet (§5–25: profit in from each sector →
   shareholders / PE / buybacks / reinvestment out, net ≈ 0). It is a fully-formed
   flow node that was **never wired into the graph.** Adding it closes the
   positive provider imbalances.

2. **Inflow under-estimation.** The negative imbalances (Hospitals, Providers)
   come from the insurer→provider claims edges (`hi_*_claims`) being estimates
   that undercount. That's a data-quality fix in `graph.json`, not a missing node.

> **The single most on-mission change available is to complete the conservation
> model — add a Capital / Shareholders sink node — not to hand-author more sheets.**

## Per-sheet verdict

Legend: **GEN** = flow, generate from graph · **GRAPH** = real flow missing from the
graph, add it · **TRIM** = flow skeleton + heavy non-flow detail, reduce · **CUT** =
not flow, drop or move to a clearly-labeled appendix.

| Sheet                   | Verdict       | What's flow (keep)                                                 | What's not flow (cut / appendix)                                                                                                  |
| ----------------------- | ------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Medicare, Medicaid      | ✅ GEN (done) | whole ledger                                                       | —                                                                                                                                 |
| **Individuals**         | GEN           | outflows to programs + OOP→providers (reconciled edges) + premiums | validation block                                                                                                                  |
| **Employers**           | GEN           | ESI premiums + payroll outflows                                    | validation block                                                                                                                  |
| **Health Insurance**    | GEN¹          | premium inflows + claims outflows                                  | validation block                                                                                                                  |
| **Federal Gov**         | GEN²          | funding → Medicare/Medicaid/ACA (graph edges)                      | direct delivery (VA/DoD/IHS), federal PH/admin — see ³                                                                            |
| State Gov               | TRIM          | $280 state→Medicaid share                                          | CHIP, public-health, admin detail (non-graph), the `=Medicaid!B7` plumbing                                                        |
| **Capital Markets**     | **GRAPH**     | profit-in / distributions-out (a complete node)                    | context + validation                                                                                                              |
| Hospitals               | TRIM          | revenue-by-payer; labor/non-labor/margin outflows                  | managed-care passthrough, cost sub-categories, CHECK rows, validation                                                             |
| Pharma                  | TRIM          | revenue-by-payer; COGS/SG&A/R&D/profit outflows                    | CHECK rows, validation                                                                                                            |
| Long-Term Care          | TRIM          | nursing+home-health revenue; expense outflows                      | per-service splits beyond the edge, CHECK rows, validation                                                                        |
| Providers & Clinicians  | TRIM (hard)   | revenue; labor/non-labor/margin outflows                           | employed-vs-independent-vs-PE sub-nodes, dental/other-prof decomposition, ~6 CHECK rows, hospital↔physician cross-ref, validation |
| **Healthcare Workers**  | **CUT**       | "labor in = $2,331B" (it's a sink)                                 | by-worker-type lens, headcounts, wages, BLS comparisons, "key insights" prose, dual-billing bridge — **the whole 95 rows**        |
| **Suppliers & Vendors** | **CUT**       | "non-labor in = $1,239B" (it's a sink)                             | by-category "what the money buys", terminal reconciliation, validation                                                            |
| **Glossary**            | **CUT**       | —                                                                  | acronyms, terms, source directory, node map → move to a markdown reference doc                                                    |
| Overview                | REGEN         | node summary + flow map are 100% derived from the graph            | "assumptions & limitations" prose → keep as doc                                                                                   |

¹ HI needs sub-node grouping (public MA/MCO vs private/commercial) in the renderer.
² FedGov needs sub-grouped inflow/outflow sections.
³ Federal/State direct delivery + public health + admin are real flows to nodes the
graph doesn't have. Either add terminal nodes (VA/DoD/IHS, Public Health) or accept
them as documented leakage. Decision needed.

## Consolidated actions

**Add to the graph (missing flow) — highest leverage:**

- A **Capital / Shareholders** sink node (layer 4) + margin edges from Hospitals,
  Pharma, Providers, LTC, and Insurers into it, and its distribution outflows.
  Closes the positive provider imbalances and turns Capital Markets into a
  generated node-ledger.
- (Optional) terminal nodes for Federal/State direct delivery, public health, and
  administration — or document them as out-of-model leakage.
- Revisit the `hi_*_claims` estimates that drive the negative provider imbalances.

**Cut or move to a clearly-labeled appendix (not flow):**

- Healthcare Workers & Suppliers: collapse each to a sink ledger; the occupational
  / by-category detail becomes an optional appendix or is dropped.
- Glossary → a markdown reference doc, not a sheet.
- Every per-sheet **VALIDATION** table → one consolidated methodology/validation
  appendix (it's QA, not flow).
- Every **CHECK: revenue − expenses ≈ 0** row → redundant with `check.ts`'s own
  conservation check once the graph is complete.
- Prose "insights" blocks → narrative docs.

**Generate from the graph (flow) — after the cuts:**

- Individuals, Employers (source-only ledgers — needs an outflow-only renderer mode)
- Health Insurance (needs sub-node grouping), Federal Gov (sub-grouped sections)
- Capital Markets (once it's a graph node)
- Hospitals / Pharma / LTC / Providers reduced to the revenue + labor/non-labor/margin
  skeleton; payer-mix kept as finer "national-lens" context (the `split` mechanism)
- Overview (fully derived)

**Finer-grained flow (payer-mix %, FFS sub-splits):** real flow, just below the
graph's grain. Keep as editorial `split` rows in the generated sheets, or promote to
graph edges/nodes — a per-sheet call, not a blanket one.

## Recommended sequence

1. **Complete the model**: add the Capital node + margin edges; re-run `check` and
   confirm the provider imbalances shrink. This is the core flow-of-funds work.
2. **Cut the clear non-flow**: Healthcare Workers / Suppliers down to sink ledgers,
   Glossary → doc, validation/CHECK rows → appendix. Big size reduction, zero model loss.
3. **Generate the remaining flow sheets** (Individuals, Employers, HI, Federal Gov,
   Capital Markets) using the renderer, adding the two modes they need (outflow-only,
   sub-node grouping).
4. **Decide the leakage**: model Federal/State direct delivery & public health as
   nodes, or document them as out-of-model.

## What this is _not_ recommending

Deleting the _analysis_. The workforce breakdown, payer mixes, and validation work
are genuinely useful — they're just not the _flow model_. The recommendation is to
stop interleaving them with the model (where they cause drift and resist generation)
and give them an honest home as an appendix or companion docs.
