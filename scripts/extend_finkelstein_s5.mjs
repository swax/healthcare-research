// Complementary analysis (NOT part of the flow model): extends Section 5 of
// Finkelstein (2005), "The Aggregate Effects of Health Insurance: Evidence from
// the Introduction of Medicare" (NBER w11619, references/w11619.pdf), through 2024.
//
//   node scripts/extend_finkelstein_s5.mjs     # prints the readout AND writes data/finkelstein_s5.json
//
// Finkelstein's Section 5 back-of-the-envelope asks: how much of the long-run rise
// in real per-capita health spending can the *spread of health insurance* explain?
// Her method (paper p.24-25, footnotes 25-27):
//
//   1. Proxy the spread of insurance by the average COINSURANCE RATE =
//      out-of-pocket spending / total health spending. (Lower = more insured.)
//   2. Use the paper's own Medicare estimate as the price response: a 7pp drop in
//      the coinsurance rate is associated with a ~23% rise in spending
//      (=> PER_PP below). Extrapolate that linearly to the full coinsurance decline.
//   3. Compare the PREDICTED spending increase to the ACTUAL real per-capita
//      increase; the ratio is the "share explained."
//
// She runs this for 1950-1990 (got "about forty percent") and, in footnote 27, for
// 1990-2000 (got "about half"). The CMS NHE series starts in 1960, so we cannot
// reach 1950; instead we (a) re-run her 1990-2000 window as a VALIDATION that this
// engine reproduces her arithmetic, and (b) carry the calculation forward to 2024.
//
// This is a traced/aggregate cross-check, not the flow model and not a gate.
// Differing window results are context, not discrepancies (cf. the repo's no-spread
// /no-discrepancy-engine convention in src/graph.ts).
//
// Inputs:
//   - references/nhe2024/NHE2024.csv (git-ignored; CMS NHE 2024 release, CY1960-2024,
//     "by type of service and source of funds"). Same file derive_hi_claims.mjs reads.
//   - CPI-U deflator: embedded below as one transparent labeled constant (BLS series
//     CUUR0000SA0, U.S. city average, all items, annual average; 1982-84=100). Embedded
//     rather than read from a file because references/ is git-ignored, so this keeps the
//     analysis reproducible offline. Verify/extend the values against data.bls.gov.
//
// Output: data/finkelstein_s5.json - a small, COMMITTED derived artifact, so the
// analysis survives without the (git-ignored) raw CSV and can be rendered later.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

export const PAPER = 'Finkelstein 2005, NBER w11619, Section 5';
export const NHE_SOURCE =
  'CMS NHE 2024 release (CY1960-2024), by type of service & source of funds';

// Finkelstein's price response, from her own Medicare estimate: a 7pp fall in the
// average coinsurance rate is associated with a ~23% rise in spending (p.24). One
// transparent elasticity, applied linearly exactly as she does.
export const PCT_PER_PP = 23 / 7; // ~3.29% spending per 1pp coinsurance drop

// CPI-U, U.S. city average, all items, annual average (BLS CUUR0000SA0; 1982-84=100).
export const CPI_SOURCE = 'BLS CPI-U, U.S. city average, all items, annual average (1982-84=100)';
export const CPI = {
  1960: 29.6,
  1965: 31.5,
  1970: 38.8,
  1980: 82.4,
  1990: 130.7,
  2000: 172.2,
  2010: 218.056,
  2020: 258.811,
  2023: 304.702,
  2024: 313.689,
};

// The windows to report. kind:'validation' re-runs one of Finkelstein's own windows
// (with her published result for comparison); kind:'extension' carries it past 2005.
const WINDOWS = [
  {
    from: 1960,
    to: 1990,
    kind: 'validation',
    finkelstein: '~40% for 1950-1990 (her window starts pre-NHE)',
  },
  { from: 1990, to: 2000, kind: 'validation', finkelstein: '~50% ("about half", footnote 27)' },
  { from: 2000, to: 2024, kind: 'extension' },
  { from: 1990, to: 2024, kind: 'extension' },
  { from: 1960, to: 2024, kind: 'extension' },
];

