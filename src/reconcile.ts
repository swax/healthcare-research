// Cross-sheet reconciliation. The 16 narrative sheets in data/workbook.json are
// hand-authored and restate the same inter-node flows in several places: as
// "X → Target" outflow rows on the paying sheet, as "Payer (NN%)" payer-mix
// rows on the receiving sheet, and as live "=OtherSheet!Cell" cross-references.
// The cross-references tie by construction; the literals and payer-mix
// percentages drift. This module resolves every sheet's stated value for each
// canonical node-pair (evaluating the small formula subset the sheets use) and
// flags pairs where the sheets — or a sheet and the canonical graph — disagree.
//
// It deliberately anchors on data/graph.json (the validated source of truth that
// check.ts already enforces) and only reconciles flows that land on a PROVIDER
// node (Hospitals, Providers & Clinicians, Pharma & Rx, Long-Term Care) — i.e.
// "who pays each provider sector, and does every sheet agree?".
//
// Crucially, statements come in two LENSES that must not be compared to each other:
//   * modeled — direct FFS/premium/OOP payments from a payer sheet (Medicare,
//     Medicaid, Individuals, …). These represent the actual money flow in this
//     model and MUST equal the canonical graph edge. Disagreements here are bugs.
//   * national — all-payer NHE figures: the provider sheets' payer-mix shares and
//     the Health Insurance sheet's NHE-basis claims. These intentionally exceed
//     the modeled FFS edges because they include the MA/MCO portion the model
//     routes THROUGH the insurer node. They are reported as context, never as
//     mismatches. (e.g. national Medicare nursing $44B ≠ modeled Medicare FFS
//     SNF $35B — both correct, different lenses.)
//
// Two classes are out of scope to avoid false positives: upstream funding flows
// into the programs/insurers (modeled with intermediary hops + split shares), and
// flows into the factor sinks (decomposed across many heterogeneous sub-rows).
// Multi-hop rows (more than one "→") are skipped for the same reason.
//
// Erasable-syntax-only TypeScript so Node strips the types directly.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphFile } from './graph.ts';

interface WCell {
  r: number;
  c: number;
  v?: string | number;
  f?: string;
}
interface WSheet {
  name: string;
  cells: WCell[];
}
export interface WorkbookFile {
  sheets: WSheet[];
}

export function loadWorkbook(root: string): WorkbookFile {
  return JSON.parse(readFileSync(join(root, 'data', 'workbook.json'), 'utf8')) as WorkbookFile;
}

// ---- A1 <-> (row,col) ----
function colToNum(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return n;
}
function numToCol(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = (n - m - 1) / 26;
  }
  return s;
}
function splitAddr(addr: string): { col: number; row: number } {
  const m = /^([A-Za-z]+)(\d+)$/.exec(addr);
  if (!m) throw new Error('bad cell address: ' + addr);
  return { col: colToNum(m[1]), row: parseInt(m[2], 10) };
}

// ---- formula evaluation (subset: numbers, +-*/, parens, cell refs, Sheet!refs, SUM(range)) ----
type Tok =
  | { t: 'num'; v: number }
  | { t: 'op'; v: string }
  | { t: 'lp' }
  | { t: 'rp' }
  | { t: 'colon' }
  | { t: 'func'; v: string }
  | { t: 'ref'; sheet?: string; addr: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const s = src.replace(/^=/, '');
  const isLetter = (ch: string): boolean => /[A-Za-z]/.test(ch);
  const isDigit = (ch: string): boolean => /[0-9]/.test(ch);
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t') {
      i++;
    } else if (ch === '(') {
      toks.push({ t: 'lp' });
      i++;
    } else if (ch === ')') {
      toks.push({ t: 'rp' });
      i++;
    } else if (ch === ':') {
      toks.push({ t: 'colon' });
      i++;
    } else if ('+-*/'.includes(ch)) {
      toks.push({ t: 'op', v: ch });
      i++;
    } else if (isDigit(ch) || ch === '.') {
      let j = i;
      while (j < s.length && (isDigit(s[j]) || s[j] === '.')) j++;
      toks.push({ t: 'num', v: parseFloat(s.slice(i, j)) });
      i = j;
    } else if (ch === "'") {
      // quoted sheet name: 'Sheet Name'!A1
      let j = i + 1;
      while (j < s.length && s[j] !== "'") j++;
      const sheet = s.slice(i + 1, j);
      j++; // closing quote
      if (s[j] !== '!') throw new Error("expected '!' after quoted sheet in: " + src);
      j++;
      let k = j;
      while (k < s.length && (isLetter(s[k]) || isDigit(s[k]))) k++;
      toks.push({ t: 'ref', sheet, addr: s.slice(j, k) });
      i = k;
    } else if (isLetter(ch)) {
      let j = i;
      while (j < s.length && isLetter(s[j])) j++;
      const word = s.slice(i, j);
      if (s[j] === '!') {
        // bareword sheet (no spaces): Sheet!A1
        j++;
        let k = j;
        while (k < s.length && (isLetter(s[k]) || isDigit(s[k]))) k++;
        toks.push({ t: 'ref', sheet: word, addr: s.slice(j, k) });
        i = k;
      } else if (isDigit(s[j])) {
        // bare cell ref on the current sheet: B6
        let k = j;
        while (k < s.length && isDigit(s[k])) k++;
        toks.push({ t: 'ref', addr: word + s.slice(j, k) });
        i = k;
      } else {
        // a function name, e.g. SUM
        toks.push({ t: 'func', v: word.toUpperCase() });
        i = j;
      }
    } else {
      throw new Error('unexpected char "' + ch + '" in formula: ' + src);
    }
  }
  return toks;
}

