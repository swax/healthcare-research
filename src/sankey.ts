// Plotly Sankey HTML from the canonical graph. Pure: takes a GraphFile and returns
// the HTML string (no file IO, no globals). Extracted from build.ts so the v2
// observations-first model can render the SAME diagram via toV1() — see
// data_v2/build.ts — instead of duplicating ~100 lines and drifting.
//
// Erasable-syntax-only TypeScript, same as the rest of src/.
import { computeFlows, findCycles } from './graph.ts';
import type { GraphFile, GNode } from './graph.ts';

export function renderSankeyHtml(file: GraphFile): string {
  const nodes = file.graph.nodes;
  const edges = file.graph.edges;

  // Derived lookups from the canonical graph (colors, layer x-positions, citation text).
  const colorByGroup: Record<string, string> = {};
  const groupLabel: Record<string, string> = {};
  for (const g of file.groups) {
    colorByGroup[g.id] = g.color;
    groupLabel[g.id] = g.label;
  }
  const xByLayer: Record<number, number> = {};
  for (const l of file.layers) xByLayer[l.n] = l.x;
  const colorOf = (n: GNode): string => colorByGroup[n.group] ?? '999999';
  const srcText = (id: string): string => file.sources[id] ?? id;

  const flows = computeFlows(nodes, edges);
  const through = (id: string): number => flows.throughput[id] ?? 0;

  const names = nodes.map((n) => n.label);
  const idx: Record<string, number> = {};
  nodes.forEach((n, i) => {
    idx[n.id] = i;
  });
  const cycles = findCycles(nodes, edges);
  if (cycles.length) throw new Error('Graph has cycles, Sankey needs a DAG: ' + cycles.join(', '));

  const byLayer: Record<number, number[]> = {};
  nodes.forEach((n, i) => {
    (byLayer[n.layer] = byLayer[n.layer] || []).push(i);
  });
  const nodeX: number[] = new Array(nodes.length).fill(0.5);
  const nodeY: number[] = new Array(nodes.length).fill(0.5);
  for (const [layer, members] of Object.entries(byLayer)) {
    const k = members.length;
    members.forEach((i, j) => {
      nodeX[i] = xByLayer[Number(layer)] ?? 0.5;
      nodeY[i] = (j + 1) / (k + 1);
    });
  }
  const rgba = (hex: string, a: number): string => {
    const h = hex.replace('#', '');
    return (
      'rgba(' +
      parseInt(h.slice(0, 2), 16) +
      ',' +
      parseInt(h.slice(2, 4), 16) +
      ',' +
      parseInt(h.slice(4, 6), 16) +
      ',' +
      a +
      ')'
    );
  };
  const fig = {
    data: [
      {
        type: 'sankey',
        arrangement: 'snap',
        valueformat: '$,.0f',
        valuesuffix: 'B',
        node: {
          pad: 18,
          thickness: 20,
          line: { color: 'rgba(0,0,0,0.35)', width: 0.5 },
          label: names,
          color: nodes.map((n) => rgba(colorOf(n), 0.95)),
          x: nodeX,
          y: nodeY,
          customdata: nodes.map((n) => [
            groupLabel[n.group] ?? n.group,
            Math.round(through(n.id) * 10) / 10,
          ]),
          hovertemplate:
            '<b>%{label}</b><br>%{customdata[0]}<br>Throughput: $%{customdata[1]}B<extra></extra>',
        },
        link: {
          source: edges.map((e) => idx[e.from]),
          target: edges.map((e) => idx[e.to]),
          value: edges.map((e) => e.amount),
          color: edges.map((e) => rgba(colorOf(nodes[idx[e.from]]), 0.33)),
          customdata: edges.map((e) => [e.channel, srcText(e.source)]),
          hovertemplate:
            '%{source.label} → %{target.label}<br><b>$%{value:,.0f}B</b><br>%{customdata[0]}<extra></extra>',
        },
      },
    ],
    layout: {
      title: {
        text: 'U.S. Healthcare Flow of Funds — FY 2023  ($B; node & ribbon width ∝ dollars)',
        font: { size: 18, color: '#263238' },
      },
      font: { family: 'Segoe UI, Helvetica, Arial, sans-serif', size: 12, color: '#263238' },
      paper_bgcolor: 'white',
      margin: { l: 10, r: 10, t: 70, b: 40 },
      annotations: file.layers.map((l) => ({
        showarrow: false,
        x: l.x,
        y: 1.045,
        xref: 'paper',
        yref: 'paper',
        text: '<b>' + (l.annotation ?? l.name) + '</b>',
        font: { size: 11, color: '#555' },
      })),
    },
  };
  return (
    '<!doctype html><html><head><meta charset="utf-8">\n<title>Healthcare Flow of Funds — FY 2023</title>\n<script src="https://cdn.plot.ly/plotly-2.35.2.min.js" charset="utf-8"></script>\n<style>html,body{margin:0;background:#fff;font-family:\'Segoe UI\',Arial,sans-serif}#chart{width:100%;height:88vh}.foot{padding:6px 16px;color:#777;font-size:12px}</style></head>\n<body><div id="chart"></div>\n<div class="foot">Generated from data.json · ' +
    nodes.length +
    ' nodes, ' +
    edges.length +
    ' flows · re-run <code>node src/build.ts</code> after editing the data.</div>\n<script>var fig=' +
    JSON.stringify(fig) +
    ";\nPlotly.newPlot('chart',fig.data,fig.layout,{responsive:true,displaylogo:false,toImageButtonOptions:{format:'png',filename:'healthcare_flow_2023',scale:2}});</script>\n</body></html>"
  );
}
