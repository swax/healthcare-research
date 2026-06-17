// Shared Excel plumbing: turn the renderer's Sheet (Cell) model into ExcelJS
// worksheets, plus the citation-footnoting pass. Kept separate from the workbook
// builder (src/xlsx.ts) so the pour-in lives in one place, independent of how the
// node-ledger sheets are produced. Erasable-syntax-only TypeScript, same as the rest of src/.
import ExcelJS from 'exceljs';
import type { Style, Cell, Sheet } from './sheet-model.ts';

export const argb = (hex: string): string => 'FF' + hex.replace('#', '').toUpperCase();

export function colToNum(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
export function numToCol(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = (n - m - 1) / 26;
  }
  return s;
}

export function applyStyle(cell: ExcelJS.Cell, s?: Style): void {
  if (!s) return;
  if (s.b || s.sz || s.color)
    cell.font = {
      bold: !!s.b,
      ...(s.sz ? { size: s.sz } : {}),
      ...(s.color ? { color: { argb: argb(s.color) } } : {}),
    };
  if (s.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(s.fill) } };
  if (s.h || s.v || s.wrap || s.indent)
    cell.alignment = {
      ...(s.h ? { horizontal: s.h as ExcelJS.Alignment['horizontal'] } : {}),
      ...(s.v ? { vertical: s.v as ExcelJS.Alignment['vertical'] } : {}),
      ...(s.wrap ? { wrapText: true } : {}),
      ...(s.indent ? { indent: s.indent } : {}),
    };
  if (s.fmt) cell.numFmt = s.fmt;
}

// Footnote the citation columns. Each narrative sheet keeps free-text citations
// in a "Source" column to the right of a "Notes" column. This collapses that
// column: every row's citation becomes [n] markers appended to its Notes cell,
// the per-row Source column is dropped, and the distinct citations are listed,
// numbered, at the bottom of the sheet. Numbering restarts per sheet; cells that
// pack several citations (";"-separated) expand to several markers, e.g. [1][2].
const HEADER_LABELS = new Set(['Notes', 'Delta / Notes', 'Source', 'Source / Category']);
interface CiteBlock {
  row: number;
  notesCol: number;
  srcCol: number;
}
export function footnoteSources(allSheets: Sheet[]): void {
  for (const sh of allSheets) {
    const cellAt = new Map<string, Cell>();
    for (const c of sh.cells) cellAt.set(c.r + ':' + c.c, c);
    const textAt = (r: number, c: number): string | undefined => {
      const cell = cellAt.get(r + ':' + c);
      return cell && cell.f === undefined && typeof cell.v === 'string' ? cell.v : undefined;
    };

    // Group the structural header cells by row; a row is a citation block when it
    // carries a Notes header and a "Source" header strictly to its right (a
    // "Source" header at/left of Notes is a row-label column, not a citation).
    const headerRows = new Set<number>();
    const byRow = new Map<number, Cell[]>();
    for (const c of sh.cells) {
      if (c.f === undefined && typeof c.v === 'string' && HEADER_LABELS.has(c.v)) {
        headerRows.add(c.r);
        let arr = byRow.get(c.r);
        if (!arr) byRow.set(c.r, (arr = []));
        arr.push(c);
      }
    }
    const blocks: CiteBlock[] = [];
    for (const [row, hdrs] of byRow) {
      const notes = hdrs.find((h) => h.v === 'Notes' || h.v === 'Delta / Notes');
      if (!notes) continue;
      const src = hdrs.find((h) => h.v === 'Source' && h.c > notes.c);
      if (src) blocks.push({ row, notesCol: notes.c, srcCol: src.c });
    }
    if (!blocks.length) continue;
    blocks.sort((a, b) => a.row - b.row);

    const boundaries = [...headerRows].sort((a, b) => a - b);
    const maxRow = Math.max(...sh.cells.map((c) => c.r));
    const order: string[] = []; // distinct citation text, first-seen order
    const num = new Map<string, number>(); // citation text -> 1-based index
    const srcCols = new Set<number>();

    for (const b of blocks) {
      srcCols.add(b.srcCol);
      const end = boundaries.find((r) => r > b.row) ?? maxRow + 1;
      for (let r = b.row + 1; r < end; r++) {
        const raw = textAt(r, b.srcCol);
        if (!raw) continue;
        const cites = raw
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!cites.length) continue;
        let marker = '';
        for (const cite of cites) {
          if (!num.has(cite)) {
            order.push(cite);
            num.set(cite, order.length);
          }
          marker += '[' + num.get(cite) + ']';
        }
        const srcCell = cellAt.get(r + ':' + b.srcCol);
        const noteKey = r + ':' + b.notesCol;
        const noteCell = cellAt.get(noteKey);
        if (noteCell && noteCell.f === undefined && typeof noteCell.v === 'string') {
          noteCell.v = (noteCell.v ? noteCell.v + ' ' : '') + marker;
        } else if (noteCell && noteCell.f === undefined) {
          noteCell.v = marker;
        } else {
          const nc: Cell = { r, c: b.notesCol, v: marker, s: srcCell?.s };
          sh.cells.push(nc);
          cellAt.set(noteKey, nc);
        }
        if (srcCell) srcCell.v = undefined;
      }
    }

    // Drop the now-empty Source column: remove its header + emptied cells, and
    // collapse its width so nothing but the legend remains.
    sh.cells = sh.cells.filter((c) => {
      if (!srcCols.has(c.c) || c.f !== undefined) return true;
      return c.v !== 'Source' && c.v !== undefined;
    });
    for (const c of srcCols) sh.columns[numToCol(c)] = 3;

    if (!order.length) continue;

    // Numbered source list at the bottom of the sheet.
    let r = maxRow + 2;
    sh.cells.push({ r, c: 1, v: 'Sources', s: { b: true, sz: 10, fill: 'ECEFF1' } });
    r++;
    for (let i = 0; i < order.length; i++) {
      sh.cells.push({
        r,
        c: 1,
        v: '[' + (i + 1) + ']  ' + order[i],
        s: { sz: 9, color: '555555', wrap: true, v: 'top' },
      });
      sh.merges.push('A' + r + ':' + numToCol(5) + r);
      r++;
    }
  }
}

