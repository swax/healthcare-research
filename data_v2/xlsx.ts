// v2 Excel workbook, generated from data_v2/graph.json (plus the editorial overlays in
// data_v2/sheets/). It wears v1's layout — per-node INFLOWS/OUTFLOWS/NET ledger sheets.
// Sheets:
//
//   Overview        — front page: counts, total, linked node summary, multi-source snapshot
//   <node> ledgers  — one per top-level node (see ledger.ts); sub-nodes nest inside parents
//   Nodes           — inflow/outflow/throughput/net summary (audit)
//   Edges           — one row per flow: canonical value + any other sources reported
//   Observations    — one row per source measurement (★ = canonical) — the v2 detail
//   Glossary        — acronyms, v2 terms, and sources/structure from the graph
//
// Pure construction: returns an ExcelJS.Workbook, no file IO. Erasable-syntax-only TS.
import ExcelJS from 'exceljs';
import { footnoteSources, addSheetsToWorkbook } from '../src/workbook.ts';
import { renderNodeLedger, loadOverlays } from './ledger.ts';
import { computeFlowsV2, canonicalObservation, type GraphFileV2 } from './graph.ts';

const CUR = '$#,##0.0##';
const argb = (hex: string): string => 'FF' + hex.replace('#', '').toUpperCase();
const rnd = (n: number): number => Math.round(n * 1000) / 1000;

