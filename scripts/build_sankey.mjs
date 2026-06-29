// Build a Sankey-style Jumpgate (.jg) diagram from data/graph.json.
//
//   node scripts/build_sankey.mjs
//   SANKEY_COLSTEP=300 SANKEY_GAP=50 SANKEY_LANE_MAXGAP=10 SANKEY_SPREAD=0.85 node scripts/build_sankey.mjs
//
// Tunables (env): COLSTEP (column x-pitch), GAP (min node gap), LANE_MIN (px width a long flow needs
// to earn its own routed lane), LANE_MAXGAP (cap so parallel lanes pack tight), SPREAD (fraction of
// the band that pure-node columns fill), RESTARTS (multi-start search count).
//
// Same honest geometry as v1 (one $/pixel SCALE drives node heights AND edge widths), but a
// layered layout tuned for READABILITY measured as ribbon OVERLAP AREA — not crossing count.
// A clean X where two colors cross is fine; what hurts is long muddy stretches where ribbons run
// on top of each other, and flows drawn across node boxes. So the objective is:
//      overlap score = different-color ribbon-overlap area  +  2 × ribbon-over-node area
//   1. Layering  — fixed semantic columns.
//   2. Dummies   — column-skipping flows split into one lane waypoint per column crossed, so they
//                  travel together instead of slashing diagonally (and the optimizer can see them).
//   3. Ordering  — median sweeps for a start, then transpose swaps accepted only when they reduce
//                  the overlap score (relax + rescore each trial — it can't scramble the layout).
//   4. Coords    — damped barycentre relaxation positions every item (real + dummy).
//   5. Ports     — flows stack on each node face, sorted by their neighbour's position.
// Steeper crossings (narrower columns / tighter gaps) shrink each crossing's overlap area, so the
// spacing constants matter and are tunable via env.
import fs from "node:fs";

const ROOT = new URL("..", import.meta.url);
const g = JSON.parse(fs.readFileSync(new URL("data/graph.json", ROOT), "utf8"));
const OUT = new URL(process.env.SANKEY_OUT || "diagrams/healthcare-flows-sankey.jg", ROOT);

const NODES = g.graph.nodes;
const EDGES = g.graph.edges;
const canon = (e) => { const o = e.observations || []; return (o.find((x) => x.canonical) || o[0])?.value || 0; };
const parentOf = Object.fromEntries(NODES.map((n) => [n.id, n.parent || n.id]));
const groupOf = Object.fromEntries(NODES.map((n) => [n.id, n.group]));
const labelOf = Object.fromEntries(NODES.map((n) => [n.id, n.label]));

// ---- aggregate to major-node pairs ----
const agg = {};
for (const e of EDGES) {
  const f = parentOf[e.from], t = parentOf[e.to];
  if (f === t) continue;
  (agg[`${f}|${t}`] ??= { from: f, to: t, v: 0 }).v += canon(e);
}
const aggEdges = Object.values(agg);

// ---- columns (6); initial within-column order is just a starting point for the optimizer ----
const COLUMNS = [
  ["individuals", "employers"],
  ["federal_government", "state_governments"],
  ["medicare", "medicaid"],
  ["health_insurance"],
  ["pharma_rx", "hospitals", "providers_clinicians", "long_term_care"],
  ["suppliers_vendors", "healthcare_workers", "capital_markets", "taxes"],
];
const NCOL = COLUMNS.length;
const colOf = {};
COLUMNS.forEach((col, ci) => col.forEach((id) => { colOf[id] = ci; }));

const isForward = (e) => colOf[e.to] > colOf[e.from];
const fwd = aggEdges.filter(isForward);
const back = aggEdges.filter((e) => !isForward(e)); // any backward feedback edge (none today: tax now terminates at the Taxes factor)

