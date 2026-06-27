import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGraph, validateGraph } from '../src/graph.ts';
import { renderNodeLedger, loadOverlays } from '../src/ledger.ts';
import { buildWorkbook } from '../src/xlsx.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = loadGraph(root);
const medicareOverlay = loadOverlays(root).get('medicare');
const texts = (nodeId: string): string[] =>
  renderNodeLedger(file, nodeId)
    .sheet.cells.filter((c) => typeof c.v === 'string')
    .map((c) => c.v as string);

test('every node renders a ledger without throwing', () => {
  for (const n of file.graph.nodes) {
    const { sheet } = renderNodeLedger(file, n.id);
    assert.equal(sheet.name, n.label);
    assert.ok(sheet.cells.length > 0, `${n.id} produced no cells`);
  }
});

test('a source node is outflow-only (no INFLOWS, no NET)', () => {
  const t = texts('individuals');
  assert.ok(t.includes('OUTFLOWS (Spending)'), 'expected an OUTFLOWS section');
  assert.ok(!t.includes('INFLOWS (Funding Sources)'), 'source node should have no INFLOWS');
  assert.ok(!t.includes('NET FLOW'), 'source node should have no NET row');
});

test('a sink node is inflow-only (no OUTFLOWS, no NET)', () => {
  const t = texts('capital_markets');
  assert.ok(t.includes('INFLOWS (Funding Sources)'), 'expected an INFLOWS section');
  assert.ok(!t.includes('OUTFLOWS (Spending)'), 'sink node should have no OUTFLOWS');
  assert.ok(!t.includes('NET FLOW'), 'sink node should have no NET row');
});

test('an intermediary has both sections, a NET row, and surfaces other sources neutrally', () => {
  const t = texts('medicaid');
  assert.ok(t.includes('INFLOWS (Funding Sources)'));
  assert.ok(t.includes('OUTFLOWS (Spending)'));
  assert.ok(t.includes('NET FLOW'));
  // FMAP carries a second source — shown as neutral context, not a flag
  assert.ok(
    t.some((s) => s.includes('also reported') && s.includes('619.9')),
    'expected the second source surfaced as "also reported"',
  );
});

test('ledger formulas: % of total, TOTAL sum, and NET reference real rows', () => {
  const { sheet } = renderNodeLedger(file, 'medicaid');
  const formulas = sheet.cells.filter((c) => c.f).map((c) => c.f as string);
  assert.ok(
    formulas.some((f) => /^=SUM\(B\d+:B\d+\)$/.test(f)),
    'expected a TOTAL SUM formula',
  );
  assert.ok(
    formulas.some((f) => /^=B\d+\/B\d+$/.test(f)),
    'expected a % of total formula',
  );
  assert.ok(
    formulas.some((f) => /^=B\d+-B\d+$/.test(f)),
    'expected a NET = inflows - outflows formula',
  );
});

test('renderNodeLedger reports inflow/outflow row locations for each edge', () => {
  const { flows } = renderNodeLedger(file, 'medicaid');
  assert.ok(flows.some((f) => f.edge === 'fed_medicaid_fmap' && f.role === 'in'));
  assert.ok(flows.some((f) => f.edge === 'medicaid_hi_mco' && f.role === 'out'));
});

test('the Medicare overlay adds extras, curated labels, and a VALIDATION section', () => {
  assert.ok(medicareOverlay, 'data/sheets/medicare.json missing');
  const { sheet } = renderNodeLedger(file, 'medicare', medicareOverlay);
  const t = sheet.cells.filter((c) => typeof c.v === 'string').map((c) => c.v as string);
  assert.ok(t.includes('VALIDATION (Independent Sources)'), 'expected a VALIDATION section');
  assert.ok(t.includes('Administration & program integrity'), 'expected the admin extra row');
  assert.ok(t.includes('Medicare Advantage (Part C) capitation'), 'expected the curated MA label');
  // the single-edge independent figure (MA net $454B) lives as the edge's second
  // observation and surfaces in the flow note as neutral "also reported" context
  assert.ok(
    t.some((s) => s.includes('also reported') && s.includes('454')),
    'MA $454B observation should surface in the MA row note',
  );
});

