// Derives the four `health_insurance -> provider` claim edge amounts in data/graph.json
// from CMS NHE (2024 release, CY2023) "by type of service and source of funds".
//
//   node scripts/derive_hi_claims.mjs
//
// The "Health Insurance" node aggregates commercial private insurance + Medicare Advantage
// + Medicaid managed care (MA and MCO capitation flow INTO it). NHE classifies MA under the
// Medicare source of funds and MCO under Medicaid, so the node's claims to each provider
// category are modeled as:
//
//   claims[cat] = PrivateHealthInsurance[cat]
//               + (MA capitation / Medicare PHC total)  * Medicare[cat]
//               + (MCO capitation / Medicaid PHC total)  * Medicaid[cat]
//
// then scaled so the four claim edges sum to the node's net (inflow - existing admin out),
// which makes the Health Insurance node balance. Assumes MA/MCO category mix tracks their
// parent program's mix — the dominant simplifying assumption; hence confidence: estimate.
//
// Requires references/nhe2024/NHE2024.csv (git-ignored; from CMS). Numbers here must match
// the hi_*_claims edges in data/graph.json — re-run and update both if the inputs change.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const csv = join(root, 'references', 'nhe2024', 'NHE2024.csv');

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

const lines = readFileSync(csv, 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.length);
const yr = parseLine(lines[1]).indexOf('2023');
const num = (s) => {
  const n = Number(String(s).replace(/[",]/g, ''));
  return isFinite(n) ? n : 0;
};

// NHE service-category header -> model provider node id
const BUCKET = {
  'Total Hospital Expenditures': 'hospitals',
  'Total Physician and Clinical Expenditures': 'providers_clinicians',
  'Total Dental Services Expenditures': 'providers_clinicians',
  'Total Other Professional Services Expenditures': 'providers_clinicians',
  'Total Prescription Drug Expenditures': 'pharma_rx',
  'Total Home Health Care Expenditures': 'long_term_care',
  'Total Nursing Care Facilities and Continuing Care Retirement Communities': 'long_term_care',
  'Total Other Health, Residential, and Personal Care Expenditures': 'long_term_care',
};
// any "Total ..." row (or these aggregates) ends the current category's child rows
const isBoundary = (lbl) =>
  /^Total /.test(lbl) || /^(Personal Health Care|Health Consumption|Other Non-Durable)/.test(lbl);

const acc = {};
for (const b of new Set(Object.values(BUCKET))) acc[b] = { phi: 0, care: 0, caid: 0 };
let cur = null,
  taken = null;
for (let i = 2; i < lines.length; i++) {
  const row = parseLine(lines[i]);
  const lbl = row[0].trim();
  if (!lbl) continue;
  if (isBoundary(lbl)) {
    cur = BUCKET[lbl] ?? null;
    taken = new Set();
    continue;
  }
  if (!cur) continue;
  if (lbl === 'Private Health Insurance' && !taken.has('phi')) {
    acc[cur].phi += num(row[yr]);
    taken.add('phi');
  } else if (lbl === 'Medicare' && !taken.has('care')) {
    acc[cur].care += num(row[yr]);
    taken.add('care');
  } else if (lbl === 'Medicaid (Title XIX)' && !taken.has('caid')) {
    acc[cur].caid += num(row[yr]);
    taken.add('caid');
  }
}

// model inputs ($B): capitation into the node, and the node's inflow / existing admin outflow
const MA = 539,
  MCO = 508;
const MEDICARE_PHC = 962.684,
  MEDICAID_PHC = 784.153; // NHE 2023 Personal Health Care totals
const maShare = MA / MEDICARE_PHC,
  mcoShare = MCO / MEDICAID_PHC;
const HI_IN = 2312,
  HI_ADMIN = 116.5 + 113.22875;
const NET = HI_IN - HI_ADMIN;

const order = ['hospitals', 'providers_clinicians', 'pharma_rx', 'long_term_care'];
const blended = {};
let gross = 0;
for (const b of order) {
  blended[b] = acc[b].phi / 1000 + (maShare * acc[b].care) / 1000 + (mcoShare * acc[b].caid) / 1000;
  gross += blended[b];
}
const k = NET / gross;

console.log(
  `MA share of Medicare PHC = ${maShare.toFixed(4)}   MCO share of Medicaid PHC = ${mcoShare.toFixed(4)}`,
);
console.log(
  `blended gross = $${gross.toFixed(1)}B   scale k = ${k.toFixed(4)}   node net = $${NET.toFixed(2)}B\n`,
);
let sum = 0;
for (const b of order) {
  const v = blended[b] * k;
  sum += v;
  console.log(`  health_insurance -> ${b.padEnd(20)} $${v.toFixed(1)}B`);
}
console.log(`  ${''.padEnd(38)} sum $${sum.toFixed(2)}B (= node net)`);
