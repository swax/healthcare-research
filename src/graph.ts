// Shared, testable graph logic. Imported by build.ts, check.ts, and the tests.
// Erasable-syntax-only TypeScript (runs natively on Node >= 22.6 / 24).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GNode { id: string; layer: number; group: string; color: string; role?: string; }
export interface Edge { from: string; to: string; amount: number; channel: string; source: string; }
export interface Graph { nodes: GNode[]; edges: Edge[]; }

export function loadGraph(root: string): { meta: Record<string, unknown>; graph: Graph } {
  return JSON.parse(readFileSync(join(root, 'data', 'graph.json'), 'utf8'));
}

export function computeFlows(nodes: GNode[], edges: Edge[]): {
  inflow: Record<string, number>; outflow: Record<string, number>; throughput: Record<string, number>;
} {
  const inflow: Record<string, number> = {};
  const outflow: Record<string, number> = {};
  for (const n of nodes) { inflow[n.id] = 0; outflow[n.id] = 0; }
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
    state[u] = 1; stack.push(u);
    for (const v of adj[u] || []) {
      if (state[v] === 1) cycles.push(stack.slice(stack.indexOf(v)).concat(v).join(' -> '));
      else if (!state[v]) dfs(v);
    }
    stack.pop(); state[u] = 2;
  }
  for (const n of nodes) if (!state[n.id]) dfs(n.id);
  return cycles;
}

// Structural + accounting invariants. Returns human-readable problems ([] = all good).
export function validateGraph(graph: Graph): string[] {
  const { nodes, edges } = graph;
  const problems: string[] = [];
  const ids = new Set<string>();
  const layer: Record<string, number> = {};
  for (const n of nodes) {
    if (ids.has(n.id)) problems.push(`duplicate node id: "${n.id}"`);
    ids.add(n.id); layer[n.id] = n.layer;
    if (!Number.isInteger(n.layer) || n.layer < 0) problems.push(`node "${n.id}": invalid layer ${n.layer}`);
    if (!/^[0-9A-Fa-f]{6}$/.test(n.color)) problems.push(`node "${n.id}": invalid color "${n.color}"`);
    if (!n.group) problems.push(`node "${n.id}": missing group`);
  }
  for (const e of edges) {
    const tag = `${e.from} -> ${e.to}`;
    if (!ids.has(e.from)) problems.push(`edge ${tag}: unknown source "${e.from}"`);
    if (!ids.has(e.to)) problems.push(`edge ${tag}: unknown target "${e.to}"`);
    if (e.from === e.to) problems.push(`edge ${tag}: self-loop`);
    if (typeof e.amount !== 'number' || !isFinite(e.amount) || e.amount <= 0)
      problems.push(`edge ${tag}: amount must be a positive number (got ${e.amount})`);
    if (ids.has(e.from) && ids.has(e.to) && layer[e.to] < layer[e.from])
      problems.push(`edge ${tag}: backward flow (layer ${layer[e.from]} -> ${layer[e.to]})`);
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
