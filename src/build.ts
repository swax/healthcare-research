// Single-source-of-truth build: reads ../data/data.json and regenerates BOTH
//   dist/2023_healthcare_spending.xlsx   (full 16-sheet workbook + generated Graph Data)
//   dist/healthcare_flow_sankey.html     (Plotly Sankey from the canonical graph)
//
// Run natively on Node 24 (type stripping, no compile step):  node src/build.ts
// Erasable-syntax-only TypeScript so Node strips the types directly.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ExcelJS from 'exceljs';
import { loadGraph, computeFlows, findCycles, validateGraph } from './graph.ts';
import type { GNode } from './graph.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
mkdirSync(DIST, { recursive: true });

interface Style { b?: boolean; sz?: number; color?: string; fill?: string; h?: string; v?: string; wrap?: boolean; indent?: number; fmt?: string; }
interface Cell { r: number; c: number; v?: string | number; f?: string; s?: Style; }
interface Sheet { name: string; tabColor: string | null; gridlines: boolean; freeze: string | null; columns: Record<string, number>; rows: Record<string, number>; merges: string[]; cells: Cell[]; }
const file = loadGraph(ROOT);
const workbookFile = JSON.parse(readFileSync(join(ROOT, 'data', 'workbook.json'), 'utf8')) as { sheets: Sheet[] };
const sheets = workbookFile.sheets;

// Derived lookups from the canonical graph (colors, layer x-positions, labels, citation text).
const colorByGroup: Record<string, string> = {};
const groupLabel: Record<string, string> = {};
for (const g of file.groups) { colorByGroup[g.id] = g.color; groupLabel[g.id] = g.label; }
const layerName: Record<number, string> = {};
const xByLayer: Record<number, number> = {};
for (const l of file.layers) { layerName[l.n] = l.name; xByLayer[l.n] = l.x; }
const labelById: Record<string, string> = {};
for (const n of file.graph.nodes) labelById[n.id] = n.label;
const colorOf = (n: GNode): string => colorByGroup[n.group] ?? '999999';
const srcText = (id: string): string => file.sources[id] ?? id;

const argb = (hex: string): string => 'FF' + hex.replace('#', '').toUpperCase();
function colToNum(letters: string): number { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }
function applyStyle(cell: ExcelJS.Cell, s?: Style): void {
  if (!s) return;
  if (s.b || s.sz || s.color) cell.font = { bold: !!s.b, ...(s.sz ? { size: s.sz } : {}), ...(s.color ? { color: { argb: argb(s.color) } } : {}) };
  if (s.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(s.fill) } };
  if (s.h || s.v || s.wrap || s.indent) cell.alignment = { ...(s.h ? { horizontal: s.h as ExcelJS.Alignment['horizontal'] } : {}), ...(s.v ? { vertical: s.v as ExcelJS.Alignment['vertical'] } : {}), ...(s.wrap ? { wrapText: true } : {}), ...(s.indent ? { indent: s.indent } : {}) };
  if (s.fmt) cell.numFmt = s.fmt;
}

const wb = new ExcelJS.Workbook();
wb.creator = 'flow-graph build.ts'; wb.created = new Date();

for (const sh of sheets) {
  const view: ExcelJS.WorksheetView = { showGridLines: sh.gridlines } as ExcelJS.WorksheetView;
  if (sh.freeze) { const m = /^([A-Z]+)(\d+)$/.exec(sh.freeze); if (m) { view.state = 'frozen'; view.xSplit = colToNum(m[1]) - 1; view.ySplit = parseInt(m[2], 10) - 1; } }
  const ws = wb.addWorksheet(sh.name, { views: [view], properties: (sh.tabColor ? { tabColor: { argb: argb(sh.tabColor) } } : {}) as ExcelJS.AddWorksheetOptions['properties'] });
  for (const [letter, width] of Object.entries(sh.columns)) ws.getColumn(colToNum(letter)).width = width;
  for (const [r, h] of Object.entries(sh.rows)) ws.getRow(parseInt(r, 10)).height = h;
  for (const cd of sh.cells) {
    const cell = ws.getRow(cd.r).getCell(cd.c);
    if (cd.f !== undefined) cell.value = { formula: cd.f.replace(/^=/, '') };
    else if (cd.v !== undefined) cell.value = cd.v;
    applyStyle(cell, cd.s);
  }
  for (const rng of sh.merges) { try { ws.mergeCells(rng); } catch { /* ignore */ } }
}