test('overlay check formulas resolve to real rows (edge + extras, totals, ratios)', () => {
  const { sheet } = renderNodeLedger(file, 'medicare', medicareOverlay);
  const formulas = sheet.cells.filter((c) => c.f).map((c) => c.f as string);
  // Part B = physician FFS edge + DME extra + admin extra
  assert.ok(
    formulas.some((f) => /^=B\d+\+B\d+\+B\d+$/.test(f)),
    'expected the Part B = a+b+c composite check',
  );
  // personal HC = total outflows - admin
  assert.ok(formulas.some((f) => /^=B\d+-B\d+$/.test(f)));
  // % of NHE = (total inflows)/4867
  assert.ok(formulas.some((f) => /\/4867$/.test(f)));
});

test('Medicaid overlay: extras + composite checks; single-edge figures stay observations', () => {
  const ov = loadOverlays(root).get('medicaid');
  assert.ok(ov, 'data/sheets/medicaid.json missing');
  const { sheet } = renderNodeLedger(file, 'medicaid', ov);
  const t = sheet.cells.filter((c) => typeof c.v === 'string').map((c) => c.v as string);
  assert.ok(t.includes('VALIDATION (Independent Sources)'));
  assert.ok(t.includes('Administration (state + federal)'), 'expected the admin extra');
  // the fed-share second source ($619.9 MACStats) surfaces inline as neutral context
  assert.ok(
    t.some((s) => s.includes('also reported') && s.includes('619.9')),
    'expected the FMAP second source inline',
  );
  // only Total + %NHE are hand-authored; federal/state/MCO are edge observations now
  assert.equal(ov!.checks?.length, 2, 'Medicaid should carry exactly 2 composite checks');
});

test('Health Insurance overlay: other-employer extra + PHI composite check (5 refs)', () => {
  const ov = loadOverlays(root).get('health_insurance');
  assert.ok(ov, 'data/sheets/health_insurance.json missing');
  const { sheet } = renderNodeLedger(file, 'health_insurance', ov);
  const t = sheet.cells.filter((c) => typeof c.v === 'string').map((c) => c.v as string);
  assert.ok(
    t.some((s) => s.includes('Other employer health spending')),
    'expected the other-employer extra inflow',
  );
  // inflows now group Commercial vs Public managed care
  assert.ok(t.includes('Commercial / private'), 'expected a Commercial sub-header');
  assert.ok(t.includes('Public managed care'), 'expected a Public managed care sub-header');
  // outflows group Claims vs Operating (the medical-loss-ratio view), with the tax
  // edge re-bucketed into Operating on this sheet (overlay category override)
  assert.ok(t.includes('Claims paid (medical)'), 'expected a Claims sub-header');
  assert.ok(t.includes('Operating, margin & tax'), 'expected an Operating sub-header');
  assert.ok(
    t.some((s) => s.includes('also reported') && s.includes('454')),
    'MA $454B observation should surface',
  );
  const formulas = sheet.cells.filter((c) => c.f).map((c) => c.f as string);
  // PHI total = 4 commercial edges + 1 extra = five B-refs summed
  assert.ok(
    formulas.some((f) => /^=B\d+\+B\d+\+B\d+\+B\d+\+B\d+$/.test(f)),
    'expected the 5-ref PHI composite check',
  );
});

test('Hospitals overlay: cost-structure labels + national-total and labor-share checks', () => {
  const ov = loadOverlays(root).get('hospitals');
  assert.ok(ov, 'data/sheets/hospitals.json missing');
  const { sheet } = renderNodeLedger(file, 'hospitals', ov);
  const t = sheet.cells.filter((c) => typeof c.v === 'string').map((c) => c.v as string);
  assert.ok(t.includes('VALIDATION (Independent Sources)'));
  assert.ok(
    t.some((s) => s.startsWith('Labor — wages, benefits')),
    'expected the curated labor outflow label',
  );
  const formulas = sheet.cells.filter((c) => c.f).map((c) => c.f as string);
  // labor share = labor edge / NHE national total
  assert.ok(
    formulas.some((f) => /^=\(B\d+\)\/1501$/.test(f)),
    'expected the labor-share ÷ 1501 check',
  );
  // these are pure overlays — no extra rows, no graph change
  assert.ok(!ov!.extraInflows && !ov!.extraOutflows, 'hospitals should carry no extras');
});

