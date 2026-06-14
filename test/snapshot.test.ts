import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGraph, computeFlows } from '../src/graph.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const expectedPath = join(root, 'test', 'expected.json');

test('node throughputs & total match the committed snapshot', () => {
  assert.ok(existsSync(expectedPath), 'test/expected.json missing — run: npm run test:update');
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as {
    total: number;
    throughput: Record<string, number>;
  };
  const { graph } = loadGraph(root);
  const { throughput } = computeFlows(graph.nodes, graph.edges);
  const total = graph.edges.reduce((s, e) => s + e.amount, 0);
  assert.ok(
    Math.abs(total - expected.total) < 1e-6,
    `total drifted: ${total} vs ${expected.total}`,
  );
  for (const id of Object.keys(expected.throughput)) {
    assert.ok(id in throughput, `node "${id}" disappeared from the graph`);
    assert.ok(
      Math.abs(throughput[id] - expected.throughput[id]) < 1e-6,
      `throughput drifted for "${id}": ${throughput[id]} vs ${expected.throughput[id]} (run npm run test:update if intended)`,
    );
  }
  for (const id of Object.keys(throughput))
    assert.ok(
      id in expected.throughput,
      `new node "${id}" not in snapshot — run npm run test:update`,
    );
});
