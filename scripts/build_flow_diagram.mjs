// Build a Jumpgate (.jg) flow-of-funds diagram from data/graph.json.
//
//   node scripts/build_flow_diagram.mjs
//
// Output: diagrams/healthcare-flows.jg  (open with the Jumpgate VS Code extension,
// or the standalone demo: cd ../jumpgate/packages/jumpgate && npm run dev -- <path>).
//
// The diagram is the 14 *major* (top-level) nodes — sub-nodes (physician/dental/other,
// nursing/home-health) are rolled into their parent, and every flow is aggregated to the
// major-node pair. Edge thickness is proportional to dollars: the big flows are drawn as
// straight "highways"; smaller flows are routed indirectly (bowed, or out to a top/bottom
// lane); the corporate-tax feedback edges return along the bottom. Everything derives from
// the graph's canonical observation values, so re-run this when graph.json changes.
import fs from "node:fs";

const ROOT = new URL("..", import.meta.url);
const GRAPH = new URL("data/graph.json", ROOT);
const OUT = new URL("diagrams/healthcare-flows.jg", ROOT);

const g = JSON.parse(fs.readFileSync(GRAPH, "utf8"));
const NODES = g.graph.nodes;
const EDGES = g.graph.edges;
const canon = (e) => {
  const obs = e.observations || [];
  const c = obs.find((o) => o.canonical) || obs[0];
  return c ? c.value : 0;
};
const parentOf = Object.fromEntries(NODES.map((n) => [n.id, n.parent || n.id]));
const groupOf = Object.fromEntries(NODES.map((n) => [n.id, n.group]));

// ---- aggregate edges to top-level (major) node pairs ----
const agg = {};
for (const e of EDGES) {
  const f = parentOf[e.from], t = parentOf[e.to];
  if (f === t) continue;
  const k = `${f}|${t}`;
  (agg[k] ??= { from: f, to: t, v: 0 }).v += canon(e);
}
const aggEdges = Object.values(agg);

// ---- throughput per major node = dollars handled = max(inflow, outflow) ----
const inSum = {}, outSum = {};
for (const e of aggEdges) { outSum[e.from] = (outSum[e.from] || 0) + e.v; inSum[e.to] = (inSum[e.to] || 0) + e.v; }
const tp = {};
for (const n of NODES) if (!n.parent) tp[n.id] = Math.max(inSum[n.id] || 0, outSum[n.id] || 0);

// ---- colors: rainbow by rank, straight from graph.json groups (single source of truth) ----
const GROUP_COLOR = Object.fromEntries(g.groups.map((gr) => [gr.id, "#" + gr.color]));
const textOn = (hex) => {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), gg = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * gg + 0.114 * b) / 255 > 0.62 ? "#1a1a1a" : "#ffffff";
};

// ---- layout: columns by layer (model layers 0-4), hand-tuned vertical order ----
const COLX = { 0: 60, 1: 460, 2: 880, 3: 1320, 4: 1760 };
const W = 210;
// id -> [column, yCenter] — hubs centered, ordered to keep the big flows from crossing
const POS = {
  individuals:          [0, 380],
  employers:            [0, 760],
  federal_government:   [1, 360],
  state_governments:    [1, 760],
  medicare:             [2, 300],
  health_insurance:     [2, 580],
  medicaid:             [2, 860],
  pharma_rx:            [3, 220],
  hospitals:            [3, 460],
  providers_clinicians: [3, 700],
  long_term_care:       [3, 940],
  suppliers_vendors:    [4, 400],
  healthcare_workers:   [4, 620],
  capital_markets:      [4, 860],
};
const colOf = Object.fromEntries(Object.entries(POS).map(([id, p]) => [id, p[0]]));

// node heights scaled (modestly) by throughput
const maxTp = Math.max(...Object.values(tp));
const hOf = (id) => Math.round((56 + Math.sqrt((tp[id] || 0) / maxTp) * 50) / 2) * 2;

const nodes = [];
nodes.push({ id: "title", bounds: { x: 60, y: -120, width: 1300, height: 46 },
  label: "U.S. Healthcare Flow of Funds — 2023 (~$4.9T)", shape: "text" });
