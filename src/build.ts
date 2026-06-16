// Single-source-of-truth build: reads ../data/data.json and regenerates BOTH
//   dist/2023_healthcare_spending.xlsx   (full 16-sheet workbook + generated Graph Data)
//   dist/healthcare_flow_sankey.html     (Plotly Sankey from the canonical graph)
//
// Run natively on Node 24 (type stripping, no compile step):  node src/build.ts
// Erasable-syntax-only TypeScript so Node strips the types directly.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ExcelJS from 'exceljs';
import { loadGraph, computeFlows, validateGraph } from './graph.ts';
import type { GNode } from './graph.ts';
import { renderSankeyHtml } from './sankey.ts';
import { loadResolvedSheets } from './render-sheet.ts';
import { footnoteSources, addSheetsToWorkbook } from './workbook.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
mkdirSync(DIST, { recursive: true });

const file = loadGraph(ROOT);
// Hand-authored sheets from data/workbook.json, with any `{ "generated": "<node>" }`
// stub (e.g. Medicaid) swapped for its rendered node-ledger sheet.
const sheets = loadResolvedSheets(ROOT, file);

// Derived lookups from the canonical graph (colors, layer x-positions, labels, citation text).
const colorByGroup: Record<string, string> = {};
for (const g of file.groups) colorByGroup[g.id] = g.color;
const layerName: Record<number, string> = {};
for (const l of file.layers) layerName[l.n] = l.name;
const labelById: Record<string, string> = {};
for (const n of file.graph.nodes) labelById[n.id] = n.label;
const colorOf = (n: GNode): string => colorByGroup[n.group] ?? '999999';
const srcText = (id: string): string => file.sources[id] ?? id;

const wb = new ExcelJS.Workbook();
wb.creator = 'flow-graph build.ts';
wb.created = new Date();

footnoteSources(sheets);
addSheetsToWorkbook(wb, sheets);

const nodes = file.graph.nodes;
const edges = file.graph.edges;
const problems = validateGraph(file);
if (problems.length) {
  console.error('Graph validation failed:\n - ' + problems.join('\n - '));
  throw new Error(problems.length + ' graph validation error(s) — fix data/graph.json');
}
const flows = computeFlows(nodes, edges);
const through = (id: string): number => flows.throughput[id] ?? 0;

const CUR = '\\$#,##0;"($"#,##0\\);\\-';
const gd = wb.addWorksheet('Graph Data', {
  views: [{ showGridLines: true, state: 'frozen', ySplit: 4 }],
  properties: { tabColor: { argb: 'FFB71C1C' } } as ExcelJS.AddWorksheetOptions['properties'],
});
const solid = (c: ExcelJS.Cell, hex: string) => {
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: hex } };
};
gd.getCell('A1').value = 'Graph Data — generated from data.json (canonical flows)';
solid(gd.getCell('A1'), 'FF263238');
gd.getCell('A1').font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 13 };
for (let c = 2; c <= 5; c++) solid(gd.getRow(1).getCell(c), 'FF263238');
gd.getCell('A2').value = 'Do not edit here — edit data/data.json and re-run `node src/build.ts`.';
gd.getCell('A2').font = { color: { argb: 'FF666666' }, size: 10 };
gd.getCell('A4').value = 'NODES';
solid(gd.getCell('A4'), 'FF0D47A1');
gd.getCell('A4').font = { bold: true, color: { argb: 'FFFFFFFF' } };
['Node', 'Layer #', 'Layer Name', 'Color', 'Throughput ($B)'].forEach((h, i) => {
  const c = gd.getRow(5).getCell(i + 1);
  c.value = h;
  solid(c, 'FFBBDEFB');
  c.font = { bold: true };
});
let r = 6;
for (const n of nodes) {
  const row = gd.getRow(r);
  row.getCell(1).value = n.label;
  row.getCell(2).value = n.layer;
  row.getCell(3).value = layerName[n.layer] ?? '';
  row.getCell(4).value = colorOf(n);
  const t = row.getCell(5);
  t.value = Math.round(through(n.id) * 10) / 10;
  t.numFmt = CUR;
  r++;
}
r += 1;
gd.getCell('A' + r).value = 'EDGES (source → target, single-hop)';
solid(gd.getCell('A' + r), 'FF0D47A1');
gd.getCell('A' + r).font = { bold: true, color: { argb: 'FFFFFFFF' } };
r++;
['Source', 'Target', 'Amount ($B)', 'Channel', 'Source', 'Confidence'].forEach((h, i) => {
  const c = gd.getRow(r).getCell(i + 1);
  c.value = h;
  solid(c, 'FFBBDEFB');
  c.font = { bold: true };
});
r++;
const firstEdge = r;
const gdOrder: string[] = []; // distinct citations on this sheet, first-seen order
const gdNum = new Map<string, number>();
for (const e of edges) {
  const row = gd.getRow(r);
  row.getCell(1).value = labelById[e.from] ?? e.from;
  row.getCell(2).value = labelById[e.to] ?? e.to;
  const a = row.getCell(3);
  a.value = e.amount;
  a.numFmt = CUR;
  row.getCell(4).value = e.channel;
  const cite = srcText(e.source);
  if (!gdNum.has(cite)) {
    gdOrder.push(cite);
    gdNum.set(cite, gdOrder.length);
  }
  row.getCell(5).value = '[' + gdNum.get(cite) + ']';
  row.getCell(6).value = e.confidence ?? '';
  r++;
}
const totalRow = gd.getRow(r);
totalRow.getCell(1).value = 'TOTAL';
totalRow.getCell(1).font = { bold: true };
const tcell = totalRow.getCell(3);
tcell.value = { formula: 'SUM(C' + firstEdge + ':C' + (r - 1) + ')' };
tcell.numFmt = CUR;
tcell.font = { bold: true };
[26, 24, 14, 30, 10, 13].forEach((w, i) => {
  gd.getColumn(i + 1).width = w;
});

// Numbered source list at the bottom (the [n] markers in column E point here).
r += 2;
const gdTitle = gd.getCell('A' + r);
gdTitle.value = 'Sources';
gdTitle.font = { bold: true };
solid(gdTitle, 'FFECEFF1');
r++;
gdOrder.forEach((cite, i) => {
  const c = gd.getCell('A' + r);
  c.value = '[' + (i + 1) + ']  ' + cite;
  c.font = { color: { argb: 'FF555555' }, size: 10 };
  r++;
});

// XLSX_OUT lets you build to an alternate path when the default is locked open
// (Excel holds an exclusive lock on Windows).
const xlsxPath = process.env.XLSX_OUT ?? join(DIST, '2023_healthcare_spending.xlsx');
await wb.xlsx.writeFile(xlsxPath);
console.log('xlsx  -> ' + xlsxPath + '  (' + (sheets.length + 1) + ' sheets)');

const htmlPath = join(DIST, 'healthcare_flow_sankey.html');
writeFileSync(htmlPath, renderSankeyHtml(file));
console.log(
  'html  -> ' + htmlPath + '  (' + nodes.length + ' nodes, ' + edges.length + ' edges, DAG ok)',
);
