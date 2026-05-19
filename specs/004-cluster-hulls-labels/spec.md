# Feature Specification: Convex hulls and force-placed labels for the agent graph

**Feature**: `004-cluster-hulls-labels`
**Created**: 2026-05-19
**Status**: In progress (ships as v0.9.0)
**Source**: Follow-up to v0.8.x agent-graph clusters. Research note: [`knowledge/tech/visualization/cluster-rendering-options.md`](../../../docs/knowledge/tech/visualization/cluster-rendering-options.md) (in the docs repo).

## Why this spec

v0.8.1 ships a working clustering pass but only renders **colored dots**. Two readability gaps remain:

1. **Boundaries are invisible.** When two clusters interleave or sit close in UMAP space, the viewer can't tell where one ends and the next begins — the points all look the same except for color, and color alone is hard for the eye at low dot density.
2. **Labels overlap.** Cluster centroid labels print at the literal 2-D mean. When clusters are within ~30 px of each other (common with 30–100 sessions), labels stack on top of each other and become unreadable.

The fix is two cheap Canvas additions plus a 30-line geometry helper — no new npm deps.

## User Scenarios

### US-1 — Clusters have visible boundaries (Priority: P1)

As a user opening the agent graph, I see each cluster outlined by a faint colored polygon, so I can scan the map and immediately see "there are 4 clusters" without counting colors.

**Acceptance**:
- Each cluster with ≥ 3 members gets a translucent convex-hull polygon filled in the cluster color (12 % alpha) with a 40 %-alpha 1 px stroke.
- Hulls render *behind* the dots (so dots remain clickable).
- Singletons and noise points get no hull.

### US-2 — Cluster labels don't overlap (Priority: P1)

As a user, when two clusters are close in 2-D, their topic labels still read cleanly side-by-side, not stacked.

**Acceptance**:
- Labels for clusters whose centroids are within 80 px in screen space are repelled apart so their bounding boxes don't overlap.
- Each label has a small text halo (1.5 px stroke matching the editor background) for legibility against varied hull fills.
- When a label is moved more than 12 px from its centroid by the layout pass, a thin leader line is drawn from the centroid to the label baseline.

### US-3 — Click a hull to focus a cluster (Priority: P2)

As a user, clicking inside a hull (or on its label) fades non-cluster points to 25 % opacity so I can study one cluster in isolation. Clicking the same hull again, or any empty area, clears the focus.

**Acceptance**:
- Click on a hull-filled area → that cluster's points stay full opacity, others drop to 25 %, hulls of other clusters drop to 5 %.
- Click on the label of the same cluster → same effect.
- Click empty area or the focused cluster again → all opacities restore.
- Click on a *dot* still opens its conversation viewer (US behavior preserved from v0.7).

## Functional Requirements

### FR-1 — Convex hulls via monotone-chain

Add `monotoneChainHull(points: {x,y}[]): {x,y}[]` to `agentGraph.ts`. ~30 LOC, no deps. Builds the convex hull in O(n log n). Output is in CCW order, ready for `ctx.beginPath() / ctx.lineTo()` rendering.

### FR-2 — Per-cluster hull computation

In `buildLayout`, after clustering, for every cluster with ≥ 3 members compute its hull from the UMAP coords. Persist nothing — the hull is cheap to recompute on each open.

### FR-3 — Hull rendering

Render hulls in Canvas **before** dots. Style:
- Fill: cluster color, `globalAlpha = 0.12`.
- Stroke: cluster color, `globalAlpha = 0.4`, `lineWidth = 1`.
- Path: closed polygon over the hull vertices.

### FR-4 — Force-placed labels

Replace the current "draw label at centroid" routine with a simple iterative force layout:

```
for iter in 1..20:
  for each label l:
    f = (0,0)
    # repel from every other label whose bbox is within 80px
    for every other label m:
      d = bbox-aware separation vector
      if |d| < min separation: f += d * 0.05
    # gentle attraction back to centroid
    f += (centroid - l.pos) * 0.03
    l.pos += f
```

Stops when no label moves > 0.5 px in one iter. With ≤ 12 clusters this converges in < 10 ms.

### FR-5 — Label rendering

- Font: 11 px theme font.
- Color: cluster color.
- Halo: 1.5 px stroke in `vscode-editor-background` (use `strokeText` before `fillText`).
- Leader line: 0.5 px stroke from centroid to label-bbox-edge, same color at 50 % alpha, only when label was displaced > 12 px from its centroid.

### FR-6 — Focus mode (US-3)

Webview state: `focusedCluster: number | null`. On click event:
- Hit-test in this order: (a) is mouse inside a label bbox? → focus that cluster; (b) is mouse inside a hull polygon? → focus that cluster; (c) is mouse over a dot? → existing open-conversation path; (d) empty? → clear focus.
- Re-render with adjusted alpha values.

Hull point-in-polygon test: standard ray-casting (~15 LOC). No new dep.

### FR-7 — Settings

No new settings. Hulls and force-placed labels are unconditionally on — both improve the v0.8 view without adding cost.

## Success Criteria

- **SC-1**: Opening the agent graph with ≥ 3 clusters renders hulls + labels in ≤ 100 ms after layout (excluding embedding & UMAP).
- **SC-2**: When two cluster centroids fall within 50 px of each other, their labels render without overlapping bounding boxes.
- **SC-3**: Clicking a hull dims non-focus content within one frame (60 fps); clicking again restores within one frame.
- **SC-4**: No visual regression for the existing dot-only view when `color by cluster` is off (hulls hide in that mode).

## Out of scope

- KDE / contour overlays (deferred to v0.10).
- Linked cluster→tree filter (deferred to v0.10).
- Alpha shapes / concave hulls — convex is the right baseline for our point counts.
- Server-side HDBSCAN or WASM clustering — adaptive DBSCAN is fine for now.