test('Pharma overlay: net-of-rebates subtitle + margin check; no extras', () => {
  const ov = loadOverlays(root).get('pharma_rx');
  assert.ok(ov, 'data/sheets/pharma_rx.json missing');
  assert.ok(/NET of rebates/i.test(ov!.subtitle ?? ''), 'expected the rebate-basis subtitle');
  const { sheet } = renderNodeLedger(file, 'pharma_rx', ov);
  const formulas = sheet.cells.filter((c) => c.f).map((c) => c.f as string);
  // pre-tax profit margin = (net profit + corporate tax) / net retail Rx 433
  assert.ok(
    formulas.some((f) => /^=\(B\d+\+B\d+\)\/433$/.test(f)),
    'expected the pre-tax margin ÷ 433 check',
  );
  assert.ok(!ov!.extraInflows && !ov!.extraOutflows, 'pharma should carry no extras');
});

test('edge splits render as indented sub-rows that sum to the parent, not the section', () => {
  const ov = loadOverlays(root).get('pharma_rx');
  const { sheet, flows } = renderNodeLedger(file, 'pharma_rx', ov);
  const t = sheet.cells.filter((c) => typeof c.v === 'string').map((c) => c.v as string);
  // the pharma cost line items render as child rows
  assert.ok(
    t.some((s) => s.includes('R&D — scientists')),
    'expected the R&D split line',
  );
  assert.ok(
    t.some((s) => s.includes('COGS — raw materials')),
    'expected the COGS split line',
  );
  const formulas = sheet.cells.filter((c) => c.f).map((c) => c.f as string);
  // OUTFLOWS total sums ONLY the parent rows (not the child sub-rows) — an explicit
  // B+B+… over every outflow edge (labor, non-labor, margin, corporate tax)
  assert.ok(
    formulas.some((f) => /^=B\d+(\+B\d+)+$/.test(f)),
    'expected TOTAL OUTFLOWS to sum the parent rows explicitly',
  );
  // a child row shows % of its PARENT (B<child>/B<parent>), and the parent is a flow row
  const parentRow = flows.find((f) => f.edge === 'pharma_workers_labor')!.row;
  assert.ok(
    formulas.some((f) => new RegExp(`^=B\\d+/B${parentRow}$`).test(f)),
    'expected a child % referencing its parent labor row',
  );
});

test('validateGraph rejects a split that does not sum to the canonical value', () => {
  const bad = JSON.parse(JSON.stringify(file)) as typeof file;
  const edge = bad.graph.edges.find((e) => e.id === 'pharma_capital_margin')!;
  edge.split = [
    { label: 'Net profit', value: 50 },
    { label: 'Other', value: 5 }, // 50 + 5 = 55 ≠ canonical 58
  ];
  const problems = validateGraph(bad);
  assert.ok(
    problems.some((p) => p.includes('pharma_capital_margin') && p.includes('split sums to')),
    'expected a split-sum mismatch problem',
  );
});

test('a section with 2+ edge categories renders grouped sub-headers + subtotals', () => {
  // The grouping path needs a node whose edges carry 2+ intrinsic categories. Corporate
  // income tax now terminates at the single-category Taxes sink, so we exercise the path on
  // a clone: split Federal Government's General-revenue inflows into two categories.
  const clone = JSON.parse(JSON.stringify(file)) as typeof file;
  const transfers = new Set([
    'ind_fed_medicare_genrev',
    'ind_fed_medicaid_genrev',
    'ind_fed_aca_genrev',
  ]);
  for (const e of clone.graph.edges)
    if (e.to === 'federal_government' && e.category === 'General revenue')
      e.category = transfers.has(e.id) ? 'Program transfers' : 'Direct federal health';

  const { sheet } = renderNodeLedger(clone, 'federal_government');
  const t = sheet.cells.filter((c) => typeof c.v === 'string').map((c) => c.v as string);
  assert.ok(t.includes('Program transfers'), 'expected a Program transfers sub-header');
  assert.ok(t.includes('Direct federal health'), 'expected a Direct federal health sub-header');
  assert.ok(t.includes('Subtotal — Program transfers'), 'expected the transfers subtotal');
  assert.ok(t.includes('Subtotal — Direct federal health'), 'expected the direct subtotal');
  assert.ok(!t.includes('Subtotal — Other'), 'every inflow is categorised — no Other bucket');

  const formulas = sheet.cells.filter((c) => c.f).map((c) => c.f as string);
  // the 3-edge bucket subtotal sums its three member rows...
  assert.ok(
    formulas.some((f) => /^=B\d+\+B\d+\+B\d+$/.test(f)),
    'expected a 3-row subtotal sum',
  );
  // ...the 2-edge bucket subtotal sums its two member rows...
  assert.ok(
    formulas.some((f) => /^=B\d+\+B\d+$/.test(f)),
    'expected a 2-row subtotal sum',
  );
  // ...and TOTAL INFLOWS sums the two subtotals, not the leaf rows.
  assert.ok(
    formulas.some((f) => /^=B\d+\+B\d+$/.test(f)),
    'expected TOTAL to sum the subtotals',
  );
});

