// v2 loader + validation for the observations-first flow model (data_v2/graph.json).
//
// FULLY INDEPENDENT of v1: this module imports nothing from src/graph.ts. v2 owns its
// types, its validation, and its flow arithmetic outright. validateGraphV2 checks the
// v2 shape directly, so it does NOT inherit v1's Sankey-only rules — forward-flow and
// acyclicity. v2 renders Excel, not a Sankey, so a flow may go to ANY node, including a
// feedback edge back to an earlier layer (e.g. corporate taxes → Government). Every
// other rule v1 enforced that still matters (reference integrity, positive amounts,
// role/balance sanity) is re-asserted here, alongside the observation- and split-level
// rules unique to v2. (The only shared code left is the neutral Excel pour-in in
// src/workbook.ts + the Sheet/Cell model in src/render-sheet.ts — pure rendering infra,
// not the v1 data model.) v1 keeps loading data/graph.json, untouched.
//
// Erasable-syntax-only TypeScript, same as src/.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Basis = 'modeled' | 'national';

// v2's own node/layer/group types (formerly borrowed from src/graph.ts — now severed).
export interface GNode {
  id: string;
  label: string;
  layer: number;
  group: string;
  role?: string;
  parent?: string; // a sub-node: edges attach to it; its parent is a pure aggregate
  description?: string; // one-line context (enrollment, coverage, share) — surfaced
  // on the Overview node summary and on ledgers without a curated subtitle
}
export interface LayerDef {
  n: number;
  name: string;
  x: number;
  annotation?: string;
}
export interface GroupDef {
  id: string;
  label: string;
  color: string;
}

export interface Observation {
  value: number; // dollars in billions; positive finite
  source: string; // key into sources{}
  basis: Basis; // which lens: this model's traced flow, or all-payer national reference
  confidence?: string; // 'reported' | 'estimate'
  canonical?: boolean; // true on the one observation that IS the model's number
  note?: string;
}
// An optional finer breakdown of an edge's flow: child components that MUST sum to
// the edge's canonical value (validated). It recovers v1's line-item detail (e.g.
// pharma labor → R&D / manufacturing / SG&A) as structured, checkable data while the
// edge itself stays a single flow to its sink — so totals, balance and hyperlinks are
// unchanged. Rendered as indented sub-rows under the parent in the ledger.
export interface SplitPart {
  label: string;
  value: number; // dollars in billions; positive finite
  note?: string;
  confidence?: string; // 'reported' | 'estimate' (parts are usually estimates)
}
export interface EdgeV2 {
  id: string;
  from: string;
  to: string;
  channel: string;
  observations: Observation[];
  split?: SplitPart[]; // optional line-item breakdown; sums to the canonical value
  category?: string; // optional grouping key — a node's section groups rows under
  // labeled sub-headers (+ subtotal) when 2+ categories are present (e.g. a
  // government's inflows split into "General revenue" vs "Corporate income tax")
}
export interface GraphFileV2 {
  meta: Record<string, unknown>;
  layers: LayerDef[];
  groups: GroupDef[];
  sources: Record<string, string>;
  graph: { nodes: GNode[]; edges: EdgeV2[] };
}

export function loadGraphV2(root: string): GraphFileV2 {
  return JSON.parse(readFileSync(join(root, 'data_v2', 'graph.json'), 'utf8'));
}

// The canonical observation: the lone one when there's a single observation, else
// the one flagged `canonical: true`. Throws if a multi-observation edge doesn't
// name exactly one — this is the strict accessor for code that has already passed
// validateGraphV2. (validation and computeFlowsV2 use the lenient resolver below so a
// malformed file is REPORTED as a problem rather than crashing the validator.)
export function canonicalObservation(edge: EdgeV2): Observation {
  const obs = edge.observations;
  if (obs.length === 1) return obs[0];
  const flagged = obs.filter((o) => o.canonical);
  if (flagged.length !== 1)
    throw new Error(
      `edge ${edge.id}: expected exactly one canonical observation, found ${flagged.length}`,
    );
  return flagged[0];
}

// Non-throwing canonical pick for the projection/validation path: a flagged
// observation if there's exactly one, else the first (so structural checks still
// run on a malformed file; validateGraphV2 separately reports why it's malformed).
function resolveCanonical(edge: EdgeV2): Observation | undefined {
  const obs = edge.observations;
  if (!Array.isArray(obs) || obs.length === 0) return undefined;
  if (obs.length === 1) return obs[0];
  const flagged = obs.filter((o) => o.canonical);
  return flagged.length === 1 ? flagged[0] : obs[0];
}

export function canonicalAmount(edge: EdgeV2): number {
  return canonicalObservation(edge).value;
}

