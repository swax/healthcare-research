// Quick "do the numbers add up?" readout. Run: npm run check
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGraph, computeFlows, validateGraph } from './graph.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = loadGraph(root);
const { graph } = file;
const problems = validateGraph(file);
const { inflow, outflow } = computeFlows(graph.nodes, graph.edges);

const fmt = (n: number): string =>
  (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString() + 'B';
const pad = (s: string, w: number): string => (s.length >= w ? s : s + ' '.repeat(w - s.length));

console.log('\nNode reconciliation (sorted by layer):\n');
console.log(pad('Node', 26) + pad('In', 11) + pad('Out', 11) + pad('Net', 11) + 'Note');
console.log('-'.repeat(70));
const sorted = [...graph.nodes].sort((a, b) => a.layer - b.layer || a.label.localeCompare(b.label));
for (const n of sorted) {
  const i = inflow[n.id] ?? 0,
    o = outflow[n.id] ?? 0,
    net = i - o;
  let note: string;
  if (n.role === 'source') note = 'source (out only)';
  else if (n.role === 'sink') note = 'sink (in only)';
  else if (Math.abs(net) > 1) note = `⚠ imbalance ${fmt(net)} — check`;
  else note = 'balanced';
  console.log(pad(n.label, 26) + pad(fmt(i), 11) + pad(fmt(o), 11) + pad(fmt(net), 11) + note);
}
const total = graph.edges.reduce((s, e) => s + e.amount, 0);
console.log('-'.repeat(70));
console.log(`${graph.nodes.length} nodes, ${graph.edges.length} edges, total flow ${fmt(total)}\n`);
if (problems.length) {
  console.error('VALIDATION ERRORS:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('✓ all structural & invariant checks passed');
