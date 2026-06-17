// v2 readout: validate the observations-first graph and list the multi-source edges
// (what each source reported and which value the model uses). Run: node data_v2/check.ts
// Big-picture flow model — differing sources are context, not discrepancies to resolve.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGraphV2, validateGraphV2, canonicalObservation, canonicalAmount } from './graph.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = loadGraphV2(root);

const fmt = (n: number): string =>
  (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n * 10) / 10).toLocaleString() + 'B';
const pad = (s: string, w: number): string => (s.length >= w ? s : s + ' '.repeat(w - s.length));

const total = file.graph.edges.reduce((s, e) => s + canonicalAmount(e), 0);
console.log(
  `\nv2 graph: ${file.graph.nodes.length} nodes, ${file.graph.edges.length} edges, ` +
    `total flow ${fmt(total)} (sum of canonical observations)\n`,
);

const multi = file.graph.edges.filter((e) => e.observations.length > 1);
console.log(`Multi-source edges — ${multi.length} edges carry more than one observation:\n`);
for (const e of multi) {
  const canon = canonicalObservation(e);
  console.log(`  ${e.from} → ${e.to}  (using ${fmt(canon.value)})`);
  for (const o of e.observations) {
    const mark = o === canon ? '*' : ' ';
    console.log(
      `      ${mark} ${pad(fmt(o.value), 9)} ${pad(o.basis, 9)} ${pad(o.source, 16)}` +
        (o.note ? `  — ${o.note}` : ''),
    );
  }
}
console.log(
  '\n  * = the value the model uses (canonical). Other rows are what else was reported —',
);
console.log(
  '  context, not a discrepancy to resolve. Pick one and note why in the canonical obs.\n',
);

const problems = validateGraphV2(file);
if (problems.length) {
  console.error('VALIDATION ERRORS:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('✓ all v2 structural & observation invariants passed\n');