nodes.push({ id: "subtitle", bounds: { x: 60, y: -74, width: 1700, height: 30 },
  label: "Major nodes left→right: Payers → Government → Programs & Insurers → Providers → Factors.  Edge thickness ∝ dollars (thick = main highways, drawn straight; thin = smaller flows, routed around).  Node figure = dollars it handles.",
  shape: "text" });

for (const n of NODES) {
  if (n.parent) continue; // major nodes only
  const [col, yc] = POS[n.id];
  const h = hOf(n.id);
  const childNote = n.id === "providers_clinicians" ? "\n(physician · dental · other)"
    : n.id === "long_term_care" ? "\n(nursing · home health)" : "";
  nodes.push({
    id: n.id,
    bounds: { x: COLX[col], y: Math.round(yc - h / 2), width: W, height: h },
    label: `${n.label}${childNote}\n$${Math.round(tp[n.id]).toLocaleString()}B`,
    nodeColor: GROUP_COLOR[n.group],
    labelColor: textOn(GROUP_COLOR[n.group]),
    shape: "rounded-rectangle",
  });
}

// column band labels
const bands = [["Payers / Households", 0], ["Government", 1], ["Programs & Insurers", 2], ["Providers", 3], ["Factors", 4]];
for (const [txt, c] of bands)
  nodes.push({ id: `band-${c}`, bounds: { x: COLX[c], y: 1160, width: W + 40, height: 26 }, label: txt, shape: "text" });

// ---- edge width scale (linear in dollars, with a readable floor) ----
const maxV = Math.max(...aggEdges.map((e) => e.v));
const MAXW = 30, FLOORW = 1.4;
const widthOf = (v) => Math.round(Math.max(FLOORW, (v / maxV) * MAXW) * 10) / 10;

const cx = (id) => COLX[POS[id][0]] + W / 2;
const cy = (id) => POS[id][1];
const hh = (id) => hOf(id);

