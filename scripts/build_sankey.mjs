// Build a Sankey-style Jumpgate (.jg) diagram from data/graph.json.
//
//   node scripts/build_sankey.mjs
//
// Output: diagrams/healthcare-flows-sankey.jg
//
// Sankey conventions, all driven off one $/pixel SCALE so the geometry is honest:
//   - node HEIGHT  = dollars it handles  × SCALE
//   - edge WIDTH   = flow dollars        × SCALE   (same scale!)
//   - edges STACK on each node's side (sorted to reduce crossings) so the bands
//     exactly fill the node height — inflows on the left, outflows on the right.
//   - edges are cubic-bezier ribbons (sampled to waypoints), no arrowheads.
//   - 6 columns: Health Insurance gets its own column right of Medicare/Medicaid,
//     so MA/MCO capitation become forward flows; only corporate-tax feedback runs
//     backward (thin, along the bottom).
import fs from "node:fs";

const ROOT = new URL("..", import.meta.url);
const g = JSON.parse(fs.readFileSync(new URL("data/graph.json", ROOT), "utf8"));
const OUT = new URL("diagrams/healthcare-flows-sankey.jg", ROOT);

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

// ---- columns (6) and vertical order within each ----
const COLUMNS = [
  ["individuals", "employers"],
  ["federal_government", "state_governments"],
  ["medicare", "medicaid"],
  ["health_insurance"],
  ["pharma_rx", "hospitals", "providers_clinicians", "long_term_care"],
  ["suppliers_vendors", "healthcare_workers", "capital_markets"],
];
const colOf = {}, orderInCol = {};
COLUMNS.forEach((col, ci) => col.forEach((id, ri) => { colOf[id] = ci; orderInCol[id] = ri; }));

const isForward = (e) => colOf[e.to] > colOf[e.from];
const fwd = aggEdges.filter(isForward);
const back = aggEdges.filter((e) => !isForward(e)); // corporate-tax feedback

// ---- node "flow handled" from FORWARD edges only (feedback is tiny, routed separately) ----
const inF = {}, outF = {};
for (const e of fwd) { outF[e.from] = (outF[e.from] || 0) + e.v; inF[e.to] = (inF[e.to] || 0) + e.v; }
const flow = {};
for (const id of Object.keys(colOf)) flow[id] = Math.max(inF[id] || 0, outF[id] || 0);

// ---- scale & layout ----
const SCALE = 0.18;          // px per $B (drives BOTH heights and widths)
const GAP = 84;              // floor for the vertical gap between stacked nodes
const MAXGAP = 240;          // cap on the spread gap (so sparse columns don't fly apart)
const W = 170;               // node width
const COLX = [60, 480, 900, 1320, 1740, 2160];
const Y0 = 70, Y1 = 1050;    // vertical band that node positions relax within
const BAND = Y1 - Y0;

const hOf = (id) => Math.max(22, flow[id] * SCALE);
// Per-column gap: sparse columns (few nodes) get a bigger gap so they SPREAD to fill the
// band — providers is tall and dense, the others fan out to match — which separates edges.
const gapOf = (ci) => {
  const col = order[ci];
  if (col.length < 2) return 0;
  const sumH = col.reduce((s, id) => s + hOf(id), 0);
  return Math.max(GAP, Math.min(MAXGAP, (BAND - sumH) / (col.length - 1)));
};

// initial layout: each column centred in [Y0,Y1] using its spread gap
const pos = {}; // id -> {x,y,h}
const order = COLUMNS.map((c) => [...c]); // mutable per-column order
for (let ci = 0; ci < order.length; ci++) {
  const col = order[ci];
  const gap = gapOf(ci);
  const total = col.reduce((a, id) => a + hOf(id), 0) + gap * (col.length - 1);
  let y = (Y0 + Y1) / 2 - total / 2;
  col.forEach((id) => { pos[id] = { x: COLX[ci], y, h: hOf(id) }; y += hOf(id) + gap; });
}
const cY = (id) => pos[id].y + pos[id].h / 2;

// forward-edge neighbours (both directions) for barycentre relaxation
const nbrs = {};
for (const id of Object.keys(colOf)) nbrs[id] = [];
for (const e of fwd) { nbrs[e.from].push({ o: e.to, v: e.v }); nbrs[e.to].push({ o: e.from, v: e.v }); }