// ---- node "flow handled" from forward edges only ----
const inF = {}, outF = {};
for (const e of fwd) { outF[e.from] = (outF[e.from] || 0) + e.v; inF[e.to] = (inF[e.to] || 0) + e.v; }
const flow = {};
for (const id of Object.keys(colOf)) flow[id] = Math.max(inF[id] || 0, outF[id] || 0);

// ---- scale & layout constants ----
const SCALE = 0.18;      // px per $B (drives BOTH heights and widths)
const GAP = process.env.SANKEY_GAP != null ? +process.env.SANKEY_GAP : 50;       // min gap between real nodes
const DGAP = 4;          // delineation gap between a lane and its neighbour (tiny, just to read them apart)
const LANE_MAXGAP = process.env.SANKEY_LANE_MAXGAP != null ? +process.env.SANKEY_LANE_MAXGAP : 10;
                         // cap on gap between stacked lanes — parallel non-crossing lanes pack tight
                         // instead of drifting apart and leaving big empty bands up top
const SPREAD_FRAC = process.env.SANKEY_SPREAD != null ? +process.env.SANKEY_SPREAD : 0.85;
                         // pure-node columns (e.g. terminal Claimants) spread their nodes to fill this
                         // fraction of the band, so fan-in/out flattens and crosses less
const MAXSPREAD = 220;   // cap on the spread gap so a 2-3 node column doesn't fly fully apart
const LABEL_OFFSET = process.env.SANKEY_LABEL_OFFSET != null ? +process.env.SANKEY_LABEL_OFFSET : 5;
                         // $ label's left edge sits this UNIFORM distance (px) out from where the
                         // ribbon leaves its source — same for every flow, not a fraction of length.
                         // jumpgate left-justifies it (labelPos < 0.5) so it reads into the edge.
const LANE_MIN = process.env.SANKEY_LANE_MIN != null ? +process.env.SANKEY_LANE_MIN : 6;
                         // only route long flows wider than this (px) through lanes; thinner
                         // capillaries cross directly — keeps the middle columns uncluttered
const W = 170;           // node width
const COLSTEP = process.env.SANKEY_COLSTEP != null ? +process.env.SANKEY_COLSTEP : 300; // x pitch between columns
const COLX = Array.from({ length: NCOL }, (_, i) => 60 + i * COLSTEP);
const Y0 = 70;
const realH = (id) => Math.max(22, flow[id] * SCALE);

// ============================================================================================
// 2. DUMMIES — split each column-skipping flow into one lane waypoint per column it crosses.
// ============================================================================================
// item id: real node id, or `~edgeKey@col` for a dummy. itemH/itemCol/itemKind track metadata.
const itemCol = {}, itemH = {}, itemKind = {};
for (const id of Object.keys(colOf)) { itemCol[id] = colOf[id]; itemH[id] = realH(id); itemKind[id] = "node"; }

const order = COLUMNS.map((c) => [...c]);                       // order[ci] = ordered item ids
const links = Array.from({ length: NCOL - 1 }, () => []);       // links[ci] = {a,b,v} pairs col ci→ci+1
const chainOf = {};                                            // edgeKey → [from, ...dummies, to]

for (const e of fwd) {
  const c0 = colOf[e.from], c1 = colOf[e.to];
  const key = `${e.from}|${e.to}`;
  const span = c1 - c0;
  const routed = span >= 2 && e.v * SCALE >= LANE_MIN; // thick long flow → lane; else direct
  const chain = [e.from];
  if (routed) {
    for (let c = c0 + 1; c < c1; c++) {
      const did = `~${key}@${c}`;
      itemCol[did] = c; itemH[did] = e.v * SCALE; itemKind[did] = "dummy";
      order[c].push(did);
      chain.push(did);
    }
  }
  chain.push(e.to);
  chainOf[key] = chain;
  if (span === 1 || routed) {
    for (let s = 0; s < chain.length - 1; s++) {
      const a = chain[s], b = chain[s + 1];
      links[itemCol[a]].push({ a, b, v: e.v, edgeKey: key });
    }
  }
}
const initialOrder = order.map((c) => [...c]); // restart point for the multi-start search

