// Shared, testable graph logic. Imported by build.ts, check.ts, and the tests.
// Erasable-syntax-only TypeScript (runs natively on Node >= 22.6 / 24).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GNode {
  id: string;
  label: string;
  layer: number;
  group: string;
  role?: string;
}
export interface Edge {
  id: string;
  from: string;
  to: string;
  amount: number;
  channel: string;
  source: string;
  confidence?: string;
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
export interface Graph {
  nodes: GNode[];
  edges: Edge[];
}
export interface GraphFile {
  meta: Record<string, unknown>;
  layers: LayerDef[];
  groups: GroupDef[];
  sources: Record<string, string>;
  graph: Graph;
}

export function loadGraph(root: string): GraphFile {
  return JSON.parse(readFileSync(join(root, 'data', 'graph.json'), 'utf8'));
}

export function computeFlows(
  nodes: GNode[],
  edges: Edge[],
): {
  inflow: Record<string, number>;
  outflow: Record<string, number>;
  throughput: Record<string, number>;
} {
  const inflow: Record<string, number> = {};
  const outflow: Record<string, number> = {};
  for (const n of nodes) {
    inflow[n.id] = 0;
    outflow[n.id] = 0;
  }
  for (const e of edges) {
    outflow[e.from] = (outflow[e.from] ?? 0) + e.amount;
    inflow[e.to] = (inflow[e.to] ?? 0) + e.amount;
  }
  const throughput: Record<string, number> = {};
  for (const n of nodes) throughput[n.id] = Math.max(inflow[n.id] ?? 0, outflow[n.id] ?? 0);
  return { inflow, outflow, throughput };
}

// Returns a list of cycle descriptions (empty = acyclic). A Sankey requires a DAG.
export function findCycles(nodes: GNode[], edges: Edge[]): string[] {
  const adj: Record<string, string[]> = {};
  for (const e of edges) (adj[e.from] = adj[e.from] || []).push(e.to);
  const state: Record<string, number> = {};
  const stack: string[] = [];
  const cycles: string[] = [];
  function dfs(u: string): void {
    state[u] = 1;
    stack.push(u);
    for (const v of adj[u] || []) {
      if (state[v] === 1) cycles.push(stack.slice(stack.indexOf(v)).concat(v).join(' -> '));
      else if (!state[v]) dfs(v);
    }
    stack.pop();
    state[u] = 2;
  }
  for (const n of nodes) if (!state[n.id]) dfs(n.id);
  return cycles;
}

const ROLES = new Set(['source', 'intermediary', 'sink']);
const CONFIDENCE = new Set(['reported', 'estimate']);

// Structural + reference + accounting invariants. Returns human-readable problems ([] = all good).
export function validateGraph(file: GraphFile): string[] {
  const { graph, layers, groups, sources } = file;
  const { nodes, edges } = graph;
  const problems: string[] = [];

  // ---- lookup tables ----
  const layerNums = new Set<number>();
  for (const l of layers) {
    if (layerNums.has(l.n)) problems.push(`duplicate layer number: ${l.n}`);
    layerNums.add(l.n);
    if (!l.name) problems.push(`layer ${l.n}: missing name`);
    if (typeof l.x !== 'number' || l.x < 0 || l.x > 1)
      problems.push(`layer ${l.n}: x must be 0..1 (got ${l.x})`);
  }
  const groupIds = new Set<string>();
  for (const g of groups) {
    if (groupIds.has(g.id)) problems.push(`duplicate group id: "${g.id}"`);
    groupIds.add(g.id);
    if (!g.label) problems.push(`group "${g.id}": missing label`);
    if (!/^[0-9A-Fa-f]{6}$/.test(g.color))
      problems.push(`group "${g.id}": invalid color "${g.color}"`);
  }
  const sourceIds = new Set<string>(Object.keys(sources ?? {}));

  // ---- nodes ----
  const ids = new Set<string>();
  const layer: Record<string, number> = {};
  for (const n of nodes) {
    if (ids.has(n.id)) problems.push(`duplicate node id: "${n.id}"`);
    ids.add(n.id);
    layer[n.id] = n.layer;
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

  // ---- edges ----
  const edgeIds = new Set<string>();
  const pairChannel = new Set<string>();
  for (const e of edges) {
    const tag = `${e.from} -> ${e.to}`;
    if (!e.id) problems.push(`edge ${tag}: missing id`);
    else if (edgeIds.has(e.id)) problems.push(`duplicate edge id: "${e.id}"`);
    edgeIds.add(e.id);
    if (!ids.has(e.from)) problems.push(`edge ${e.id || tag}: unknown source "${e.from}"`);
    if (!ids.has(e.to)) problems.push(`edge ${e.id || tag}: unknown target "${e.to}"`);
    if (e.from === e.to) problems.push(`edge ${e.id || tag}: self-loop`);
    if (typeof e.amount !== 'number' || !isFinite(e.amount) || e.amount <= 0)
      problems.push(`edge ${e.id || tag}: amount must be a positive number (got ${e.amount})`);
    if (ids.has(e.from) && ids.has(e.to) && layer[e.to] < layer[e.from])
      problems.push(
        `edge ${e.id || tag}: backward flow (layer ${layer[e.from]} -> ${layer[e.to]})`,
      );
    if (!sourceIds.has(e.source))
      problems.push(`edge ${e.id || tag}: source "${e.source}" not defined in sources{}`);
    if (e.confidence !== undefined && !CONFIDENCE.has(e.confidence))
      problems.push(`edge ${e.id || tag}: invalid confidence "${e.confidence}"`);
    const key = `${e.from}|${e.to}|${e.channel}`;
    if (pairChannel.has(key))
      problems.push(
        `edge ${e.id || tag}: duplicate (from,to,channel) "${e.channel}" — give it a distinct channel`,
      );
    pairChannel.add(key);
  }

  for (const c of findCycles(nodes, edges)) problems.push(`cycle (Sankey needs a DAG): ${c}`);

  const { inflow, outflow } = computeFlows(nodes, edges);
  for (const n of nodes) {
    if (n.role === 'source' && (inflow[n.id] ?? 0) > 1e-9)
      problems.push(`node "${n.id}" role=source but has inflow $${inflow[n.id].toFixed(1)}B`);
    if (n.role === 'sink' && (outflow[n.id] ?? 0) > 1e-9)
      problems.push(`node "${n.id}" role=sink but has outflow $${outflow[n.id].toFixed(1)}B`);
    if ((inflow[n.id] ?? 0) === 0 && (outflow[n.id] ?? 0) === 0)
      problems.push(`node "${n.id}" is isolated (no edges)`);
  }
  return problems;
}