const nodes = file.graph.nodes; const edges = file.graph.edges;
const problems = validateGraph(file);
if (problems.length) { console.error('Graph validation failed:\n - ' + problems.join('\n - ')); throw new Error(problems.length + ' graph validation error(s) — fix data/graph.json'); }
const flows = computeFlows(nodes, edges);
const through = (id: string): number => flows.throughput[id] ?? 0;

const CUR = '\\$#,##0;"($"#,##0\\);\\-';
const gd = wb.addWorksheet('Graph Data', { views: [{ showGridLines: true, state: 'frozen', ySplit: 4 }], properties: { tabColor: { argb: 'FFB71C1C' } } as ExcelJS.AddWorksheetOptions['properties'] });
const solid = (c: ExcelJS.Cell, hex: string) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: hex } }; };
gd.getCell('A1').value = 'Graph Data — generated from data.json (canonical flows)'; solid(gd.getCell('A1'), 'FF263238'); gd.getCell('A1').font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 13 };
for (let c = 2; c <= 5; c++) solid(gd.getRow(1).getCell(c), 'FF263238');
gd.getCell('A2').value = 'Do not edit here — edit data/data.json and re-run `node src/build.ts`.'; gd.getCell('A2').font = { color: { argb: 'FF666666' }, size: 10 };
gd.getCell('A4').value = 'NODES'; solid(gd.getCell('A4'), 'FF0D47A1'); gd.getCell('A4').font = { bold: true, color: { argb: 'FFFFFFFF' } };
['Node', 'Layer #', 'Layer Name', 'Color', 'Throughput ($B)'].forEach((h, i) => { const c = gd.getRow(5).getCell(i + 1); c.value = h; solid(c, 'FFBBDEFB'); c.font = { bold: true }; });
let r = 6;
for (const n of nodes) { const row = gd.getRow(r); row.getCell(1).value = n.label; row.getCell(2).value = n.layer; row.getCell(3).value = layerName[n.layer] ?? ''; row.getCell(4).value = colorOf(n); const t = row.getCell(5); t.value = Math.round(through(n.id) * 10) / 10; t.numFmt = CUR; r++; }
r += 1;
gd.getCell('A' + r).value = 'EDGES (source → target, single-hop)'; solid(gd.getCell('A' + r), 'FF0D47A1'); gd.getCell('A' + r).font = { bold: true, color: { argb: 'FFFFFFFF' } };
r++;
['Source', 'Target', 'Amount ($B)', 'Channel', 'Source / Citation', 'Confidence'].forEach((h, i) => { const c = gd.getRow(r).getCell(i + 1); c.value = h; solid(c, 'FFBBDEFB'); c.font = { bold: true }; });
r++;
const firstEdge = r;
for (const e of edges) { const row = gd.getRow(r); row.getCell(1).value = labelById[e.from] ?? e.from; row.getCell(2).value = labelById[e.to] ?? e.to; const a = row.getCell(3); a.value = e.amount; a.numFmt = CUR; row.getCell(4).value = e.channel; row.getCell(5).value = srcText(e.source); row.getCell(6).value = e.confidence ?? ''; r++; }
const totalRow = gd.getRow(r); totalRow.getCell(1).value = 'TOTAL'; totalRow.getCell(1).font = { bold: true };
const tcell = totalRow.getCell(3); tcell.value = { formula: 'SUM(C' + firstEdge + ':C' + (r - 1) + ')' }; tcell.numFmt = CUR; tcell.font = { bold: true };
[26, 24, 14, 30, 26, 13].forEach((w, i) => { gd.getColumn(i + 1).width = w; });

const xlsxPath = join(DIST, '2023_healthcare_spending.xlsx');
await wb.xlsx.writeFile(xlsxPath);
console.log('xlsx  -> ' + xlsxPath + '  (' + (sheets.length + 1) + ' sheets)');