// Pour the Sheet (Cell) model into ExcelJS worksheets on `wb`, preserving column
// widths, row heights, freeze panes, tab color, formulas, styles and merges.
export function addSheetsToWorkbook(wb: ExcelJS.Workbook, sheets: Sheet[]): void {
  for (const sh of sheets) {
    const view: ExcelJS.WorksheetView = { showGridLines: sh.gridlines } as ExcelJS.WorksheetView;
    if (sh.freeze) {
      const m = /^([A-Z]+)(\d+)$/.exec(sh.freeze);
      if (m) {
        view.state = 'frozen';
        view.xSplit = colToNum(m[1]) - 1;
        view.ySplit = parseInt(m[2], 10) - 1;
      }
    }
    const ws = wb.addWorksheet(sh.name, {
      views: [view],
      properties: (sh.tabColor
        ? { tabColor: { argb: argb(sh.tabColor) } }
        : {}) as ExcelJS.AddWorksheetOptions['properties'],
    });
    for (const [letter, width] of Object.entries(sh.columns))
      ws.getColumn(colToNum(letter)).width = width;
    for (const [r, h] of Object.entries(sh.rows)) ws.getRow(parseInt(r, 10)).height = h;
    for (const cd of sh.cells) {
      const cell = ws.getRow(cd.r).getCell(cd.c);
      if (cd.f !== undefined) cell.value = { formula: cd.f.replace(/^=/, '') };
      else if (cd.v !== undefined) cell.value = cd.v;
      applyStyle(cell, cd.s);
    }
    for (const rng of sh.merges) {
      try {
        ws.mergeCells(rng);
      } catch {
        /* ignore */
      }
    }
  }
}