// Per-node flow sums from canonical amounts — v2's own arithmetic (no reach into v1's
// computeFlows). Pure: inflow/outflow per node, throughput = max of the two. Sub-nodes
// (those with a `parent`) carry the real edges; each parent is an aggregate, so its
// children's flows roll up into it. The grand total is conserved by summing LEAF nodes
// only — see `leafNodeIds`.
export function computeFlowsV2(file: GraphFileV2): {
  inflow: Record<string, number>;
  outflow: Record<string, number>;
  throughput: Record<string, number>;
} {
  const inflow: Record<string, number> = {};
  const outflow: Record<string, number> = {};
  for (const n of file.graph.nodes) {
    inflow[n.id] = 0;
    outflow[n.id] = 0;
  }
  for (const e of file.graph.edges) {
    const c = resolveCanonical(e);
    if (!c) continue;
    outflow[e.from] = (outflow[e.from] ?? 0) + c.value;
    inflow[e.to] = (inflow[e.to] ?? 0) + c.value;
  }
  // Roll each child's flow up into its parent (one level of nesting).
  for (const n of file.graph.nodes) {
    if (!n.parent) continue;
    inflow[n.parent] = (inflow[n.parent] ?? 0) + (inflow[n.id] ?? 0);
    outflow[n.parent] = (outflow[n.parent] ?? 0) + (outflow[n.id] ?? 0);
  }
  const throughput: Record<string, number> = {};
  for (const n of file.graph.nodes)
    throughput[n.id] = Math.max(inflow[n.id] ?? 0, outflow[n.id] ?? 0);
  return { inflow, outflow, throughput };
}

// Node ids that are NOT aggregates — i.e. carry their own edges. Summing a flow map
// over just these avoids double-counting a parent and its children.
export function leafNodeIds(file: GraphFileV2): Set<string> {
  const parents = new Set<string>();
  for (const n of file.graph.nodes) if (n.parent) parents.add(n.parent);
  return new Set(file.graph.nodes.map((n) => n.id).filter((id) => !parents.has(id)));
}

const BASES = new Set<string>(['modeled', 'national']);
const CONFIDENCE = new Set<string>(['reported', 'estimate']);
const ROLES = new Set<string>(['source', 'intermediary', 'sink']);