const names = nodes.map((n) => n.label);
const idx: Record<string, number> = {}; nodes.forEach((n, i) => { idx[n.id] = i; });
const cycles = findCycles(nodes, edges);
if (cycles.length) throw new Error('Graph has cycles, Sankey needs a DAG: ' + cycles.join(', '));

const byLayer: Record<number, number[]> = {};
nodes.forEach((n, i) => { (byLayer[n.layer] = byLayer[n.layer] || []).push(i); });
const nodeX: number[] = new Array(nodes.length).fill(0.5); const nodeY: number[] = new Array(nodes.length).fill(0.5);
for (const [layer, members] of Object.entries(byLayer)) { const k = members.length; members.forEach((i, j) => { nodeX[i] = xByLayer[Number(layer)] ?? 0.5; nodeY[i] = (j + 1) / (k + 1); }); }
const rgba = (hex: string, a: number): string => { const h = hex.replace('#', ''); return 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16) + ',' + a + ')'; };
const fig = {
  data: [{
    type: 'sankey', arrangement: 'snap', valueformat: '$,.0f', valuesuffix: 'B',
    node: { pad: 18, thickness: 20, line: { color: 'rgba(0,0,0,0.35)', width: 0.5 }, label: names, color: nodes.map((n) => rgba(colorOf(n), 0.95)), x: nodeX, y: nodeY, customdata: nodes.map((n) => [groupLabel[n.group] ?? n.group, Math.round(through(n.id) * 10) / 10]), hovertemplate: '<b>%{label}</b><br>%{customdata[0]}<br>Throughput: $%{customdata[1]}B<extra></extra>' },
    link: { source: edges.map((e) => idx[e.from]), target: edges.map((e) => idx[e.to]), value: edges.map((e) => e.amount), color: edges.map((e) => rgba(colorOf(nodes[idx[e.from]]), 0.33)), customdata: edges.map((e) => [e.channel, srcText(e.source)]), hovertemplate: '%{source.label} → %{target.label}<br><b>$%{value:,.0f}B</b><br>%{customdata[0]}<extra></extra>' },
  }],
  layout: {
    title: { text: 'U.S. Healthcare Flow of Funds — FY 2023  ($B; node & ribbon width ∝ dollars)', font: { size: 18, color: '#263238' } },
    font: { family: 'Segoe UI, Helvetica, Arial, sans-serif', size: 12, color: '#263238' }, paper_bgcolor: 'white', margin: { l: 10, r: 10, t: 70, b: 40 },
    annotations: file.layers.map((l) => ({ showarrow: false, x: l.x, y: 1.045, xref: 'paper', yref: 'paper', text: '<b>' + (l.annotation ?? l.name) + '</b>', font: { size: 11, color: '#555' } })),
  },
};
const html = '<!doctype html><html><head><meta charset="utf-8">\n<title>Healthcare Flow of Funds — FY 2023</title>\n<script src="https://cdn.plot.ly/plotly-2.35.2.min.js" charset="utf-8"></script>\n<style>html,body{margin:0;background:#fff;font-family:\'Segoe UI\',Arial,sans-serif}#chart{width:100%;height:88vh}.foot{padding:6px 16px;color:#777;font-size:12px}</style></head>\n<body><div id="chart"></div>\n<div class="foot">Generated from data.json · ' + nodes.length + ' nodes, ' + edges.length + ' flows · re-run <code>node src/build.ts</code> after editing the data.</div>\n<script>var fig=' + JSON.stringify(fig) + ';\nPlotly.newPlot(\'chart\',fig.data,fig.layout,{responsive:true,displaylogo:false,toImageButtonOptions:{format:\'png\',filename:\'healthcare_flow_2023\',scale:2}});</script>\n</body></html>';
const htmlPath = join(DIST, 'healthcare_flow_sankey.html');
writeFileSync(htmlPath, html);
console.log('html  -> ' + htmlPath + '  (' + nodes.length + ' nodes, ' + edges.length + ' edges, DAG ok)');
