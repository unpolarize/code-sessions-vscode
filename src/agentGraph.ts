// 2D agent graph: embedding → UMAP → Canvas scatter.
//
// Phase 1C of v0.7.0. The graph is computed lazily when the user opens it,
// then cached: subsequent opens skip embedding for sessions that already have
// one stored under the same `embedding_model`.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { UMAP } from "umap-js";
import { SessionStore, SessionRow } from "./db";
import { embedMany, EmbedConfig } from "./embedding";

interface GraphPoint {
  session_id: string;
  x: number;
  y: number;
  title: string;
  project: string | null;
  endedAt: number | null;
  costUsd: number;
  msgs: number;
  isAutomated: boolean;
  cluster: number;
}

interface ClusterLabel {
  cluster: number;
  cx: number;
  cy: number;
  label: string;
  count: number;
  hull: Array<{ x: number; y: number }>;
}

/** Andrew's monotone chain. Returns CCW hull (≥3 unique input points). */
function convexHull(pts: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (pts.length < 3) return pts.slice();
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Array<{ x: number; y: number }> = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Array<{ x: number; y: number }> = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * k-means in 2D with deterministic seeding (k-means++). Returns cluster ids
 * 0..k-1. Used as a fallback when DBSCAN can't find density (small or
 * uniformly spread corpora).
 */
function kmeans2d(points: Array<{ x: number; y: number }>, k: number, maxIter = 80): number[] {
  if (points.length === 0 || k <= 0) return points.map(() => 0);
  if (k >= points.length) return points.map((_, i) => i);
  // k-means++ seeding
  const seeds: Array<{ x: number; y: number }> = [];
  let rng = 0x9e3779b1; // deterministic
  const rand = () => {
    rng = ((rng + 0x6d2b79f5) ^ (rng >>> 15)) >>> 0;
    rng = Math.imul(rng, 1 | rng);
    rng ^= rng + Math.imul(rng ^ (rng >>> 7), 61 | rng);
    return ((rng ^ (rng >>> 14)) >>> 0) / 0x100000000;
  };
  seeds.push({ ...points[Math.floor(rand() * points.length)] });
  while (seeds.length < k) {
    const d2 = points.map((p) => {
      let best = Infinity;
      for (const s of seeds) {
        const dx = p.x - s.x, dy = p.y - s.y;
        const v = dx * dx + dy * dy;
        if (v < best) best = v;
      }
      return best;
    });
    const sum = d2.reduce((a, b) => a + b, 0);
    let r = rand() * sum;
    let idx = 0;
    for (; idx < d2.length; idx++) {
      r -= d2[idx];
      if (r <= 0) break;
    }
    seeds.push({ ...points[Math.min(idx, points.length - 1)] });
  }
  const centers = seeds.map((c) => ({ ...c }));
  const assign = new Array(points.length).fill(0);
  for (let it = 0; it < maxIter; it++) {
    let changed = false;
    for (let i = 0; i < points.length; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dx = points[i].x - centers[c].x, dy = points[i].y - centers[c].y;
        const v = dx * dx + dy * dy;
        if (v < bd) { bd = v; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; changed = true; }
    }
    // Recompute centers
    const sumX = new Array(k).fill(0), sumY = new Array(k).fill(0), count = new Array(k).fill(0);
    for (let i = 0; i < points.length; i++) {
      sumX[assign[i]] += points[i].x;
      sumY[assign[i]] += points[i].y;
      count[assign[i]] += 1;
    }
    for (let c = 0; c < k; c++) {
      if (count[c] > 0) {
        centers[c].x = sumX[c] / count[c];
        centers[c].y = sumY[c] / count[c];
      }
    }
    if (!changed) break;
  }
  return assign;
}