// ============================================================================================
// 3. COORDINATE + SCORING INFRASTRUCTURE (so ordering can be driven by overlap area).
// ============================================================================================
const nbrs = {};
for (const ci of order.keys()) for (const id of order[ci]) nbrs[id] = [];
for (let ci = 0; ci < NCOL - 1; ci++) for (const l of links[ci]) { nbrs[l.a].push({ o: l.b, v: l.v }); nbrs[l.b].push({ o: l.a, v: l.v }); }

// Band height is set by the densest column at base spacing (BAND never grows from spreading).
const baseGap = (a, b) => (itemKind[a] === "node" && itemKind[b] === "node" ? GAP : DGAP);
const baseOccupancy = (ci) => {
  const col = order[ci];
  let h = col.reduce((s, id) => s + itemH[id], 0);
  for (let i = 1; i < col.length; i++) h += baseGap(col[i - 1], col[i]);
  return h;
};
const BAND = Math.max(...order.map((_, ci) => baseOccupancy(ci)), 700);
const Y1 = Y0 + BAND;

// Pure-node columns (no lanes passing through, e.g. terminal Claimants) spread their nodes to fill
// SPREAD_FRAC of the band so the fan flattens; columns with lanes keep nodes at the base gap.
const colNodeGap = (ci) => {
  const col = order[ci];
  if (col.length < 2 || col.some((id) => itemKind[id] !== "node")) return GAP;
  const sumH = col.reduce((s, id) => s + itemH[id], 0);
  return Math.max(GAP, Math.min(MAXSPREAD, (BAND * SPREAD_FRAC - sumH) / (col.length - 1)));
};
const gapBetween = (a, b, ci) => (itemKind[a] === "node" && itemKind[b] === "node" ? colNodeGap(ci) : DGAP);
const colOccupancy = (ci) => {
  const col = order[ci];
  let h = col.reduce((s, id) => s + itemH[id], 0);
  for (let i = 1; i < col.length; i++) h += gapBetween(col[i - 1], col[i], ci);
  return h;
};

const pos = {}; // id -> {y, h}
function seedPositions() {
  for (let ci = 0; ci < NCOL; ci++) {
    const col = order[ci], occ = colOccupancy(ci);
    let y = Y0 + (BAND - occ) / 2;
    for (let i = 0; i < col.length; i++) { pos[col[i]] = { y, h: itemH[col[i]] }; y += itemH[col[i]] + (i < col.length - 1 ? gapBetween(col[i], col[i + 1], ci) : 0); }
  }
}
const cY = (id) => pos[id].y + pos[id].h / 2;

const DAMP = 0.5;
function relaxColumn(ci) {
  const col = order[ci];
  const c = col.map((id) => {
    const ns = nbrs[id];
    if (!ns.length) return cY(id);
    let sw = 0, sy = 0;
    for (const n of ns) { sw += n.v; sy += n.v * cY(n.o); }
    return cY(id) + DAMP * (sy / sw - cY(id));
  });
  for (let i = 1; i < col.length; i++) {
    const half = pos[col[i - 1]].h / 2 + pos[col[i]].h / 2;
    const min = c[i - 1] + half + gapBetween(col[i - 1], col[i], ci);
    if (c[i] < min) c[i] = min;
    // cap the gap between stacked LANES so parallel non-crossing lanes pack tight (no empty bands)
    const isLane = itemKind[col[i - 1]] !== "node" || itemKind[col[i]] !== "node";
    if (isLane) { const max = c[i - 1] + half + LANE_MAXGAP; if (c[i] > max) c[i] = max; }
  }
  const bottom = c[col.length - 1] + pos[col[col.length - 1]].h / 2;
  if (bottom > Y1) { const s = bottom - Y1; for (let i = 0; i < c.length; i++) c[i] -= s; }
  const top = c[0] - pos[col[0]].h / 2;
  if (top < Y0) { const s = Y0 - top; for (let i = 0; i < c.length; i++) c[i] += s; }
  col.forEach((id, i) => { pos[id].y = c[i] - pos[id].h / 2; });
}
function relax(passes) {
  for (let pass = 0; pass < passes; pass++) {
    const cols = [...order.keys()];
    if (pass % 2) cols.reverse();
    for (const ci of cols) relaxColumn(ci);
  }
}

