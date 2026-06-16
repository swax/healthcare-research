// Generate a narrative "node ledger" sheet (e.g. Medicaid) from the canonical
// graph + a thin editorial side-schema in data/sheets/<node>.json, instead of
// hand-authoring its cells in data/workbook.json.
//
// Why this exists: the hand-authored sheets restate the graph's dollar amounts
// in several places, which drift (the whole reason reconcile.ts has to exist).
// A generated sheet references each graph-backed amount by edge id, so it cannot
// drift, and computes every %/total/cross-reference formula from the row it
// actually landed on (no brittle hard-coded A1 refs).
//
// loadResolvedSheets() returns the full workbook with any sheet marked
// `{ "generated": "<node>" }` in workbook.json swapped for its rendered form.
// build.ts (xlsx) and reconcile.ts (cross-checks) both go through it, so the
// generated sheet is the single source — and other sheets' `=Medicaid!B8` style
// references keep resolving because the layout is preserved cell-for-cell.
//
// Erasable-syntax-only TypeScript, same as the rest of src/.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadGraph } from './graph.ts';
import type { GraphFile, Edge } from './graph.ts';

// ---- cell model (the shape build.ts pours into ExcelJS) ----
export interface Style {
  b?: boolean;
  sz?: number;
  color?: string;
  fill?: string;
  h?: string;
  v?: string;
  wrap?: boolean;
  indent?: number;
  fmt?: string;
}
export interface Cell {
  r: number;
  c: number;
  v?: string | number;
  f?: string;
  s?: Style;
}
export interface Sheet {
  name: string;
  tabColor: string | null;
  gridlines: boolean;
  freeze: string | null;
  columns: Record<string, number>;
  rows: Record<string, number>;
  merges: string[];
  cells: Cell[];
}

// ---- editorial side-schema (data/sheets/<node>.json) ----
interface ContentRow {
  edge?: string; // graph edge id — amount is taken from the graph, never restated
  edges?: string[]; // several graph edges shown as one row (e.g. payroll EE + ER)
  extra?: boolean; // a flow the graph doesn't model (e.g. admin); amount lives here
  id?: string; // stable handle so a validation `terms` ref can point at this row
  label: string;
  amount?: number; // required for `extra`/`split` sub-rows; optional rounded total for `edges`
  note?: string;
  source?: string;
  split?: ContentRow[]; // sub-rows that must sum to the referenced edge's amount
}
// A validation "Our Model Value" cell. Either a single ref (optionally /over), or a
// signed sum of terms — e.g. `=B16+B21+B22` (Part B subset) or `=B23-B22` (ex-admin).
interface RefTerm {
  ref: 'totalInflows' | 'totalOutflows' | 'inflow' | 'outflow' | 'row';
  edge?: string; // for inflow/outflow
  id?: string; // for a `row` term — matches a ContentRow.id
  sign?: '-'; // default is +; '-' subtracts this term
}
interface ModelRef {
  ref?: 'totalInflows' | 'totalOutflows' | 'inflow' | 'outflow';
  edge?: string;
  terms?: RefTerm[];
  over?: number;
}
interface ValidationRow {
  metric: string;
  independent: number;
  independentFmt?: 'pct';
  model: ModelRef; // resolved to a live formula against the row the edge rendered on
  modelFmt?: 'pct';
  note?: string;
  emphasis?: boolean;
}
export interface SheetContent {
  node: string;
  subtitle: string;
  tabColor?: string; // defaults to the node's group color; override for hand-tuned tabs
  inflows: ContentRow[];
  outflows: ContentRow[];
  validation: ValidationRow[];
}

// ---- presentation theme (the per-sheet styling, pulled out of the data) ----
const CUR = '\\$#,##0;"($"#,##0\\);\\-';
const CUR_TOTAL = '\\$#,##0';
const PCT = '0.0%';
const MERGE_TOL = 1.0; // $B; a merged row's rounded total may differ this much from its edges
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
};

interface FlatRow {
  label: string;
  amount: number;
  note?: string;
  source?: string;
  edge?: string;
  id?: string;
}