// v2's own validation — self-contained, NOT a wrapper over v1's validateGraph.
// It re-asserts the structural / reference / accounting rules that still matter on
// the v2 shape, and adds the observation- and split-level rules unique to v2. The
// two rules it deliberately DROPS are v1's Sankey-only ones: forward-flow (an edge
// may point to any layer) and acyclicity (feedback edges, e.g. taxes → Government,
// are allowed). The Excel output needs neither.
export function validateGraphV2(file: GraphFileV2): string[] {
  const problems: string[] = [];
  const { layers, groups, graph } = file;
  const { nodes, edges } = graph;

  // ---- layers ----
  const layerNums = new Set<number>();
  for (const l of layers ?? []) {
    if (layerNums.has(l.n)) problems.push(`duplicate layer number: ${l.n}`);
    layerNums.add(l.n);
    if (!l.name) problems.push(`layer ${l.n}: missing name`);
    if (typeof l.x !== 'number' || l.x < 0 || l.x > 1)
      problems.push(`layer ${l.n}: x must be 0..1 (got ${l.x})`);
  }

  // ---- groups ----
  const groupIds = new Set<string>();
  for (const g of groups ?? []) {
    if (groupIds.has(g.id)) problems.push(`duplicate group id: "${g.id}"`);
    groupIds.add(g.id);
    if (!g.label) problems.push(`group "${g.id}": missing label`);
    if (!/^[0-9A-Fa-f]{6}$/.test(g.color))
      problems.push(`group "${g.id}": invalid color "${g.color}"`);
  }

  // ---- nodes ----
  const ids = new Set<string>();
  const role: Record<string, string | undefined> = {};
  for (const n of nodes) {
    if (ids.has(n.id)) problems.push(`duplicate node id: "${n.id}"`);
    ids.add(n.id);
    role[n.id] = n.role;
    if (!n.label) problems.push(`node "${n.id}": missing label`);
    if (!Number.isInteger(n.layer) || n.layer < 0)
      problems.push(`node "${n.id}": invalid layer ${n.layer}`);
    else if (!layerNums.has(n.layer))
      problems.push(`node "${n.id}": layer ${n.layer} not defined in layers[]`);
    if (!groupIds.has(n.group))
      problems.push(`node "${n.id}": group "${n.group}" not defined in groups[]`);
    if (n.role !== undefined && !ROLES.has(n.role))
      problems.push(`node "${n.id}": invalid role "${n.role}"`);
  }

  // ---- sub-nodes (parent / child): a child carries edges, its parent aggregates ----
  const parentIds = new Set<string>();
  for (const n of nodes) if (n.parent) parentIds.add(n.parent);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    if (!n.parent) continue;
    const p = nodeById.get(n.parent);
    if (!p) problems.push(`node "${n.id}": parent "${n.parent}" not defined`);
    else if (p.layer !== n.layer)
      problems.push(
        `node "${n.id}": layer ${n.layer} must match parent "${n.parent}" layer ${p.layer}`,
      );
  }

  const sourceIds = new Set<string>(Object.keys(file.sources ?? {}));

  // ---- edges: structure (no forward-flow / no DAG check), observations, split ----
  const edgeIds = new Set<string>();
  const pairChannel = new Set<string>();
  const directEdgeNodes = new Set<string>();
  for (const e of edges) {
    const tag = e.id || `${e.from} -> ${e.to}`;
    if (!e.id) problems.push(`edge ${tag}: missing id`);
    else if (edgeIds.has(e.id)) problems.push(`duplicate edge id: "${e.id}"`);
    edgeIds.add(e.id);
    directEdgeNodes.add(e.from);
    directEdgeNodes.add(e.to);
    if (!ids.has(e.from)) problems.push(`edge ${tag}: unknown source "${e.from}"`);
    if (!ids.has(e.to)) problems.push(`edge ${tag}: unknown target "${e.to}"`);
    if (e.from === e.to) problems.push(`edge ${tag}: self-loop`);
    const key = `${e.from}|${e.to}|${e.channel}`;
    if (pairChannel.has(key))
      problems.push(
        `edge ${tag}: duplicate (from,to,channel) "${e.channel}" — give it a distinct channel`,
      );
    pairChannel.add(key);

    const obs = e.observations;
    if (!Array.isArray(obs) || obs.length === 0) {
      problems.push(`edge ${tag}: must have at least one observation`);
      continue;
    }
    const flagged = obs.filter((o) => o.canonical);
    if (obs.length > 1 && flagged.length !== 1)
      problems.push(
        `edge ${tag}: ${obs.length} observations need exactly one "canonical": true (found ${flagged.length})`,
      );
    obs.forEach((o, i) => {
      const otag = `edge ${tag} obs[${i}]`;
      if (typeof o.value !== 'number' || !isFinite(o.value) || o.value <= 0)
        problems.push(`${otag}: value must be a positive finite number (got ${o.value})`);
      if (!sourceIds.has(o.source))
        problems.push(`${otag}: source "${o.source}" not defined in sources{}`);
      if (!BASES.has(o.basis)) problems.push(`${otag}: invalid basis "${o.basis}"`);
      if (o.confidence !== undefined && !CONFIDENCE.has(o.confidence))
        problems.push(`${otag}: invalid confidence "${o.confidence}"`);
    });
    // A split must sum to the edge's canonical value (within tolerance) so the
    // line items reconcile to the flow — each number still lives once.
    if (Array.isArray(e.split) && e.split.length) {
      let sum = 0;
      e.split.forEach((p, i) => {
        const ptag = `edge ${tag} split[${i}]`;
        if (typeof p.value !== 'number' || !isFinite(p.value) || p.value <= 0)
          problems.push(`${ptag}: value must be a positive finite number (got ${p.value})`);
        else sum += p.value;
        if (typeof p.label !== 'string' || !p.label) problems.push(`${ptag}: missing label`);
        if (p.confidence !== undefined && !CONFIDENCE.has(p.confidence))
          problems.push(`${ptag}: invalid confidence "${p.confidence}"`);
      });
      const canon = resolveCanonical(e);
      if (canon && Math.abs(sum - canon.value) > 1.0)
        problems.push(
          `edge ${tag}: split sums to ${Math.round(sum * 100) / 100} but canonical is ${canon.value} (must match within $1B)`,
        );
    }
  }

  // A parent is a pure aggregate: flows must go through its children, not the parent.
  for (const pid of parentIds)
    if (directEdgeNodes.has(pid))
      problems.push(
        `node "${pid}" is a parent (aggregate) but has direct edges — attach flows to its children instead`,
      );

  // ---- role / balance sanity (on canonical amounts, parents rolled up) ----
  const { inflow, outflow } = computeFlowsV2(file);
  for (const n of nodes) {
    if (role[n.id] === 'source' && (inflow[n.id] ?? 0) > 1e-9)
      problems.push(`node "${n.id}" role=source but has inflow $${inflow[n.id].toFixed(1)}B`);
    if (role[n.id] === 'sink' && (outflow[n.id] ?? 0) > 1e-9)
      problems.push(`node "${n.id}" role=sink but has outflow $${outflow[n.id].toFixed(1)}B`);
    if ((inflow[n.id] ?? 0) === 0 && (outflow[n.id] ?? 0) === 0)
      problems.push(`node "${n.id}" is isolated (no edges)`);
  }

  return problems;
}

// NOTE: v2 deliberately has NO discrepancy/spread "engine". This is a big-picture
// flow model — when sources differ by a few $B that is context, not an error to gate
// on. Multiple sources live as `observations[]`; one is canonical (the value used) and
// the others are surfaced as plain "also reported: …" context in the ledger, Edges,
// Overview, and check.ts. The author records the reason for the pick in the canonical
// observation's `note`. There is no tolerance, no flag, no spread report. See docs/v2.md.