// ---- ports: stack each node's flows on its faces, sorted by the neighbour's position ----
const leftPortY = {}, rightPortY = {};
const firstHop = (key) => chainOf[key][1];
const lastHop = (key) => chainOf[key][chainOf[key].length - 2];
function computePorts() {
  for (const k in leftPortY) delete leftPortY[k];
  for (const k in rightPortY) delete rightPortY[k];
  for (const id of Object.keys(colOf)) {
    const outs = fwd.filter((e) => e.from === id).map((e) => `${e.from}|${e.to}`);
    const ins = fwd.filter((e) => e.to === id).map((e) => `${e.from}|${e.to}`);
    const vOf = (key) => agg[key].v;
    outs.sort((p, q) => cY(firstHop(p)) - cY(firstHop(q)));
    ins.sort((p, q) => cY(lastHop(p)) - cY(lastHop(q)));
    const stack = (list, sideMap) => {
      const tot = list.reduce((s, k) => s + vOf(k) * SCALE, 0);
      let c = cY(id) - tot / 2;
      for (const k of list) { sideMap[k] = c + (vOf(k) * SCALE) / 2; c += vOf(k) * SCALE; }
    };
    stack(outs, leftPortY);
    stack(ins, rightPortY);
  }
}

// ---- ribbon centreline: matches the rendered smooth bezier through ports + lane waypoints ----
function ribbonCenter(e) {
  const key = `${e.from}|${e.to}`, ch = chainOf[key];
  const pts = [{ x: COLX[colOf[e.from]] + W, y: leftPortY[key] }];
  for (let s = 1; s < ch.length - 1; s++) pts.push({ x: COLX[itemCol[ch[s]]] + W / 2, y: cY(ch[s]) });
  pts.push({ x: COLX[colOf[e.to]], y: rightPortY[key] });
  const out = [pts[0]], N = 10;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], dx = (b.x - a.x) * 0.5;
    for (let k = 1; k <= N; k++) { const t = k / N, u = 1 - t;
      out.push({ x: u*u*u*a.x + 3*u*u*t*(a.x+dx) + 3*u*t*t*(b.x-dx) + t*t*t*b.x,
                 y: u*u*u*a.y + 3*u*u*t*a.y + 3*u*t*t*b.y + t*t*t*b.y }); }
  }
  return out;
}