// ---- barycentre relaxation (positions only, order fixed): nudge each node toward the
//      flow-weighted centre of its neighbours, damped, then enforce order + min gap and
//      clamp to the band. Keeping the order fixed preserves the clean column structure
//      while flows straighten out — fewer crossings, edges run flatter. ----
const DAMP = 0.55;
function relaxColumn(ci) {
  const col = order[ci];
  const c = col.map((id) => {
    const ns = nbrs[id];
    if (!ns.length) return cY(id);
    let sw = 0, sy = 0;
    for (const n of ns) { sw += n.v; sy += n.v * cY(n.o); }
    return cY(id) + DAMP * (sy / sw - cY(id));        // damped move toward barycentre
  });
  const gap = gapOf(ci);
  for (let i = 1; i < col.length; i++) {              // enforce order + spread gap (top→down)
    const min = c[i - 1] + pos[col[i - 1]].h / 2 + gap + pos[col[i]].h / 2;
    if (c[i] < min) c[i] = min;
  }
  const bottom = c[col.length - 1] + pos[col[col.length - 1]].h / 2;
  if (bottom > Y1) { const s = bottom - Y1; for (let i = 0; i < c.length; i++) c[i] -= s; }
  const top = c[0] - pos[col[0]].h / 2;
  if (top < Y0) { const s = Y0 - top; for (let i = 0; i < c.length; i++) c[i] += s; }
  col.forEach((id, i) => { pos[id].y = c[i] - pos[id].h / 2; });
}
for (let pass = 0; pass < 40; pass++) {
  const cols = [...order.keys()];
  if (pass % 2) cols.reverse();           // alternate L→R / R→L sweeps
  for (const ci of cols) relaxColumn(ci);
}
for (const id of Object.keys(pos)) pos[id].y = Math.round(pos[id].y);

// ---- assign stacked slots: outflows on right (sorted by target y), inflows on left (by source y) ----
const srcY = {}, tgtY = {}; // edgeKey -> anchor world-y
const key = (e) => `${e.from}|${e.to}`;
for (const id of Object.keys(colOf)) {
  const outs = fwd.filter((e) => e.from === id).sort((a, b) => cY(a.to) - cY(b.to));
  const ins = fwd.filter((e) => e.to === id).sort((a, b) => cY(a.from) - cY(b.from));
  const stack = (list, pick) => {
    const tot = list.reduce((a, e) => a + e.v * SCALE, 0);
    let c = cY(id) - tot / 2;
    for (const e of list) { pick[key(e)] = c + (e.v * SCALE) / 2; c += e.v * SCALE; }
  };
  stack(outs, srcY);
  stack(ins, tgtY);
}

// ---- colors: rainbow by rank, straight from graph.json groups (single source of truth) ----
const GROUP_COLOR = Object.fromEntries(g.groups.map((gr) => [gr.id, "#" + gr.color]));
const NODE_COLOR = (id) => GROUP_COLOR[groupOf[id]];
const textOn = (hex) => {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), gg = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * gg + 0.114 * b) / 255 > 0.62 ? "#1a1a1a" : "#ffffff";
};

// ---- nodes ----
const nodes = [];
nodes.push({ id: "title", bounds: { x: 60, y: -150, width: 1400, height: 46 }, label: "U.S. Healthcare Flow of Funds — 2023 (Sankey)", shape: "text" });
nodes.push({ id: "subtitle", bounds: { x: 60, y: -104, width: 2000, height: 30 },
  label: "Node height ∝ dollars handled · band width ∝ dollars (same scale) · bands stack to fill each node · flow left→right, corporate tax loops back along the bottom.",
  shape: "text" });
