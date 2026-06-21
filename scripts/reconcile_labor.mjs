// Complementary cross-check (NOT part of the model): reconciles the 10 labor edges
// flowing into the `healthcare_workers` sink against BLS OEWS May 2023 industry data.
//
//   node scripts/reconcile_labor.mjs       # prints the readout AND writes data/labor_bls.json
//
// For each edge we keep the MODEL's dollar figure as the spine (read live from
// data/graph.json) and use BLS to look *inside* it: how many people that industry
// employs (headcount), what they earn (wage bill), and which job functions dominate.
// The model's edge is total comp (wages + benefits + self-employed income); OEWS is
// wages of payroll employees only, so we gross BLS wages to comp with an ECEC benefit
// load and report the gap as CONTEXT — never as a discrepancy to gate on (cf.
// src/graph.ts: there is deliberately no spread/discrepancy engine; differing lenses
// are notes, not errors).
//
// Output: data/labor_bls.json — a small, COMMITTED derived artifact (BLS numbers only,
// no model dollars, so it can't drift from graph.json). src/xlsx.ts renders it as the
// "Labor Cross-Check (BLS)" workbook sheet. Regenerate it when BLS publishes a new year.
//
// Requires the BLS OEWS May 2023 files under references/bls2023/ (git-ignored):
//   oesm23nat/national_M2023_dl.xlsx        national by occupation
//   oesm23in4/nat3d_M2023_dl.xlsx           3-digit NAICS x occupation
//   oesm23in4/nat4d_M2023_dl.xlsx           4-digit NAICS x occupation
//   oesm23in4/nat5d_6d_M2023_dl.xlsx        5/6-digit NAICS x occupation
import ExcelJS from 'exceljs';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

export const SOURCE = 'BLS OEWS May 2023';
// ECEC 2023: wages & salaries are ~70% of total compensation in health care & social
// assistance, so total comp = wages / 0.70 ~= wages x 1.42. One transparent factor;
// real benefit loads run higher for hospitals, lower for aide-heavy sectors.
export const BENEFIT_LOAD = 1.42;

// edge id (data/graph.json) -> BLS industry it most closely corresponds to.
// `naics` is the OEWS code; `file` is which industry file carries that digit level.
const MAP = {
  hospitals_workers_labor: { naics: '622000', file: 'nat3d', note: '' },
  providers_physician_workers_labor: {
    naics: '621100',
    file: 'nat4d',
    note: 'edge also carries hospital-EMPLOYED physician comp, which BLS counts under Hospitals (622) — so headcount here is understated vs the dollars',
  },
  providers_dental_workers_labor: { naics: '621200', file: 'nat4d', note: '' },
  providers_other_workers_labor: {
    naics: '621300',
    file: 'nat4d',
    note: 'optometry/chiro/podiatry/PT-OT/behavioral — many are self-employed (income invisible to OEWS wages)',
  },
  ltc_nursing_workers_labor: {
    naics: '623100',
    file: 'nat4d',
    altNaics: '623000',
    altFile: 'nat3d',
    note: 'primary = skilled nursing (6231); broad alt = all nursing+residential care (623)',
  },
  ltc_homehealth_workers_labor: {
    naics: '621600',
    file: 'nat4d',
    note: 'most personal-care aides sit in 624120 (social assistance), OUTSIDE this health-care edge',
  },
  pharma_workers_labor: { naics: '325400', file: 'nat4d', note: 'pharma & medicine manufacturing' },
  hi_workers_labor: {
    naics: '524114',
    file: 'nat56d',
    note: 'direct health & medical insurance carriers (excludes PBMs, TPAs, brokers)',
  },
  fed_workers_programs: {
    gov: true,
    note: 'CMS admin, CDC/HRSA/IHS, NIH researchers — government ownership, no single NAICS in OEWS',
  },
  state_workers_programs: {
    gov: true,
    note: 'state/local public-health & Medicaid administration workforce',
  },
};

// the 8 industry-mapped edges, in display order
export const MAPPED_ORDER = [
  'hospitals_workers_labor',
  'providers_physician_workers_labor',
  'providers_dental_workers_labor',
  'providers_other_workers_labor',
  'ltc_nursing_workers_labor',
  'ltc_homehealth_workers_labor',
  'pharma_workers_labor',
  'hi_workers_labor',
];
export const GOV_ORDER = ['fed_workers_programs', 'state_workers_programs'];