type RefResolver = (sheet: string, addr: string) => number;

function evalFormula(src: string, ctxSheet: string, resolve: RefResolver): number {
  const toks = tokenize(src);
  let p = 0;
  const peek = (): Tok | undefined => toks[p];
  const expr = (): number => {
    let v = term();
    for (;;) {
      const t = peek();
      if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
        p++;
        const rhs = term();
        v = t.v === '+' ? v + rhs : v - rhs;
      } else break;
    }
    return v;
  };
  const term = (): number => {
    let v = factor();
    for (;;) {
      const t = peek();
      if (t && t.t === 'op' && (t.v === '*' || t.v === '/')) {
        p++;
        const rhs = factor();
        v = t.v === '*' ? v * rhs : v / rhs;
      } else break;
    }
    return v;
  };
  const factor = (): number => {
    const t = peek();
    if (!t) throw new Error('unexpected end of formula: ' + src);
    if (t.t === 'op' && t.v === '-') {
      p++;
      return -factor();
    }
    if (t.t === 'op' && t.v === '+') {
      p++;
      return factor();
    }
    if (t.t === 'num') {
      p++;
      return t.v;
    }
    if (t.t === 'lp') {
      p++;
      const v = expr();
      if (peek()?.t !== 'rp') throw new Error('missing ) in: ' + src);
      p++;
      return v;
    }
    if (t.t === 'func') {
      p++;
      if (peek()?.t !== 'lp') throw new Error('expected ( after ' + t.v);
      p++;
      const start = peek();
      if (!start || start.t !== 'ref') throw new Error('expected range in ' + t.v);
      p++;
      let sum = 0;
      if (peek()?.t === 'colon') {
        p++;
        const end = peek();
        if (!end || end.t !== 'ref') throw new Error('expected range end in ' + t.v);
        p++;
        const sheet = start.sheet ?? ctxSheet;
        const a = splitAddr(start.addr);
        const b = splitAddr(end.addr);
        for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++)
          for (let rr = Math.min(a.row, b.row); rr <= Math.max(a.row, b.row); rr++)
            sum += resolve(sheet, numToCol(c) + rr);
      } else {
        sum = resolve(start.sheet ?? ctxSheet, start.addr);
      }
      if (peek()?.t !== 'rp') throw new Error('missing ) in ' + t.v);
      p++;
      return sum;
    }
    if (t.t === 'ref') {
      p++;
      return resolve(t.sheet ?? ctxSheet, t.addr);
    }
    throw new Error('unexpected token in formula: ' + src);
  };
  const v = expr();
  return v;
}

// Resolve any cell to a number, evaluating formulas recursively (memoized, cycle-guarded).
function makeResolver(wb: WorkbookFile): RefResolver {
  const index = new Map<string, Map<string, WCell>>();
  for (const sh of wb.sheets) {
    const m = new Map<string, WCell>();
    for (const c of sh.cells) m.set(numToCol(c.c) + c.r, c);
    index.set(sh.name, m);
  }
  const memo = new Map<string, number>();
  const active = new Set<string>();
  const resolve: RefResolver = (sheet, addr) => {
    const key = sheet + '!' + addr;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (active.has(key)) return NaN; // circular reference
    const cell = index.get(sheet)?.get(addr);
    let val: number;
    if (!cell) val = 0;
    else if (cell.f !== undefined) {
      active.add(key);
      val = evalFormula(cell.f, sheet, resolve);
      active.delete(key);
    } else if (typeof cell.v === 'number') val = cell.v;
    else val = 0;
    memo.set(key, val);
    return val;
  };
  return resolve;
}