for (const id of Object.keys(colOf)) {
  const p = pos[id];
  const childNote = id === "providers_clinicians" ? "\n(phys·dental·other)" : id === "long_term_care" ? "\n(nursing·home health)" : "";
  nodes.push({
    id, bounds: { x: p.x, y: p.y, width: W, height: p.h },
    label: `${labelOf[id]}${childNote}\n$${Math.round(flow[id]).toLocaleString()}B`,
    nodeColor: NODE_COLOR(id), labelColor: textOn(NODE_COLOR(id)), shape: "rounded-rectangle",
  });
}
const bands = [["Payers", 0], ["Government", 1], ["Public Programs", 2], ["Insurers", 3], ["Providers", 4], ["Factors", 5]];
for (const [txt, c] of bands) nodes.push({ id: `band-${c}`, bounds: { x: COLX[c], y: 1130, width: W + 30, height: 26 }, label: txt, shape: "text" });

// ---- edges ----
const edges = [];
for (const e of fwd) {
  const a = pos[e.from], b = pos[e.to];
  const p0 = { x: a.x + W, y: Math.round(srcY[key(e)]) };
  const p3 = { x: b.x, y: Math.round(tgtY[key(e)]) };
  edges.push({
    id: `e-${e.from}-${e.to}`,
    from: { nodeId: e.from, anchor: [W, Math.round(srcY[key(e)] - a.y)] },
    to: { nodeId: e.to, anchor: [0, Math.round(tgtY[key(e)] - b.y)] },
    // one draggable handle in the centre; jumpgate's "smooth" curve draws the bezier
    waypoints: [{ x: Math.round((p0.x + p3.x) / 2), y: Math.round((p0.y + p3.y) / 2) }],
    curve: "smooth",
    color: NODE_COLOR(e.from), arrow: "none", opacity: 0.8, width: Math.max(1, Math.round(e.v * SCALE * 10) / 10),
    label: e.v >= 250 ? `$${Math.round(e.v)}B` : undefined, labelColor: NODE_COLOR(e.from),
  });
}
const LANE = 1080;
for (const e of back) {
  const a = pos[e.from], b = pos[e.to];
  edges.push({
    id: `e-${e.from}-${e.to}`,
    from: { nodeId: e.from, anchor: [W * 0.5, a.h] },
    to: { nodeId: e.to, anchor: [W * 0.5, b.h] },
    waypoints: [{ x: a.x + W / 2, y: LANE }, { x: b.x + W / 2, y: LANE }],
    color: "#B0641E", style: "dashed", arrow: "none", opacity: 0.9, width: Math.max(1.2, Math.round(e.v * SCALE * 10) / 10),
    label: e.v >= 12 ? `$${Math.round(e.v)}B tax` : undefined, labelColor: "#8a4d12",
  });
}

// paint widest bands first so thin crossing flows stay visible on top (jumpgate draws in array order)
edges.sort((a, b) => (b.width || 0) - (a.width || 0));

const doc = { theme: "standard", nodes, edges };

// ---- self-check ----
const ids = new Set(); const nodeIds = new Set(nodes.map((n) => n.id));
for (const n of nodes) { if (ids.has(n.id)) throw new Error("dup " + n.id); ids.add(n.id); if (!(n.bounds.width > 0 && n.bounds.height > 0)) throw new Error("bad bounds " + n.id); }
for (const e of edges) { if (ids.has(e.id)) throw new Error("dup " + e.id); ids.add(e.id); for (const ep of [e.from, e.to]) if (ep.nodeId && !nodeIds.has(ep.nodeId)) throw new Error("dangling " + e.id); if (!(e.width > 0)) throw new Error("bad width " + e.id); }
// verify stacks fill node heights (within rounding)
for (const id of Object.keys(colOf)) {
  const o = fwd.filter((e) => e.from === id).reduce((s, e) => s + e.v * SCALE, 0);
  const i = fwd.filter((e) => e.to === id).reduce((s, e) => s + e.v * SCALE, 0);
  const fill = Math.max(o, i), h = pos[id].h;
  if (h > 30 && Math.abs(fill - h) > 1.5) throw new Error(`stack≠height ${id}: fill ${fill.toFixed(1)} vs h ${h}`);
}

fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
console.log(`wrote ${OUT.pathname.slice(1)}`);
console.log(`scale ${SCALE} px/$B · nodes ${Object.keys(colOf).length} · forward bands ${fwd.length} · feedback ${back.length}`);
console.log(`tallest node: individuals ${pos.individuals.h}px ($${Math.round(flow.individuals)}B)`);