/** 2D DBSCAN. eps in same units as coords. minPts cluster size. */
function dbscan2d(points: Array<{ x: number; y: number }>, eps: number, minPts: number): number[] {
  const n = points.length;
  const cluster = new Array<number>(n).fill(-2); // -2 = unvisited
  const eps2 = eps * eps;
  const neighbors = (i: number): number[] => {
    const out: number[] = [];
    const pi = points[i];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = pi.x - points[j].x;
      const dy = pi.y - points[j].y;
      if (dx * dx + dy * dy <= eps2) out.push(j);
    }
    return out;
  };
  let cid = 0;
  for (let i = 0; i < n; i++) {
    if (cluster[i] !== -2) continue;
    const nb = neighbors(i);
    if (nb.length + 1 < minPts) {
      cluster[i] = -1; // noise
      continue;
    }
    cluster[i] = cid;
    const queue = [...nb];
    while (queue.length > 0) {
      const j = queue.shift()!;
      if (cluster[j] === -1) cluster[j] = cid; // promote noise → border
      if (cluster[j] !== -2) continue;
      cluster[j] = cid;
      const nb2 = neighbors(j);
      if (nb2.length + 1 >= minPts) {
        for (const k of nb2) if (cluster[k] === -2) queue.push(k);
      }
    }
    cid++;
  }
  return cluster;
}

/** Build the per-session embedding input. Cheap and fully deterministic. */
function embedInput(s: SessionRow): string {
  const project = s.projects_touched.join(", ") || s.project_id || "";
  const first = (s.first_user_msg ?? "").slice(0, 4096);
  return `PROJECT: ${project}\nTITLE: ${s.title || ""}\nFIRST USER: ${first}`;
}

/**
 * Compute (or refresh) embeddings + UMAP coords for every non-automated
 * session, persist into `session_embedding`, return the layout.
 */
