// Excel workbook, generated from data/graph.json (plus the editorial overlays in
// data/sheets/). Per-node INFLOWS/OUTFLOWS/NET ledger sheets.
// Sheets:
//
//   Overview        — front page: counts, total, linked node summary, flow summary, multi-source snapshot
//   <node> ledgers  — one per top-level node (see ledger.ts); sub-nodes nest inside parents
//   Nodes           — inflow/outflow/throughput/net summary (audit)
//   Edges           — one row per flow: canonical value + any other sources reported
//   Observations    — one row per source measurement (★ = canonical)
//   Labor Cross-Check (BLS) — labor edges × BLS OEWS May 2023; numbers link back to the
//                   Healthcare Workers sheet. Complementary context, rendered from the
//                   committed data/labor_bls.json (see scripts/reconcile_labor.mjs).
//   Insurance & Spending (S5) — extends Finkelstein 2005 (w11619) §5 to 2024: national
//                   coinsurance series + back-of-the-envelope, from data/finkelstein_s5.json.
//   Hospital Sector (Finkelstein) — the paper's actual subject: hospital coinsurance,
//                   windows, and the 1966 Medicare payer-mix break (same data file).
//   Glossary        — acronyms, model terms, and sources/structure from the graph
//
// Pure construction: returns an ExcelJS.Workbook, no file IO. Erasable-syntax-only TS.
import ExcelJS from 'exceljs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { footnoteSources, addSheetsToWorkbook } from './workbook.ts';
import { renderNodeLedger, loadOverlays } from './ledger.ts';
import { computeFlows, canonicalObservation, type GraphFile } from './graph.ts';

const CUR = '$#,##0.0##';
const argb = (hex: string): string => 'FF' + hex.replace('#', '').toUpperCase();
const rnd = (n: number): number => Math.round(n * 1000) / 1000;

