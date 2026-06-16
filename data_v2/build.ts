// Build the v2 Excel workbook from data_v2/graph.json (validated first):
//   dist/2023_healthcare_spending_v2.xlsx
//
// It wears v1's layout — per-node ledger sheets (INFLOWS/OUTFLOWS/NET/VALIDATION) —
// driven by the observations-first data, plus Nodes/Edges/Observations audit sheets.
// See data_v2/xlsx.ts.
//
// Run: node data_v2/build.ts   (set XLSX_V2_OUT to a temp path if Excel holds the
// default file open — Excel takes an exclusive lock on Windows).
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGraphV2, validateGraphV2 } from './graph.ts';
import { buildV2Workbook } from './xlsx.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = loadGraphV2(root);

const problems = validateGraphV2(file);
if (problems.length) {
  console.error('v2 graph validation failed:\n - ' + problems.join('\n - '));
  throw new Error(problems.length + ' v2 validation error(s) — fix data_v2/graph.json');
}

const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

const wb = buildV2Workbook(file, root);
const xlsxPath = process.env.XLSX_V2_OUT ?? join(dist, '2023_healthcare_spending_v2.xlsx');
await wb.xlsx.writeFile(xlsxPath);
console.log('xlsx  -> ' + xlsxPath + '  (' + wb.worksheets.length + ' sheets)');