// ---- overlap score by RASTERISING the real geometry: different-color overlap + 2× over-node ----
// (An analytical proxy diverged too far from the rendered beziers+ports and misled the search.)
// `cell` = grid size; `dense` resamples the centreline to ~2px for gap-free coverage. The search
// uses a coarse fast grid (relative scores only need to be consistent); the printed guard uses a
// fine, dense grid for an accurate absolute area.
const SCELL = 8;
function rasterCov(cell, dense) {
  computePorts();
  const cov = new Map(); // cell -> { g:Set(colorGroups), ids:[edges covering it] }
  for (const e of fwd) {
    const half = (e.v * SCALE) / 2, gp = groupOf[e.from];
    let c = ribbonCenter(e);
    if (dense) {
      const d = [c[0]];
      for (let i = 1; i < c.length; i++) { const a = c[i - 1], b = c[i], L = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(L / 2)); for (let s = 1; s <= n; s++) { const t = s / n; d.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); } }
      c = d;
    }
    const seen = new Set();
    for (let i = 0; i < c.length; i++) {
      const prev = c[Math.max(0, i - 1)], next = c[Math.min(c.length - 1, i + 1)];
      let tx = next.x - prev.x, ty = next.y - prev.y; const len = Math.hypot(tx, ty) || 1; tx /= len; ty /= len;
      const nx = -ty, ny = tx;
      for (let o = -half; o <= half; o += cell / 2) seen.add(Math.floor((c[i].x + nx*o)/cell) + "," + Math.floor((c[i].y + ny*o)/cell));
    }
    for (const k of seen) { let r = cov.get(k); if (!r) cov.set(k, r = { g: new Set(), ids: [] }); r.g.add(gp); r.ids.push(e); }
  }
  return cov;
}
function overlapAt(cell, dense) {
  const cov = rasterCov(cell, dense);
  let diff = 0;
  for (const [, r] of cov) if (r.ids.length >= 2) diff += r.g.size - 1;
  let node = 0;
  for (const id of Object.keys(colOf)) {
    const cx0 = Math.floor(COLX[colOf[id]] / cell), cx1 = Math.floor((COLX[colOf[id]] + W) / cell);
    const cy0 = Math.floor(pos[id].y / cell), cy1 = Math.floor((pos[id].y + pos[id].h) / cell);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const r = cov.get(cx + "," + cy); if (!r) continue;
      for (const e of r.ids) if (e.from !== id && e.to !== id) node++;
    }
  }
  const A = cell * cell;
  return { diff: diff * A, node: node * A, combined: (diff + 2 * node) * A };
}
const overlapScore = () => overlapAt(SCELL, false).combined; // weight over-node 2× (obscuring a node is worse)

// ============================================================================================
// 4. ORDERING — median start, then transpose swaps that reduce the overlap score.
// ============================================================================================
const posIn = (ci) => { const m = {}; order[ci].forEach((id, i) => (m[id] = i)); return m; };
function medianSort(ci, refCi) {
  const refPos = posIn(refCi);
  const chan = refCi < ci ? links[refCi] : links[ci];
  const neigh = {};
  for (const id of order[ci]) neigh[id] = [];
  for (const l of chan) { if (refCi < ci) neigh[l.b]?.push(refPos[l.a]); else neigh[l.a]?.push(refPos[l.b]); }
  const med = {};
  order[ci].forEach((id, i) => {
    const xs = neigh[id].sort((p, q) => p - q);
    med[id] = xs.length ? (xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2) : i;
  });
  order[ci] = [...order[ci]].sort((p, q) => (med[p] - med[q]) || 0);
}
// The transpose local search is sensitive to its starting order, so run several restarts from
// different shuffles and keep the global best — makes the result robust, not luck of one optimum.
const RESTARTS = process.env.SANKEY_RESTARTS != null ? +process.env.SANKEY_RESTARTS : 6;
const rngFrom = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
function startOrder(rs) {
  for (let ci = 0; ci < NCOL; ci++) order[ci] = [...initialOrder[ci]];
  if (rs > 0) { const r = rngFrom(rs * 97 + 7); for (let ci = 0; ci < NCOL; ci++) for (let i = order[ci].length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[ci][i], order[ci][j]] = [order[ci][j], order[ci][i]]; } }
  for (let iter = 0; iter < 6; iter++) {                        // median sweeps for a clean start
    for (let ci = 1; ci < NCOL; ci++) medianSort(ci, ci - 1);
    for (let ci = NCOL - 2; ci >= 0; ci--) medianSort(ci, ci + 1);
  }
}
let gBest = Infinity, gOrder = null;
for (let rs = 0; rs < RESTARTS; rs++) {
  startOrder(rs);
  seedPositions(); relax(40);
  let best = overlapScore();
  let bestOrder = order.map((c) => [...c]);
  for (let round = 0; round < 5; round++) {
    let improved = false;
    for (let ci = 0; ci < NCOL; ci++) {
      for (let i = 0; i < order[ci].length - 1; i++) {
        [order[ci][i], order[ci][i + 1]] = [order[ci][i + 1], order[ci][i]];
        seedPositions(); relax(22);
        const s = overlapScore();
        if (s < best - 1e-6) { best = s; bestOrder = order.map((c) => [...c]); improved = true; }
        else [order[ci][i], order[ci][i + 1]] = [order[ci][i + 1], order[ci][i]]; // revert
      }
    }
    if (!improved) break;
  }
  if (best < gBest) { gBest = best; gOrder = bestOrder; }
}
order.forEach((_, ci) => (order[ci] = gOrder[ci]));

