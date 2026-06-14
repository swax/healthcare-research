// Regenerate the throughput snapshot after an intentional data change. Run: npm run test:update
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGraph, computeFlows } from '../src/graph.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { graph } = loadGraph(root);
const { throughput } = computeFlows(graph.nodes, graph.edges);
const total = graph.edges.reduce((s, e) => s + e.amount, 0);
const out = { total, throughput };
writeFileSync(join(root, 'test', 'expected.json'), JSON.stringify(out, null, 2) + '\n');
console.log(
  'updated test/expected.json (total $' +
    Math.round(total) +
    'B, ' +
    Object.keys(throughput).length +
    ' nodes)',
);
