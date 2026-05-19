# Feature Specification: Trajectory view, graph clustering, topics in tree

**Feature**: `003-trajectory-clusters-topics`
**Created**: 2026-05-18
**Status**: In progress (ships as v0.8.0)
**Source**: User request to (1) visualize per-conversation drift in 2D, (2) cluster sessions on the agent graph, (3) surface topics in the Sessions tree.

## Why one spec for three features

They share infrastructure:
- All three reuse the existing embedder (`src/embedding.ts`) and the `turn_topic` table.
- Trajectory and clusters both need a 2-D projection — UMAP coords already exist for sessions; we add a per-turn equivalent.
- Topics-in-tree closes the loop: after a user analyses topics in one session, the labels become discoverable from the sidebar without opening the viewer.

## User Scenarios

### US-1 — See drift inside one conversation (Priority: P1)

As a user reviewing an old session, I want a **Show trajectory** button in the conversation viewer that opens a panel with each turn as a numbered dot in 2-D, connected in time order, color-coded by topic. Long jumps in the path = topic shifts.

**Acceptance**:
- Click *Show trajectory* on a 30-turn session → within ~30 s a Canvas opens with 30 numbered dots, connected by a polyline.
- Dots inherit the existing topic chip color where a topic is known. Untagged turns are grey.
- Hovering a dot shows: turn #, topic, first 120 chars of the user message.
- "Drift markers": when the Euclidean distance between adjacent turn embeddings exceeds the 90th percentile of pairwise gaps inside the session, the connecting segment is drawn dashed-and-red.

### US-2 — Clusters on the agent graph (Priority: P1)

On the existing 2-D agent graph, points should be colored by cluster so I can see *families* of sessions at a glance. Cluster centroids get a small label showing the most common topic for that cluster.

**Acceptance**:
- The agent-graph webview shows ≥ 3 distinct colored clusters when the user has ≥ 20 sessions and ≥ 2 distinct topics.
- Cluster colors are stable across reopens.
- Each cluster has a faint label at its 2-D centroid: the topic with the highest member-frequency among that cluster's sessions, lowercase, e.g. `vscode-extension-webview · 14`.
- Right-click a cluster label → "Filter graph to this cluster" (toggle): non-cluster points fade to 20% opacity.

### US-3 — Topics in the Sessions tree (Priority: P2)

After analyzing a session, the tree row should surface its dominant topics. Tooltip shows the full topic list with counts.

**Acceptance**:
- A session that has at least one topic in `turn_topic` shows up to 3 most-frequent topics in its tree description, comma-separated, after the cost/duration row.
- Tooltip lists every distinct topic with `(N turns)` count.
- Sessions with no topics show nothing extra — no placeholder.

## Functional Requirements

### FR-1 — Migration v4: `turn_embedding`

```sql
CREATE TABLE turn_embedding (
  turn_uuid       TEXT PRIMARY KEY REFERENCES turn(turn_uuid) ON DELETE CASCADE,
  embedding       BLOB NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dim   INTEGER NOT NULL,
  computed_at     INTEGER NOT NULL
);
CREATE INDEX idx_turn_emb_model ON turn_embedding(embedding_model);

ALTER TABLE session_embedding ADD COLUMN cluster_id INTEGER;
```

`cluster_id` is `NULL` until the agent graph is rebuilt; the cluster pass writes it under the latest fit.

### FR-2 — Per-turn embedding (lazy)

On open of the trajectory view: for every turn in the session lacking a `turn_embedding` row at the current model, embed via `embedMany(...)` using the same backend the agent graph uses (Ollama if reachable, hashed-BoW otherwise). Input per turn is `"USER: {user_text_truncated_1024}\nTOOLS: {tool_names_csv}"`.

### FR-3 — Per-session UMAP

For the trajectory view, fit UMAP **per session** (n_neighbors = min(15, turns-1), min_dist = 0.1) — drift inside a session is best seen against a session-local manifold rather than the global one. Results are *not* persisted; recompute each open.

### FR-4 — Drift detection

Compute pairwise cosine distance between consecutive turn embeddings. A segment is marked "drift" when `dist > p90(distances)`. Output is purely visual; no DB row.

### FR-5 — DBSCAN clustering on the agent graph

After UMAP fit on the session level, run a small inline 2-D DBSCAN (eps adaptive to the graph: `0.04 * (max - min)` along each axis, minPts = 5). Points not assigned to any cluster get `cluster_id = -1`. Persist `cluster_id` in `session_embedding`. The Canvas reads this column on render.

### FR-6 — Cluster palette

Assign a fixed 12-color palette to cluster ids modulo 12. Cluster `-1` (noise) is rendered in muted grey. Colors must respect VS Code contrast — pull from the same palette already used in the insights dashboard charts.

### FR-7 — Cluster labels

For each cluster with ≥ 3 members, compute the most common `topic_norm` across all the cluster's sessions' turn topics. Draw that label at the cluster centroid in 11 px font with 60% opacity. Limit to one label per cluster.

### FR-8 — Topics in `SessionsProvider`

The tree query joins `session` × `turn_topic` (via `turn`) and groups topics per session, producing `top_topics[]` (max 3 ordered by frequency) and `topic_counts: Map<topic, n>`. The provider applies these to `SessionRow.description` and `SessionRow.tooltip`.

### FR-9 — Commands & settings

| Command | Title |
|---|---|
| `claudeSessions.showTrajectory` | "Show conversation trajectory" |

| Setting | Default | Notes |
|---|---|---|
| `claudeSessions.cluster.minPts` | `5` | DBSCAN minPts |
| `claudeSessions.cluster.epsScale` | `0.04` | Eps as fraction of axis range |
| `claudeSessions.trajectory.driftPercentile` | `90` | Above this percentile, segment marked as drift |

## Success Criteria

- **SC-1**: Opening the trajectory view on a 30-turn session completes in ≤ 30 s end-to-end with Ollama running.
- **SC-2**: Agent graph with ≥ 50 sessions produces ≥ 3 distinct clusters using default DBSCAN parameters.
- **SC-3**: After running "Analyze topics" on a session, the Sessions tree row immediately shows up to 3 topics on next refresh (no manual reload).
- **SC-4**: Cluster labels remain stable across two consecutive opens (no flapping).

## Out of scope

- Cross-session trajectory (i.e. plotting the user's *career* through topics over time) — Phase 2.
- Editing / merging topic labels — Phase 2.
- Re-embedding under a *different* model from the agent graph — the same model id is used everywhere.