function lighten(hex, f = 0.45) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, gc = (n >> 8) & 255, b = n & 255;
  r = Math.round(r + (255 - r) * f); gc = Math.round(gc + (255 - gc) * f); b = Math.round(b + (255 - b) * f);
  return "#" + [r, gc, b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// fan offset: spread edges leaving the same source so parallels don't overlap
const outIndex = {};

const edges = [];
const HIGHWAY = 250, ARTERIAL = 100, FEEDBACK_LANE = 1070;
aggEdges.sort((a, b) => b.v - a.v); // biggest first
for (const e of aggEdges) {
  const fc = colOf[e.from], tc = colOf[e.to];
  const v = e.v, w = widthOf(v);
  const baseColor = GROUP_COLOR[groupOf[e.from]];
  const id = `e-${e.from}-${e.to}`;
  const i = (outIndex[e.from] = (outIndex[e.from] || 0) + 1);

  // FEEDBACK (corporate tax → government): return along the bottom
  if (tc < fc) {
    edges.push({
      id, from: { nodeId: e.from, anchor: [W * 0.5, hh(e.from)] },
      to: { nodeId: e.to, anchor: [W * 0.5, hh(e.to)] },
      waypoints: [{ x: cx(e.from), y: FEEDBACK_LANE + 40 }, { x: cx(e.to), y: FEEDBACK_LANE + 40 }],
      color: "#B0641E", style: "dashed", arrow: "end", width: Math.max(1.2, w),
      label: v >= 10 ? `$${Math.round(v)}B tax` : undefined, labelColor: "#8a4d12",
    });
    continue;
  }

  // SAME COLUMN (medicare/medicaid → health insurance): vertical, bowed into the right gutter
  if (tc === fc) {
    const down = cy(e.to) > cy(e.from);
    const fa = down ? [W * 0.62, hh(e.from)] : [W * 0.62, 0];
    const ta = down ? [W * 0.62, 0] : [W * 0.62, hh(e.to)];
    edges.push({
      id, from: { nodeId: e.from, anchor: fa }, to: { nodeId: e.to, anchor: ta },
      waypoints: [{ x: COLX[fc] + W + 70, y: (cy(e.from) + cy(e.to)) / 2 }],
      color: baseColor, arrow: "end", width: w, label: `$${Math.round(v)}B`, labelColor: baseColor,
    });
    continue;
  }

  // FORWARD edges
  const fa = [W, hh(e.from) / 2];
  const ta = [0, hh(e.to) / 2];
  const x0 = cx(e.from) + W / 2, y0 = cy(e.from);
  const x1 = cx(e.to) - W / 2, y1 = cy(e.to);

  if (v >= HIGHWAY) {
    // main highway — straight, thick, full color, labeled
    edges.push({ id, from: { nodeId: e.from, anchor: fa }, to: { nodeId: e.to, anchor: ta },
      color: baseColor, arrow: "end", width: w, label: `$${Math.round(v)}B`, labelColor: baseColor });
    continue;
  }

  if (v >= ARTERIAL) {
    // arterial — gentle single-waypoint bow so it clears the highways
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
    const sign = i % 2 === 0 ? 1 : -1, off = 40 + (i % 3) * 22;
    const wp = { x: Math.round(mx + (-dy / len) * off * sign), y: Math.round(my + (dx / len) * off * sign) };
    edges.push({ id, from: { nodeId: e.from, anchor: fa }, to: { nodeId: e.to, anchor: ta },
      waypoints: [wp], color: lighten(baseColor, 0.15), arrow: "end", width: w,
      label: `$${Math.round(v)}B`, labelColor: lighten(baseColor, 0.15) });
    continue;
  }

  // local / back-road — route indirectly. Multi-column hops detour to a top/bottom lane.
  const span = tc - fc;
  const upper = (y0 + y1) / 2 < 580;
  const col = lighten(baseColor, 0.4);
  if (span >= 2) {
    const lane = upper ? 150 : 1010;
    edges.push({ id, from: { nodeId: e.from, anchor: [W, hh(e.from) * (upper ? 0.25 : 0.75)] },
      to: { nodeId: e.to, anchor: [0, hh(e.to) * (upper ? 0.25 : 0.75)] },
      waypoints: [{ x: COLX[fc] + W + 50, y: lane }, { x: COLX[tc] - 50, y: lane }],
      color: col, style: "dotted", arrow: "end", width: w });
  } else {
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
    const sign = i % 2 === 0 ? 1 : -1, off = 55 + (i % 4) * 20;
    const wp = { x: Math.round(mx + (-dy / len) * off * sign), y: Math.round(my + (dx / len) * off * sign) };
    edges.push({ id, from: { nodeId: e.from, anchor: fa }, to: { nodeId: e.to, anchor: ta },
      waypoints: [wp], color: col, style: "dotted", arrow: "end", width: w });
  }
}

const doc = { theme: "standard", nodes, edges };

// ---- self-check: unique ids, valid bounds/widths, no dangling endpoints ----
const ids = new Set();
const nodeIds = new Set(nodes.map((n) => n.id));
for (const n of nodes) {
  if (ids.has(n.id)) throw new Error("dup id " + n.id);
  ids.add(n.id);
  if (!(n.bounds.width > 0 && n.bounds.height > 0)) throw new Error("bad bounds " + n.id);
}
for (const e of edges) {
  if (ids.has(e.id)) throw new Error("dup id " + e.id);
  ids.add(e.id);
  for (const ep of [e.from, e.to])
    if (ep.nodeId && !nodeIds.has(ep.nodeId)) throw new Error("dangling " + e.id + " -> " + ep.nodeId);
  if (e.width != null && !(e.width > 0)) throw new Error("bad width " + e.id);
}

fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
const highways = aggEdges.filter((e) => e.v >= HIGHWAY && colOf[e.to] > colOf[e.from]).length;
console.log(`wrote ${OUT.pathname.slice(1)}`);
console.log(`major nodes: ${nodes.filter((n) => n.shape === "rounded-rectangle").length}  aggregated edges: ${edges.length}  highways: ${highways}`);
console.log(`edge width: $${maxV}B → ${MAXW}px (floor ${FLOORW}px)`);
