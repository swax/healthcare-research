import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGraph } from '../src/graph.ts';
import { renderNodeSheet, loadSheetContents, loadResolvedSheets } from '../src/render-sheet.ts';
import type { Sheet, Cell } from '../src/render-sheet.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = loadGraph(root);

const numToCol = (n: number): string => {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = (n - m - 1) / 26;
  }
  return s;
};
const byAddr = (cells: Cell[]): Map<string, Cell> => {
  const m = new Map<string, Cell>();
  for (const c of cells) m.set(numToCol(c.c) + c.r, c);
  return m;
};

// Every generated sheet must reproduce its committed hand-authored snapshot exactly
// (this is also what locks the cross-referenced cells — see the table below — at
// their fixed positions, since other sheets link to e.g. `=Medicaid!B8`).
const SHEETS = ['medicaid', 'medicare'] as const;

for (const node of SHEETS) {
  test(`generated ${node} sheet matches the committed hand-authored snapshot`, () => {
    const expected = JSON.parse(
      readFileSync(join(root, 'test', 'fixtures', `${node}.expected.json`), 'utf8'),
    ) as Sheet;
    const content = loadSheetContents(root).get(node);
    assert.ok(content, `data/sheets/${node}.json missing`);
    const got = renderNodeSheet(file, content!);

    for (const k of ['name', 'tabColor', 'gridlines', 'freeze'] as const)
      assert.deepStrictEqual(got[k], expected[k], `sheet.${k} differs`);
    assert.deepStrictEqual(got.columns, expected.columns, 'columns differ');
    assert.deepStrictEqual(got.merges, expected.merges, 'merges differ');

    const g = byAddr(got.cells);
    const e = byAddr(expected.cells);
    assert.equal(g.size, e.size, `cell count: generated ${g.size} vs snapshot ${e.size}`);
    for (const [addr, ec] of e) {
      const gc = g.get(addr);
      assert.ok(gc, `generated sheet missing cell ${addr}`);
      assert.deepStrictEqual(gc!.v, ec.v, `${addr} value differs`);
      assert.deepStrictEqual(gc!.f, ec.f, `${addr} formula differs`);
      assert.deepStrictEqual(gc!.s, ec.s, `${addr} style differs`);
    }
  });
}

test('Medicaid keeps its cross-referenced cells (other sheets link to them)', () => {
  const at = byAddr(loadResolvedSheets(root, file).find((s) => s.name === 'Medicaid')!.cells);
  assert.equal(at.get('B6')?.v, 614);
  assert.equal(at.get('B7')?.v, 280);
  assert.equal(at.get('B8')?.f, '=SUM(B6:B7)');
  assert.equal(at.get('B12')?.v, 508);
  assert.equal(at.get('B21')?.f, '=SUM(B12:B20)');
  assert.equal(at.get('B23')?.f, '=B8-B21');
});

test('Medicare exercises merge, splits, extras and compound validation formulas', () => {
  const at = byAddr(loadResolvedSheets(root, file).find((s) => s.name === 'Medicare')!.cells);
  assert.equal(at.get('B6')?.v, 437, 'genrev (edge, exact)');
  assert.equal(at.get('B7')?.v, 325, 'payroll (merge of EE+ER, rounded from 325.5)');
  assert.equal(at.get('B9')?.v, 112, 'other (extra, not in graph)');
  assert.equal(at.get('B10')?.f, '=SUM(B6:B9)', 'total inflows');
  assert.equal(at.get('B17')?.v, 35, 'SNF (LTC split)');
  assert.equal(at.get('B18')?.v, 17, 'home health (LTC split)');
  assert.equal(at.get('B19')?.v, 24, 'hospice (LTC split)');
  assert.equal(at.get('B23')?.f, '=SUM(B14:B22)', 'total outflows');
  assert.equal(at.get('B25')?.f, '=B10-B23', 'net flow');
  // the compound validation refs resolved to the rows the edges/extras landed on
  assert.equal(at.get('C32')?.f, '=B16+B21+B22', 'Part B subset = physician + DME + admin');
  assert.equal(at.get('C33')?.f, '=B23-B22', 'personal HC = total outflows − admin');
});
