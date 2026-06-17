// Render a v1-style node-ledger Sheet from the v2 graph. Two modes:
//
//   auto     renderNodeLedger(file, nodeId)            — one row per edge, no curation
//   overlay  renderNodeLedger(file, nodeId, overlay)   — an editorial layer (curated
//            labels/notes, `extra` rows for flows not in the graph, and an
//            independent-source VALIDATION section) ported from v1's per-node sheets
//
// Either way: inflows = incoming edges, outflows = outgoing edges, amounts come from
// each edge's canonical observation, source-only/sink-only nodes drop the empty
// section, and where an edge carries more than one observation the cross-source flag
// rides in the Notes column. The v2 improvement over v1: a single-edge independent
// figure (e.g. MA net $454B) lives as that edge's observation and surfaces here
// automatically — only genuinely composite checks (totals, Part B = a+b+c) are
// hand-authored in `checks`.
//
// Emits the shared Sheet (Cell) model so it pours through src/workbook.ts; the
// returned `flows` let xlsx.ts wire each edge amount to its counterpart end.
// Erasable-syntax-only TypeScript.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Sheet, Cell, Style } from '../src/render-sheet.ts';
import { canonicalObservation, type GraphFileV2, type EdgeV2 } from './graph.ts';

const CUR = '\\$#,##0;"($"#,##0\\);\\-';
const CUR_TOTAL = '\\$#,##0';
const PCT = '0.0%';
const THEME = {
  title: { b: true, sz: 13, color: 'FFFFFF', fill: '263238', h: 'left' } as Style,
  subtitle: { sz: 10, color: '666666', h: 'left' } as Style,
  totalFill: 'E3F2FD',
  netFill: 'FFF9C4',
  inflow: { bar: '1B5E20', head: 'C8E6C9' },
  outflow: { bar: 'B71C1C', head: 'FFCDD2' },
  validation: { bar: 'E65100', head: 'FFE0B2' },
  label: { sz: 10, h: 'left' } as Style,
  amount: { sz: 10, h: 'right', v: 'center', fmt: CUR } as Style,
  pct: { sz: 10, h: 'right', v: 'center', fmt: PCT } as Style,
  note: { sz: 9, color: '666666', h: 'left' } as Style,
  source: { sz: 8, color: '888888', h: 'left' } as Style,
  childLabel: { sz: 9, color: '555555', h: 'left' } as Style,
  childAmount: { sz: 9, color: '555555', h: 'right', v: 'center', fmt: CUR } as Style,
  childPct: { sz: 9, color: '888888', h: 'right', v: 'center', fmt: PCT } as Style,
  childNote: { sz: 8, color: '888888', h: 'left' } as Style,
  subtotalFill: 'ECEFF1',
};

interface ChildRow {
  label: string;
  value: number;
  note?: string;
}
interface FlatRow {
  label: string;
  amount: number;
  note?: string;
  source?: string;
  edge?: string;
  extraId?: string;
  category?: string; // grouping key within a section (sub-header + subtotal)
  children?: ChildRow[]; // indented line-item breakdown (edge split); not summed again
}

// Where an edge's amount landed on this sheet, so xlsx.ts can wire each flow's
// amount cell to its counterpart end (outflow on the payer ↔ inflow on the payee).
export interface FlowLoc {
  edge: string;
  role: 'in' | 'out';
  row: number;
}
export interface LedgerResult {
  sheet: Sheet;
  flows: FlowLoc[];
}

