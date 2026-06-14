import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGraph, validateGraph, findCycles, computeFlows } from '../src/graph.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { graph } = loadGraph(root);

test('graph passes all structural & invariant validations', () => {
  const problems = validateGraph(graph);
  assert.deepEqual(problems, [], 'validateGraph found problems:\n' + problems.join('\n'));
});

test('node ids are unique', () => {
  const ids = graph.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every edge endpoint references a real node (no dangling refs)', () => {
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const e of graph.edges) {
    assert.ok(ids.has(e.from), `unknown source: ${e.from}`);
    assert.ok(ids.has(e.to), `unknown target: ${e.to}`);
  }
});

test('all amounts are positive finite numbers', () => {
  for (const e of graph.edges) assert.ok(e.amount > 0 && isFinite(e.amount), `${e.from}->${e.to}: ${e.amount}`);
});

test('flows never go backward across layers (keeps it a DAG)', () => {
  const layer: Record<string, number> = {};
  for (const n of graph.nodes) layer[n.id] = n.layer;
  for (const e of graph.edges) assert.ok(layer[e.to] >= layer[e.from], `backward: ${e.from}(${layer[e.from]})->${e.to}(${layer[e.to]})`);
});

test('graph is acyclic', () => {
  assert.deepEqual(findCycles(graph.nodes, graph.edges), []);
});

test('declared sources have no inflow, sinks no outflow', () => {
  const { inflow, outflow } = computeFlows(graph.nodes, graph.edges);
  for (const n of graph.nodes) {
    if (n.role === 'source') assert.equal(inflow[n.id], 0, `${n.id} should have no inflow`);
    if (n.role === 'sink') assert.equal(outflow[n.id], 0, `${n.id} should have no outflow`);
  }
});