test('Individuals overlay groups outflows into taxes / premiums / out-of-pocket', () => {
  const ov = loadOverlays(root).get('individuals');
  assert.ok(ov, 'data/sheets/individuals.json missing');
  const { sheet } = renderNodeLedger(file, 'individuals', ov);
  const t = sheet.cells.filter((c) => typeof c.v === 'string').map((c) => c.v as string);
  for (const g of ['Taxes & payroll', 'Insurance premiums', 'Out-of-pocket'])
    assert.ok(t.includes(g), `expected the "${g}" group`);
  for (const g of ['Taxes & payroll', 'Insurance premiums', 'Out-of-pocket'])
    assert.ok(t.includes(`Subtotal — ${g}`), `expected the "${g}" subtotal`);
});

test('Medicare inflows group into payroll (Part A) vs premiums & general revenue', () => {
  const ov = loadOverlays(root).get('medicare');
  const { sheet } = renderNodeLedger(file, 'medicare', ov);
  const t = sheet.cells.filter((c) => typeof c.v === 'string').map((c) => c.v as string);
  assert.ok(t.includes('Payroll taxes (HI trust fund)'), 'expected the payroll group');
  assert.ok(t.includes('Premiums & general revenue'), 'expected the premiums/genrev group');
  // outflows stay flat (no categories there) — no subtotal under an outflow label
  assert.ok(!t.includes('Subtotal — Fee-for-service'), 'medicare outflows stay flat');
});

test('a section with one (or no) category stays flat — no grouping', () => {
  // Medicaid inflows are all uncategorised, so the section renders flat (no subtotals).
  const ov = loadOverlays(root).get('medicaid');
  const { sheet } = renderNodeLedger(file, 'medicaid', ov);
  const t = sheet.cells.filter((c) => typeof c.v === 'string').map((c) => c.v as string);
  assert.ok(!t.some((s) => s.startsWith('Subtotal —')), 'flat section should have no subtotals');
});

test('overlay notes render as a NOTES callout section', () => {
  const ov = loadOverlays(root).get('hospitals');
  assert.ok(ov?.notes?.length, 'hospitals overlay should carry notes');
  const { sheet } = renderNodeLedger(file, 'hospitals', ov);
  const t = sheet.cells.filter((c) => typeof c.v === 'string').map((c) => c.v as string);
  assert.ok(t.includes('NOTES'), 'expected a NOTES section header');
  assert.ok(
    t.some((s) => s.startsWith('Dual-billing')),
    'expected the dual-billing note text',
  );
});

test('node descriptions surface on the ledger subtitle and child headers', () => {
  // a node without a curated overlay subtitle gets its description appended
  const emp = renderNodeLedger(file, 'employers');
  const sub = emp.sheet.cells.find((c) => c.r === 2 && c.c === 1);
  assert.ok(
    typeof sub?.v === 'string' && sub.v.includes('employer-sponsored insurance'),
    'employers subtitle should carry its description',
  );
  // a parent node surfaces each child's description in its ▸ header band
  const prov = renderNodeLedger(file, 'providers_clinicians');
  const t = prov.sheet.cells.filter((c) => typeof c.v === 'string').map((c) => c.v as string);
  assert.ok(
    t.some((s) => s.startsWith('▸ Physician & Clinical') && s.includes('1.1M active physicians')),
    'physician child header should carry its description',
  );
});

