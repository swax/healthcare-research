import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ExcelJS from 'exceljs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

before(() => { execSync('node src/build.ts', { cwd: root, stdio: 'ignore' }); });

test('build produces a loadable workbook with the Graph Data sheet', async () => {
  const p = join(root, 'dist', '2023_healthcare_spending.xlsx');
  assert.ok(existsSync(p), 'xlsx not generated');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  const names = wb.worksheets.map((w) => w.name);
  assert.ok(names.includes('Overview'), 'missing Overview');
  assert.ok(names.includes('Graph Data'), 'missing generated Graph Data');
  assert.equal(names.length, 17, '16 source sheets + Graph Data');
});

test('build produces the Sankey html', () => {
  const h = readFileSync(join(root, 'dist', 'healthcare_flow_sankey.html'), 'utf8');
  assert.match(h, /Plotly\.newPlot/);
  assert.match(h, /\d+ nodes, \d+ flows/);
});