export function renderNodeSheet(file: GraphFile, content: SheetContent): Sheet {
  const node = file.graph.nodes.find((n) => n.id === content.node);
  if (!node) throw new Error(`render: unknown node "${content.node}"`);
  const year = (file.meta.year as number) ?? '';
  const groupColor = file.groups.find((g) => g.id === node.group)?.color;
  const edgeById = new Map<string, Edge>();
  for (const e of file.graph.edges) edgeById.set(e.id, e);

  const cells: Cell[] = [];
  const put = (
    r: number,
    c: number,
    v: string | number | undefined,
    s?: Style,
    f?: string,
  ): void => {
    const cell: Cell = { r, c };
    if (f !== undefined) cell.f = f;
    else if (v !== undefined) cell.v = v;
    if (s) cell.s = s;
    cells.push(cell);
  };
  // a styled-but-empty cell, used to extend a colored header band across the row
  const band = (r: number, fromCol: number, toCol: number, s: Style): void => {
    for (let c = fromCol; c <= toCol; c++)
      put(r, c, undefined, { ...s, h: 'general', v: 'bottom' });
  };

  const edgeAmount = (id: string): number => {
    const e = edgeById.get(id);
    if (!e) throw new Error(`render: row references unknown edge "${id}"`);
    return e.amount;
  };

  // expand the content rows into the flat list actually laid down, validating
  // that every `split` sums to the graph edge it claims to decompose
  const explode = (rows: ContentRow[]): FlatRow[] => {
    const out: FlatRow[] = [];
    for (const row of rows) {
      if (row.split) {
        const sum = row.split.reduce((s, x) => s + (x.amount ?? 0), 0);
        if (row.edge && Math.abs(sum - edgeAmount(row.edge)) > 1e-9)
          throw new Error(
            `render: split of "${row.edge}" sums to ${sum} but the edge is ${edgeAmount(row.edge)}`,
          );
        for (const sub of row.split)
          out.push({
            label: sub.label,
            amount: sub.amount ?? 0,
            note: sub.note,
            source: sub.source,
            edge: row.edge,
            id: sub.id,
          });
      } else if (row.edges) {
        // several edges shown as one row; the displayed (often rounded) total must
        // stay within tolerance of their true sum, or it's a real discrepancy
        const sum = row.edges.reduce((s, id) => s + edgeAmount(id), 0);
        const amount = row.amount ?? sum;
        if (Math.abs(amount - sum) > MERGE_TOL)
          throw new Error(
            `render: merged row "${row.label}" shows ${amount} but its edges sum to ${sum}`,
          );
        out.push({ label: row.label, amount, note: row.note, source: row.source, id: row.id });
      } else {
        const amount = row.edge ? edgeAmount(row.edge) : (row.amount ?? 0);
        out.push({
          label: row.label,
          amount,
          note: row.note,
          source: row.source,
          edge: row.edge,
          id: row.id,
        });
      }
    }
    return out;
  };

  // ---- header ----
  put(1, 1, `${node.label} — FY ${year}`, THEME.title);
  band(1, 5, 5, THEME.title);
  put(2, 1, content.subtitle, THEME.subtitle);

  // remember where each edge/id/total landed so validation refs resolve to real cells
  const inflowRowByEdge = new Map<string, number>();
  const outflowRowByEdge = new Map<string, number>();
  const rowById = new Map<string, number>();
  let totalInflowsRow = 0;
  let totalOutflowsRow = 0;

  function section(
    startRow: number,
    title: string,
    bar: string,
    head: string,
    rows: FlatRow[],
    recordEdgeRow: Map<string, number>,
  ): { totalRow: number; nextRow: number } {
    let r = startRow;
    put(r, 1, title, { b: true, color: 'FFFFFF', fill: bar, h: 'left' });
    band(r, 2, 5, { b: true, color: 'FFFFFF', fill: bar });
    r++;
    const hStyle = (h: string): Style => ({ b: true, fill: head, h, v: 'bottom' });
    put(r, 1, 'Flow', { b: true, fill: head, h: 'left', color: 'FFFFFF' });
    put(r, 2, 'Amount ($B)', hStyle('center'));
    put(r, 3, '% of Total', hStyle('center'));
    put(r, 4, 'Notes', { b: true, fill: head, h: 'center' });
    put(r, 5, 'Source', { b: true, fill: head, h: 'general' });
    r++;
    const firstData = r;
    const totalRow = firstData + rows.length;
    for (const row of rows) {
      if (row.edge && !recordEdgeRow.has(row.edge)) recordEdgeRow.set(row.edge, r);
      if (row.id) rowById.set(row.id, r);
      put(r, 1, row.label, THEME.label);
      put(r, 2, row.amount, THEME.amount);
      put(r, 3, undefined, THEME.pct, `=B${r}/B${totalRow}`);
      if (row.note) put(r, 4, row.note, THEME.note);
      if (row.source) put(r, 5, row.source, THEME.source);
      r++;
    }
    put(r, 1, `TOTAL ${title.split(' ')[0]}`, {
      b: true,
      color: 'FFFFFF',
      fill: THEME.totalFill,
      h: 'left',
    });
    put(
      r,
      2,
      undefined,
      { b: true, fill: THEME.totalFill, h: 'right', v: 'bottom', fmt: CUR_TOTAL },
      `=SUM(B${firstData}:B${r - 1})`,
    );
    for (let c = 3; c <= 5; c++)
      put(r, c, undefined, { fill: THEME.totalFill, h: 'general', v: 'bottom' });
    return { totalRow: r, nextRow: r + 2 };
  }

  const inSec = section(
    4,
    'INFLOWS (Funding Sources)',
    THEME.inflow.bar,
    THEME.inflow.head,
    explode(content.inflows),
    inflowRowByEdge,
  );
  totalInflowsRow = inSec.totalRow;

  const outSec = section(
    inSec.nextRow,
    'OUTFLOWS (Spending)',
    THEME.outflow.bar,
    THEME.outflow.head,
    explode(content.outflows),
    outflowRowByEdge,
  );
  totalOutflowsRow = outSec.totalRow;

  // ---- NET FLOW ----
  const netRow = outSec.nextRow;
  put(netRow, 1, 'NET FLOW', { b: true, color: 'FFFFFF', fill: THEME.netFill, h: 'left' });
  put(
    netRow,
    2,
    undefined,
    { b: true, fill: THEME.netFill, h: 'right', v: 'bottom', fmt: CUR },
    `=B${totalInflowsRow}-B${totalOutflowsRow}`,
  );
  for (let c = 3; c <= 5; c++)
    put(netRow, c, undefined, { fill: THEME.netFill, h: 'general', v: 'bottom' });

  // ---- VALIDATION (independent sources) ----
  let r = netRow + 2;
  put(r, 1, 'VALIDATION (Independent Sources)', {
    b: true,
    color: 'FFFFFF',
    fill: THEME.validation.bar,
    h: 'left',
  });
  band(r, 2, 5, { b: true, color: 'FFFFFF', fill: THEME.validation.bar });
  r++;
  const vHead = THEME.validation.head;
  put(r, 1, 'Metric', { b: true, fill: vHead, h: 'left', color: 'FFFFFF' });
  put(r, 2, 'Independent Value', { b: true, fill: vHead, h: 'center', v: 'bottom' });
  put(r, 3, 'Our Model Value', { b: true, fill: vHead, h: 'center', v: 'bottom' });
  put(r, 4, 'Delta / Notes', { b: true, fill: vHead, h: 'center' });
  put(r, 5, undefined, { b: true, fill: vHead, h: 'general', v: 'bottom' });
  r++;
  const cellOfTerm = (t: RefTerm): string => {
    if (t.ref === 'totalInflows') return `B${totalInflowsRow}`;
    if (t.ref === 'totalOutflows') return `B${totalOutflowsRow}`;
    if (t.ref === 'inflow') return `B${inflowRowByEdge.get(t.edge ?? '')}`;
    if (t.ref === 'outflow') return `B${outflowRowByEdge.get(t.edge ?? '')}`;
    return `B${rowById.get(t.id ?? '')}`; // 'row'
  };
  const resolveRef = (m: ModelRef): string => {
    let body: string;
    if (m.terms) {
      // signed sum: first term bare (or negated), later terms joined with +/-
      body = m.terms
        .map((t, i) => (t.sign === '-' ? '-' : i === 0 ? '' : '+') + cellOfTerm(t))
        .join('');
    } else if (m.ref) {
      body = cellOfTerm({ ref: m.ref, edge: m.edge });
    } else {
      throw new Error('render: validation model needs `ref` or `terms`');
    }
    return m.over ? `=${body}/${m.over}` : `=${body}`;
  };
  for (const vr of content.validation) {
    const emph = vr.emphasis ? { b: true } : {};
    put(r, 1, vr.metric, { ...emph, sz: 10, h: 'left' });
    put(r, 2, vr.independent, {
      ...emph,
      sz: 10,
      h: 'right',
      v: 'center',
      fmt: vr.independentFmt === 'pct' ? PCT : CUR,
    });
    put(
      r,
      3,
      undefined,
      { ...emph, sz: 10, h: 'right', v: 'center', fmt: vr.modelFmt === 'pct' ? PCT : CUR },
      resolveRef(vr.model),
    );
    if (vr.note)
      put(
        r,
        4,
        vr.note,
        vr.emphasis
          ? { sz: 8, color: '888888', h: 'general' }
          : { sz: 9, color: '666666', h: 'left' },
      );
    r++;
  }

  return {
    name: node.label,
    tabColor: content.tabColor ?? groupColor ?? '263238',
    gridlines: true,
    freeze: 'A6',
    columns: { A: 54, B: 14, C: 14, D: 22, E: 52 },
    rows: {},
    merges: ['A1:D1', 'A2:D2'],
    cells,
  };
}