// ============================================================================================
// 5. FINAL COORDINATES + PORTS
// ============================================================================================
seedPositions(); relax(60);
{ // recenter the real-node mass vertically so the figure is balanced
  let minY = Infinity, maxY = -Infinity;
  for (const id of Object.keys(colOf)) { minY = Math.min(minY, pos[id].y); maxY = Math.max(maxY, pos[id].y + pos[id].h); }
  const off = (Y0 + Y1) / 2 - (minY + maxY) / 2;
  for (const id of Object.keys(pos)) pos[id].y += off;
}
for (const id of Object.keys(pos)) pos[id].y = Math.round(pos[id].y);
computePorts();

// ---- colors ----
const GROUP_COLOR = Object.fromEntries(g.groups.map((gr) => [gr.id, "#" + gr.color]));
const NODE_COLOR = (id) => GROUP_COLOR[groupOf[id]];
const textOn = (hex) => {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), gg = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * gg + 0.114 * b) / 255 > 0.62 ? "#1a1a1a" : "#ffffff";
};

// ---- nodes (real only) ----
const nodes = [];
nodes.push({ id: "title", bounds: { x: 60, y: -150, width: 1400, height: 46 }, label: "U.S. Healthcare Flow of Funds — 2023 (Sankey)", shape: "text" });
nodes.push({ id: "subtitle", bounds: { x: 60, y: -104, width: 2000, height: 30 },
  label: "Node height ∝ dollars handled · band width ∝ dollars (same scale) · long flows routed through lanes · flow left→right · corporate income tax shown as a terminal factor (Taxes), not a loop.",
  shape: "text" });
for (const id of Object.keys(colOf)) {
  const p = pos[id], x = COLX[colOf[id]];
  const childNote = id === "providers_clinicians" ? "\n(phys·dental·other)" : id === "long_term_care" ? "\n(nursing·home health)" : "";
  nodes.push({
    id, bounds: { x, y: p.y, width: W, height: p.h },
    label: `${labelOf[id]}${childNote}\n$${Math.round(flow[id]).toLocaleString()}B`,
    nodeColor: NODE_COLOR(id), labelColor: textOn(NODE_COLOR(id)), shape: "rounded-rectangle",
  });
}
const bandLabelY = Math.round(Y1 + 60);
const bands = [["Payers", 0], ["Government", 1], ["Public Programs", 2], ["Insurers", 3], ["Providers", 4], ["Claimants", 5]];
for (const [txt, c] of bands) nodes.push({ id: `band-${c}`, bounds: { x: COLX[c], y: bandLabelY, width: W + 30, height: 26 }, label: txt, shape: "text" });

