// The cell model both renderers emit: a plain {row, col, value/formula, style}
// description of a worksheet that src/workbook.ts pours into ExcelJS. Pure types,
// no IO and no graph dependency — shared infra for ledger.ts and workbook.ts.
// Erasable-syntax-only TypeScript, same as the rest of src/.
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
