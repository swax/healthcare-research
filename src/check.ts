// Quick "do the numbers add up?" readout. Run: npm run check
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGraph, computeFlows, validateGraph } from './graph.ts';
import { loadWorkbook, reconcileWorkbook } from './reconcile.ts';

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
  // This is a traced-flow model of major channels, not closed national accounting,
  // so intermediary net ≠ $0 is expected, not an error: a positive net is money
  // traced in but not traced onward (admin/overhead/margin beyond the modeled
  // edges); a negative net is an inflow modeled below the node's national revenue
  // (the claims edges are a curated subset). See docs/data-model.md.
  let note: string;
  if (n.role === 'source') note = 'source (out only)';
  else if (n.role === 'sink') note = 'sink (in only)';
  else if (net > 1) note = `+${fmt(net)} not traced onward`;
  else if (net < -1) note = `${fmt(net)} inflow below national`;
  else note = 'balanced';
  console.log(pad(n.label, 26) + pad(fmt(i), 11) + pad(fmt(o), 11) + pad(fmt(net), 11) + note);
}
const total = graph.edges.reduce((s, e) => s + e.amount, 0);
console.log('-'.repeat(70));
console.log(`${graph.nodes.length} nodes, ${graph.edges.length} edges, total flow ${fmt(total)}\n`);
console.log(
  'Traced-flow model of major channels, not closed national accounting — an\n' +
    'intermediary net ≠ $0 is expected, not an error (see docs/data-model.md).\n',
);

// ---- cross-sheet reconciliation (narrative workbook vs the canonical graph) ----
const recon = reconcileWorkbook(file, loadWorkbook(root, file));
const modeledCount = recon.pairs.filter((p) => p.status !== 'context-only').length;
console.log('Cross-sheet reconciliation — modeled flows (program FFS/OOP payments vs graph):\n');
if (!recon.mismatches.length) {
  console.log(
    `✓ all ${modeledCount} modeled provider-payment pairs agree within $${recon.tolerance}B\n`,
  );
} else {
  console.log(
    `⚠ ${recon.mismatches.length} of ${modeledCount} modeled pairs disagree by more than ` +
      `$${recon.tolerance}B:\n`,
  );
  for (const p of recon.mismatches) {
    const parts = [
      `graph ${p.graph === null ? '(no edge)' : fmt(p.graph)}`,
      ...p.modeled.map((s) => `${s.sheet} ${fmt(s.amount)}`),
    ];
    const tag = p.status === 'absent-in-graph' ? ' [missing graph edge]' : '';
    console.log(`  ${p.fromLabel} → ${p.toLabel}  Δ${fmt(p.spread)}${tag}`);
    console.log(`      ${parts.join('  vs  ')}`);
  }
  console.log('');
}

// National-NHE context: all-payer figures (include MA/MCO routed via insurers),
// shown alongside the modeled FFS edge — informational, not a pass/fail.
if (recon.context.length) {
  console.log('National-NHE payer-mix context (all-payer; not expected to equal the FFS edges):\n');
  for (const p of recon.context) {
    const modeled = p.graph === null ? 'no direct edge' : `modeled ${fmt(p.graph)}`;
    const nat = p.national.map((s) => `${fmt(s.amount)} (${s.sheet})`).join(', ');
    console.log(`  ${p.fromLabel} → ${p.toLabel}:  national ${nat}  vs  ${modeled}`);
  }
  console.log('');
}

if (problems.length) {
  console.error('VALIDATION ERRORS:\n - ' + problems.join('\n - '));
  process.exit(1);
}
const reconNote = recon.mismatches.length
  ? `⚠ ${recon.mismatches.length} modeled-flow reconciliation mismatch(es) — see above`
  : '✓ modeled-flow reconciliation clean';
console.log('✓ all structural & invariant checks passed');
console.log(reconNote);