async function buildLayout(
  store: SessionStore,
  cfg: EmbedConfig,
  clusterCfg: { minPts: number; epsScale: number },
  progress: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<{ points: GraphPoint[]; embeddingModel: string; clusterLabels: ClusterLabel[]; clusterMethod: string }> {
  // Decide the model id first by probing (single round-trip). We don't yet
  // know whether Ollama is up; embedMany will probe and pick. To avoid a
  // double-probe, just embed the first session immediately so the returned
  // model id is final, then re-use that string when querying which sessions
  // need embedding.
  const allSessions = store.listRecent(100_000, false); // exclude automated
  if (allSessions.length === 0) {
    return { points: [], embeddingModel: "(none)", clusterLabels: [], clusterMethod: "none" };
  }

  // Try Ollama-or-fallback on the first session so we get the model id.
  progress.report({ message: "Probing embedder…" });
  const seed = await embedMany([{ session_id: allSessions[0].session_id, text: embedInput(allSessions[0]) }], cfg);
  const modelId = seed.model;
  store.upsertEmbedding(seed.results[0].session_id, seed.results[0].embedding, modelId);

  // Find which other sessions still need embedding under this model.
  const missing = store.sessionsMissingEmbedding(modelId);
  const toEmbed = missing.filter((s) => s.session_id !== seed.results[0].session_id);
  if (toEmbed.length > 0) {
    progress.report({ message: `Embedding ${toEmbed.length} sessions via ${modelId}…` });
    const reqs = toEmbed.map((s) => ({ session_id: s.session_id, text: embedInput(s) }));
    const { results } = await embedMany(reqs, cfg, (done, total) => {
      progress.report({
        message: `Embedding ${done}/${total} (${modelId})`,
      });
    });
    for (const r of results) store.upsertEmbedding(r.session_id, r.embedding, modelId);
  }

  // Pull every embedding back and project to 2D.
  progress.report({ message: "Fitting 2D layout (UMAP)…" });
  const all = store.embeddingsByModel(modelId);
  if (all.length === 0) return { points: [], embeddingModel: modelId, clusterLabels: [], clusterMethod: "none" };

  const ids = all.map((e) => e.session_id);
  const vectors = all.map((e) => Array.from(e.embedding));

  // UMAP needs at least n_neighbors+1 rows. Below that just lay them on a
  // line — the graph still works.
  let coords: number[][];
  if (vectors.length < 8) {
    coords = vectors.map((_, i) => [i, 0]);
  } else {
    const umap = new UMAP({
      nNeighbors: Math.min(30, vectors.length - 1),
      minDist: 0.05,
      nComponents: 2,
    });
    coords = umap.fit(vectors);
  }

  // Persist coords
  store.setUmapCoords(
    coords.map((c, i) => ({ session_id: ids[i], x: c[0], y: c[1] })),
    Date.now(),
  );

  // ---- Clustering (DBSCAN in 2D, adaptive eps) -------------------------- //
  // The configured epsScale is the starting point. If that yields zero
  // clusters (common when corpus is small or embeddings are noisy), step
  // eps up until ≥1 cluster forms or we hit 0.30 of the axis range.
  progress.report({ message: "Clustering…" });
  let minXc = Infinity, maxXc = -Infinity, minYc = Infinity, maxYc = -Infinity;
  for (const c of coords) {
    if (c[0] < minXc) minXc = c[0]; if (c[0] > maxXc) maxXc = c[0];
    if (c[1] < minYc) minYc = c[1]; if (c[1] > maxYc) maxYc = c[1];
  }
  const spanX = Math.max(1e-6, maxXc - minXc);
  const spanY = Math.max(1e-6, maxYc - minYc);
  const axisSpan = Math.max(spanX, spanY);
  const pts2d = coords.map((c) => ({ x: c[0], y: c[1] }));
  let clusters: number[] = coords.map(() => -1);
  let clusterMethod = "none";
  if (coords.length >= clusterCfg.minPts) {
    const scales = [clusterCfg.epsScale, clusterCfg.epsScale * 1.5, clusterCfg.epsScale * 2, clusterCfg.epsScale * 3, clusterCfg.epsScale * 5];
    for (const s of scales) {
      if (s > 0.30) break;
      const trial = dbscan2d(pts2d, s * axisSpan, clusterCfg.minPts);
      const clusterCount = new Set(trial.filter((c) => c >= 0)).size;
      if (clusterCount >= 2) {
        clusters = trial;
        clusterMethod = `dbscan (eps=${(s * axisSpan).toFixed(3)})`;
        break;
      }
    }
  }
  // Fallback: if DBSCAN can't find ≥2 clusters (common with small, diverse
  // corpora — points spread evenly across UMAP), force k-means so the user
  // sees at least *some* structure.
  const dbscanClusterCount = new Set(clusters.filter((c) => c >= 0)).size;
  if (dbscanClusterCount < 2 && coords.length >= 6) {
    const k = Math.max(3, Math.min(8, Math.round(Math.sqrt(coords.length / 2))));
    clusters = kmeans2d(pts2d, k);
    clusterMethod = `k-means (k=${k}, fallback)`;
  }
  store.setClusterIds(ids.map((id, i) => ({ session_id: id, cluster_id: clusters[i] })));

  // Build a session_id → SessionRow map for tooltips.
  const sessByid = new Map<string, SessionRow>();
  for (const s of allSessions) sessByid.set(s.session_id, s);

  const points: GraphPoint[] = ids.map((id, i) => {
    const s = sessByid.get(id);
    return {
      session_id: id,
      x: coords[i][0],
      y: coords[i][1],
      title: s?.title || id.slice(0, 8),
      project: s?.project_id ?? null,
      endedAt: s?.ended_at ?? null,
      costUsd: s?.cost_usd ?? 0,
      msgs: s?.message_count ?? 0,
      isAutomated: s?.is_automated ?? false,
      cluster: clusters[i],
    };
  });

  // ---- Cluster labels: most frequent topic_norm per cluster ------------- //
  progress.report({ message: "Labeling clusters…" });
  const byCluster = new Map<number, GraphPoint[]>();
  for (const p of points) {
    if (p.cluster < 0) continue;
    const arr = byCluster.get(p.cluster) ?? [];
    arr.push(p);
    byCluster.set(p.cluster, arr);
  }
  const clusterLabels: ClusterLabel[] = [];
  if (byCluster.size > 0) {
    // Pull topics for every session id in any cluster, in one batch
    const allMemberIds: string[] = [];
    for (const arr of byCluster.values()) for (const p of arr) allMemberIds.push(p.session_id);
    const topicsBySession = store.topTopicsBySession(allMemberIds, 5);
    for (const [cid, arr] of byCluster) {
      if (arr.length < 3) continue;
      let cx = 0, cy = 0;
      const counts = new Map<string, number>();
      for (const p of arr) {
        cx += p.x;
        cy += p.y;
        const t = topicsBySession.get(p.session_id);
        if (!t) continue;
        for (const [topic, n] of t.counts) counts.set(topic, (counts.get(topic) ?? 0) + n);
      }
      cx /= arr.length;
      cy /= arr.length;
      let bestTopic = "";
      let bestN = 0;
      for (const [t, n] of counts) {
        if (n > bestN) { bestTopic = t; bestN = n; }
      }
      const hull = convexHull(arr.map((p) => ({ x: p.x, y: p.y })));
      // Always emit a label/hull for ≥3-member clusters. If no topic data is
      // available (sessions not yet classified), fall back to a synthesized
      // label so the hull still renders and the user can see structure
      // before running "Analyze topics".
      const label = bestTopic
        ? bestTopic
        : (() => {
            // Use the most common project across the cluster as a fallback
            const projCounts = new Map<string, number>();
            for (const p of arr) if (p.project) projCounts.set(p.project, (projCounts.get(p.project) ?? 0) + 1);
            let bp = "", bpN = 0;
            for (const [k, v] of projCounts) if (v > bpN) { bp = k; bpN = v; }
            return bp || `cluster ${cid + 1}`;
          })();
      clusterLabels.push({ cluster: cid, cx, cy, label, count: arr.length, hull });
    }
  }

  return { points, embeddingModel: modelId, clusterLabels, clusterMethod };
}

/** Open the agent-graph webview. */
export async function openAgentGraph(
  ctx: vscode.ExtensionContext,
  store: SessionStore,
  onSessionClick: (sessionId: string) => void,
): Promise<vscode.WebviewPanel> {
  const cfg = vscode.workspace.getConfiguration("claudeSessions");
  const embedCfg: EmbedConfig = {
    preferred: cfg.get<"ollama" | "transformersjs" | "fallback">("embedding.preferred", "ollama"),
    ollamaUrl: cfg.get<string>("embedding.ollamaUrl", "http://127.0.0.1:11434"),
    ollamaModel: cfg.get<string>("embedding.ollamaModel", "nomic-embed-text"),
  };
  const clusterCfg = {
    minPts: cfg.get<number>("cluster.minPts", 5),
    epsScale: cfg.get<number>("cluster.epsScale", 0.04),
  };

  const panel = vscode.window.createWebviewPanel(
    "claudeAgentGraph",
    "Claude · Agent graph",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  // Show a placeholder immediately so the user sees something while we work.
  panel.webview.html = placeholderHtml(panel.webview);

  let built: { points: GraphPoint[]; embeddingModel: string; clusterLabels: ClusterLabel[]; clusterMethod: string };
  try {
    built = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Building agent graph",
        cancellable: false,
      },
      async (progress) => buildLayout(store, embedCfg, clusterCfg, progress),
    );
  } catch (e: any) {
    panel.webview.html = errorHtml(panel.webview, e?.message || String(e));
    return panel;
  }

  panel.webview.html = graphHtml(panel.webview, built.points, built.clusterLabels, built.embeddingModel, built.clusterMethod);

  panel.webview.onDidReceiveMessage((msg) => {
    if (msg?.command === "open" && typeof msg.id === "string") {
      onSessionClick(msg.id);
    }
  });

  return panel;
}