test('a parent node renders each child as a nested block + a combined roll-up', () => {
  const { sheet, flows } = renderNodeLedger(file, 'long_term_care');
  const t = sheet.cells.filter((c) => typeof c.v === 'string').map((c) => c.v as string);
  // one child header band per sub-entity
  assert.ok(
    t.some((s) => s.includes('Nursing Facilities')),
    'expected a Nursing Facilities block',
  );
  assert.ok(
    t.some((s) => s.includes('Home Health & Hospice')),
    'expected a Home Health block',
  );
  // a combined roll-up that sums the two children's section totals
  assert.ok(t.includes('Combined inflows'), 'expected Combined inflows');
  assert.ok(t.includes('Combined outflows'), 'expected Combined outflows');
  const formulas = sheet.cells.filter((c) => c.f).map((c) => c.f as string);
  assert.ok(
    formulas.some((f) => /^=B\d+\+B\d+$/.test(f)),
    'expected the combined total to sum two child section totals',
  );
  // the child edges (not the parent) carry the flows for hyperlinking
  assert.ok(
    flows.some((f) => f.edge === 'medicare_ltc_nursing_snf'),
    'child edges should be recorded for hyperlinks',
  );
  // the parent itself has no direct edges
  assert.equal(
    file.graph.edges.filter((e) => e.from === 'long_term_care' || e.to === 'long_term_care').length,
    0,
    'parent should carry no direct edges',
  );
});

test('flow amounts are cross-linked to their counterpart end via HYPERLINK', () => {
  const wb = buildWorkbook(file, root);
  // Individuals' 437 outflow (ind_fed_medicare_genrev) links to the Federal Government inflow.
  const ind = wb.getWorksheet('Individuals');
  assert.ok(ind, 'Individuals sheet missing');
  let outLink = '';
  ind!.eachRow((row) =>
    row.eachCell((cell) => {
      const f = cell.formula;
      if (f && f.includes('HYPERLINK') && f.includes('Federal Government')) outLink = f;
    }),
  );
  assert.ok(outLink, 'expected an Individuals amount linking to Federal Government');

  // and the link is bidirectional: the Federal Government inflow links back to Individuals.
  const fed = wb.getWorksheet('Federal Government');
  let backLink = '';
  fed!.eachRow((row) =>
    row.eachCell((cell) => {
      const f = cell.formula;
      if (f && f.includes('HYPERLINK') && f.includes('Individuals')) backLink = f;
    }),
  );
  assert.ok(backLink, 'expected a Federal Government inflow linking back to Individuals');
});

test('the workbook leads with Overview and ends with Glossary', () => {
  const wb = buildWorkbook(file, root);
  const names = wb.worksheets.map((w) => w.name);
  assert.equal(names[0], 'Overview', 'Overview should be the first tab');
  assert.equal(names[names.length - 1], 'Glossary', 'Glossary should be the last tab');

  // Overview: a node-summary row links to a node sheet, and the multi-source snapshot
  // lists the FMAP edge (which carries a second source).
  const ov = wb.getWorksheet('Overview')!;
  let nodeLink = '';
  let fmapRow = '';
  ov.eachRow((row) =>
    row.eachCell((cell) => {
      const f =
        typeof cell.value === 'object' && cell.value
          ? (cell.value as { formula?: string }).formula
          : '';
      if (f && f.includes('HYPERLINK') && f.includes('Medicare')) nodeLink = f;
      if (typeof cell.value === 'string' && cell.value.includes('fed_medicaid_fmap'))
        fmapRow = cell.value;
    }),
  );
  assert.ok(nodeLink, 'Overview node summary should link to a node sheet');
  assert.ok(fmapRow, 'Overview should list the multi-source FMAP edge');

  // Glossary: acronyms (hand-authored) + data sources (generated from sources{}).
  const gl = wb.getWorksheet('Glossary')!;
  const cells: string[] = [];
  gl.eachRow((row) =>
    row.eachCell((cell) => typeof cell.value === 'string' && cells.push(cell.value)),
  );
  assert.ok(cells.includes('ACRONYMS & ABBREVIATIONS'), 'expected the acronyms section');
  assert.ok(
    cells.includes('DATA SOURCES (sources{} in graph.json)'),
    'expected the sources section',
  );
  assert.ok(
    cells.some((c) => c.startsWith('National Health Expenditures')),
    'expected a generated source citation',
  );
});