export function buildWorkbook(file: GraphFile, root: string): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'src/build.ts';

  const nodes = file.graph.nodes;
  const edges = file.graph.edges;
  const { inflow, outflow, throughput } = computeFlows(file);

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
  titleBar(ov, '2023 U.S. Healthcare Flow-of-Funds — Overview', 6);
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

  // scope & coverage — what the model deliberately traces vs leaves out. It's a
  // traced-subset model (see docs/data-model.md), so this is honest framing, not a deficiency:
  // a node's inflow is the payer flows we follow, below its NHE national total.
  sectionBar(ov, ovr, 'SCOPE & COVERAGE', '00695C', 6);
  ovr++;
  for (const line of [
    'A traced-subset model: it follows specific payer → provider → worker / supplier / capital flows,',
    'not every dollar in the national accounts. For reference, CMS NHE 2023 = $4,866.5B.',
    'Traced: hospitals · physician & clinical · dental · other professional · retail Rx · nursing & home health · plus',
    'government direct spending (administration · public health · NIH research · VA / DoD) and employer retiree, workers-comp & HSA/HRA.',
    'Not modeled (by design): DME & non-durable products · residential care · construction · the remaining other-payer residual.',
    'Each provider sheet’s VALIDATION section shows how much of its NHE national total the model traces.',
  ]) {
    note(ov.getRow(ovr).getCell(1), line);
    ovr++;
  }
  ovr++;

  // where the money ends up — the terminal (sink) layer, computed from the model's flows.
  // This is the model's figure (share of the traced flow's final layer), NOT the NHE-based
  // "45% to labor" — different basis, so we report what this model actually shows.
  const sinks = topLevel
    .filter((n) => n.role === 'sink')
    .sort((a, b) => (inflow[b.id] ?? 0) - (inflow[a.id] ?? 0));
  const terminalTotal = sinks.reduce((s, n) => s + (inflow[n.id] ?? 0), 0);
  const sinkDesc: Record<string, string> = {
    healthcare_workers: 'labor — wages, salaries, benefits',
    suppliers_vendors: 'non-labor — drugs, devices, supplies, IT, facilities',
    capital_markets: 'margins, dividends, buybacks, retained earnings',
  };
  sectionBar(ov, ovr, 'WHERE THE MONEY ENDS UP  (the traced flow’s final layer)', '4E342E', 6);
  ovr++;
  const wmHead = ov.getRow(ovr);
  ['Destination', 'Amount ($B)', 'Share', 'What it is'].forEach((h, i) => {
    wmHead.getCell(i + 1).value = h;
    wmHead.getCell(i + 1).font = { bold: true };
    solid(wmHead.getCell(i + 1), 'D7CCC8');
  });
  ovr++;
  for (const n of sinks) {
    const amt = inflow[n.id] ?? 0;
    const row = ov.getRow(ovr);
    row.getCell(1).value = n.label;
    money(row.getCell(2), amt);
    const pc = row.getCell(3);
    pc.value = terminalTotal ? amt / terminalTotal : 0;
    pc.numFmt = '0.0%';
    row.getCell(4).value = sinkDesc[n.id] ?? '';
    ovr++;
  }
  ov.getRow(ovr).getCell(1).value = 'TERMINAL TOTAL';
  ov.getRow(ovr).getCell(1).font = { bold: true };
  money(ov.getRow(ovr).getCell(2), terminalTotal);
  ov.getRow(ovr).getCell(2).font = { bold: true };
  ovr++;
  const laborPct = terminalTotal
    ? Math.round((100 * (inflow[sinks[0]?.id] ?? 0)) / terminalTotal)
    : 0;
  const taxToGov = edges
    .filter((e) => e.channel === 'Corporate income tax')
    .reduce((s, e) => s + canonicalObservation(e).value, 0);
  note(
    ov.getRow(ovr).getCell(1),
    `~${laborPct}¢ of every traced dollar that reaches the economy ends as labor. US health administration alone runs ~15–30% of spend vs ~2–5% in peer countries (Commonwealth Fund).`,
  );
  ovr++;
  note(
    ov.getRow(ovr).getCell(1),
    `Plus $${rnd(taxToGov)}B corporate income tax routed back to Government — a feedback edge, not a terminal destination.`,
  );
  ovr += 2;

  // node summary — linked to each node's sheet
  sectionBar(ov, ovr, 'NODE SUMMARY  (click a node to open its sheet)', '1B5E20', 6);
  ovr++;
  headerRow(
    ov,
    ovr,
    ['Node', 'Layer', 'Inflow ($B)', 'Outflow ($B)', 'Net ($B)', 'Context'],
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
    row.getCell(6).value = n.description ?? netNote(n, i - o);
    ovr++;
  }
  ovr++;

  // flow summary — every flow between two nodes, largest first. Sub-nodes roll up to
  // their parent so this reads at NODE SUMMARY's grain (and From/To link to real sheets);
  // amounts sum canonical values across all channels for a pair. Sums to the total above.
  const parentOf: Record<string, string> = {};
  for (const n of nodes) if (n.parent) parentOf[n.id] = n.parent;
  const topOf = (id: string): string => parentOf[id] ?? id;
  const pairAmt = new Map<string, { from: string; to: string; amt: number }>();
  for (const e of edges) {
    const from = topOf(e.from);
    const to = topOf(e.to);
    if (from === to) continue; // a within-parent edge would self-loop after rollup
    const key = from + ' ' + to;
    const agg = pairAmt.get(key) ?? { from, to, amt: 0 };
    agg.amt += canonicalObservation(e).value;
    pairAmt.set(key, agg);
  }
  const flowRows = [...pairAmt.values()].sort((a, b) => b.amt - a.amt);
  sectionBar(ov, ovr, 'FLOW SUMMARY  (money moved between nodes, largest first)', '4527A0', 6);
  ovr++;
  headerRow(ov, ovr, ['From', 'To', 'Amount ($B)', '% of total'], 'D1C4E9');
  ovr++;
  const linkTo = (cell: ExcelJS.Cell, lbl: string): void => {
    cell.value = { formula: `HYPERLINK("#'${lbl}'!A1","${lbl}")`, result: lbl };
    cell.font = { color: { argb: 'FF0563C1' } };
  };
  for (const fl of flowRows) {
    const row = ov.getRow(ovr);
    linkTo(row.getCell(1), labelOf(fl.from));
    linkTo(row.getCell(2), labelOf(fl.to));
    money(row.getCell(3), fl.amt);
    const pc = row.getCell(4);
    pc.value = grandTotal ? fl.amt / grandTotal : 0;
    pc.numFmt = '0.0%';
    ovr++;
  }
  note(
    ov.getRow(ovr).getCell(1),
    `${flowRows.length} node-to-node flows; sub-nodes rolled into their parent. Sums to the total traced flow above.`,
  );
  ovr += 2;

  // multi-source snapshot — edges with more than one source, and the value the model
  // uses. Big-picture flow model: this is neutral context (what else was reported), not
  // a discrepancy to flag — see docs/data-model.md.
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
  [34, 26, 13, 13, 13, 50].forEach((w, i) => {
    ov.getColumn(i + 1).width = w;
  });

  // ---- node-ledger sheets (one per node) ----
  // Ordered by layer so the workbook reads left-to-right with the flow. A node with
  // a data/sheets/<node>.json overlay renders curated (labels, extras, checks);
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

  // ---- audit sheets ----
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
    'Nodes — derived from data/graph.json (flows = canonical observations)',
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
  titleBar(es, 'Edges — one row per flow; canonical value + any other sources', eHead.length);
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
  titleBar(os, 'Observations — every source measurement (★ = canonical)', oHead.length);
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

  // ---- Labor Cross-Check (BLS) ----
  // Complementary context (NOT a gate): the labor edges into Healthcare Workers, seen
  // through BLS OEWS May 2023 industry data. Numbers are derived offline into the
  // committed data/labor_bls.json by scripts/reconcile_labor.mjs (the BLS source files
  // are git-ignored), and rendered here. Model $ are read live from the graph so they
  // never drift; the BLS file carries headcount/wages/occupations only. Each model $
  // links back to that edge's inflow row on the Healthcare Workers sheet.
  const blsPath = join(root, 'data', 'labor_bls.json');
  if (existsSync(blsPath)) {
    type BlsOcc = { title: string; emp: number; mean: number | null; capped: boolean };
    type BlsEdge = {
      edgeId: string;
      naics: string;
      industry: string;
      jobs: number | null;
      meanWage: number | null;
      note: string;
      top: BlsOcc[];
    };
    type BlsFile = {
      source: string;
      benefitLoad: number;
      edges: BlsEdge[];
      broadNursing: {
        forEdge: string;
        naics: string;
        industry: string;
        jobs: number;
        meanWage: number;
      } | null;
      anchors: {
        practitioners: { code: string; title: string; emp: number; mean: number };
        support: { code: string; title: string; emp: number; mean: number };
      };
      government: { edgeId: string; note: string }[];
    };
    const bls = JSON.parse(readFileSync(blsPath, 'utf8')) as BlsFile;
    const load = bls.benefitLoad;
    const NC = 8;
    const INT = '#,##0';
    const USD0 = '$#,##0';
    const edgeById = new Map(edges.map((e) => [e.id, e]));
    const modelOf = (id: string): number => {
      const e = edgeById.get(id);
      return e ? canonicalObservation(e).value : 0;
    };

    const ws = wb.addWorksheet('Labor Cross-Check (BLS)', {
      views: [{ state: 'frozen', ySplit: 2 }],
    });
    ws.mergeCells('A1:H1');
    ws.mergeCells('A2:H2');
    titleBar(ws, 'Labor Cross-Check — model labor edges × BLS OEWS May 2023', NC);
    note(
      ws.getCell('A2'),
      `Complementary context, not a gate. Model $ = total comp (live from graph.json); BLS = wages of payroll employees, grossed to comp ×${load} (ECEC). Blue numbers link to the Healthcare Workers sheet.`,
    );

    // link an edge's model $ (or its label) back to that edge's inflow row on Healthcare Workers
    const linkNum = (cell: ExcelJS.Cell, edgeId: string, v: number): void => {
      const t = inLoc.get(edgeId);
      const x = rnd(v);
      if (t) {
        cell.value = { formula: `HYPERLINK("#'${t.sheet}'!B${t.row}",${x})`, result: x };
        cell.font = { color: { argb: 'FF0563C1' } };
      } else cell.value = x;
      cell.numFmt = CUR;
    };
    const linkLabel = (cell: ExcelJS.Cell, edgeId: string, text: string): void => {
      const t = inLoc.get(edgeId);
      if (t) {
        cell.value = { formula: `HYPERLINK("#'${t.sheet}'!A${t.row}","${text}")`, result: text };
        cell.font = { color: { argb: 'FF0563C1' } };
      } else cell.value = text;
    };
    const plain = (cell: ExcelJS.Cell, v: number, fmt: string): void => {
      cell.value = Math.round(v);
      cell.numFmt = fmt;
    };

    let lr = 4;
    sectionBar(
      ws,
      lr,
      'RECONCILIATION  (model $ ÷ BLS jobs = what each edge pays per worker)',
      '0D47A1',
      NC,
    );
    lr++;
    headerRow(
      ws,
      lr,
      [
        'Edge → BLS industry',
        'Model $B',
        'NAICS',
        'BLS jobs',
        'BLS wages $B',
        `BLS comp $B (×${load})`,
        'Model $/worker',
        'BLS comp/worker',
      ],
      'BBDEFB',
    );
    lr++;
    let mapJobs = 0;
    let mapDollars = 0;
    for (const e of bls.edges) {
      const model = modelOf(e.edgeId);
      const wages = e.jobs && e.meanWage ? (e.jobs * e.meanWage) / 1e9 : null;
      mapJobs += e.jobs ?? 0;
      mapDollars += model;
      const row = ws.getRow(lr);
      linkLabel(row.getCell(1), e.edgeId, e.edgeId.replace(/_workers_labor/, ''));
      linkNum(row.getCell(2), e.edgeId, model);
      row.getCell(3).value = `${e.industry} (${e.naics})`;
      if (e.jobs) plain(row.getCell(4), e.jobs, INT);
      if (wages != null) money(row.getCell(5), wages);
      if (wages != null) money(row.getCell(6), wages * load);
      if (e.jobs) plain(row.getCell(7), (model * 1e9) / e.jobs, USD0);
      if (e.meanWage) plain(row.getCell(8), e.meanWage * load, USD0);
      if (e.note) note(row.getCell(9), '⚠ ' + e.note);
      lr++;
    }
    if (bls.broadNursing) {
      const a = bls.broadNursing;
      const row = ws.getRow(lr);
      note(row.getCell(1), '  ↳ if counted as all nursing+residential care (623)');
      plain(row.getCell(4), a.jobs, INT);
      money(row.getCell(5), (a.jobs * a.meanWage) / 1e9);
      money(row.getCell(6), (a.jobs * a.meanWage * load) / 1e9);
      plain(row.getCell(7), (modelOf(a.forEdge) * 1e9) / a.jobs, USD0);
      plain(row.getCell(8), a.meanWage * load, USD0);
      lr++;
    }
    // subtotal + government + total
    const subRow = ws.getRow(lr);
    subRow.getCell(1).value = 'Mapped subtotal (8 edges)';
    subRow.getCell(1).font = { bold: true };
    money(subRow.getCell(2), mapDollars);
    subRow.getCell(2).font = { bold: true };
    plain(subRow.getCell(4), mapJobs, INT);
    subRow.getCell(4).font = { bold: true };
    lr++;
    let govDollars = 0;
    for (const g of bls.government) {
      const model = modelOf(g.edgeId);
      govDollars += model;
      const row = ws.getRow(lr);
      linkLabel(row.getCell(1), g.edgeId, g.edgeId);
      linkNum(row.getCell(2), g.edgeId, model);
      row.getCell(3).value = 'no OEWS NAICS (government)';
      note(row.getCell(9), g.note);
      lr++;
    }
    const totRow = ws.getRow(lr);
    totRow.getCell(1).value = 'TOTAL → Healthcare Workers';
    totRow.getCell(1).font = { bold: true };
    money(totRow.getCell(2), mapDollars + govDollars);
    totRow.getCell(2).font = { bold: true };
    lr += 2;

    // headcount anchors (occupation view)
    sectionBar(
      ws,
      lr,
      'HEADCOUNT ANCHORS  (occupation view — how many people, nationally)',
      '00695C',
      NC,
    );
    lr++;
    headerRow(ws, lr, ['SOC', 'Occupation group', 'People', 'Mean wage'], 'B2DFDB');
    lr++;
    for (const a of [bls.anchors.practitioners, bls.anchors.support]) {
      const row = ws.getRow(lr);
      row.getCell(1).value = a.code;
      row.getCell(2).value = a.title;
      plain(row.getCell(3), a.emp, INT);
      plain(row.getCell(4), a.mean, USD0);
      lr++;
    }
    const clin = bls.anchors.practitioners.emp + bls.anchors.support.emp;
    const cl = ws.getRow(lr);
    cl.getCell(2).value = 'Clinical-occupation total (29+31)';
    cl.getCell(2).font = { bold: true };
    plain(cl.getCell(3), clin, INT);
    cl.getCell(3).font = { bold: true };
    lr++;
    const mj = ws.getRow(lr);
    mj.getCell(2).value = 'Mapped-industry headcount (8 edges above)';
    plain(mj.getCell(3), mapJobs, INT);
    note(
      mj.getCell(5),
      'node label says ~22M = the broader health care + social assistance sector',
    );
    lr += 2;

    // job functions inside each edge
    sectionBar(
      ws,
      lr,
      'JOB FUNCTIONS INSIDE EACH EDGE  (top occupations by employment)',
      '4E342E',
      NC,
    );
    lr++;
    headerRow(ws, lr, ['Edge / occupation', '', 'BLS jobs', 'Mean wage', 'Wage bill $B'], 'D7CCC8');
    lr++;
    for (const e of bls.edges) {
      const head = ws.getRow(lr);
      head.getCell(1).value = `${e.edgeId.replace(/_workers_labor/, '')} — ${e.industry}`;
      head.getCell(1).font = { bold: true };
      if (e.note) note(head.getCell(5), e.note);
      lr++;
      for (const o of e.top) {
        const row = ws.getRow(lr);
        row.getCell(1).value = '   ' + o.title;
        plain(row.getCell(3), o.emp, INT);
        if (o.mean) plain(row.getCell(4), o.mean, USD0);
        else if (o.capped) note(row.getCell(4), '≥$239k (top-coded)');
        if (o.mean) money(row.getCell(5), (o.emp * o.mean) / 1e9);
        lr++;
      }
    }
    lr++;
    note(
      ws.getRow(lr).getCell(1),
      `Source: ${bls.source}. Derived by scripts/reconcile_labor.mjs → data/labor_bls.json. A traced-subset cross-check — divergences are explained by self-employed income, BLS wage top-coding, contract labor, headcount scope and the pharma/insurer 50% labor split, not flagged as errors.`,
    );
    [40, 12, 30, 12, 14, 16, 16, 16].forEach((w, i) => {
      ws.getColumn(i + 1).width = w;
    });
  } else {
    console.warn(
      'bls   -> data/labor_bls.json absent; skipping Labor Cross-Check sheet (run: npm run reconcile:labor)',
    );
  }

  // ---- Insurance & Spending (Finkelstein S5) ----
  // Complementary aggregate analysis (NOT the flow model, NOT a gate): extends Section 5
  // of Finkelstein 2005 (NBER w11619) through 2024. The average coinsurance rate
  // (out-of-pocket ÷ total NHE) is her proxy for the spread of insurance; applying her
  // own 23%-per-7pp Medicare elasticity to its decline gives the share of real per-capita
  // spending growth attributable to insurance spreading. Derived offline into the committed
  // data/finkelstein_s5.json by scripts/extend_finkelstein_s5.mjs (the NHE CSV is
  // git-ignored). Differing window results are context, not discrepancies.
  const finkPath = join(root, 'data', 'finkelstein_s5.json');
  if (existsSync(finkPath)) {
    type FinkWindow = {
      from: number;
      to: number;
      kind: string;
      finkelstein?: string;
      context?: string;
      coinsuranceFromPct: number;
      coinsuranceToPct: number;
      dropPP: number;
      predictedSpendingPct: number;
      realPerCapitaGrowthPct: number;
      explainedSharePct: number;
    };
    type FinkFile = {
      paper: string;
      method: string;
      nheSource: string;
      cpiSource: string;
      pctPerPp: number;
      caveats: string[];
      coinsuranceSeries: {
        year: number;
        totalMillions: number;
        oopMillions: number;
        coinsurancePct: number;
      }[];
      windows: FinkWindow[];
      hospital: {
        coinsuranceSeries: { year: number; coinsurancePct: number }[];
        windows: FinkWindow[];
        payerMix: {
          year: number;
          oopPct: number;
          privatePct: number;
          medicarePct: number;
          medicaidPct: number;
          otherPct: number;
        }[];
      };
    };
    const fink = JSON.parse(readFileSync(finkPath, 'utf8')) as FinkFile;
    const NC = 6;
    const PP = '0.0"pp"';
    const GROW = '"+"0"%"';
    const SHARE = '0"%"';
    const PCT1 = '0.0%';
    const USD1 = '$#,##0.0';

    const ws = wb.addWorksheet('Insurance & Spending (S5)', {
      views: [{ state: 'frozen', ySplit: 2 }],
    });
    ws.mergeCells('A1:F1');
    ws.mergeCells('A2:F2');
    titleBar(ws, 'Insurance & Spending — extending Finkelstein (2005, NBER w11619) §5 to 2024', NC);
    note(
      ws.getCell('A2'),
      `Aggregate cross-check, not a gate. Coinsurance = out-of-pocket ÷ total NHE; predicted spending rise = coinsurance drop × ${fink.pctPerPp.toFixed(2)}%/pp (her 23%-per-7pp Medicare estimate); "explains" = predicted ÷ actual real per-capita growth.`,
    );

    // back-of-the-envelope by window
    let fr = 4;
    sectionBar(
      ws,
      fr,
      'BACK-OF-THE-ENVELOPE  (how much of the spending rise the spread of insurance explains)',
      '0D47A1',
      NC,
    );
    fr++;
    headerRow(
      ws,
      fr,
      [
        'Window',
        'Coinsurance drop',
        'Predicted spending rise',
        'Actual real per-capita rise',
        'Insurance explains',
        'Validation / extension',
      ],
      'BBDEFB',
    );
    fr++;
    const fcell = (r: number, c: number, v: number, fmt: string, bold?: boolean): void => {
      const cell = ws.getRow(r).getCell(c);
      cell.value = v;
      cell.numFmt = fmt;
      if (bold) cell.font = { bold: true };
    };
    for (const w of fink.windows) {
      const row = ws.getRow(fr);
      row.getCell(1).value = `${w.from}–${w.to}`;
      fcell(fr, 2, w.dropPP, PP);
      fcell(fr, 3, w.predictedSpendingPct, GROW);
      fcell(fr, 4, w.realPerCapitaGrowthPct, GROW);
      fcell(fr, 5, w.explainedSharePct, SHARE, true);
      if (w.kind === 'validation') {
        row.getCell(6).value = `validation — Finkelstein ${w.finkelstein}`;
        row.getCell(6).font = { italic: true, color: { argb: 'FF1B5E20' } };
      } else {
        note(row.getCell(6), 'extension (post-2005)');
      }
      fr++;
    }
    note(
      ws.getRow(fr).getCell(1),
      'The 1990–2000 validation lands near her "about half"; the post-2000 share shrinks as coinsurance nears its floor — the insurance-spread channel is largely spent, leaving the residual (technology, prices) to dominate.',
    );
    fr += 2;

    // average coinsurance rate, full series
    sectionBar(
      ws,
      fr,
      'AVERAGE COINSURANCE RATE, 1960–2024  (out-of-pocket ÷ total NHE)',
      '00695C',
      NC,
    );
    fr++;
    headerRow(
      ws,
      fr,
      ['Year', 'Total NHE ($B)', 'Out-of-pocket ($B)', 'Coinsurance rate', 'Trend', ''],
      'B2DFDB',
    );
    fr++;
    for (const p of fink.coinsuranceSeries) {
      const row = ws.getRow(fr);
      row.getCell(1).value = p.year;
      fcell(fr, 2, p.totalMillions / 1000, USD1);
      fcell(fr, 3, p.oopMillions / 1000, USD1);
      fcell(fr, 4, p.coinsurancePct / 100, PCT1);
      // text bar (REPT) proportional to the rate — a chart-free sparkline that renders anywhere
      row.getCell(5).value = { formula: `REPT("█",ROUND(D${fr}*50,0))`, result: '' };
      row.getCell(5).font = { color: { argb: 'FF26A69A' } };
      if (p.year === 1966) {
        note(row.getCell(6), '◄ Medicare & Medicaid begin (1965 enacted, 1966 implemented)');
      }
      fr++;
    }
    fr++;
    for (const line of [
      `Source: ${fink.nheSource}. Deflator: ${fink.cpiSource}.`,
      `Derived by scripts/extend_finkelstein_s5.mjs → data/finkelstein_s5.json. ${fink.paper}.`,
      ...fink.caveats.map((c) => 'Caveat: ' + c),
    ]) {
      note(ws.getRow(fr).getCell(1), line);
      fr++;
    }
    [14, 18, 22, 24, 24, 44].forEach((w, i) => {
      ws.getColumn(i + 1).width = w;
    });

    // ---- Hospital Sector (Finkelstein's actual subject) ----
    // Section 3 of the paper is hospital-specific, and her 23%-per-7pp estimate IS a hospital
    // spending response — so applying it to hospital coinsurance is the most direct use. The
    // payer-mix table makes Medicare's 1966 hospital takeover visible (out-of-pocket even
    // falls in absolute dollars that year). Tied back to the model's Hospitals ledger.
    const H = fink.hospital;
    const hws = wb.addWorksheet('Hospital Sector (Finkelstein)', {
      views: [{ state: 'frozen', ySplit: 2 }],
    });
    hws.mergeCells('A1:F1');
    hws.mergeCells('A2:F2');
    titleBar(
      hws,
      'Hospital Sector — the part of the system Finkelstein actually studied (w11619 §3)',
      NC,
    );
    note(
      hws.getCell('A2'),
      "Hospitals were the largest component of spending and of its growth. Her 23%-per-7pp estimate is itself a hospital spending response, so this applies it to hospital coinsurance directly. See the model's Hospitals sheet for FY2023 hospital flows.",
    );
    const hcell = (r: number, c: number, v: number, fmt: string, bold?: boolean): void => {
      const cell = hws.getRow(r).getCell(c);
      cell.value = v;
      cell.numFmt = fmt;
      if (bold) cell.font = { bold: true };
    };

    let hr = 4;
    sectionBar(
      hws,
      hr,
      'HOSPITAL BACK-OF-THE-ENVELOPE  (her hospital elasticity × hospital coinsurance)',
      '0D47A1',
      NC,
    );
    hr++;
    headerRow(
      hws,
      hr,
      [
        'Window',
        'Coinsurance drop',
        'Predicted spending rise',
        'Actual real per-capita rise',
        'Insurance explains',
        'Context',
      ],
      'BBDEFB',
    );
    hr++;
    for (const w of H.windows) {
      const row = hws.getRow(hr);
      row.getCell(1).value = `${w.from}–${w.to}`;
      hcell(hr, 2, w.dropPP, PP);
      hcell(hr, 3, w.predictedSpendingPct, GROW);
      hcell(hr, 4, w.realPerCapitaGrowthPct, GROW);
      hcell(hr, 5, w.explainedSharePct, SHARE, true);
      if (w.kind === 'core') {
        row.getCell(6).value = w.context ?? 'core expansion window';
        row.getCell(6).font = { bold: true, color: { argb: 'FF1B5E20' } };
      } else {
        note(row.getCell(6), 'applies her hospital elasticity');
      }
      hr++;
    }
    note(
      hws.getRow(hr).getCell(1),
      'The 1965–1980 window — when hospital coinsurance was genuinely falling — is where the channel explains the most. By 1990 hospital out-of-pocket is near its floor, so later hospital growth is overwhelmingly the residual (technology, intensity, prices).',
    );
    hr += 2;

    sectionBar(
      hws,
      hr,
      'HOSPITAL PAYER MIX, 1960–2024  (share of hospital spending; Medicare arrives 1966)',
      '4E342E',
      NC,
    );
    hr++;
    headerRow(
      hws,
      hr,
      ['Year', 'Out-of-pocket', 'Private insurance', 'Medicare', 'Medicaid', 'Other payers'],
      'D7CCC8',
    );
    hr++;
    for (const m of H.payerMix) {
      const row = hws.getRow(hr);
      row.getCell(1).value = m.year;
      hcell(hr, 2, m.oopPct / 100, PCT1);
      hcell(hr, 3, m.privatePct / 100, PCT1);
      hcell(hr, 4, m.medicarePct / 100, PCT1);
      hcell(hr, 5, m.medicaidPct / 100, PCT1);
      hcell(hr, 6, m.otherPct / 100, PCT1);
      if (m.year === 1966) {
        for (let c = 1; c <= NC; c++) solid(row.getCell(c), 'FFF9C4'); // highlight the break year
        row.getCell(1).font = { bold: true };
      }
      hr++;
    }
    hr++;
    // tie the research sheet back to the flow model's Hospitals ledger
    const hospLink = hws.getRow(hr).getCell(1);
    hospLink.value = {
      formula: `HYPERLINK("#'Hospitals'!A1","→ Hospitals sheet: FY2023 hospital flows in the model")`,
      result: '→ Hospitals sheet: FY2023 hospital flows in the model',
    };
    hospLink.font = { color: { argb: 'FF0563C1' } };
    hr++;
    const firstHosp = H.coinsuranceSeries[0];
    const lastHosp = H.coinsuranceSeries[H.coinsuranceSeries.length - 1];
    for (const line of [
      `Hospital coinsurance fell ${firstHosp.coinsurancePct.toFixed(1)}% (${firstHosp.year}) → ${lastHosp.coinsurancePct.toFixed(1)}% (${lastHosp.year}) — steeper than the national rate, since Medicare hit hospitals first and hardest.`,
      `Source: ${fink.nheSource}. Derived by scripts/extend_finkelstein_s5.mjs → data/finkelstein_s5.json.`,
    ]) {
      note(hws.getRow(hr).getCell(1), line);
      hr++;
    }
    [14, 20, 22, 26, 18, 40].forEach((w, i) => {
      hws.getColumn(i + 1).width = w;
    });
  } else {
    console.warn(
      'nhe   -> data/finkelstein_s5.json absent; skipping Insurance & Spending sheets (run: npm run derive:finkelstein)',
    );
  }

  // ---- Glossary (acronyms + model terms by hand; sources + structure from the graph) ----
  const gl = wb.addWorksheet('Glossary', { views: [{ state: 'frozen', ySplit: 2 }] });
  gl.mergeCells('A1:B1');
  gl.mergeCells('A2:B2');
  titleBar(gl, 'Glossary, Acronyms & Sources', 2);
  note(
    gl.getCell('A2'),
    'Quick reference for acronyms, the model vocabulary, data sources, and model structure',
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

  glSection('KEY TERMS', '00838F', ['Term', 'Meaning']);
  for (const [t, m] of [
    ['Observation', "One source's measurement of a flow: value + source + basis + confidence."],
    [
      'Canonical observation',
      'The one value per edge used in totals and balance checks. Implicit when an edge has a single observation.',
    ],
    [
      'Basis (modeled / national)',
      'The lens a figure is measured on: this model’s traced flow (modeled) vs an all-payer NHE reference (national).',
    ],
    [
      'Confidence (reported / estimate)',
      'Each observation is tagged reported (a published figure — CMS NHE, MedPAC, MACPAC, KFF, AHA, PhRMA) or estimate (derived / backsolved from ratios). Treat estimates as order-of-magnitude: a “$294B physician salaries” figure is really $1,027B × 0.52 × 0.55 — three assumptions multiplied. The big-picture flow is robust; the finer sub-splits are directional, not precise.',
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