// ---- edges (forward, routed through dummy lanes) ----
const edges = [];
for (const e of fwd) {
  const key = `${e.from}|${e.to}`;
  const chain = chainOf[key];
  const srcNode = e.from, tgtNode = e.to;
  const y0 = leftPortY[key], yN = rightPortY[key];
  const p0 = { x: COLX[colOf[srcNode]] + W, y: Math.round(y0) };
  const pN = { x: COLX[colOf[tgtNode]], y: Math.round(yN) };
  const wps = [];
  for (let s = 1; s < chain.length - 1; s++) wps.push({ x: Math.round(COLX[itemCol[chain[s]]] + W / 2), y: Math.round(cY(chain[s])) });
  if (wps.length === 0) wps.push({ x: Math.round((p0.x + pN.x) / 2), y: Math.round((p0.y + pN.y) / 2) });
  // Uniform distance from the source: convert the fixed px offset to this edge's path fraction
  // (jumpgate walks the polyline through these same points), capped at the midpoint.
  const poly = [p0, ...wps, pN];
  let plen = 0;
  for (let s = 1; s < poly.length; s++) plen += Math.hypot(poly[s].x - poly[s - 1].x, poly[s].y - poly[s - 1].y);
  const labelPos = Math.max(0, Math.min(0.5, LABEL_OFFSET / Math.max(plen, 1)));
  edges.push({
    id: `e-${key.replace("|", "-")}`,
    from: { nodeId: srcNode, anchor: [W, Math.round(y0 - pos[srcNode].y)] },
    to: { nodeId: tgtNode, anchor: [0, Math.round(yN - pos[tgtNode].y)] },
    waypoints: wps, curve: "smooth",
    color: NODE_COLOR(srcNode), arrow: "none", opacity: 0.8,
    width: Math.max(1, Math.round(e.v * SCALE * 10) / 10),
    label: e.v >= 250 ? `$${Math.round(e.v).toLocaleString()}B` : undefined, labelColor: "#ffffff", labelPos,
  });
}
// ---- backward (corporate tax) edges along the bottom ----
const LANE = Math.round(Y1 + 30);
for (const e of back) {
  edges.push({
    id: `e-${e.from}-${e.to}`,
    from: { nodeId: e.from, anchor: [W * 0.5, pos[e.from].h] },
    to: { nodeId: e.to, anchor: [W * 0.5, pos[e.to].h] },
    waypoints: [{ x: COLX[colOf[e.from]] + W / 2, y: LANE }, { x: COLX[colOf[e.to]] + W / 2, y: LANE }],
    color: "#B0641E", style: "dashed", arrow: "none", opacity: 0.9,
    width: Math.max(1.2, Math.round(e.v * SCALE * 10) / 10),
    label: e.v >= 12 ? `$${Math.round(e.v).toLocaleString()}B tax` : undefined, labelColor: "#ffffff",
  });
}
edges.sort((a, b) => (b.width || 0) - (a.width || 0)); // widest first; thin flows stay visible on top

const doc = { theme: "standard", nodes, edges };

// ---- self-check ----
const ids = new Set(); const nodeIds = new Set(nodes.map((n) => n.id));
for (const n of nodes) { if (ids.has(n.id)) throw new Error("dup " + n.id); ids.add(n.id); if (!(n.bounds.width > 0 && n.bounds.height > 0)) throw new Error("bad bounds " + n.id); }
for (const e of edges) { if (ids.has(e.id)) throw new Error("dup " + e.id); ids.add(e.id); for (const ep of [e.from, e.to]) if (ep.nodeId && !nodeIds.has(ep.nodeId)) throw new Error("dangling " + e.id); if (!(e.width > 0)) throw new Error("bad width " + e.id); }

fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
const dummyCount = Object.values(itemKind).filter((k) => k === "dummy").length;
const stats = overlapAt(4, true), k = (u) => (u / 1000).toFixed(0); // accurate dense measure for the guard
console.log(`wrote ${OUT.pathname.split("/").pop()}`);
console.log(`nodes ${Object.keys(colOf).length} · dummies ${dummyCount} · forward ${fwd.length} · feedback ${back.length} · colstep ${COLSTEP} · gap ${GAP} · band ${Math.round(BAND)}px`);
console.log(`overlap area (readability guard) — diff-color ${k(stats.diff)}k px² · over-node ${k(stats.node)}k px² · combined ${k(stats.combined)}k px²`);
