import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  loadGraphV2,
  validateGraphV2,
  canonicalAmount,
  canonicalObservation,
  computeFlowsV2,
  leafNodeIds,
  type GraphFileV2,
} from '../data_v2/graph.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = loadGraphV2(root);
const edge = (id: string) => file.graph.edges.find((e) => e.id === id)!;

test('the committed v2 graph passes all v2 structural + observation invariants', () => {
  assert.deepStrictEqual(validateGraphV2(file), []);
});

test('canonical observation is the flagged one, not just the first', () => {
  // medicare_hi_ma lists gross capitation (canonical) and net-of-premiums
  assert.equal(canonicalObservation(edge('medicare_hi_ma')).value, 539);
  assert.equal(canonicalAmount(edge('medicare_hi_ma')), 539);
  // single-observation edges are canonical implicitly
  assert.equal(canonicalAmount(edge('emp_hi_esi')), 830);
});

test('computeFlowsV2 conserves the grand total (sum inflows == sum outflows == all edges)', () => {
  const { inflow, outflow } = computeFlowsV2(file);
  // Sum LEAF nodes only — parents are aggregates and would double-count their children.
  const leaves = leafNodeIds(file);
  const sum = (m: Record<string, number>): number =>
    [...leaves].reduce((s, id) => s + (m[id] ?? 0), 0);
  const totalIn = sum(inflow);
  const totalOut = sum(outflow);
  // every edge lands in exactly one inflow and one outflow, so the two sides match...
  assert.ok(Math.abs(totalIn - totalOut) < 1e-6, `in ${totalIn} != out ${totalOut}`);
  // ...and the grand total is unchanged — splitting a node into sub-nodes (or routing tax
  // out of margin into a feedback edge) moves value between edges but conserves the whole.
  assert.ok(Math.abs(totalOut - 12331.9337) < 1e-6, `got ${totalOut}`);
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

  // single-observation edges are canonical implicitly
  assert.equal(edge('emp_hi_esi').observations.length, 1);
  assert.equal(canonicalAmount(edge('emp_hi_esi')), 830);
});

test('corporate-tax feedback edges flow to Government and validate (no DAG constraint)', () => {
  const taxEdges = file.graph.edges.filter((e) => e.channel === 'Corporate income tax');
  // every taxable provider/insurer node routes tax back to Federal Government (Long-Term
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
  assert.ok(taxEdges.every((e) => e.to === 'federal_government'));
  // ...these are backward (layer 3/2 -> 1) feedback edges that v1 would have rejected
  // as "backward flow"/"cycle"; v2 accepts them.
  assert.deepStrictEqual(validateGraphV2(file), []);
  // and Government's inflow now includes the corporate tax it collects
  const { inflow } = computeFlowsV2(file);
  const taxTotal = taxEdges.reduce((s, e) => s + canonicalAmount(e), 0);
  assert.equal(taxTotal, 39.5);
  assert.ok(inflow['federal_government'] >= taxTotal);
});

test('validateGraphV2 catches a multi-observation edge with no canonical flag', () => {
  const broken: GraphFileV2 = {
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
  const problems = validateGraphV2(broken);
  assert.ok(
    problems.some((p) => p.includes('broken') && p.includes('canonical')),
    `expected a canonical-count problem, got: ${problems.join(' | ')}`,
  );
});

test('validateGraphV2 catches an unknown observation source and bad basis', () => {
  const broken: GraphFileV2 = {
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
  const problems = validateGraphV2(broken);
  assert.ok(problems.some((p) => p.includes('not_a_source')));
  assert.ok(problems.some((p) => p.includes('invalid basis')));
});