// Resolve a single workbook cell to its numeric value (evaluating formulas).
// Exposed for tests; check.ts goes through reconcileWorkbook.
export function resolveCell(wb: WorkbookFile, sheet: string, addr: string): number {
  return makeResolver(wb)(sheet, addr);
}

// ---- mapping sheet labels & free-text counterparties to canonical node ids ----
const SHEET_NODE: Record<string, string> = {
  Medicare: 'medicare',
  Medicaid: 'medicaid',
  'Health Insurance': 'health_insurance',
  Hospitals: 'hospitals',
  'Providers & Clinicians': 'providers_clinicians',
  Pharma: 'pharma_rx',
  'Long-Term Care': 'long_term_care',
  Individuals: 'individuals',
  Employers: 'employers',
  'Federal Gov': 'federal_government',
  'State Gov': 'state_governments',
};

// Map a free-text counterparty phrase to a node id (or null if it isn't a graph
// node — e.g. "Other services", "Capital Markets", "Construction"). Parentheticals
// are stripped first so "Medicare Advantage (Part C)" => "medicare advantage".
function toNode(text: string): string | null {
  const t = text
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  // insurers first, so "Medicare Advantage"/"MA plans"/"MCOs" don't match plain "medicare"
  if (/advantage|\bma plan|\bmco|managed care|private (health )?insurance|health insurance/.test(t))
    return 'health_insurance';
  if (/^medicare\b/.test(t)) return 'medicare';
  if (/^medicaid\b/.test(t)) return 'medicaid';
  if (/hospital/.test(t)) return 'hospitals';
  if (/physician|clinical|providers & clinicians/.test(t)) return 'providers_clinicians';
  if (/pharma|prescription drug|\brx\b/.test(t)) return 'pharma_rx';
  if (/long-?term care|nursing|home health|home & community|ltss|hcbs|hospice/.test(t))
    return 'long_term_care';
  if (/out-?of-?pocket|\boop\b|individuals/.test(t)) return 'individuals';
  if (/employers/.test(t)) return 'employers';
  if (/fed(eral)? gov/.test(t)) return 'federal_government';
  if (/state gov/.test(t)) return 'state_governments';
  if (/workers|doctors|nurses/.test(t)) return 'healthcare_workers';
  if (/suppliers/.test(t)) return 'suppliers_vendors';
  return null;
}

// Sheets whose outflow rows are DIRECT payments (FFS, premiums, OOP) — the
// "modeled" lens that must agree with the graph. Every other sheet's flow rows
// are national-NHE aggregations (payer-mix shares, insurer claims built from
// them) — the "national" lens, shown as context and NOT expected to equal the
// modeled FFS edges (they include the MA/MCO portion routed through insurers).
const MODELED_SOURCES = new Set([
  'Medicare',
  'Medicaid',
  'Individuals',
  'Employers',
  'Federal Gov',
  'State Gov',
]);

export interface Statement {
  sheet: string;
  via: 'outflow' | 'payer-mix';
  lens: 'modeled' | 'national';
  amount: number;
}
export interface PairRecon {
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  graph: number | null;
  modeled: Statement[];
  national: Statement[];
  spread: number; // among graph + modeled statements
  status: 'ok' | 'mismatch' | 'absent-in-graph' | 'context-only';
}
export interface ReconResult {
  pairs: PairRecon[];
  mismatches: PairRecon[]; // modeled-lens disagreements (the pass/fail set)
  context: PairRecon[]; // pairs carrying national-lens payer-mix context
  tolerance: number;
}

const TOL = 1.0; // $B; matches check.ts's imbalance threshold