function nonceStr(): string {
  let s = "";
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += charset[Math.floor(Math.random() * charset.length)];
  return s;
}

function placeholderHtml(webview: vscode.Webview): string {
  return `<!doctype html><html><body style="font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 32px;">
    <h2>Building agent graph…</h2>
    <p>This embeds every non-automated session and projects them into a 2-D layout. Watch the notification bar.</p>
  </body></html>`;
}

function errorHtml(webview: vscode.Webview, msg: string): string {
  return `<!doctype html><html><body style="font-family: var(--vscode-font-family); color: var(--vscode-errorForeground); background: var(--vscode-editor-background); padding: 32px;">
    <h2>Agent graph failed</h2>
    <pre>${escapeHtml(msg)}</pre>
  </body></html>`;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function graphHtml(webview: vscode.Webview, points: GraphPoint[], clusterLabels: ClusterLabel[], modelId: string, clusterMethod: string): string {
  const nonce = nonceStr();
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join("; ");

  const data = JSON.stringify(points);
  const labelsData = JSON.stringify(clusterLabels);

  return `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); margin: 0; padding: 12px 16px; overflow: hidden; }
  header { display: flex; gap: 16px; align-items: baseline; margin-bottom: 8px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 16px; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .toolbar { margin-left: auto; display: flex; gap: 6px; align-items: center; }
  .toolbar label { font-size: 11px; color: var(--vscode-descriptionForeground); user-select: none; }
  #wrap { position: relative; width: 100vw; height: calc(100vh - 60px); }
  canvas { display: block; width: 100%; height: 100%; cursor: crosshair; }
  #tip { position: absolute; pointer-events: none; padding: 4px 8px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 3px; font-size: 11px; max-width: 320px; white-space: pre-wrap; display: none; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
</style>
</head>
<body>
<header>
  <h1>Agent graph</h1>
  <span class="sub">${points.length} sessions · ${clusterLabels.length} clusters via ${escapeHtml(clusterMethod)} · embedder: ${escapeHtml(modelId)} · hover for details · click to open</span>
  <span class="toolbar">
    <label><input type="checkbox" id="colorByCluster" checked> color by cluster</label>
    <label><input type="checkbox" id="showLabels" checked> cluster labels</label>
  </span>
</header>
<div id="wrap">
  <canvas id="c"></canvas>
  <div id="tip"></div>
</div>
<script nonce="${nonce}">
(function() {
  const data = ${data};
  const labels = ${labelsData};
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('c');
  const tip = document.getElementById('tip');
  const cbCluster = document.getElementById('colorByCluster');
  const cbLabels = document.getElementById('showLabels');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0;
  const PAD = 24;
  // 12-color qualitative palette (theme-agnostic, decent contrast on dark+light)
  const PALETTE = ['#e57373','#81c784','#64b5f6','#ffb74d','#ba68c8','#4db6ac','#f06292','#9575cd','#aed581','#7986cb','#ffd54f','#a1887f'];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of data) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  if (!isFinite(minX)) { minX = 0; maxX = 1; minY = 0; maxY = 1; }
  if (minX === maxX) maxX = minX + 1;
  if (minY === maxY) maxY = minY + 1;

  let now = Date.now();
  function ageColor(endedAt) {
    if (!endedAt) return '#888';
    const ageDays = (now - endedAt) / 86400000;
    if (ageDays < 1) return '#3ecf8e';
    if (ageDays < 7) return '#5aa9ff';
    if (ageDays < 30) return '#b08bff';
    return '#888';
  }
  function clusterColor(c) {
    if (c < 0) return '#888';
    return PALETTE[c % PALETTE.length];
  }

  function project(p) {
    const sx = PAD + ((p.x - minX) / (maxX - minX)) * (W - 2 * PAD);
    const sy = PAD + ((p.y - minY) / (maxY - minY)) * (H - 2 * PAD);
    return [sx, sy];
  }

  // Screen-space label positions (recomputed every layout()).
  // Each entry holds: cluster id, anchor (centroid in screen px), pos (placed
  // position), size (text bbox). Force layout runs once per draw().
  let labelPlaced = [];
  let focusedCluster = null;

  function measureLabelText(text) {
    ctx.font = '11px var(--vscode-font-family)';
    return ctx.measureText(text).width;
  }

  function placeLabels() {
    labelPlaced = labels.map(l => {
      const [ax, ay] = project({ x: l.cx, y: l.cy });
      const text = l.label + ' · ' + l.count;
      const w = measureLabelText(text) + 8;
      const h = 14;
      return {
        cluster: l.cluster,
        text,
        ax, ay,                  // anchor (centroid)
        x: ax, y: ay - 10,       // current position (top-left of bbox)
        w, h,
      };
    });
    if (labelPlaced.length < 2) return;
    const MAX_ITER = 20;
    for (let it = 0; it < MAX_ITER; it++) {
      let moved = 0;
      for (let i = 0; i < labelPlaced.length; i++) {
        const a = labelPlaced[i];
        let fx = 0, fy = 0;
        for (let j = 0; j < labelPlaced.length; j++) {
          if (i === j) continue;
          const b = labelPlaced[j];
          // bbox-overlap repulsion (axis-aligned)
          const dx = (a.x + a.w / 2) - (b.x + b.w / 2);
          const dy = (a.y + a.h / 2) - (b.y + b.h / 2);
          const overlapX = (a.w + b.w) / 2 - Math.abs(dx);
          const overlapY = (a.h + b.h) / 2 - Math.abs(dy);
          if (overlapX > 0 && overlapY > 0) {
            // push along the smaller-overlap axis
            if (overlapX < overlapY) {
              fx += (dx === 0 ? 1 : Math.sign(dx)) * (overlapX + 1) * 0.5;
            } else {
              fy += (dy === 0 ? 1 : Math.sign(dy)) * (overlapY + 1) * 0.5;
            }
          }
        }
        // gentle pull back toward anchor
        fx += ((a.ax) - (a.x + a.w / 2)) * 0.04;
        fy += ((a.ay - 10) - (a.y)) * 0.04;
        a.x += fx;
        a.y += fy;
        moved += Math.abs(fx) + Math.abs(fy);
      }
      if (moved < 0.5) break;
    }
  }

  function pointInPolygon(mx, my, hull) {
    // ray-cast in screen space; hull verts are in DATA space → project them
    let inside = false;
    for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
      const [xi, yi] = project(hull[i]);
      const [xj, yj] = project(hull[j]);
      const intersect = ((yi > my) !== (yj > my)) &&
        (mx < (xj - xi) * (my - yi) / ((yj - yi) || 1e-9) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function hitTestHull(mx, my) {
    for (const lbl of labels) {
      if (lbl.hull && lbl.hull.length >= 3 && pointInPolygon(mx, my, lbl.hull)) return lbl.cluster;
    }
    return null;
  }

  function hitTestLabel(mx, my) {
    for (const lp of labelPlaced) {
      if (mx >= lp.x && mx <= lp.x + lp.w && my >= lp.y && my <= lp.y + lp.h) return lp.cluster;
    }
    return null;
  }

  function bgColor() {
    return getComputedStyle(document.body).backgroundColor || '#1e1e1e';
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const useCluster = cbCluster.checked;

    // --- Hulls (behind dots) ---
    if (useCluster) {
      for (const lbl of labels) {
        if (!lbl.hull || lbl.hull.length < 3) continue;
        const dim = focusedCluster != null && focusedCluster !== lbl.cluster;
        ctx.fillStyle = clusterColor(lbl.cluster);
        ctx.strokeStyle = clusterColor(lbl.cluster);
        ctx.beginPath();
        for (let i = 0; i < lbl.hull.length; i++) {
          const [hx, hy] = project(lbl.hull[i]);
          if (i === 0) ctx.moveTo(hx, hy); else ctx.lineTo(hx, hy);
        }
        ctx.closePath();
        ctx.globalAlpha = dim ? 0.04 : 0.12;
        ctx.fill();
        ctx.globalAlpha = dim ? 0.15 : 0.4;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // --- Dots ---
    for (const p of data) {
      const [sx, sy] = project(p);
      ctx.fillStyle = useCluster ? clusterColor(p.cluster) : ageColor(p.endedAt);
      let alpha;
      if (focusedCluster != null) {
        alpha = p.cluster === focusedCluster ? 0.95 : 0.25;
      } else {
        alpha = p.cluster < 0 && useCluster ? 0.35 : 0.78;
      }
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(sx, sy, 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // --- Labels (force-placed) ---
    if (cbLabels.checked && useCluster && labelPlaced.length > 0) {
      ctx.font = '11px var(--vscode-font-family)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const bg = bgColor();
      for (const lp of labelPlaced) {
        const dim = focusedCluster != null && focusedCluster !== lp.cluster;
        ctx.globalAlpha = dim ? 0.25 : 0.95;
        // leader line if label moved noticeably off its anchor
        const dx = (lp.x + lp.w / 2) - lp.ax;
        const dy = (lp.y + lp.h / 2) - (lp.ay - 10);
        const offset = Math.sqrt(dx * dx + dy * dy);
        if (offset > 12) {
          ctx.strokeStyle = clusterColor(lp.cluster);
          ctx.globalAlpha = dim ? 0.15 : 0.45;
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(lp.ax, lp.ay);
          ctx.lineTo(lp.x + lp.w / 2, lp.y + lp.h / 2);
          ctx.stroke();
          ctx.globalAlpha = dim ? 0.25 : 0.95;
        }
        // halo
        ctx.strokeStyle = bg;
        ctx.lineWidth = 3;
        ctx.strokeText(lp.text, lp.x + 4, lp.y + 1);
        ctx.fillStyle = clusterColor(lp.cluster);
        ctx.fillText(lp.text, lp.x + 4, lp.y + 1);
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }
  }

  function relayoutAndDraw() {
    placeLabels();
    draw();
  }

  cbCluster.addEventListener('change', relayoutAndDraw);
  cbLabels.addEventListener('change', relayoutAndDraw);

  function findNear(mx, my) {
    let best = null, bestD2 = 64; // ~8 px radius
    for (const p of data) {
      const [sx, sy] = project(p);
      const d2 = (sx - mx) * (sx - mx) + (sy - my) * (sy - my);
      if (d2 < bestD2) { bestD2 = d2; best = p; }
    }
    return best;
  }

  function placeTip(mx, my) {
    const wrap = document.getElementById('wrap');
    const wrapRect = wrap.getBoundingClientRect();
    tip.style.display = 'block';
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = mx + 12;
    let top = my + 12;
    if (left + tw + 8 > wrapRect.width) left = Math.max(4, mx - tw - 12);
    if (top + th + 8 > wrapRect.height) top = Math.max(4, my - th - 12);
    if (left < 4) left = 4;
    if (top < 4) top = 4;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const p = findNear(mx, my);
    if (p) {
      const cost = p.costUsd ? '$' + p.costUsd.toFixed(2) : '\$0';
      const proj = p.project ? p.project : '(no project)';
      tip.textContent = p.title + '\\n' + proj + ' · ' + p.msgs + ' msgs · ' + cost;
      placeTip(mx, my);
      canvas.style.cursor = 'pointer';
    } else {
      tip.style.display = 'none';
      const hit = hitTestLabel(mx, my) ?? hitTestHull(mx, my);
      canvas.style.cursor = hit != null ? 'pointer' : 'crosshair';
    }
  });
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const p = findNear(mx, my);
    if (p) {
      vscode.postMessage({ command: 'open', id: p.session_id });
      return;
    }
    const cid = hitTestLabel(mx, my) ?? hitTestHull(mx, my);
    if (cid != null) {
      focusedCluster = focusedCluster === cid ? null : cid;
    } else {
      focusedCluster = null;
    }
    draw();
  });
  window.addEventListener('resize', relayoutAndDraw);
  relayoutAndDraw();
})();
</script>
</body></html>`;
}