const COL = { naics: 5, naicsTitle: 6, occ: 9, occTitle: 10, ogroup: 11, emp: 12, amean: 19 };
const numOr = (v) => {
  const s = String(v);
  if (s.includes('#') || !/[0-9]/.test(s)) return null;
  const n = Number(s.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// scan one OEWS file once, pulling each target NAICS's industry total + detailed occ rows
async function scan(path, naicsSet) {
  const out = {};
  for (const n of naicsSet) out[n] = { title: '', emp: null, amean: null, occ: [] };
  const wb = new ExcelJS.stream.xlsx.WorkbookReader(path, {});
  for await (const ws of wb) {
    for await (const row of ws) {
      const v = row.values; // 1-indexed
      const naics = String(v[COL.naics] ?? '');
      if (!naicsSet.has(naics)) continue;
      const rec = out[naics];
      rec.title = String(v[COL.naicsTitle] ?? '');
      if (v[COL.occ] === '00-0000') {
        rec.emp = numOr(v[COL.emp]);
        rec.amean = numOr(v[COL.amean]);
      } else if (v[COL.ogroup] === 'detailed') {
        rec.occ.push({
          title: String(v[COL.occTitle]),
          emp: numOr(v[COL.emp]),
          mean: numOr(v[COL.amean]),
          capped: String(v[COL.amean]).includes('#'),
        });
      }
    }
    break; // first worksheet only
  }
  return out;
}

// model edge dollars, read live from the source of truth (used only for the console
// readout — NOT written into labor_bls.json, so the derived file can't drift).
export function loadEdgeDollars(root) {
  const graph = JSON.parse(readFileSync(join(root, 'data', 'graph.json'), 'utf8'));
  const edges = graph.edges ?? graph.graph?.edges;
  const canon = (e) =>
    (e.observations.length === 1 ? e.observations[0] : e.observations.find((o) => o.canonical))
      .value;
  const out = {};
  for (const e of edges) if (e.id in MAP) out[e.id] = canon(e);
  return out;
}

// Build the BLS-only derived object that gets written to data/labor_bls.json.
export async function computeReconciliation(root) {
  const dir = join(root, 'references', 'bls2023');
  const FILES = {
    nat3d: join(dir, 'oesm23in4', 'nat3d_M2023_dl.xlsx'),
    nat4d: join(dir, 'oesm23in4', 'nat4d_M2023_dl.xlsx'),
    nat56d: join(dir, 'oesm23in4', 'nat5d_6d_M2023_dl.xlsx'),
    nat: join(dir, 'oesm23nat', 'national_M2023_dl.xlsx'),
  };

  // group needed NAICS by file, scan each file once
  const need = { nat3d: new Set(), nat4d: new Set(), nat56d: new Set() };
  for (const m of Object.values(MAP)) {
    if (m.gov) continue;
    need[m.file].add(m.naics);
    if (m.altNaics) need[m.altFile].add(m.altNaics);
  }
  const data = {};
  for (const f of Object.keys(need))
    if (need[f].size) Object.assign(data, await scan(FILES[f], need[f]));

  // national occupation anchors (29-0000 / 31-0000) for the "how many people" headline
  const anchorRaw = {};
  {
    const wb = new ExcelJS.stream.xlsx.WorkbookReader(FILES.nat, {});
    for await (const ws of wb) {
      for await (const row of ws) {
        const v = row.values;
        if (String(v[COL.naics]) !== '000000') continue;
        if (v[COL.occ] === '29-0000' || v[COL.occ] === '31-0000')
          anchorRaw[v[COL.occ]] = {
            code: v[COL.occ],
            title: String(v[COL.occTitle]),
            emp: numOr(v[COL.emp]),
            mean: numOr(v[COL.amean]),
          };
      }
      break;
    }
  }

  const topOcc = (naics, k = 6) =>
    data[naics].occ
      .filter((o) => o.emp)
      .sort((a, b) => b.emp - a.emp)
      .slice(0, k)
      .map((o) => ({ title: o.title, emp: o.emp, mean: o.mean, capped: o.capped }));

  const edges = MAPPED_ORDER.map((id) => {
    const m = MAP[id];
    const d = data[m.naics];
    return {
      edgeId: id,
      naics: m.naics,
      industry: d.title,
      jobs: d.emp,
      meanWage: d.amean,
      note: m.note,
      top: topOcc(m.naics),
    };
  });

  const alt = data['623000'];
  return {
    _generated:
      'by scripts/reconcile_labor.mjs — do not hand-edit. Regenerate when BLS publishes a new year.',
    source: SOURCE,
    benefitLoad: BENEFIT_LOAD,
    edges,
    broadNursing: alt
      ? {
          forEdge: 'ltc_nursing_workers_labor',
          naics: '623000',
          industry: alt.title,
          jobs: alt.emp,
          meanWage: alt.amean,
        }
      : null,
    anchors: { practitioners: anchorRaw['29-0000'], support: anchorRaw['31-0000'] },
    government: GOV_ORDER.map((id) => ({ edgeId: id, note: MAP[id].note })),
  };
}

export function writeDerived(root, data) {
  const out = join(root, 'data', 'labor_bls.json');
  writeFileSync(out, JSON.stringify(data, null, 2) + '\n');
  return out;
}

// ---- console readout (only when run directly) ----
function printConsole(data, edgeVal) {
  const B = (n) => (n / 1e9).toFixed(1);
  const k = (n) => '$' + Math.round(n / 1000) + 'k';
  const M = (n) => (n / 1e6).toFixed(2) + 'M';
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  const L = data.benefitLoad;

  console.log(`\n${data.source}  x  model labor edges   (complementary cross-check, not a gate)\n`);
  console.log(
    pad('edge / industry', 34) +
      padL('model $B', 9) +
      padL('BLS jobs', 10) +
      padL('wages $B', 10) +
      padL('comp $B', 9) +
      padL('model $/wkr', 12) +
      padL('BLS $/wkr', 11),
  );
  console.log('-'.repeat(95));
  let mJobs = 0,
    mDollars = 0;
  for (const e of data.edges) {
    const model = edgeVal[e.edgeId] * 1e9;
    const wages = e.jobs && e.meanWage ? e.jobs * e.meanWage : null;
    mJobs += e.jobs ?? 0;
    mDollars += edgeVal[e.edgeId];
    console.log(
      pad(e.edgeId.replace(/_workers_labor/, ''), 22) +
        pad(' ' + e.industry.slice(0, 11), 12).slice(0, 12) +
        padL(edgeVal[e.edgeId].toFixed(0), 9) +
        padL(e.jobs ? M(e.jobs) : 'n/a', 10) +
        padL(wages ? B(wages) : 'n/a', 10) +
        padL(wages ? B(wages * L) : 'n/a', 9) +
        padL(e.jobs ? k(model / e.jobs) : 'n/a', 12) +
        padL(e.meanWage ? k(e.meanWage * L) : 'n/a', 11),
    );
  }
  if (data.broadNursing) {
    const a = data.broadNursing;
    console.log(
      pad('  ↳ ltc_nursing (broad 623)', 34) +
        padL('', 9) +
        padL(M(a.jobs), 10) +
        padL(B(a.jobs * a.meanWage), 10) +
        padL(B(a.jobs * a.meanWage * L), 9) +
        padL(k((edgeVal.ltc_nursing_workers_labor * 1e9) / a.jobs), 12) +
        padL(k(a.meanWage * L), 11),
    );
  }
  console.log('-'.repeat(95));
  const gov = data.government.reduce((s, g) => s + (edgeVal[g.edgeId] ?? 0), 0);
  console.log(
    pad('mapped subtotal (8 edges)', 22) +
      pad('', 12) +
      padL(mDollars.toFixed(0), 9) +
      padL(M(mJobs), 10),
  );
  console.log(
    pad('government (fed+state)', 22) +
      pad(' no OEWS NAICS', 12) +
      padL(gov.toFixed(0), 9) +
      padL('n/a', 10),
  );
  console.log(pad('TOTAL into healthcare_workers', 34) + padL((mDollars + gov).toFixed(0), 9));

  console.log('\nHeadcount anchors (occupation view, national):');
  for (const a of [data.anchors.practitioners, data.anchors.support])
    console.log(
      `  ${a.code}  ${pad(a.title, 42)} ${padL(M(a.emp), 8)} people   mean wage ${k(a.mean)}`,
    );
  console.log(
    `  clinical-occupation total (29+31)            ${padL(M(data.anchors.practitioners.emp + data.anchors.support.emp), 8)} people`,
  );
  console.log(
    `  mapped-industry headcount (8 edges)          ${padL(M(mJobs), 8)} jobs  (vs model node label ~22M)`,
  );

  console.log('\nJob-function decomposition — top occupations inside each edge (by employment):');
  for (const e of data.edges) {
    console.log(
      `\n  ${e.edgeId.replace(/_workers_labor/, '')}  —  ${e.industry}  (model $${edgeVal[e.edgeId].toFixed(0)}B, ${M(e.jobs)} jobs)`,
    );
    if (e.note) console.log(`    note: ${e.note}`);
    for (const o of e.top) {
      const wb = o.mean
        ? `wages $${B(o.emp * o.mean)}B, mean ${k(o.mean)}`
        : o.capped
          ? 'mean ≥$239k (BLS top-coded)'
          : 'wage n/a';
      console.log(`      ${pad(o.title.slice(0, 44), 46)} ${padL(M(o.emp), 8)}   ${wb}`);
    }
  }
  console.log(
    '\nGovernment edges (no OEWS industry mapping — model retains agency-budget figures):',
  );
  for (const g of data.government)
    console.log(`  ${pad(g.edgeId, 22)} $${edgeVal[g.edgeId].toFixed(0)}B — ${g.note}`);
  console.log(`\nbenefit load applied: x${L} (ECEC 2023, wages->total comp).\n`);
}

const isMain = pathToFileURL(process.argv[1] ?? '').href === import.meta.url;
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const data = await computeReconciliation(root);
  const out = writeDerived(root, data);
  printConsole(data, loadEdgeDollars(root));
  console.log('wrote ' + out);
}