export function reconcileWorkbook(file: GraphFile, wb: WorkbookFile, tolerance = TOL): ReconResult {
  const nodes = file.graph.nodes;
  const layer: Record<string, number> = {};
  const label: Record<string, string> = {};
  const group: Record<string, string> = {};
  for (const n of nodes) {
    layer[n.id] = n.layer;
    label[n.id] = n.label;
    group[n.id] = n.group;
  }
  const resolve = makeResolver(wb);
  const byRC = (sh: WSheet): Map<string, WCell> => {
    const m = new Map<string, WCell>();
    for (const c of sh.cells) m.set(c.r + ':' + c.c, c);
    return m;
  };

  // collect statements keyed by "from|to"
  const stmts = new Map<string, Statement[]>();
  const add = (from: string, to: string, st: Statement): void => {
    // forward flow only, both endpoints are graph nodes, target is a provider
    if (from === to) return;
    if (layer[from] === undefined || layer[to] === undefined) return;
    if (layer[to] <= layer[from]) return;
    if (group[to] !== 'providers') return;
    const key = from + '|' + to;
    let arr = stmts.get(key);
    if (!arr) stmts.set(key, (arr = []));
    arr.push(st);
  };

  for (const sh of wb.sheets) {
    const selfNode = SHEET_NODE[sh.name];
    if (!selfNode) continue; // Overview/Capital Markets/Glossary etc. — not a single node
    const modeledSource = MODELED_SOURCES.has(sh.name);
    const cells = byRC(sh);
    const amountAt = (r: number): number => {
      const cell = cells.get(r + ':2');
      if (!cell) return NaN;
      if (cell.f !== undefined) return resolve(sh.name, 'B' + r);
      if (typeof cell.v === 'number') return cell.v;
      return NaN;
    };
    for (const c of sh.cells) {
      if (c.c !== 1 || typeof c.v !== 'string') continue;
      const txt = c.v;
      const payer = /^(.+?)\s*\(\d+(?:\.\d+)?%\)\s*$/.exec(txt);
      if (payer) {
        // "Payer (NN%)" inflow row: payer -> this sheet's node (always national-lens)
        const from = toNode(payer[1]);
        const amt = amountAt(c.r);
        if (from && isFinite(amt))
          add(from, selfNode, { sheet: sh.name, via: 'payer-mix', lens: 'national', amount: amt });
      } else if (txt.includes('→') && (txt.match(/→/g) ?? []).length === 1) {
        // single-hop "... → Target" outflow row: this sheet's node -> target.
        // Direct payments from a payer sheet are modeled; everything else (e.g.
        // the Health Insurance sheet's NHE-basis claims) is national context.
        // Multi-hop "A → B → C" funding labels are skipped — see header note.
        const target = txt.slice(txt.lastIndexOf('→') + 1);
        const to = toNode(target);
        const amt = amountAt(c.r);
        if (to && isFinite(amt))
          add(selfNode, to, {
            sheet: sh.name,
            via: 'outflow',
            lens: modeledSource ? 'modeled' : 'national',
            amount: amt,
          });
      }
    }
  }

  // canonical graph edge sums per pair
  const graphPair = new Map<string, number>();
  for (const e of file.graph.edges)
    graphPair.set(e.from + '|' + e.to, (graphPair.get(e.from + '|' + e.to) ?? 0) + e.amount);

  const pairs: PairRecon[] = [];
  const keys = new Set<string>([...stmts.keys()]);
  for (const key of keys) {
    const [from, to] = key.split('|');
    // sum each sheet's statements for this pair, per lens (a sheet may state it
    // across several rows — e.g. Medicare → LTC across SNF + home health + hospice)
    const sumBySheet = (lens: Statement['lens']): Statement[] => {
      const bySheet = new Map<string, Statement>();
      for (const st of stmts.get(key) ?? []) {
        if (st.lens !== lens) continue;
        const cur = bySheet.get(st.sheet);
        if (cur) cur.amount += st.amount;
        else bySheet.set(st.sheet, { ...st });
      }
      return [...bySheet.values()].sort((a, b) => a.sheet.localeCompare(b.sheet));
    };
    const modeled = sumBySheet('modeled');
    const national = sumBySheet('national');
    const g = graphPair.has(key) ? (graphPair.get(key) as number) : null;

    // modeled reconciliation: the canonical edge and every modeled-lens sheet
    // value for this pair must agree. national-lens values are context only.
    const modeledValues = modeled.map((s) => s.amount);
    if (g !== null) modeledValues.push(g);
    let spread = 0;
    let status: PairRecon['status'];
    if (modeled.length > 0 && modeledValues.length >= 2) {
      spread = Math.max(...modeledValues) - Math.min(...modeledValues);
      if (spread > tolerance) status = 'mismatch';
      else if (g === null) status = 'absent-in-graph';
      else status = 'ok';
    } else {
      // nothing to cross-check in the modeled lens (a lone graph edge, or only
      // national-lens statements such as the insurer's NHE-basis claims)
      status = 'context-only';
    }
    if (!modeled.length && !national.length && g === null) continue;
    pairs.push({
      from,
      to,
      fromLabel: label[from] ?? from,
      toLabel: label[to] ?? to,
      graph: g,
      modeled,
      national,
      spread,
      status,
    });
  }
  pairs.sort((a, b) => b.spread - a.spread || a.from.localeCompare(b.from));
  return {
    pairs,
    mismatches: pairs.filter((p) => p.status === 'mismatch' || p.status === 'absent-in-graph'),
    context: pairs.filter((p) => p.national.length > 0),
    tolerance,
  };
}
