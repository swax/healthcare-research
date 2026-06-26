// Build the Excel workbook from data/graph.json (validated first):
//   dist/2023_healthcare_spending.xlsx
//
// Per-node ledger sheets (INFLOWS/OUTFLOWS/NET/VALIDATION) driven by the
// observations-first data, plus Nodes/Edges/Observations audit sheets.
// See src/xlsx.ts.
//
// Run: node src/build.ts   (set XLSX_OUT to a temp path if Excel holds the
// default file open — Excel takes an exclusive lock on Windows).
import { mkdirSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGraph, validateGraph } from './graph.ts';
import { buildWorkbook } from './xlsx.ts';

const BASENAME = '2023_healthcare_spending';

// Next versioned output path: scans dist for <BASENAME>_v<N>.xlsx and returns
// the path for max(N)+1 (v1 when none exist), so each build is a new file
// instead of overwriting the previous one.
function nextVersionedPath(dist: string): string {
  const re = new RegExp(`^${BASENAME}_v(\\d+)\\.xlsx$`);
  let max = 0;
  for (const name of readdirSync(dist)) {
    const m = name.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return join(dist, `${BASENAME}_v${max + 1}.xlsx`);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = loadGraph(root);

const problems = validateGraph(file);
if (problems.length) {
  console.error('graph validation failed:\n - ' + problems.join('\n - '));
  throw new Error(problems.length + ' validation error(s) — fix data/graph.json');
}

// Refresh the BLS labor cross-check from the (git-ignored) OEWS source files when they
// are present locally — so the workbook's "Labor Cross-Check (BLS)" sheet stays current
// as part of the build. On a fresh clone without the files, the committed
// data/labor_bls.json is rendered as-is. Non-fatal: a parse failure never breaks the build.
if (existsSync(join(root, 'references', 'bls2023', 'oesm23in4'))) {
  try {
    const { computeReconciliation, writeDerived } = await import('../scripts/reconcile_labor.mjs');
    writeDerived(root, await computeReconciliation(root));
    console.log('bls   -> refreshed data/labor_bls.json from references/bls2023');
  } catch (e) {
    console.warn(
      'bls   -> recompute skipped (' +
        (e instanceof Error ? e.message : e) +
        '); using committed data/labor_bls.json',
    );
  }
}

// Likewise refresh the Finkelstein §5 aggregate cross-check from the (git-ignored) CMS NHE
// CSV when it's present locally, so the "Insurance & Spending (Finkelstein S5)" sheet stays
// current. On a fresh clone the committed data/finkelstein_s5.json is rendered as-is.
if (existsSync(join(root, 'references', 'nhe2024', 'NHE2024.csv'))) {
  try {
    const { compute, writeDerived } = await import('../scripts/extend_finkelstein_s5.mjs');
    writeDerived(root, compute(root));
    console.log('nhe   -> refreshed data/finkelstein_s5.json from references/nhe2024');
  } catch (e) {
    console.warn(
      'nhe   -> recompute skipped (' +
        (e instanceof Error ? e.message : e) +
        '); using committed data/finkelstein_s5.json',
    );
  }
}

const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

const wb = buildWorkbook(file, root);
const xlsxPath = process.env.XLSX_OUT ?? nextVersionedPath(dist);
await wb.xlsx.writeFile(xlsxPath);
console.log('xlsx  -> ' + xlsxPath + '  (' + wb.worksheets.length + ' sheets)');
