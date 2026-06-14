// 2D agent graph: embedding → UMAP → Canvas scatter.
//
// Phase 1C of v0.7.0. The graph is computed lazily when the user opens it,
// then cached: subsequent opens skip embedding for sessions that already have
// one stored under the same `embedding_model`.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { preferredEditorColumn } from "./editorColumn";
import { UMAP } from "umap-js";
import { SessionStore, SessionRow } from "./db";
import { embedMany, EmbedConfig } from "./embedding";
import { classifySession } from "./topicClassifier";

interface GraphPoint {
  session_id: string;
  /** 2D UMAP coords for the canvas scatter. */
  x: number;
  y: number;
  /** 3D UMAP coords (independent run; do not mix with x/y). */
  x3: number;
  y3: number;
  z3: number;
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
  cx3: number;
  cy3: number;
  cz3: number;
  label: string;
  count: number;
  hull: Array<{ x: number; y: number }>;
  /** Top topics in this cluster, ranked by turn count. */
  topics: Array<{ topic: string; count: number }>;
  /** Most-common project ids in this cluster. */
  projects: Array<{ name: string; count: number }>;
  /** Representative session titles (closest sessions to the 2D centroid). */
  samples: Array<{ session_id: string; title: string }>;
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
  let coords3: number[][];
  if (vectors.length < 8) {
    coords = vectors.map((_, i) => [i, 0]);
    coords3 = vectors.map((_, i) => [i, 0, 0]);
  } else {
    const umap = new UMAP({
      nNeighbors: Math.min(30, vectors.length - 1),
      minDist: 0.05,
      nComponents: 2,
    });
    coords = umap.fit(vectors);
    progress.report({ message: "Embedding (3D)…" });
    const umap3 = new UMAP({
      nNeighbors: Math.min(30, vectors.length - 1),
      minDist: 0.05,
      nComponents: 3,
    });
    coords3 = umap3.fit(vectors);
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
      x3: coords3[i][0] ?? 0,
      y3: coords3[i][1] ?? 0,
      z3: coords3[i][2] ?? 0,
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
      let cx = 0, cy = 0, cx3 = 0, cy3 = 0, cz3 = 0;
      const counts = new Map<string, number>();
      for (const p of arr) {
        cx += p.x;
        cy += p.y;
        cx3 += p.x3;
        cy3 += p.y3;
        cz3 += p.z3;
        const t = topicsBySession.get(p.session_id);
        if (!t) continue;
        for (const [topic, n] of t.counts) counts.set(topic, (counts.get(topic) ?? 0) + n);
      }
      cx /= arr.length;
      cy /= arr.length;
      cx3 /= arr.length;
      cy3 /= arr.length;
      cz3 /= arr.length;
      let bestTopic = "";
      let bestN = 0;
      for (const [t, n] of counts) {
        if (n > bestN) { bestTopic = t; bestN = n; }
      }
      const hull = convexHull(arr.map((p) => ({ x: p.x, y: p.y })));
      // Project mix across the cluster.
      const projCounts = new Map<string, number>();
      for (const p of arr) if (p.project) projCounts.set(p.project, (projCounts.get(p.project) ?? 0) + 1);
      const projects = [...projCounts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
      // Always emit a label/hull for ≥3-member clusters. If no topic data is
      // available (sessions not yet classified), fall back to a synthesized
      // label so the hull still renders and the user can see structure
      // before running "Analyze topics".
      const label = bestTopic
        ? bestTopic
        : (projects[0]?.name ?? `cluster ${cid + 1}`);
      // Top-N topics for the cluster meaning panel.
      const topics = [...counts.entries()]
        .map(([topic, count]) => ({ topic, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);
      // Representative samples: members closest to the 2D centroid.
      const samples = arr
        .map((p) => ({
          session_id: p.session_id,
          title: p.title,
          d2: (p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy),
        }))
        .sort((a, b) => a.d2 - b.d2)
        .slice(0, 5)
        .map(({ session_id, title }) => ({ session_id, title }));
      clusterLabels.push({
        cluster: cid, cx, cy, cx3, cy3, cz3,
        label, count: arr.length, hull,
        topics, projects, samples,
      });
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
  const cfg = vscode.workspace.getConfiguration("codeSessions");
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
    preferredEditorColumn(),
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

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.command === "open" && typeof msg.id === "string") {
      onSessionClick(msg.id);
      return;
    }
    if (msg?.command === "classifyAll") {
      const cCfg = vscode.workspace.getConfiguration("codeSessions");
      const backend = cCfg.get<"ollama" | "claude-p">("classify.backend", "ollama");
      const model = cCfg.get<string>("classify.model", "llama3.2:3b");
      const batchSize = cCfg.get<number>("classify.batchSize", 20);
      const claudeBin = cCfg.get<string>("classify.claudeBin", "") || undefined;
      const ollamaUrl = cCfg.get<string>("embedding.ollamaUrl", "http://127.0.0.1:11434");

      const ids = built.points.map((p) => p.session_id);
      let totalClassified = 0;
      const errors: string[] = [];

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Classifying ${ids.length} sessions (${backend}/${model})…`,
          cancellable: true,
        },
        async (progress, token) => {
          let done = 0;
          for (const id of ids) {
            if (token.isCancellationRequested) break;
            done++;
            progress.report({ message: `${done}/${ids.length}` });
            try {
              const res = await classifySession(store, id, {
                backend,
                model,
                batchSize,
                claudeBin,
                ollamaUrl,
              });
              totalClassified += res.classified;
              if (res.errors.length) errors.push(...res.errors);
              if (res.errors.some((e) => /rate.?limit|usage.?cap/i.test(e))) break;
            } catch (e: any) {
              errors.push(String(e?.message ?? e));
            }
          }
        },
      );

      // Rebuild layout + re-render so the new topics flow into cluster labels.
      try {
        built = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Rebuilding agent graph",
            cancellable: false,
          },
          async (progress) => buildLayout(store, embedCfg, clusterCfg, progress),
        );
        panel.webview.html = graphHtml(
          panel.webview,
          built.points,
          built.clusterLabels,
          built.embeddingModel,
          built.clusterMethod,
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(`Rebuild after classification failed: ${e.message}`);
      }

      const summary = `Classified ${totalClassified} new turns across ${ids.length} sessions.`;
      if (errors.length) {
        vscode.window.showWarningMessage(`${summary} ${errors.length} warnings. First: ${errors[0].slice(0, 200)}`);
      } else {
        vscode.window.showInformationMessage(summary);
      }
      return;
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
  .toolbar button { font: 11px var(--vscode-font-family); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 1px 8px; cursor: pointer; min-width: 22px; }
  .toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.15))); }
  .toolbar button.modeBtn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  #wrap { position: relative; width: 100vw; height: calc(100vh - 60px); }
  canvas { display: block; width: 100%; height: 100%; cursor: crosshair; }
  #tip { position: absolute; pointer-events: none; padding: 4px 8px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 3px; font-size: 11px; max-width: 320px; white-space: pre-wrap; display: none; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
  #cinfo { position: absolute; top: 12px; right: 12px; width: 280px; max-height: calc(100vh - 100px); overflow-y: auto; padding: 10px 12px 12px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; font-size: 11px; display: none; box-shadow: 0 4px 16px rgba(0,0,0,0.35); }
  #cinfo h3 { margin: 0 0 6px; font-size: 13px; }
  #cinfo .row { color: var(--vscode-descriptionForeground); margin-top: 8px; font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; }
  #cinfo ul { margin: 4px 0 0; padding: 0; list-style: none; }
  #cinfo li { padding: 2px 0; line-height: 1.4; }
  #cinfo li .meta { color: var(--vscode-descriptionForeground); margin-left: 4px; }
  #cinfo a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  #cinfo a:hover { text-decoration: underline; }
  #cinfo .close { position: absolute; top: 4px; right: 6px; cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 13px; padding: 2px 6px; border-radius: 2px; }
  #cinfo .close:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.15)); color: var(--vscode-editor-foreground); }
  #cinfo .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  #cinfo .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding-top: 2px; }
</style>
</head>
<body>
<header>
  <h1>Agent graph</h1>
  <span class="sub">${points.length} sessions · ${clusterLabels.length} clusters via ${escapeHtml(clusterMethod)} · embedder: ${escapeHtml(modelId)} · hover for details · click to open</span>
  <span class="toolbar">
    <button id="mode2d" class="modeBtn active" title="2D scatter">2D</button>
    <button id="mode3d" class="modeBtn" title="3D scatter — drag to orbit, wheel to zoom">3D</button>
    <label><input type="checkbox" id="colorByCluster" checked> color by cluster</label>
    <label><input type="checkbox" id="showLabels" checked> cluster labels</label>
    <button id="zoomOut" title="Zoom out (or scroll down on the graph)">−</button>
    <button id="zoomIn" title="Zoom in (or scroll up on the graph)">+</button>
    <button id="resetView" title="Reset view (or double-click the graph)">reset</button>
    <button id="classifyAll" title="Run topic classification across every session in this graph, then rebuild clusters">Classify all topics</button>
  </span>
</header>
<div id="wrap">
  <canvas id="c"></canvas>
  <div id="tip"></div>
  <div id="cinfo"></div>
</div>
<script nonce="${nonce}">
(function() {
  const data = ${data};
  const labels = ${labelsData};
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('c');
  const tip = document.getElementById('tip');
  const cinfo = document.getElementById('cinfo');
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

  // Screen-space view transform applied on top of the base data→pixel mapping.
  // (scale, tx, ty) lets the user wheel-zoom about the cursor and drag-pan.
  let viewScale = 1, viewTx = 0, viewTy = 0;
  const MIN_SCALE = 0.2, MAX_SCALE = 40;

  // ---- 3D state ---- //
  let mode = '2d'; // '2d' | '3d'
  // Compute 3D extents once (data → normalized cube)
  let x3Min = Infinity, x3Max = -Infinity, y3Min = Infinity, y3Max = -Infinity, z3Min = Infinity, z3Max = -Infinity;
  for (const p of data) {
    if (p.x3 < x3Min) x3Min = p.x3; if (p.x3 > x3Max) x3Max = p.x3;
    if (p.y3 < y3Min) y3Min = p.y3; if (p.y3 > y3Max) y3Max = p.y3;
    if (p.z3 < z3Min) z3Min = p.z3; if (p.z3 > z3Max) z3Max = p.z3;
  }
  if (!isFinite(x3Min)) { x3Min = 0; x3Max = 1; y3Min = 0; y3Max = 1; z3Min = 0; z3Max = 1; }
  if (x3Min === x3Max) x3Max = x3Min + 1;
  if (y3Min === y3Max) y3Max = y3Min + 1;
  if (z3Min === z3Max) z3Max = z3Min + 1;

  // Orbit camera: yaw around world-Y, pitch around camera-X, dolly via camDist.
  // pan3X/pan3Y shift the projected image; do not change the orbit center.
  let yaw = 0.6, pitch = 0.35, camDist = 3.0, pan3X = 0, pan3Y = 0;
  const FOV = (45 * Math.PI) / 180;
  function resetCamera3d() { yaw = 0.6; pitch = 0.35; camDist = 3.0; pan3X = 0; pan3Y = 0; }

  function baseProject(p) {
    const sx = PAD + ((p.x - minX) / (maxX - minX)) * (W - 2 * PAD);
    const sy = PAD + ((p.y - minY) / (maxY - minY)) * (H - 2 * PAD);
    return [sx, sy];
  }
  function project2(p) {
    const [bx, by] = baseProject(p);
    return [bx * viewScale + viewTx, by * viewScale + viewTy];
  }
  // 3D project: returns [sx, sy, depth] in screen px (or NaN behind camera).
  function project3(x3, y3, z3) {
    const nx = ((x3 - x3Min) / (x3Max - x3Min)) * 2 - 1;
    const ny = ((y3 - y3Min) / (y3Max - y3Min)) * 2 - 1;
    const nz = ((z3 - z3Min) / (z3Max - z3Min)) * 2 - 1;
    // Yaw around Y
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const x1 = nx * cy + nz * sy;
    const z1 = -nx * sy + nz * cy;
    // Pitch around X
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const y2 = ny * cp - z1 * sp;
    const z2 = ny * sp + z1 * cp;
    const zcam = camDist + z2;
    if (zcam < 0.05) return [NaN, NaN, zcam];
    const f = (Math.min(W, H) * 0.5) / Math.tan(FOV * 0.5);
    const sxp = W * 0.5 + (x1 * f) / zcam + pan3X;
    const syp = H * 0.5 - (y2 * f) / zcam + pan3Y;
    return [sxp, syp, zcam];
  }
  function project(p) {
    if (mode === '3d') {
      const [sx, sy] = project3(p.x3, p.y3, p.z3);
      return [sx, sy];
    }
    return project2(p);
  }
  function zoomAt(cx, cy, factor) {
    if (mode === '3d') {
      camDist = Math.max(0.4, Math.min(20, camDist / factor));
      return;
    }
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, viewScale * factor));
    const k = next / viewScale;
    viewTx = cx - (cx - viewTx) * k;
    viewTy = cy - (cy - viewTy) * k;
    viewScale = next;
  }
  function resetView() {
    if (mode === '3d') { resetCamera3d(); return; }
    viewScale = 1; viewTx = 0; viewTy = 0;
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
    if (mode === '3d') { draw3d(useCluster); return; }

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

  function draw3d(useCluster) {
    // Project every point, then painter-sort back-to-front by depth.
    const proj = new Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const p = data[i];
      const [sx, sy, depth] = project3(p.x3, p.y3, p.z3);
      proj[i] = { idx: i, sx, sy, depth };
    }
    proj.sort((a, b) => b.depth - a.depth);
    // Distance-based size cue (closer dots are slightly larger)
    const baseR = 3.4;
    for (const q of proj) {
      if (!isFinite(q.sx)) continue;
      const p = data[q.idx];
      ctx.fillStyle = useCluster ? clusterColor(p.cluster) : ageColor(p.endedAt);
      let alpha;
      if (focusedCluster != null) {
        alpha = p.cluster === focusedCluster ? 0.95 : 0.2;
      } else {
        alpha = p.cluster < 0 && useCluster ? 0.32 : 0.82;
      }
      ctx.globalAlpha = alpha;
      const r = Math.max(1.6, Math.min(5.5, baseR * (3.0 / Math.max(0.6, q.depth))));
      ctx.beginPath();
      ctx.arc(q.sx, q.sy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Labels: anchored at projected 3D centroid (no force-layout in 3D).
    if (cbLabels.checked && useCluster && labels.length > 0) {
      ctx.font = '11px var(--vscode-font-family)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const bg = bgColor();
      // Sort labels by depth so nearer text wins overlap.
      const lp = labels.map((l) => {
        const [sx, sy, depth] = project3(l.cx3, l.cy3, l.cz3);
        return { l, sx, sy, depth };
      }).sort((a, b) => b.depth - a.depth);
      for (const e of lp) {
        if (!isFinite(e.sx)) continue;
        const dim = focusedCluster != null && focusedCluster !== e.l.cluster;
        ctx.globalAlpha = dim ? 0.25 : 0.95;
        const text = e.l.label + ' · ' + e.l.count;
        ctx.strokeStyle = bg;
        ctx.lineWidth = 3;
        ctx.strokeText(text, e.sx + 6, e.sy - 6);
        ctx.fillStyle = clusterColor(e.l.cluster);
        ctx.fillText(text, e.sx + 6, e.sy - 6);
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }
  }

  function relayoutAndDraw() {
    if (mode === '2d') placeLabels();
    draw();
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function setClusterInfo(cid) {
    if (cid == null) { cinfo.style.display = 'none'; cinfo.innerHTML = ''; return; }
    const lbl = labels.find((l) => l.cluster === cid);
    if (!lbl) { cinfo.style.display = 'none'; return; }
    const col = clusterColor(cid);
    const topicRows = (lbl.topics || []).length === 0
      ? '<li class="empty">No topics yet — click "Classify all topics" to label.</li>'
      : (lbl.topics || []).map((t) => '<li>' + escHtml(t.topic) + '<span class="meta">· ' + t.count + '</span></li>').join('');
    const projRows = (lbl.projects || []).length === 0
      ? '<li class="empty">(no project tags)</li>'
      : (lbl.projects || []).map((p) => '<li>' + escHtml(p.name) + '<span class="meta">· ' + p.count + '</span></li>').join('');
    const sampleRows = (lbl.samples || []).length === 0
      ? '<li class="empty">—</li>'
      : (lbl.samples || []).map((s) => '<li><a data-sid="' + escHtml(s.session_id) + '">' + escHtml(s.title) + '</a></li>').join('');
    cinfo.innerHTML =
      '<div class="close" id="cinfoClose" title="Clear selection">×</div>' +
      '<h3><span class="dot" style="background:' + col + '"></span>' + escHtml(lbl.label) + '</h3>' +
      '<div class="meta">' + lbl.count + ' sessions in this cluster</div>' +
      '<div class="row">Top topics</div><ul>' + topicRows + '</ul>' +
      '<div class="row">Projects</div><ul>' + projRows + '</ul>' +
      '<div class="row">Representative sessions</div><ul>' + sampleRows + '</ul>';
    cinfo.style.display = 'block';
    document.getElementById('cinfoClose').addEventListener('click', () => {
      focusedCluster = null;
      setClusterInfo(null);
      relayoutAndDraw();
    });
    cinfo.querySelectorAll('a[data-sid]').forEach((a) => {
      a.addEventListener('click', () => {
        vscode.postMessage({ command: 'open', id: a.getAttribute('data-sid') });
      });
    });
  }

  cbCluster.addEventListener('change', relayoutAndDraw);
  cbLabels.addEventListener('change', relayoutAndDraw);

  function findNear(mx, my) {
    let best = null, bestD2 = 64; // ~8 px radius
    for (const p of data) {
      const [sx, sy] = project(p);
      if (!isFinite(sx)) continue;
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

  // --- Drag state (panning in 2D, orbiting in 3D) ---
  let panning = false;
  let panStartX = 0, panStartY = 0;
  let panBaseTx = 0, panBaseTy = 0;
  let panBaseYaw = 0, panBasePitch = 0;
  let panMoved = 0; // pixels moved during current gesture (to suppress click)

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    panning = true;
    panMoved = 0;
    const rect = canvas.getBoundingClientRect();
    panStartX = e.clientX - rect.left;
    panStartY = e.clientY - rect.top;
    if (mode === '3d') {
      panBaseYaw = yaw;
      panBasePitch = pitch;
    } else {
      panBaseTx = viewTx;
      panBaseTy = viewTy;
    }
    canvas.style.cursor = 'grabbing';
  });
  window.addEventListener('mouseup', () => {
    if (!panning) return;
    panning = false;
    canvas.style.cursor = 'grab';
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (panning) {
      const dx = mx - panStartX;
      const dy = my - panStartY;
      panMoved = Math.max(panMoved, Math.abs(dx) + Math.abs(dy));
      if (mode === '3d') {
        yaw = panBaseYaw + dx * 0.01;
        const HALF = Math.PI * 0.5 - 0.05;
        pitch = Math.max(-HALF, Math.min(HALF, panBasePitch + dy * 0.01));
      } else {
        viewTx = panBaseTx + dx;
        viewTy = panBaseTy + dy;
      }
      tip.style.display = 'none';
      relayoutAndDraw();
      return;
    }
    const p = findNear(mx, my);
    if (p) {
      const cost = p.costUsd ? '$' + p.costUsd.toFixed(2) : '\$0';
      const proj = p.project ? p.project : '(no project)';
      tip.textContent = p.title + '\\n' + proj + ' · ' + p.msgs + ' msgs · ' + cost;
      placeTip(mx, my);
      canvas.style.cursor = 'pointer';
    } else {
      tip.style.display = 'none';
      const hit = mode === '2d' ? (hitTestLabel(mx, my) ?? hitTestHull(mx, my)) : null;
      canvas.style.cursor = hit != null ? 'pointer' : 'grab';
    }
  });
  canvas.addEventListener('click', (e) => {
    if (panMoved > 4) { panMoved = 0; return; } // it was a drag, not a click
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const p = findNear(mx, my);
    if (p) {
      vscode.postMessage({ command: 'open', id: p.session_id });
      return;
    }
    // Hull/label hit-testing is 2D-only (no hulls drawn in 3D mode).
    const cid = mode === '2d' ? (hitTestLabel(mx, my) ?? hitTestHull(mx, my)) : null;
    if (cid != null) {
      focusedCluster = focusedCluster === cid ? null : cid;
    } else {
      focusedCluster = null;
    }
    setClusterInfo(focusedCluster);
    draw();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // trackpad pinch + wheel scrolls: e.deltaY is pixels; use multiplicative step
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomAt(mx, my, factor);
    relayoutAndDraw();
  }, { passive: false });
  canvas.addEventListener('dblclick', () => {
    resetView();
    relayoutAndDraw();
  });
  document.getElementById('zoomIn').addEventListener('click', () => {
    zoomAt(W / 2, H / 2, 1.25);
    relayoutAndDraw();
  });
  document.getElementById('zoomOut').addEventListener('click', () => {
    zoomAt(W / 2, H / 2, 1 / 1.25);
    relayoutAndDraw();
  });
  document.getElementById('resetView').addEventListener('click', () => {
    resetView();
    relayoutAndDraw();
  });
  const classifyBtn = document.getElementById('classifyAll');
  classifyBtn.addEventListener('click', () => {
    classifyBtn.disabled = true;
    classifyBtn.textContent = 'Classifying…';
    vscode.postMessage({ command: 'classifyAll' });
  });
  const btn2d = document.getElementById('mode2d');
  const btn3d = document.getElementById('mode3d');
  function setMode(m) {
    if (m === mode) return;
    mode = m;
    btn2d.classList.toggle('active', mode === '2d');
    btn3d.classList.toggle('active', mode === '3d');
    focusedCluster = null;
    setClusterInfo(null);
    tip.style.display = 'none';
    relayoutAndDraw();
  }
  btn2d.addEventListener('click', () => setMode('2d'));
  btn3d.addEventListener('click', () => setMode('3d'));
  // External command channel — used by the keybinding to flip 2D ↔ 3D.
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.command === 'setMode' && (m.mode === '2d' || m.mode === '3d')) setMode(m.mode);
    else if (m.command === 'toggleMode') setMode(mode === '2d' ? '3d' : '2d');
  });
  canvas.style.cursor = 'grab';
  window.addEventListener('resize', relayoutAndDraw);
  relayoutAndDraw();
})();
</script>
</body></html>`;
}