export function buildV2Workbook(file: GraphFileV2, root: string): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'data_v2/build.ts';

  const nodes = file.graph.nodes;
  const edges = file.graph.edges;
  const { inflow, outflow, throughput } = computeFlowsV2(file);

  const layerName: Record<number, string> = {};
  for (const l of file.layers) layerName[l.n] = l.name;
  const groupColor: Record<string, string> = {};
  for (const g of file.groups) groupColor[g.id] = g.color;
  const label: Record<string, string> = {};
  for (const n of nodes) label[n.id] = n.label;
  const labelOf = (id: string): string => label[id] ?? id;
  const cite = (id: string): string => file.sources[id] ?? id;

  // ---- shared cell helpers (Overview, audit sheets, Glossary) ----
  const solid = (c: ExcelJS.Cell, hex: string): void => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(hex) } };
  };
  const titleBar = (ws: ExcelJS.Worksheet, text: string, ncols: number): void => {
    const a1 = ws.getCell('A1');
    a1.value = text;
    a1.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 13 };
    for (let c = 1; c <= ncols; c++) solid(ws.getRow(1).getCell(c), '263238');
  };
  const sectionBar = (
    ws: ExcelJS.Worksheet,
    row: number,
    text: string,
    fill: string,
    ncols: number,
  ): void => {
    const c1 = ws.getRow(row).getCell(1);
    c1.value = text;
    c1.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    for (let c = 1; c <= ncols; c++) solid(ws.getRow(row).getCell(c), fill);
  };
  const headerRow = (ws: ExcelJS.Worksheet, row: number, labels: string[], fill: string): void => {
    labels.forEach((h, i) => {
      const c = ws.getRow(row).getCell(i + 1);
      c.value = h;
      solid(c, fill);
      c.font = { bold: true };
    });
  };
  const money = (cell: ExcelJS.Cell, v: number): void => {
    cell.value = rnd(v);
    cell.numFmt = CUR;
  };
  const note = (cell: ExcelJS.Cell, text: string): void => {
    cell.value = text;
    cell.font = { italic: true, color: { argb: 'FF888888' } };
  };

  // ---- Overview (front page; created first so it's the leftmost tab) ----
  const ov = wb.addWorksheet('Overview', { views: [{ state: 'frozen', ySplit: 2 }] });
  ov.mergeCells('A1:F1');
  ov.mergeCells('A2:F2');
  titleBar(ov, '2023 U.S. Healthcare Flow-of-Funds — v2 Overview', 6);
  note(
    ov.getCell('A2'),
    'All amounts $B · observations-first model · CMS NHE / MedPAC / MACPAC / KFF / AHA / PhRMA',
  );

  const topLevel = [...nodes].filter((n) => !n.parent);
  const obsTotal = edges.reduce((s, e) => s + e.observations.length, 0);
  const obsBy = (conf: string): number =>
    edges.reduce((s, e) => s + e.observations.filter((o) => o.confidence === conf).length, 0);
  const grandTotal = topLevel.reduce((s, n) => s + (outflow[n.id] ?? 0), 0);

  let ovr = 4;
  sectionBar(ov, ovr, 'MODEL AT A GLANCE', '0D47A1', 6);
  ovr++;
  const stat = (lbl: string, val: string | number): void => {
    ov.getRow(ovr).getCell(1).value = lbl;
    const c = ov.getRow(ovr).getCell(2);
    c.value = val;
    c.font = { bold: true };
    ovr++;
  };
  stat('Top-level nodes', topLevel.length);
  stat('Sub-nodes (nested in parent sheets)', nodes.length - topLevel.length);
  stat('Edges (flows)', edges.length);
  stat(
    'Observations',
    `${obsTotal}  (${obsBy('reported')} reported · ${obsBy('estimate')} estimate)`,
  );
  ov.getRow(ovr).getCell(1).value = 'Total traced flow (sum of all edges)';
  money(ov.getRow(ovr).getCell(2), grandTotal);
  ov.getRow(ovr).getCell(2).font = { bold: true };
  ovr++;
  note(
    ov.getRow(ovr).getCell(1),
    'Gross hop-by-hop flow — money is counted at each layer, so this is not an NHE total.',
  );
  ovr += 2;

  // node summary — linked to each node's sheet
  sectionBar(ov, ovr, 'NODE SUMMARY  (click a node to open its sheet)', '1B5E20', 6);
  ovr++;
  headerRow(
    ov,
    ovr,
    ['Node', 'Layer', 'Inflow ($B)', 'Outflow ($B)', 'Net ($B)', 'Note'],
    'C8E6C9',
  );
  ovr++;
  const netNote = (n: (typeof nodes)[number], net: number): string => {
    if (n.role === 'source') return 'source (out only)';
    if (n.role === 'sink') return 'sink (in only)';
    if (net > 1) return 'traced in, not onward';
    if (net < -1) return 'inflow below national';
    return 'balanced';
  };
  for (const n of topLevel.sort((a, b) => a.layer - b.layer || a.label.localeCompare(b.label))) {
    const i = inflow[n.id] ?? 0;
    const o = outflow[n.id] ?? 0;
    const row = ov.getRow(ovr);
    const link = row.getCell(1);
    link.value = { formula: `HYPERLINK("#'${n.label}'!A1","${n.label}")`, result: n.label };
    link.font = { color: { argb: 'FF0563C1' } };
    row.getCell(2).value = layerName[n.layer] ?? n.layer;
    money(row.getCell(3), i);
    money(row.getCell(4), o);
    money(row.getCell(5), i - o);
    row.getCell(6).value = netNote(n, i - o);
    ovr++;
  }
  ovr++;

  // multi-source snapshot — edges with more than one source, and the value the model
  // uses. Big-picture flow model: this is neutral context (what else was reported), not
  // a discrepancy to flag — see docs/v2.md.
  const multiSource = edges.filter((e) => e.observations.length > 1);
  sectionBar(ov, ovr, 'MULTI-SOURCE EDGES  (sources & the value used)', 'E65100', 6);
  ovr++;
  const csHead = ov.getRow(ovr);
  ['Edge', 'Value used ($B)'].forEach((h, i) => {
    csHead.getCell(i + 1).value = h;
    csHead.getCell(i + 1).font = { bold: true };
    solid(csHead.getCell(i + 1), 'FFE0B2');
  });
  csHead.getCell(6).value = 'Other sources reported';
  csHead.getCell(6).font = { bold: true };
  solid(csHead.getCell(6), 'FFE0B2');
  ovr++;
  for (const e of multiSource) {
    const canon = canonicalObservation(e);
    const others = e.observations
      .filter((o) => o !== canon)
      .map((o) => `$${rnd(o.value)} ${o.basis} (${o.source})`)
      .join(' · ');
    const row = ov.getRow(ovr);
    row.getCell(1).value = e.id;
    money(row.getCell(2), canon.value);
    row.getCell(6).value = others;
    ovr++;
  }
  note(
    ov.getRow(ovr).getCell(1),
    `${multiSource.length} of ${edges.length} edges carry a second source today — see the Edges & Observations sheets. Adding more is the main open work.`,
  );
  [34, 20, 13, 13, 13, 50].forEach((w, i) => {
    ov.getColumn(i + 1).width = w;
  });

  // ---- node-ledger sheets (v1 layout, one per node) ----
  // Ordered by layer so the workbook reads left-to-right with the flow. A node with
  // a data_v2/sheets/<node>.json overlay renders curated (labels, extras, checks);
  // the rest fall back to the auto-ledger straight from the graph.
  const overlays = loadOverlays(root);
  const rendered = [...nodes]
    .filter((n) => !n.parent) // sub-nodes render nested inside their parent's sheet
    .sort((a, b) => a.layer - b.layer || a.label.localeCompare(b.label))
    .map((n) => renderNodeLedger(file, n.id, overlays.get(n.id)));
  const ledgers = rendered.map((r) => r.sheet);

  // Cross-sheet hyperlinks: every flow's amount is clickable to its counterpart end,
  // so you can trace a dollar hop by hop — an outflow on the payer's sheet jumps to
  // the same edge's inflow on the payee's sheet, and back. Uses Excel's HYPERLINK()
  // with the dollar value as the friendly name, so the cell stays numeric (SUM / %
  // keep working). The blue text signals it's clickable.
  const inLoc = new Map<string, { sheet: string; row: number }>();
  const outLoc = new Map<string, { sheet: string; row: number }>();
  for (const { sheet, flows } of rendered)
    for (const f of flows)
      (f.role === 'in' ? inLoc : outLoc).set(f.edge, { sheet: sheet.name, row: f.row });
  for (const { sheet, flows } of rendered) {
    const cellAt = new Map<string, (typeof sheet.cells)[number]>();
    for (const c of sheet.cells) cellAt.set(c.r + ':' + c.c, c);
    for (const f of flows) {
      const target = f.role === 'in' ? outLoc.get(f.edge) : inLoc.get(f.edge);
      const cell = cellAt.get(f.row + ':2');
      if (!target || !cell || typeof cell.v !== 'number') continue;
      cell.f = `HYPERLINK("#'${target.sheet}'!B${target.row}",${cell.v})`;
      delete cell.v;
      cell.s = { ...cell.s, color: '0563C1' };
    }
  }

  footnoteSources(ledgers);
  addSheetsToWorkbook(wb, ledgers);

  // ---- audit sheets (the v2 detail) ----
  // ---- Nodes ----
  const ns = wb.addWorksheet('Nodes', { views: [{ state: 'frozen', ySplit: 2 }] });
  const nHead = [
    'Node',
    'Layer #',
    'Layer',
    'Group',
    'Color',
    'Inflow ($B)',
    'Outflow ($B)',
    'Throughput ($B)',
    'Net ($B)',
    'Note',
  ];
  titleBar(
    ns,
    'v2 Nodes — derived from data_v2/graph.json (flows = canonical observations)',
    nHead.length,
  );
  headerRow(ns, 2, nHead, 'BBDEFB');
  let r = 3;
  const sortedNodes = [...nodes].sort(
    (a, b) => a.layer - b.layer || a.label.localeCompare(b.label),
  );
  for (const n of sortedNodes) {
    const i = inflow[n.id] ?? 0;
    const o = outflow[n.id] ?? 0;
    const net = i - o;
    // same lens as src/check.ts: a traced-flow model, so intermediary net ≠ 0 is expected
    let note: string;
    if (n.role === 'source') note = 'source (out only)';
    else if (n.role === 'sink') note = 'sink (in only)';
    else if (net > 1) note = 'traced in, not onward';
    else if (net < -1) note = 'inflow below national';
    else note = 'balanced';
    const row = ns.getRow(r);
    row.getCell(1).value = n.label;
    row.getCell(2).value = n.layer;
    row.getCell(3).value = layerName[n.layer] ?? '';
    row.getCell(4).value = n.group;
    row.getCell(5).value = groupColor[n.group] ?? '';
    money(row.getCell(6), i);
    money(row.getCell(7), o);
    money(row.getCell(8), throughput[n.id] ?? 0);
    money(row.getCell(9), net);
    row.getCell(10).value = note;
    r++;
  }
  [26, 8, 20, 18, 10, 14, 14, 16, 12, 22].forEach((w, i) => {
    ns.getColumn(i + 1).width = w;
  });

  // ---- Edges ----
  const es = wb.addWorksheet('Edges', { views: [{ state: 'frozen', ySplit: 2 }] });
  const eHead = [
    'Edge ID',
    'From',
    'To',
    'Channel',
    'Canonical ($B)',
    'Basis',
    'Conf.',
    '# Obs',
    'Other sources reported',
  ];
  titleBar(es, 'v2 Edges — one row per flow; canonical value + any other sources', eHead.length);
  headerRow(es, 2, eHead, 'BBDEFB');
  r = 3;
  const firstEdge = r;
  for (const e of edges) {
    const c = canonicalObservation(e);
    const others = e.observations
      .filter((o) => o !== c)
      .map((o) => `$${rnd(o.value)} ${o.basis} (${o.source})`)
      .join(' · ');
    const row = es.getRow(r);
    row.getCell(1).value = e.id;
    row.getCell(2).value = labelOf(e.from);
    row.getCell(3).value = labelOf(e.to);
    row.getCell(4).value = e.channel;
    money(row.getCell(5), c.value);
    row.getCell(6).value = c.basis;
    row.getCell(7).value = c.confidence ?? '';
    row.getCell(8).value = e.observations.length;
    row.getCell(9).value = others;
    r++;
  }
  const tr = es.getRow(r);
  tr.getCell(1).value = 'TOTAL';
  tr.getCell(1).font = { bold: true };
  const tc = tr.getCell(5);
  tc.value = { formula: 'SUM(E' + firstEdge + ':E' + (r - 1) + ')' };
  tc.numFmt = CUR;
  tc.font = { bold: true };
  [22, 16, 18, 30, 14, 10, 8, 7, 48].forEach((w, i) => {
    es.getColumn(i + 1).width = w;
  });

  // ---- Observations ----
  const os = wb.addWorksheet('Observations', { views: [{ state: 'frozen', ySplit: 2 }] });
  const oHead = [
    'Edge ID',
    'Flow',
    'Channel',
    'Value ($B)',
    'Basis',
    'Source key',
    'Citation',
    'Conf.',
    'Canonical',
    'Note',
  ];
  titleBar(os, 'v2 Observations — every source measurement (★ = canonical)', oHead.length);
  headerRow(os, 2, oHead, 'C8E6C9');
  r = 3;
  for (const e of edges) {
    for (const o of e.observations) {
      const isCanon = e.observations.length === 1 ? true : !!o.canonical;
      const row = os.getRow(r);
      row.getCell(1).value = e.id;
      row.getCell(2).value = labelOf(e.from) + ' → ' + labelOf(e.to);
      row.getCell(3).value = e.channel;
      money(row.getCell(4), o.value);
      row.getCell(5).value = o.basis;
      row.getCell(6).value = o.source;
      row.getCell(7).value = cite(o.source);
      row.getCell(8).value = o.confidence ?? '';
      const cc = row.getCell(9);
      cc.value = isCanon ? '★' : '';
      if (isCanon) cc.font = { bold: true };
      row.getCell(10).value = o.note ?? '';
      r++;
    }
  }
  [22, 34, 28, 12, 10, 16, 42, 8, 10, 52].forEach((w, i) => {
    os.getColumn(i + 1).width = w;
  });

  // ---- Glossary (acronyms + v2 terms by hand; sources + structure from the graph) ----
  const gl = wb.addWorksheet('Glossary', { views: [{ state: 'frozen', ySplit: 2 }] });
  gl.mergeCells('A1:B1');
  gl.mergeCells('A2:B2');
  titleBar(gl, 'Glossary, Acronyms & Sources — v2', 2);
  note(
    gl.getCell('A2'),
    'Quick reference for acronyms, the v2 model vocabulary, data sources, and model structure',
  );
  let gr = 4;
  const glSection = (title: string, fill: string, headers: [string, string]): void => {
    sectionBar(gl, gr, title, fill, 2);
    gr++;
    headerRow(gl, gr, headers, 'ECEFF1');
    gr++;
  };
  const glRow = (k: string, v: string): void => {
    const row = gl.getRow(gr);
    row.getCell(1).value = k;
    row.getCell(1).font = { bold: true };
    row.getCell(2).value = v;
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    gr++;
  };

  glSection('ACRONYMS & ABBREVIATIONS', '1565C0', ['Acronym', 'Meaning']);
  for (const [a, m] of [
    ['NHE', 'National Health Expenditures (CMS annual accounts)'],
    ['FFS', 'Fee-for-service'],
    ['MA', 'Medicare Advantage (Part C)'],
    ['MA-PD', 'Medicare Advantage Prescription Drug plan'],
    ['MCO', 'Managed Care Organization (Medicaid managed care)'],
    ['FMAP', 'Federal Medical Assistance Percentage (federal Medicaid match)'],
    ['DSH', 'Disproportionate Share Hospital payments'],
    ['LTSS', 'Long-Term Services & Supports (Medicaid)'],
    ['HCBS', 'Home- & Community-Based Services'],
    ['SNF', 'Skilled Nursing Facility'],
    ['ESI', 'Employer-Sponsored Insurance'],
    ['ACA', 'Affordable Care Act'],
    ['APTC', 'Advance Premium Tax Credit (ACA premium subsidies)'],
    ['PHI', 'Private Health Insurance'],
    ['OOP', 'Out-of-Pocket'],
    [
      'HI / SMI',
      'Hospital Insurance (Medicare Part A trust fund) / Supplementary Medical Insurance (Parts B & D)',
    ],
    ['SG&A', 'Selling, General & Administrative expenses'],
    ['COGS', 'Cost of Goods Sold'],
    ['PBM', 'Pharmacy Benefit Manager'],
    ['DME', 'Durable Medical Equipment'],
    ['MLR', 'Medical Loss Ratio (claims ÷ premiums)'],
    ['PE', 'Private Equity'],
    ['CMS', 'Centers for Medicare & Medicaid Services'],
    ['MedPAC', 'Medicare Payment Advisory Commission'],
    ['MACPAC', 'Medicaid and CHIP Payment and Access Commission'],
    ['KFF', 'Kaiser Family Foundation'],
    ['AHA', 'American Hospital Association'],
    ['PhRMA', 'Pharmaceutical Research and Manufacturers of America'],
  ])
    glRow(a, m);
  gr++;

  glSection('KEY TERMS (v2 model)', '00838F', ['Term', 'Meaning']);
  for (const [t, m] of [
    ['Observation', "One source's measurement of a flow: value + source + basis + confidence."],
    [
      'Canonical observation',
      'The one value per edge used in totals and balance checks (the v1 amount). Implicit when an edge has a single observation.',
    ],
    [
      'Basis (modeled / national)',
      'The lens a figure is measured on: this model’s traced flow (modeled) vs an all-payer NHE reference (national).',
    ],
    [
      'Also reported',
      'When an edge has more than one source, the non-canonical values shown as neutral context in Notes ("also reported: …"). This is a big-picture flow model — sources a few $B apart are recorded and one is picked, not flagged as a discrepancy.',
    ],
    [
      'Feedback edge',
      'A flow back to an earlier layer (e.g. corporate income tax → Government). Makes the model a circular flow, not a one-way tree.',
    ],
    [
      'Sub-node (node.parent)',
      'A child node that carries the edges; its parent is a pure aggregate that rolls the children up and renders them as nested blocks.',
    ],
    [
      'Split (edge.split[])',
      'Line-item breakdown of one edge that must sum to its canonical value; rendered as indented sub-rows.',
    ],
    [
      'Category (edge.category)',
      'Grouping key; a section groups into labeled subtotals when 2+ categories are present.',
    ],
    [
      'Traced subset',
      'The model traces specific flows, so a node’s inflow need not equal its outflow. Intentional, not an error.',
    ],
  ])
    glRow(t, m);
  gr++;

  glSection('DATA SOURCES (sources{} in graph.json)', '2E7D32', ['Key', 'Citation']);
  for (const [k, v] of Object.entries(file.sources).sort((a, b) => a[0].localeCompare(b[0])))
    glRow(k, v);
  gr++;

  glSection('MODEL STRUCTURE', '6A1B9A', ['Layer / Group', 'Detail']);
  for (const l of [...file.layers].sort((a, b) => a.n - b.n)) glRow(`Layer ${l.n}`, l.name);
  for (const g of file.groups) glRow(`Group: ${g.id}`, g.label);

  [26, 96].forEach((w, i) => {
    gl.getColumn(i + 1).width = w;
  });

  return wb;
}