// ---- editorial overlay (data_v2/sheets/<node>.json) ----
export interface OverlayRow {
  label?: string; // curated label for an edge row (else "Counterparty — channel")
  note?: string; // curated note, prepended to the observation flag
  category?: string; // override/set the edge's grouping category for this sheet
}
export interface ExtraRow {
  id: string; // stable handle a check can reference as "extra:<id>"
  label: string;
  amount: number; // a flow NOT in the graph (admin, DME, …) — amount lives here
  note?: string;
  source?: string; // citation key
  category?: string; // grouping category (same buckets as edge.category)
}
// A check's model value: a signed sum of references, optionally divided by `over`.
// Each ref is "total:inflows" | "total:outflows" | "edge:<id>" | "extra:<id>".
export interface CheckModel {
  sum: string[];
  minus?: string[];
  over?: number;
}
export interface CheckRow {
  metric: string;
  independent: number;
  fmt?: 'pct';
  model: CheckModel;
  note?: string;
  emphasis?: boolean;
}
export interface NodeOverlay {
  node: string;
  subtitle?: string;
  rows?: Record<string, OverlayRow>;
  extraInflows?: ExtraRow[];
  extraOutflows?: ExtraRow[];
  checks?: CheckRow[];
  notes?: string[]; // free-text structural callouts, rendered as a NOTES section
}

