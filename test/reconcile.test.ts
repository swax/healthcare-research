import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGraph } from '../src/graph.ts';
import { loadWorkbook, reconcileWorkbook, resolveCell } from '../src/reconcile.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = loadGraph(root);
const wb = loadWorkbook(root);
const result = reconcileWorkbook(file, wb);
const pair = (from: string, to: string) => result.pairs.find((p) => p.from === from && p.to === to);
const modeledVal = (p: ReturnType<typeof pair>, sheet: string) =>
  p?.modeled.find((s) => s.sheet === sheet)?.amount;
const nationalVal = (p: ReturnType<typeof pair>, sheet: string) =>
  p?.national.find((s) => s.sheet === sheet)?.amount;

test('formula evaluator resolves literals, arithmetic and cross-sheet refs', () => {
  // literal
  assert.equal(resolveCell(wb, 'Medicare', 'B17'), 35);
  // arithmetic: Long-Term Care!B7 = B6*0.215 = 205 * 0.215
  assert.ok(Math.abs(resolveCell(wb, 'Long-Term Care', 'B7') - 205 * 0.215) < 1e-9);
  // SUM range: Medicare!B23 = SUM(B14:B22) total outflows
  assert.ok(resolveCell(wb, 'Medicare', 'B23') > 1000);
  // cross-sheet ref: Hospitals!B11 = Medicare!B15 (FFS hospital)
  assert.equal(resolveCell(wb, 'Hospitals', 'B11'), 150);
});

test('modeled FFS/OOP flows reconcile cleanly against the graph', () => {
  // after the data fixes, every modeled provider-payment pair agrees
  assert.equal(result.mismatches.length, 0, 'unexpected modeled mismatches');
  for (const p of result.pairs) {
    if (p.status === 'context-only') continue;
    assert.ok(p.spread <= result.tolerance, `${p.from}→${p.to} modeled spread ${p.spread}`);
  }
});

test('Medicare→LTC: modeled FFS ($76B) agrees, national NHE ($96B) is separate context', () => {
  const p = pair('medicare', 'long_term_care');
  assert.ok(p, 'medicare → long_term_care not reconciled');
  assert.equal(p!.status, 'ok');
  assert.equal(p!.graph, 76); // canonical edge
  assert.equal(modeledVal(p, 'Medicare'), 76); // 35 + 17 + 24 FFS outflow rows
  // national payer-mix lens: Medicare nursing (205*0.215≈44) + home health (154*0.337≈52) ≈ 96
  assert.ok(Math.abs((nationalVal(p, 'Long-Term Care') ?? 0) - 96) < 1, 'national ≈ $96B');
});

test('the added Individuals→LTC out-of-pocket edge reconciles (~$73B)', () => {
  const p = pair('individuals', 'long_term_care');
  assert.ok(p, 'individuals → long_term_care not reconciled');
  assert.equal(p!.status, 'ok');
  assert.ok(Math.abs((p!.graph ?? 0) - 73.281) < 0.01, 'graph edge ≈ $73.3B');
  assert.ok(Math.abs((modeledVal(p, 'Individuals') ?? 0) - 73.281) < 0.5);
});

test('reconciliation only targets provider sectors (upstream funding flows excluded)', () => {
  const providers = new Set(
    file.graph.nodes.filter((n) => n.group === 'providers').map((n) => n.id),
  );
  for (const p of result.pairs)
    assert.ok(providers.has(p.to), `unexpected non-provider target ${p.to}`);
  // the multi-hop "Individuals → Federal Gov → Medicare" funding label must NOT
  // be mistaken for a direct individuals→medicare edge
  assert.equal(pair('individuals', 'medicare'), undefined);
});

test('an ok pair (Medicare → Hospitals) reconciles cleanly', () => {
  const p = pair('medicare', 'hospitals');
  assert.ok(p, 'medicare → hospitals not reconciled');
  assert.equal(p!.status, 'ok');
  assert.equal(p!.graph, 150);
  assert.equal(modeledVal(p, 'Medicare'), 150);
});
