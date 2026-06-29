# Sankey layout — minimizing ribbon overlap

_Design narrative for `scripts/build_sankey.mjs`, which turns `data/graph.json` into
`diagrams/healthcare-flows-sankey.jg` — a [Jumpgate](https://github.com/swax/jumpgate) diagram
(`.jg` is plain JSON: nodes, edges, waypoints, colors). For the data model the diagram is built
from, see [data-model.md](data-model.md)._

```
data/graph.json ──> scripts/build_sankey.mjs ──> diagrams/healthcare-flows-sankey.jg
                                                  (open in the Jumpgate VS Code extension)
```

## The premise: honest geometry, readable flows

Two goals pull against each other:

1. **Honest geometry.** A single `$/pixel` scale (`SCALE = 0.18`) drives **both** a node's height
   (dollars it handles) **and** a ribbon's width (dollars it carries). Ribbons stack to exactly
   fill each node's face, so the picture can't lie about magnitudes.
2. **Readability.** With ~14 nodes and ~54 flows — many of them spanning several columns — the
   ribbons can turn into spaghetti.

This doc is about goal 2: how the nodes and ribbons are placed so the flows stay legible.

## What "readable" actually means here — overlap area, not crossings

The intuitive metric is *number of crossings*, and the classic layered-graph (Sugiyama)
machinery exists to minimize it. We tried that first and it was the **wrong objective**:
minimizing crossing count actually *raised* visual clutter (it trades a few steep crossings for
many shallow ones).

The thing that hurts the eye isn't a crossing — it's **overlap area**:

- A clean **X** where two differently-colored ribbons cross is fine; the colors carry the eye
  through it. Its overlap is a tiny diamond.
- What kills legibility is **long stretches of overlap** — two ribbons running on top of each
  other (a near-parallel bundle, or a *shallow-angle* crossing whose overlap diamond stretches
  out long and thin). The muddy region is large.
- **Same-color** overlap is mild (a thicker red band still reads as "red, going right").
  **Different-color** overlap is the muddy, hard-to-follow part.
- A ribbon drawn **across a node box** is the worst — it obscures the node itself.

So the objective the layout minimizes is an **overlap-area score**, measured by rasterizing the
actual ribbon geometry onto a grid and summing where ribbons coincide:

```
score = (different-color ribbon-on-ribbon overlap area)  +  2 × (ribbon-over-node area)
```

Over-node overlap is weighted double because obscuring a node is worse than two flows blending.
A crossing's overlap area scales like `w₁·w₂ / sin θ` — which is exactly why **thick** crossings
and **shallow** crossings dominate the score, and why the levers below target both.

## The pipeline

A layered layout in five stages.

### 1. Layering — fixed semantic columns

Six columns, left → right: **Payers → Government → Public Programs → Insurers → Providers →
Claimants**. These are domain-meaningful, so column assignment is fixed (not computed). Node
height ∝ dollars handled = `max(inflow, outflow) × SCALE`.

### 2. Dummies — route long flows through lanes

A flow that skips columns (e.g. employer premiums Payers → Insurers, jumping Government and
Public Programs) would otherwise slash diagonally across everything in between. Instead each
column-skipping flow is split into one **virtual waypoint ("dummy") per column it crosses**, so
it travels along a **lane** through the gaps between nodes. Two payoffs: the long ribbon runs
flat instead of diagonal, and the ordering step (next) can finally *see* it in every column it
passes through.

Thin capillaries don't earn a lane — a flow only routes through dummies if it spans ≥2 columns
**and** is wider than `LANE_MIN` (px). Below that it draws directly; its small overlap isn't
worth the extra lanes cluttering the middle columns.

### 3. Ordering — minimize the overlap score

Within each column, the vertical order of items (real nodes + dummies) is what governs overlap.
We choose it by:

- **A median start** — a few Sugiyama median sweeps for a sane initial order.
- **Transpose refinement** — repeatedly try swapping adjacent items; keep a swap only if it
  *reduces* the overlap score. Because every accepted move provably helps, it can't scramble the
  layout (the failure mode of the old barycenter *sort*, which flung small nodes to the extremes).
- **Scored on the real geometry.** Each candidate order is positioned (stage 4) and the ribbons
  are **rasterized** to score it. An analytical shortcut (straight segments, `w·w/sinθ`) was
  tried and *misled* the search — it diverged too far from the rendered béziers + stacked ports.
- **Multi-start.** The transpose search is sensitive to its starting order, so it runs from
  several shuffled starts (`RESTARTS`) and keeps the global best — robust, not luck of one run.

### 4. Coordinates — relax, pack lanes, spread terminal nodes

Vertical positions come from **damped barycentre relaxation**: each item slides toward the
flow-weighted average height of its neighbours, repeatedly, which straightens ribbons. On top of
that, three shaping rules:

- **Min gaps** keep real nodes apart (`GAP`); lanes sit a hair apart (`DGAP`) just to read them
  as separate ribbons.
- **Cap lane gaps** (`LANE_MAXGAP`) — parallel, non-crossing lanes pack tight instead of drifting
  apart and leaving big empty bands up top.
- **Spread pure-node columns** (`SPREAD`) — a terminal column like Claimants (no lanes pass
  through) spreads its few nodes to fill the band, so the fan-in flattens and crosses less.

Finally the whole figure is recentred so the real-node mass sits centered in the band.

### 5. Ports — stack flows on each node face

Each node's outgoing flows stack on its right face, incoming on its left, **sorted by the height
of the flow's other end** (the first/last lane waypoint, or the other node). Sorting by the
neighbour's position is what stops ribbons from re-crossing right at the node face, and the
stack fills the node height exactly (honest geometry).

Corporate income tax flows forward to a terminal **Taxes** factor (a `factors`-group sink
beside Capital & Shareholders), so it reads as a normal left-to-right ribbon into the last
column rather than a dashed loop back to Government. (The backward-lane path below the diagram
remains in the builder for any future feedback edge, but is unused today.)

## Why each lever lowers the score

| Lever | Effect on overlap area |
| --- | --- |
| Lanes (stage 2) | long flows leave other colors alone instead of cutting across them |
| Steeper crossings (narrower `COLSTEP`, tighter `GAP`) | overlap ≈ `w·w/sinθ`, so steeper θ ⇒ shorter muddy region |
| Spread terminal nodes (`SPREAD`) | flattens fan-in/out so its ribbons cross less |
| Pack lanes (`LANE_MAXGAP`) | removes wasted empty bands between parallel lanes |
| Overlap-driven ordering (stage 3) | directly minimizes the measured score, incl. the 2× node penalty |

## Tuning knobs (environment variables)

```bash
SANKEY_COLSTEP=300 SANKEY_GAP=50 SANKEY_LANE_MAXGAP=10 \
SANKEY_SPREAD=0.85 SANKEY_LANE_MIN=6 SANKEY_RESTARTS=6 \
node scripts/build_sankey.mjs
```

| Var | Default | Meaning |
| --- | --- | --- |
| `SANKEY_COLSTEP` | 300 | horizontal pitch between columns (narrower ⇒ steeper crossings ⇒ less overlap, to a point) |
| `SANKEY_GAP` | 50 | minimum vertical gap between two real nodes |
| `SANKEY_LANE_MIN` | 6 | min ribbon width (px) for a long flow to earn its own routed lane |
| `SANKEY_LANE_MAXGAP` | 10 | cap on the gap between stacked lanes (packs parallel lanes) |
| `SANKEY_SPREAD` | 0.85 | fraction of the band a pure-node column fills by spreading its nodes |
| `SANKEY_RESTARTS` | 6 | multi-start search count (more = steadier result, slower build) |

`SANKEY_OUT` overrides the output path (used for A/B comparisons).

## The build-time guard

The build prints the overlap area it achieved — a regression indicator, so a future data or
layout change that muddies the picture shows up as a rising number:

```
overlap area (readability guard) — diff-color 83k px² · over-node 22k px² · combined 126k px²
```

(The printed guard is a dense, fine-grid rasterization for an accurate absolute area; the
optimizer searches on a coarser, faster grid. Both count the same forward ribbons — including
the corporate-tax flows into the terminal Taxes factor — so they move together.)

## Results

Versus the original fixed-order layout (independent rasterized measure, all edges):

| metric | before | after | change |
| --- | --- | --- | --- |
| different-color overlap | 160k px² | 72k px² | −55% |
| ribbon-over-node | 106k px² | 29k px² | −72% |
| **combined (diff + 2×node)** | **371k px²** | **131k px²** | **−65%** |

Build runs in a few seconds (dominated by the multi-start rasterized search).

## Scope notes

- The model is a **traced subset** (see [data-model.md](data-model.md)), so a node's inflow need
  not equal its outflow — node heights use `max(inflow, outflow)` and the smaller side simply
  doesn't fill the face. That's intentional, not a layout bug.
- **Same-color overlap is accepted.** Packing same-group flows into shared lanes raises total
  overlap but lowers the *different-color* overlap that actually impairs reading.
- The renderer (Jumpgate) draws the translucent, constant-width ribbons and the smooth
  (horizontal-tangent bézier) curves; this script only decides positions, widths, colors, and
  waypoints.