// Load every data_v2/sheets/<node>.json, keyed by node id.
export function loadOverlays(root: string): Map<string, NodeOverlay> {
  const dir = join(root, 'data_v2', 'sheets');
  const out = new Map<string, NodeOverlay>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const ov = JSON.parse(readFileSync(join(dir, f), 'utf8')) as NodeOverlay;
    out.set(ov.node, ov);
  }
  return out;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function renderNodeLedger(
  file: GraphFileV2,
  nodeId: string,
  overlay?: NodeOverlay,
): LedgerResult {
  const node = file.graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`ledger: unknown node "${nodeId}"`);
  const year = (file.meta.year as number) ?? '';
  const label: Record<string, string> = {};
  for (const n of file.graph.nodes) label[n.id] = n.label;
  const group = file.groups.find((g) => g.id === node.group);
  const cite = (id: string): string => file.sources[id] ?? id;

  // Sub-nodes: if this node is a parent (aggregate), its children carry the edges and
  // each renders as its own nested in/out/net block, followed by a combined roll-up.
  const children = file.graph.nodes.filter((n) => n.parent === nodeId);

  const cells: Cell[] = [];
  const put = (r: number, c: number, v?: string | number, s?: Style, f?: string): void => {
    const cell: Cell = { r, c };
    if (f !== undefined) cell.f = f;
    else if (v !== undefined) cell.v = v;
    if (s) cell.s = s;
    cells.push(cell);
  };
  const band = (r: number, fromCol: number, toCol: number, s: Style): void => {
    for (let c = fromCol; c <= toCol; c++)
      put(r, c, undefined, { ...s, h: 'general', v: 'bottom' });
  };

  // Where an edge carries more than one observation, surface the OTHER sources as plain
  // context in the Notes column. The row's amount IS the canonical value the model uses;
  // this just records what else was reported. This is a big-picture flow model — sources
  // a few $B apart are a footnote, not a discrepancy to flag (see docs/v2.md). The
  // author's reasoning for the pick ("…using $614") lives in the canonical obs note.
  const crossNote = (e: EdgeV2): string => {
    const canon = canonicalObservation(e);
    const others = e.observations.filter((o) => o !== canon);
    if (!others.length) return '';
    return (
      'also reported: ' +
      others.map((o) => `$${round1(o.value)}B ${o.basis} (${o.source})`).join(' · ')
    );
  };

  const rowsFor = (edges: EdgeV2[], counterparty: (e: EdgeV2) => string): FlatRow[] =>
    edges.map((e) => {
      const c = canonicalObservation(e);
      const ov = overlay?.rows?.[e.id];
      const note = [ov?.note, c.note, crossNote(e)].filter(Boolean).join(' · ');
      return {
        label: ov?.label ?? `${label[counterparty(e)] ?? counterparty(e)} — ${e.channel}`,
        amount: c.value,
        note: note || undefined,
        source: cite(c.source),
        edge: e.id,
        category: ov?.category ?? e.category,
        children: e.split?.map((p) => ({ label: p.label, value: p.value, note: p.note })),
      };
    });
  const extraToRow = (x: ExtraRow): FlatRow => ({
    label: x.label,
    amount: x.amount,
    note: x.note,
    source: x.source ? cite(x.source) : undefined,
    extraId: x.id,
    category: x.category,
  });

  function section(
    startRow: number,
    title: string,
    bar: string,
    head: string,
    rows: FlatRow[],
  ): {
    totalRow: number;
    nextRow: number;
    rowOf: number[]; // emitted row of each input row (the parent line of a split)
  } {
    let r = startRow;
    put(r, 1, title, { b: true, color: 'FFFFFF', fill: bar, h: 'left' });
    band(r, 2, 5, { b: true, color: 'FFFFFF', fill: bar });
    r++;
    const hStyle = (h: string): Style => ({ b: true, fill: head, h, v: 'bottom' });
    put(r, 1, 'Flow', hStyle('left'));
    put(r, 2, 'Amount ($B)', hStyle('center'));
    put(r, 3, '% of Total', hStyle('center'));
    put(r, 4, 'Notes', hStyle('center'));
    put(r, 5, 'Source', hStyle('general'));
    r++;
    const firstData = r;

    // Group rows by category when 2+ distinct categories are present — else one flat
    // bucket (the original behaviour). Each category renders a sub-header + subtotal;
    // any uncategorised rows collect in a trailing "Other" bucket.
    const defined: string[] = [];
    for (const row of rows)
      if (row.category && !defined.includes(row.category)) defined.push(row.category);
    const grouping = defined.length >= 2;
    const idxsWhere = (pred: (row: FlatRow) => boolean): number[] =>
      rows.map((row, i) => (pred(row) ? i : -1)).filter((i) => i >= 0);
    const buckets: { label: string | null; idxs: number[] }[] = grouping
      ? [
          ...defined.map((cat) => ({ label: cat, idxs: idxsWhere((row) => row.category === cat) })),
          ...(idxsWhere((row) => !row.category).length
            ? [{ label: 'Other', idxs: idxsWhere((row) => !row.category) }]
            : []),
        ]
      : [{ label: null, idxs: rows.map((_, i) => i) }];

    // The TOTAL lands below every parent row, every child sub-row, and (when grouping)
    // a sub-header + subtotal per bucket — compute its position up front for the
    // "% of Total" denominators.
    let emitted = 0;
    for (const b of buckets) {
      if (grouping) emitted += 1; // sub-header
      for (const i of b.idxs) emitted += 1 + (rows[i].children?.length ?? 0);
      if (grouping) emitted += 1; // subtotal
    }
    const totalRow = firstData + emitted;

    const rowOf: number[] = new Array(rows.length);
    const parentRows: number[] = [];
    const subtotalRows: number[] = [];
    const indent = grouping ? '   ' : '';
    for (const b of buckets) {
      if (grouping) {
        put(r, 1, b.label as string, { b: true, fill: head, h: 'left' });
        band(r, 2, 5, { b: true, fill: head });
        r++;
      }
      const groupParents: number[] = [];
      for (const i of b.idxs) {
        const row = rows[i];
        const pr = r;
        rowOf[i] = pr;
        parentRows.push(pr);
        groupParents.push(pr);
        put(pr, 1, indent + row.label, THEME.label);
        put(pr, 2, row.amount, THEME.amount);
        put(pr, 3, undefined, THEME.pct, `=B${pr}/B${totalRow}`);
        if (row.note) put(pr, 4, row.note, THEME.note);
        if (row.source) put(pr, 5, row.source, THEME.source);
        r++;
        // Child line items: indented, % of their PARENT, and deliberately left out of
        // the section SUM so the breakdown is detail, not a second count.
        for (const ch of row.children ?? []) {
          put(r, 1, '      • ' + ch.label, THEME.childLabel);
          put(r, 2, ch.value, THEME.childAmount);
          put(r, 3, undefined, THEME.childPct, `=B${r}/B${pr}`);
          if (ch.note) put(r, 4, ch.note, THEME.childNote);
          r++;
        }
      }
      if (grouping) {
        const sf = THEME.subtotalFill;
        put(r, 1, `Subtotal — ${b.label}`, { b: true, fill: sf, h: 'left' });
        put(
          r,
          2,
          undefined,
          { b: true, fill: sf, h: 'right', v: 'bottom', fmt: CUR_TOTAL },
          '=' + groupParents.map((p) => `B${p}`).join('+'),
        );
        put(
          r,
          3,
          undefined,
          { b: true, fill: sf, h: 'right', v: 'center', fmt: PCT },
          `=B${r}/B${totalRow}`,
        );
        for (let c = 4; c <= 5; c++) put(r, c, undefined, { fill: sf, h: 'general', v: 'bottom' });
        subtotalRows.push(r);
        r++;
      }
    }

    put(r, 1, `TOTAL ${title.split(' ')[0]}`, { b: true, fill: THEME.totalFill, h: 'left' });
    // Sum the right things and never double-count: grouped → sum the subtotals; flat
    // with splits → sum parent refs explicitly (children sit inside the range);
    // flat without splits → a clean contiguous SUM.
    const hasChildren = rows.some((row) => row.children?.length);
    const sum = grouping
      ? '=' + subtotalRows.map((p) => `B${p}`).join('+')
      : hasChildren
        ? '=' + parentRows.map((p) => `B${p}`).join('+')
        : `=SUM(B${firstData}:B${r - 1})`;
    put(
      r,
      2,
      undefined,
      { b: true, fill: THEME.totalFill, h: 'right', v: 'bottom', fmt: CUR_TOTAL },
      sum,
    );
    for (let c = 3; c <= 5; c++)
      put(r, c, undefined, { fill: THEME.totalFill, h: 'general', v: 'bottom' });
    return { totalRow: r, nextRow: r + 2, rowOf };
  }

  // ---- header ----
  const canon = (e: EdgeV2): number => canonicalObservation(e).value;
  const fmt$ = (n: number): string => '$' + Math.round(n).toLocaleString() + 'B';
  // Totals span this node plus any children (a parent has no direct edges of its own).
  const memberIds = new Set<string>([nodeId, ...children.map((c) => c.id)]);
  let totIn = file.graph.edges.filter((e) => memberIds.has(e.to)).reduce((s, e) => s + canon(e), 0);
  let totOut = file.graph.edges
    .filter((e) => memberIds.has(e.from))
    .reduce((s, e) => s + canon(e), 0);
  totIn += (overlay?.extraInflows ?? []).reduce((s, x) => s + x.amount, 0);
  totOut += (overlay?.extraOutflows ?? []).reduce((s, x) => s + x.amount, 0);
  const subParts = [group?.label ?? node.group, `layer ${node.layer}`];
  if (totIn) subParts.push(`in ${fmt$(totIn)}`);
  if (totOut) subParts.push(`out ${fmt$(totOut)}`);
  if (totIn && totOut) subParts.push(`net ${fmt$(totIn - totOut)}`);

  // Auto-subtitle = group · layer · totals, plus the node's context line when present.
  // A curated overlay subtitle (medicare, hospitals, …) supersedes it.
  const autoParts = node.description ? [...subParts, node.description] : subParts;
  put(1, 1, `${node.label} — FY ${year}`, THEME.title);
  band(1, 5, 5, THEME.title);
  put(2, 1, overlay?.subtitle ?? autoParts.join('  ·  '), THEME.subtitle);

  const flows: FlowLoc[] = [];
  const edgeRowById = new Map<string, number>();
  const extraRowById = new Map<string, number>();
  let cursor = 4;
  let totalInflowsRow = 0;
  let totalOutflowsRow = 0;
  const record = (rows: FlatRow[], rowOf: number[], role: 'in' | 'out'): void => {
    rows.forEach((row, i) => {
      const rr = rowOf[i];
      if (row.edge) {
        flows.push({ edge: row.edge, role, row: rr });
        edgeRowById.set(row.edge, rr);
      }
      if (row.extraId) extraRowById.set(row.extraId, rr);
    });
  };

  // Render one node's INFLOWS / OUTFLOWS / NET starting at `startRow`. Used directly for
  // a normal node, and once per child for a parent (aggregate) node.
  const emitNodeBlock = (
    blockId: string,
    startRow: number,
    extraIn: ExtraRow[],
    extraOut: ExtraRow[],
  ): { nextRow: number; inTotalRow: number; outTotalRow: number } => {
    let cur = startRow;
    const inRows = [
      ...rowsFor(
        file.graph.edges.filter((e) => e.to === blockId),
        (e) => e.from,
      ),
      ...extraIn.map(extraToRow),
    ];
    const outRows = [
      ...rowsFor(
        file.graph.edges.filter((e) => e.from === blockId),
        (e) => e.to,
      ),
      ...extraOut.map(extraToRow),
    ];
    let inTot = 0;
    let outTot = 0;
    if (inRows.length) {
      const sec = section(
        cur,
        'INFLOWS (Funding Sources)',
        THEME.inflow.bar,
        THEME.inflow.head,
        inRows,
      );
      record(inRows, sec.rowOf, 'in');
      inTot = sec.totalRow;
      cur = sec.nextRow;
    }
    if (outRows.length) {
      const sec = section(
        cur,
        'OUTFLOWS (Spending)',
        THEME.outflow.bar,
        THEME.outflow.head,
        outRows,
      );
      record(outRows, sec.rowOf, 'out');
      outTot = sec.totalRow;
      cur = sec.nextRow;
    }
    // NET only makes sense for a node that both receives and spends.
    if (inTot && outTot) {
      put(cur, 1, 'NET FLOW', { b: true, fill: THEME.netFill, h: 'left' });
      put(
        cur,
        2,
        undefined,
        { b: true, fill: THEME.netFill, h: 'right', v: 'bottom', fmt: CUR },
        `=B${inTot}-B${outTot}`,
      );
      for (let c = 3; c <= 5; c++)
        put(cur, c, undefined, { fill: THEME.netFill, h: 'general', v: 'bottom' });
      cur += 2;
    }
    return { nextRow: cur, inTotalRow: inTot, outTotalRow: outTot };
  };

  if (children.length === 0) {
    const blk = emitNodeBlock(
      nodeId,
      cursor,
      overlay?.extraInflows ?? [],
      overlay?.extraOutflows ?? [],
    );
    totalInflowsRow = blk.inTotalRow;
    totalOutflowsRow = blk.outTotalRow;
    cursor = blk.nextRow;
  } else {
    // Parent (aggregate): one nested block per child, then a combined roll-up.
    const childInRows: number[] = [];
    const childOutRows: number[] = [];
    for (const child of children) {
      const childHead = child.description
        ? `▸ ${child.label}  ·  ${child.description}`
        : `▸ ${child.label}`;
      put(cursor, 1, childHead, { b: true, color: 'FFFFFF', fill: '455A64', h: 'left' });
      band(cursor, 2, 5, { b: true, color: 'FFFFFF', fill: '455A64' });
      cursor++;
      const blk = emitNodeBlock(child.id, cursor, [], []);
      if (blk.inTotalRow) childInRows.push(blk.inTotalRow);
      if (blk.outTotalRow) childOutRows.push(blk.outTotalRow);
      cursor = blk.nextRow;
    }
    // COMBINED roll-up — sums each child's section totals.
    put(cursor, 1, `COMBINED — ${node.label}`, {
      b: true,
      color: 'FFFFFF',
      fill: '37474F',
      h: 'left',
    });
    band(cursor, 2, 5, { b: true, color: 'FFFFFF', fill: '37474F' });
    cursor++;
    const combinedRow = (label: string, totals: number[]): number => {
      put(cursor, 1, label, { b: true, fill: THEME.totalFill, h: 'left' });
      put(
        cursor,
        2,
        undefined,
        { b: true, fill: THEME.totalFill, h: 'right', v: 'bottom', fmt: CUR_TOTAL },
        '=' + totals.map((t) => `B${t}`).join('+'),
      );
      for (let c = 3; c <= 5; c++)
        put(cursor, c, undefined, { fill: THEME.totalFill, h: 'general', v: 'bottom' });
      return cursor++;
    };
    if (childInRows.length) totalInflowsRow = combinedRow('Combined inflows', childInRows);
    if (childOutRows.length) totalOutflowsRow = combinedRow('Combined outflows', childOutRows);
    if (totalInflowsRow && totalOutflowsRow) {
      put(cursor, 1, 'NET FLOW', { b: true, fill: THEME.netFill, h: 'left' });
      put(
        cursor,
        2,
        undefined,
        { b: true, fill: THEME.netFill, h: 'right', v: 'bottom', fmt: CUR },
        `=B${totalInflowsRow}-B${totalOutflowsRow}`,
      );
      for (let c = 3; c <= 5; c++)
        put(cursor, c, undefined, { fill: THEME.netFill, h: 'general', v: 'bottom' });
      cursor++;
    }
    cursor++;
  }

  // ---- VALIDATION (independent sources) — composite/total checks from the overlay ----
  if (overlay?.checks?.length) {
    const resolve = (ref: string): string => {
      if (ref === 'total:inflows') return `B${totalInflowsRow}`;
      if (ref === 'total:outflows') return `B${totalOutflowsRow}`;
      if (ref.startsWith('edge:')) {
        const row = edgeRowById.get(ref.slice(5));
        if (!row) throw new Error(`overlay check on "${nodeId}": unknown edge ref "${ref}"`);
        return `B${row}`;
      }
      if (ref.startsWith('extra:')) {
        const row = extraRowById.get(ref.slice(6));
        if (!row) throw new Error(`overlay check on "${nodeId}": unknown extra ref "${ref}"`);
        return `B${row}`;
      }
      throw new Error(`overlay check on "${nodeId}": bad ref "${ref}"`);
    };
    let r = cursor;
    put(r, 1, 'VALIDATION (Independent Sources)', {
      b: true,
      color: 'FFFFFF',
      fill: THEME.validation.bar,
      h: 'left',
    });
    band(r, 2, 5, { b: true, color: 'FFFFFF', fill: THEME.validation.bar });
    r++;
    const vh = THEME.validation.head;
    put(r, 1, 'Metric', { b: true, fill: vh, h: 'left' });
    put(r, 2, 'Independent', { b: true, fill: vh, h: 'center', v: 'bottom' });
    put(r, 3, 'Our Model', { b: true, fill: vh, h: 'center', v: 'bottom' });
    put(r, 4, 'Delta / Notes', { b: true, fill: vh, h: 'center' });
    put(r, 5, undefined, { b: true, fill: vh, h: 'general', v: 'bottom' });
    r++;
    for (const chk of overlay.checks) {
      let body = chk.model.sum.map(resolve).join('+');
      for (const m of chk.model.minus ?? []) body += '-' + resolve(m);
      const formula = chk.model.over ? `=(${body})/${chk.model.over}` : `=${body}`;
      const fmt = chk.fmt === 'pct' ? PCT : CUR;
      const emph = chk.emphasis ? { b: true } : {};
      put(r, 1, chk.metric, { ...emph, sz: 10, h: 'left' });
      put(r, 2, chk.independent, { ...emph, sz: 10, h: 'right', v: 'center', fmt });
      put(r, 3, undefined, { ...emph, sz: 10, h: 'right', v: 'center', fmt }, formula);
      if (chk.note) put(r, 4, chk.note, { sz: 9, color: '666666', h: 'left' });
      r++;
    }
    cursor = r + 1;
  }

  // ---- NOTES (free-text structural callouts from the overlay) ----
  if (overlay?.notes?.length) {
    put(cursor, 1, 'NOTES', { b: true, color: 'FFFFFF', fill: '37474F', h: 'left' });
    band(cursor, 2, 5, { b: true, color: 'FFFFFF', fill: '37474F' });
    cursor++;
    for (const n of overlay.notes) {
      put(cursor, 1, n, THEME.note);
      cursor++;
    }
  }

  const sheet: Sheet = {
    name: node.label,
    tabColor: group?.color ?? '263238',
    gridlines: true,
    freeze: 'A6',
    columns: { A: 48, B: 14, C: 12, D: 40, E: 52 },
    rows: {},
    merges: ['A1:D1', 'A2:D2'],
    cells,
  };
  return { sheet, flows };
}
