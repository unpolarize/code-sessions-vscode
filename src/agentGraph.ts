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
): Promise<{ points: GraphPoint[]; embeddingModel: string; clusterLabels: ClusterLabel[] }> {
  // Decide the model id first by probing (single round-trip). We don't yet
  // know whether Ollama is up; embedMany will probe and pick. To avoid a
  // double-probe, just embed the first session immediately so the returned
  // model id is final, then re-use that string when querying which sessions
  // need embedding.
  const allSessions = store.listRecent(100_000, false); // exclude automated
  if (allSessions.length === 0) {
    return { points: [], embeddingModel: "(none)", clusterLabels: [] };
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
  if (all.length === 0) return { points: [], embeddingModel: modelId, clusterLabels: [] };

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

  // ---- Clustering (DBSCAN in 2D) ---------------------------------------- //
  progress.report({ message: "Clustering…" });
  let minXc = Infinity, maxXc = -Infinity, minYc = Infinity, maxYc = -Infinity;
  for (const c of coords) {
    if (c[0] < minXc) minXc = c[0]; if (c[0] > maxXc) maxXc = c[0];
    if (c[1] < minYc) minYc = c[1]; if (c[1] > maxYc) maxYc = c[1];
  }
  const spanX = Math.max(1e-6, maxXc - minXc);
  const spanY = Math.max(1e-6, maxYc - minYc);
  const eps = clusterCfg.epsScale * Math.max(spanX, spanY);
  const clusters =
    coords.length >= clusterCfg.minPts
      ? dbscan2d(
          coords.map((c) => ({ x: c[0], y: c[1] })),
          eps,
          clusterCfg.minPts,
        )
      : coords.map(() => -1);
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
      if (bestTopic) {
        clusterLabels.push({ cluster: cid, cx, cy, label: bestTopic, count: arr.length });
      }
    }
  }

  return { points, embeddingModel: modelId, clusterLabels };
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

  let built: { points: GraphPoint[]; embeddingModel: string; clusterLabels: ClusterLabel[] };
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

  panel.webview.html = graphHtml(panel.webview, built.points, built.clusterLabels, built.embeddingModel);

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

function graphHtml(webview: vscode.Webview, points: GraphPoint[], clusterLabels: ClusterLabel[], modelId: string): string {
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
  <span class="sub">${points.length} sessions · ${clusterLabels.length} clusters · embedder: ${escapeHtml(modelId)} · hover for details · click to open</span>
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

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const useCluster = cbCluster.checked;
    for (const p of data) {
      const [sx, sy] = project(p);
      ctx.fillStyle = useCluster ? clusterColor(p.cluster) : ageColor(p.endedAt);
      ctx.globalAlpha = p.cluster < 0 && useCluster ? 0.35 : 0.78;
      ctx.beginPath();
      ctx.arc(sx, sy, 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Cluster labels
    if (cbLabels.checked && useCluster) {
      ctx.font = '11px var(--vscode-font-family)';
      ctx.textAlign = 'center';
      for (const lbl of labels) {
        const [sx, sy] = project({ x: lbl.cx, y: lbl.cy });
        ctx.fillStyle = clusterColor(lbl.cluster);
        ctx.globalAlpha = 0.95;
        ctx.fillText(lbl.label + ' · ' + lbl.count, sx, sy - 8);
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = 'start';
    }
  }
  cbCluster.addEventListener('change', draw);
  cbLabels.addEventListener('change', draw);

  function findNear(mx, my) {
    let best = null, bestD2 = 64; // ~8 px radius
    for (const p of data) {
      const [sx, sy] = project(p);
      const d2 = (sx - mx) * (sx - mx) + (sy - my) * (sy - my);
      if (d2 < bestD2) { bestD2 = d2; best = p; }
    }
    return best;
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
      tip.style.left = (mx + 12) + 'px';
      tip.style.top = (my + 12) + 'px';
      tip.style.display = 'block';
      canvas.style.cursor = 'pointer';
    } else {
      tip.style.display = 'none';
      canvas.style.cursor = 'crosshair';
    }
  });
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const p = findNear(e.clientX - rect.left, e.clientY - rect.top);
    if (p) vscode.postMessage({ command: 'open', id: p.session_id });
  });
  window.addEventListener('resize', draw);
  draw();
})();
</script>
</body></html>`;
}