// ---- workbook resolution ----
interface GeneratedStub {
  name: string;
  generated: string; // node id whose data/sheets/<node>.json drives this sheet
}

// Load every data/sheets/<node>.json, keyed by its node id.
export function loadSheetContents(root: string): Map<string, SheetContent> {
  const dir = join(root, 'data', 'sheets');
  const out = new Map<string, SheetContent>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const content = JSON.parse(readFileSync(join(dir, f), 'utf8')) as SheetContent;
    out.set(content.node, content);
  }
  return out;
}

// The workbook with every `{ "generated": "<node>" }` stub replaced by its
// rendered sheet, in the original tab order.
export function loadResolvedSheets(root: string, file: GraphFile = loadGraph(root)): Sheet[] {
  const raw = JSON.parse(readFileSync(join(root, 'data', 'workbook.json'), 'utf8')) as {
    sheets: (Sheet | GeneratedStub)[];
  };
  const contents = loadSheetContents(root);
  return raw.sheets.map((s) => {
    if ('generated' in s && typeof s.generated === 'string') {
      const content = contents.get(s.generated);
      if (!content)
        throw new Error(
          `workbook.json sheet "${s.name}" is generated:"${s.generated}" but data/sheets/${s.generated}.json is missing`,
        );
      return renderNodeSheet(file, content);
    }
    return s;
  });
}
