import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  loadGraph,
  validateGraph,
  canonicalAmount,
  canonicalObservation,
  computeFlows,
  leafNodeIds,
  type GraphFile,
} from '../src/graph.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = loadGraph(root);
const edge = (id: string) => file.graph.edges.find((e) => e.id === id)!;

test('the committed graph passes all structural + observation invariants', () => {
  assert.deepStrictEqual(validateGraph(file), []);
});

test('canonical observation is the flagged one, not just the first', () => {
  // medicare_hi_ma lists gross capitation (canonical) and net-of-premiums
  assert.equal(canonicalObservation(edge('medicare_hi_ma')).value, 539);
  assert.equal(canonicalAmount(edge('medicare_hi_ma')), 539);
  // single-observation edges are canonical implicitly
  assert.equal(canonicalAmount(edge('emp_hi_esi')), 830);
});

test('computeFlows conserves the grand total (sum inflows == sum outflows == all edges)', () => {
  const { inflow, outflow } = computeFlows(file);
  // Sum LEAF nodes only — parents are aggregates and would double-count their children.
  const leaves = leafNodeIds(file);
  const sum = (m: Record<string, number>): number =>
    [...leaves].reduce((s, id) => s + (m[id] ?? 0), 0);
  const totalIn = sum(inflow);
  const totalOut = sum(outflow);
  // every edge lands in exactly one inflow and one outflow, so the two sides match...
  assert.ok(Math.abs(totalIn - totalOut) < 1e-6, `in ${totalIn} != out ${totalOut}`);
  // ...and the grand total matches the pinned golden value. Transformations that only MOVE
  // value (splitting a node into sub-nodes, routing tax out of margin into the Taxes sink)
  // leave this unchanged; adding genuinely new traced flow raises it — e.g. the Other Payers
  // source (+$603B closing Hospitals / Physician / Other-Professional to their NHE totals).
  assert.ok(Math.abs(totalOut - 13871.9337) < 1e-6, `got ${totalOut}`);
});

test('multi-source edges keep every source; canonical is the value used (no flagging)', () => {
  // Differing sources are recorded as observations and reconciled by picking a canonical
  // value — there is no spread/discrepancy engine. (Big-picture flow model.)
  const fmap = edge('fed_medicaid_fmap');
  assert.equal(fmap.observations.length, 2, 'FMAP keeps both sources');
  assert.equal(canonicalAmount(fmap), 614, 'and uses the CMS-64 value');
  // the other source is still on the edge for context, just not the canonical one
  assert.ok(
    fmap.observations.some((o) => o.value === 619.9 && !o.canonical),
    'MACStats 619.9 is retained as a non-canonical observation',
  );

  // a concurring second source is also fine: two sources, same value, one canonical
  const esi = edge('emp_hi_esi');
  assert.equal(esi.observations.length, 2, 'ESI carries KFF + CMS NHE');
  assert.equal(canonicalAmount(esi), 830);
  assert.ok(
    esi.observations.some((o) => o.source === 'cms_nhe' && !o.canonical),
    'CMS NHE is retained as a concurring non-canonical source',
  );

  // single-observation edges are canonical implicitly
  assert.equal(edge('emp_medicare_payroll_er').observations.length, 1);
  assert.equal(canonicalAmount(edge('emp_medicare_payroll_er')), 163);
});

test('corporate income tax flows to the terminal Taxes sink and validates', () => {
  const taxEdges = file.graph.edges.filter((e) => e.channel === 'Corporate income tax');
  // every taxable provider/insurer node routes tax to the terminal Taxes factor (Long-Term
  // Care now does so through its nursing / home-health sub-nodes)...
  const froms = taxEdges.map((e) => e.from).sort();
  assert.deepStrictEqual(froms, [
    'health_insurance',
    'hospitals',
    'ltc_homehealth',
    'ltc_nursing',
    'pharma_rx',
    'providers_dental',
    'providers_other',
    'providers_physician',
  ]);
  assert.ok(taxEdges.every((e) => e.to === 'taxes'));
  assert.deepStrictEqual(validateGraph(file), []);
  // Taxes is a pure sink: its inflow equals the corporate tax, and it has no outflow.
  const { inflow, outflow } = computeFlows(file);
  const taxTotal = taxEdges.reduce((s, e) => s + canonicalAmount(e), 0);
  assert.equal(taxTotal, 39.5);
  assert.equal(inflow['taxes'], taxTotal);
  assert.equal(outflow['taxes'] ?? 0, 0);
});

test('validateGraph catches a multi-observation edge with no canonical flag', () => {
  const broken: GraphFile = {
    ...file,
    graph: {
      nodes: file.graph.nodes,
      edges: [
        {
          id: 'broken',
          from: 'medicare',
          to: 'hospitals',
          channel: 'test',
          observations: [
            { value: 10, source: 'cms_nhe', basis: 'modeled' },
            { value: 12, source: 'macpac', basis: 'modeled' },
          ],
        },
      ],
    },
  };
  const problems = validateGraph(broken);
  assert.ok(
    problems.some((p) => p.includes('broken') && p.includes('canonical')),
    `expected a canonical-count problem, got: ${problems.join(' | ')}`,
  );
});

test('validateGraph catches an unknown observation source and bad basis', () => {
  const broken: GraphFile = {
    ...file,
    graph: {
      nodes: file.graph.nodes,
      edges: [
        {
          id: 'badobs',
          from: 'medicare',
          to: 'hospitals',
          channel: 'test',
          observations: [{ value: 10, source: 'not_a_source', basis: 'guess' as 'modeled' }],
        },
      ],
    },
  };
  const problems = validateGraph(broken);
  assert.ok(problems.some((p) => p.includes('not_a_source')));
  assert.ok(problems.some((p) => p.includes('invalid basis')));
});