// Hospital windows. Finkelstein's 23%-per-7pp estimate is itself a HOSPITAL spending
// response (Section 3), so applying it to hospital coinsurance is the paper's most direct
// use — not validating a published total-spending BOTE, hence kind:'application'. The
// 1965-1980 window isolates Medicare's actual hospital takeover, when coinsurance was
// genuinely falling.
const HOSP_WINDOWS = [
  {
    from: 1965,
    to: 1980,
    kind: 'core',
    note: "Medicare's hospital takeover — coinsurance actually falling",
  },
  { from: 1960, to: 1990, kind: 'application' },
  { from: 1990, to: 2024, kind: 'application' },
  { from: 2000, to: 2024, kind: 'application' },
  { from: 1960, to: 2024, kind: 'application' },
];

// ---- CSV parsing (same idiom as scripts/derive_hi_claims.mjs) ----
function parseLine(line) {
  const out = [];
  let cur = '',
    q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') {
        out.push(cur);
        cur = '';
      } else cur += c;
    }
  }
  out.push(cur);
  return out;
}
const num = (s) => {
  const n = Number(String(s).replace(/[",]/g, ''));
  return Number.isFinite(n) ? n : null;
};
// like num, but NHE's " - " (dash = not applicable / zero) becomes 0 — used for the
// hospital payer components, which are dashes before a program exists (Medicare pre-1966).
const num0 = (s) => {
  const t = String(s)
    .replace(/[",]/g, '')
    .trim();
  if (t === '' || /^-+$/.test(t)) return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
};

// Pull the three top-level series we need, plus the year header, from the CSV.
function readNhe(root) {
  const lines = readFileSync(join(root, 'references', 'nhe2024', 'NHE2024.csv'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.length);
  const header = parseLine(lines[1]); // "Expenditure Amount (Millions)", 1960, 1961, ...
  const years = header
    .slice(1)
    .map((y) => parseInt(y, 10))
    .filter(Number.isFinite);
  const want = {
    total: 'Total National Health Expenditures',
    oop: 'Out of pocket',
    pop: 'POPULATION',
  };
  const series = {};
  for (let i = 2; i < lines.length; i++) {
    const row = parseLine(lines[i]);
    const lbl = row[0].trim();
    for (const [key, label] of Object.entries(want)) {
      if (lbl === label && !(key in series)) {
        series[key] = Object.fromEntries(years.map((y, j) => [y, num(row[1 + j])]));
      }
    }
  }
  for (const k of Object.keys(want))
    if (!series[k]) throw new Error(`NHE row not found: "${want[k]}"`);
  return { years, ...series };
}

// Pull the hospital block (Total Hospital Expenditures + its source-of-funds rows) — the
// sector Finkelstein actually studies. Captures the block total plus out-of-pocket and the
// three biggest payers, then stops at the next "Total ..." service-category boundary.
function readHospital(root, years) {
  const lines = readFileSync(join(root, 'references', 'nhe2024', 'NHE2024.csv'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.length);
  let i = 2;
  for (; i < lines.length; i++)
    if (parseLine(lines[i])[0].trim() === 'Total Hospital Expenditures') break;
  if (i >= lines.length) throw new Error('hospital block not found in NHE CSV');
  const rowVals = (cells) => Object.fromEntries(years.map((y, j) => [y, num0(cells[1 + j])]));
  const out = { total: rowVals(parseLine(lines[i])) };
  const want = {
    oop: 'Out of pocket',
    privateIns: 'Private Health Insurance',
    medicare: 'Medicare',
    medicaid: 'Medicaid (Title XIX)',
  };
  const taken = new Set();
  for (i++; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    const lbl = cells[0].trim();
    if (lbl.startsWith('Total ')) break; // next service-category boundary
    for (const [k, label] of Object.entries(want))
      if (lbl === label && !taken.has(k)) {
        out[k] = rowVals(cells);
        taken.add(k);
      }
  }
  for (const k of Object.keys(want))
    if (!out[k]) throw new Error(`hospital row not found: "${want[k]}"`);
  return out;
}

// Coinsurance series + windowed back-of-the-envelope for one spending aggregate (national
// or hospital). Shared so both views use byte-identical arithmetic.
function analyze(total, oop, pop, years, windowDefs) {
  const coinsuranceSeries = years.map((y) => ({
    year: y,
    totalMillions: total[y],
    oopMillions: oop[y],
    coinsurancePct: +((100 * oop[y]) / total[y]).toFixed(2),
  }));
  // Real per-capita level: total $millions / population millions, CPI-deflated (the index
  // base cancels in any ratio).
  const perCapReal = (y) => total[y] / pop[y] / CPI[y];
  const windows = windowDefs.map((w) => {
    for (const y of [w.from, w.to])
      if (!(y in CPI)) throw new Error(`CPI missing for ${y}; add it to the CPI table.`);
    const cFrom = (100 * oop[w.from]) / total[w.from];
    const cTo = (100 * oop[w.to]) / total[w.to];
    const dropPP = cFrom - cTo;
    const predictedSpendingPct = dropPP * PCT_PER_PP;
    const realPerCapitaGrowthPct = (perCapReal(w.to) / perCapReal(w.from) - 1) * 100;
    const explainedSharePct = (predictedSpendingPct / realPerCapitaGrowthPct) * 100;
    return {
      from: w.from,
      to: w.to,
      kind: w.kind,
      ...(w.finkelstein ? { finkelstein: w.finkelstein } : {}),
      ...(w.note ? { context: w.note } : {}),
      coinsuranceFromPct: +cFrom.toFixed(2),
      coinsuranceToPct: +cTo.toFixed(2),
      dropPP: +dropPP.toFixed(2),
      predictedSpendingPct: +predictedSpendingPct.toFixed(1),
      realPerCapitaGrowthPct: +realPerCapitaGrowthPct.toFixed(1),
      explainedSharePct: +explainedSharePct.toFixed(1),
    };
  });
  return { coinsuranceSeries, windows };
}

// Snapshot years for the hospital payer-mix table (decade-ish, plus the 1965/1966 break).
const PAYER_MIX_YEARS = [1960, 1965, 1966, 1970, 1980, 1990, 2000, 2010, 2024];

export function compute(root) {
  const nhe = readNhe(root);
  const { total, oop, pop, years } = nhe;
  const hosp = readHospital(root, years);

  const national = analyze(total, oop, pop, years, WINDOWS);
  const hospital = analyze(hosp.total, hosp.oop, pop, years, HOSP_WINDOWS);

  // Hospital payer mix: each payer's share of hospital spending at snapshot years. "Other"
  // is the residual (DoD, VA, CHIP, other third-party, workers' comp, philanthropy, …).
  // This is where Medicare's 1966 arrival is most visible — and where out-of-pocket falls
  // in absolute dollars (1965→1966) as Medicare displaces it.
  const payerMix = PAYER_MIX_YEARS.map((y) => {
    const t = hosp.total[y];
    const pct = (v) => +((100 * v) / t).toFixed(1);
    const oopPct = pct(hosp.oop[y]);
    const privatePct = pct(hosp.privateIns[y]);
    const medicarePct = pct(hosp.medicare[y]);
    const medicaidPct = pct(hosp.medicaid[y]);
    return {
      year: y,
      totalMillions: t,
      oopPct,
      privatePct,
      medicarePct,
      medicaidPct,
      otherPct: +(100 - oopPct - privatePct - medicarePct - medicaidPct).toFixed(1),
    };
  });

  return {
    _generated:
      'by scripts/extend_finkelstein_s5.mjs - do not hand-edit. Re-run when CMS publishes a new NHE release.',
    paper: PAPER,
    method:
      'coinsurance = out-of-pocket / total spending; predicted spending rise = coinsurance drop (pp) x ' +
      `${PCT_PER_PP.toFixed(3)}%/pp (Finkelstein's 23%-per-7pp Medicare estimate); ` +
      'explained share = predicted / actual real-per-capita growth.',
    nheSource: NHE_SOURCE,
    cpiSource: CPI_SOURCE,
    pctPerPp: +PCT_PER_PP.toFixed(4),
    caveats: [
      "Aggregate back-of-the-envelope, not a causal estimate; cannot reproduce the paper's hospital-panel identification.",
      'NHE starts in 1960, so the 1950-1990 window (her ~40%) cannot be reached; the 1960-1990 result is lower by exactly the pre-1960 coinsurance decline.',
      'Linear extrapolation of one elasticity far outside the Medicare experiment that produced it; less reliable as coinsurance approaches its floor.',
      'Hospital windows apply her hospital-spending elasticity to hospital coinsurance — the paper\'s most direct use — but there is no published hospital "share explained" to validate against.',
    ],
    coinsuranceSeries: national.coinsuranceSeries,
    windows: national.windows,
    hospital: {
      coinsuranceSeries: hospital.coinsuranceSeries,
      windows: hospital.windows,
      payerMix,
    },
  };
}

export function writeDerived(root, data) {
  const out = join(root, 'data', 'finkelstein_s5.json');
  writeFileSync(out, JSON.stringify(data, null, 2) + '\n');
  return out;
}

// ---- console readout (only when run directly) ----
function printConsole(d) {
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  console.log(`\n${d.paper}  -  spread of insurance vs. growth of health spending`);
  console.log('(aggregate cross-check, not the flow model, not a gate)\n');

  const s = d.coinsuranceSeries;
  console.log('Average coinsurance rate (out-of-pocket / total NHE):');
  for (const y of [1960, 1966, 1970, 1980, 1990, 2000, 2010, 2024]) {
    const r = s.find((x) => x.year === y);
    if (r)
      console.log(
        `  ${r.year}   ${padL(r.coinsurancePct.toFixed(1) + '%', 6)}   ` +
          `total NHE $${(r.totalMillions / 1e6).toFixed(2)}T` +
          (y === 1966 ? '   <- Medicare/Medicaid begin' : ''),
      );
  }

  console.log('\nBack-of-the-envelope, by window:');
  console.log(
    '  ' +
      pad('window', 12) +
      padL('coins drop', 11) +
      padL('predicted', 11) +
      padL('actual real', 12) +
      padL('explained', 11) +
      '   note',
  );
  console.log('  ' + '-'.repeat(72));
  for (const w of d.windows) {
    console.log(
      '  ' +
        pad(`${w.from}-${w.to}`, 12) +
        padL(`${w.dropPP.toFixed(1)}pp`, 11) +
        padL(`+${w.predictedSpendingPct.toFixed(0)}%`, 11) +
        padL(`+${w.realPerCapitaGrowthPct.toFixed(0)}%`, 12) +
        padL(`${w.explainedSharePct.toFixed(0)}%`, 11) +
        (w.kind === 'validation' ? `   validation: Finkelstein ${w.finkelstein}` : '   extension'),
    );
  }
  console.log(
    '\nReading: "explained" = share of the real per-capita spending rise attributable to',
  );
  console.log("the falling coinsurance rate, on Finkelstein's own elasticity. The 1990-2000");
  console.log('validation lands near her "about half"; the post-2000 share shrinks as coinsurance');
  console.log('nears its floor - i.e. the insurance-spread channel is largely spent, leaving the');
  console.log('residual (technology, prices) - her preferred long-run driver - to dominate.\n');
  const h = d.hospital;
  console.log("\nHOSPITAL SECTOR (Finkelstein's actual subject) — coinsurance (OOP / hospital spend):");
  for (const y of [1960, 1965, 1966, 1980, 2000, 2024]) {
    const r = h.coinsuranceSeries.find((x) => x.year === y);
    if (r)
      console.log(
        `  ${r.year}   ${padL(r.coinsurancePct.toFixed(1) + '%', 6)}` +
          (y === 1966 ? '   <- Medicare/Medicaid begin' : ''),
      );
  }
  console.log('\nHospital back-of-the-envelope (her 23%/7pp is itself a hospital estimate):');
  for (const w of h.windows) {
    console.log(
      '  ' +
        pad(`${w.from}-${w.to}`, 12) +
        padL(`${w.dropPP.toFixed(1)}pp`, 11) +
        padL(`+${w.predictedSpendingPct.toFixed(0)}%`, 11) +
        padL(`+${w.realPerCapitaGrowthPct.toFixed(0)}%`, 12) +
        padL(`${w.explainedSharePct.toFixed(0)}%`, 11) +
        (w.context ? `   ${w.context}` : ''),
    );
  }
  console.log('\nHospital payer mix (% of hospital spending):');
  console.log(
    '  ' +
      pad('year', 6) +
      padL('OOP', 8) +
      padL('Private', 9) +
      padL('Medicare', 10) +
      padL('Medicaid', 10) +
      padL('Other', 8),
  );
  for (const m of h.payerMix) {
    console.log(
      '  ' +
        pad(String(m.year), 6) +
        padL(m.oopPct.toFixed(1) + '%', 8) +
        padL(m.privatePct.toFixed(1) + '%', 9) +
        padL(m.medicarePct.toFixed(1) + '%', 10) +
        padL(m.medicaidPct.toFixed(1) + '%', 10) +
        padL(m.otherPct.toFixed(1) + '%', 8) +
        (m.year === 1966 ? '  <- Medicare & Medicaid begin' : ''),
    );
  }
  console.log('');
  for (const c of d.caveats) console.log('  caveat: ' + c);
  console.log('');
}

const isMain = pathToFileURL(process.argv[1] ?? '').href === import.meta.url;
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const data = compute(root);
  const out = writeDerived(root, data);
  printConsole(data);
  console.log('wrote ' + out);
}
