// Per-session trajectory viewer: each turn as a numbered dot in 2D, connected
// in time order. Topic chip colors the dot. Drift segments (cosine distance
// > p90 of session) drawn dashed-red.

import * as vscode from "vscode";
import { preferredEditorColumn } from "./editorColumn";
import { UMAP } from "umap-js";
import { SessionStore, TurnRow } from "./db";
import { embedMany, EmbedConfig } from "./embedding";

interface TrajPoint {
  turn_uuid: string;
  index: number;
  x: number;
  y: number;
  topic: string | null;
  user_excerpt: string;
}

interface TrajSegment {
  from: number;
  to: number;
  drift: boolean;
}

function cosineDist(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let an = 0;
  let bn = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    an += a[i] * a[i];
    bn += b[i] * b[i];
  }
  if (an === 0 || bn === 0) return 1;
  return 1 - dot / (Math.sqrt(an) * Math.sqrt(bn));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function nonceStr(): string {
  let s = "";
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += charset[Math.floor(Math.random() * charset.length)];
  return s;
}

function topicEmbedInput(t: TurnRow): string {
  const user = (t.user_text ?? "").slice(0, 1024);
  return `USER: ${user}\nTOOLS: ${t.tool_names_csv || ""}`;
}

/**
 * Build the trajectory for one session. Embeds any missing turns under the
 * caller-provided model id, fits a session-local UMAP, computes drift
 * markers using cosine distance over the raw vectors.
 */
async function buildTrajectory(
  store: SessionStore,
  sessionId: string,
  cfg: EmbedConfig,
  driftPercentile: number,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<{ points: TrajPoint[]; segments: TrajSegment[]; model: string; title: string }> {
  const turns = store.turnsForSession(sessionId);
  const eligible = turns.filter((t) => (t.user_text ?? "").trim().length > 0);

  if (eligible.length === 0) {
    return { points: [], segments: [], model: "(none)", title: "" };
  }

  // Probe once via a single embed so we know which model id to query against.
  progress.report({ message: "Probing embedder…" });
  const seed = await embedMany([{ session_id: eligible[0].turn_uuid, text: topicEmbedInput(eligible[0]) }], cfg);
  const model = seed.model;
  store.upsertTurnEmbeddings([{ turn_uuid: seed.results[0].session_id, embedding: seed.results[0].embedding, model }]);

  // Find which turns are already embedded under that model
  const existing = store.turnEmbeddingsForSession(sessionId, model);
  const missing = eligible.filter((t) => !existing.has(t.turn_uuid));
  if (missing.length > 0) {
    progress.report({ message: `Embedding ${missing.length} turns via ${model}…` });
    const reqs = missing.map((t) => ({ session_id: t.turn_uuid, text: topicEmbedInput(t) }));
    const { results } = await embedMany(reqs, cfg, (done, total) =>
      progress.report({ message: `Embedding ${done}/${total} (${model})` }),
    );
    store.upsertTurnEmbeddings(results.map((r) => ({ turn_uuid: r.session_id, embedding: r.embedding, model })));
  }

  // Pull all back, in turn-index order
  const refreshed = store.turnEmbeddingsForSession(sessionId, model);
  const inOrder = eligible
    .map((t) => ({ turn: t, vec: refreshed.get(t.turn_uuid) }))
    .filter((p): p is { turn: TurnRow; vec: Float32Array } => p.vec !== undefined);

  if (inOrder.length === 0) {
    return { points: [], segments: [], model, title: "" };
  }

  // Per-session UMAP — small n_neighbors
  progress.report({ message: "Fitting per-session 2D layout…" });
  let coords: number[][];
  if (inOrder.length < 4) {
    coords = inOrder.map((_, i) => [i, 0]);
  } else {
    const umap = new UMAP({
      nNeighbors: Math.min(15, inOrder.length - 1),
      minDist: 0.1,
      nComponents: 2,
    });
    coords = umap.fit(inOrder.map((r) => Array.from(r.vec)));
  }

  // Topics
  const topics = store.topicsForSession(sessionId);

  const points: TrajPoint[] = inOrder.map((r, i) => ({
    turn_uuid: r.turn.turn_uuid,
    index: r.turn.turn_index,
    x: coords[i][0],
    y: coords[i][1],
    topic: topics.get(r.turn.turn_uuid)?.topic ?? null,
    user_excerpt: (r.turn.user_text ?? "").slice(0, 120).replace(/\n+/g, " "),
  }));

  // Drift: cosine distance between consecutive embeddings, mark above p90
  const dists: number[] = [];
  for (let i = 1; i < inOrder.length; i++) {
    dists.push(cosineDist(inOrder[i - 1].vec, inOrder[i].vec));
  }
  const driftThreshold = percentile(dists, driftPercentile);
  const segments: TrajSegment[] = dists.map((d, i) => ({
    from: i,
    to: i + 1,
    drift: d >= driftThreshold && dists.length >= 2,
  }));

  return { points, segments, model, title: "" };
}

export async function openTrajectoryView(
  ctx: vscode.ExtensionContext,
  store: SessionStore,
  sessionId: string,
  title: string,
): Promise<vscode.WebviewPanel> {
  const cfg = vscode.workspace.getConfiguration("codeSessions");
  const embedCfg: EmbedConfig = {
    preferred: cfg.get<"ollama" | "transformersjs" | "fallback">("embedding.preferred", "ollama"),
    ollamaUrl: cfg.get<string>("embedding.ollamaUrl", "http://127.0.0.1:11434"),
    ollamaModel: cfg.get<string>("embedding.ollamaModel", "nomic-embed-text"),
  };
  const driftP = cfg.get<number>("trajectory.driftPercentile", 90);

  const panel = vscode.window.createWebviewPanel(
    "claudeTrajectory",
    `Trajectory · ${title || sessionId.slice(0, 8)}`,
    preferredEditorColumn(),
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = placeholderHtml();

  let built;
  try {
    built = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Building trajectory", cancellable: false },
      async (progress) => buildTrajectory(store, sessionId, embedCfg, driftP, progress),
    );
  } catch (e: any) {
    panel.webview.html = errorHtml(e?.message || String(e));
    return panel;
  }

  panel.webview.html = trajectoryHtml(panel.webview, built.points, built.segments, built.model, title);
  return panel;
}

function placeholderHtml(): string {
  return `<!doctype html><html><body style="font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 32px;">
    <h2>Building trajectory…</h2>
    <p>Embedding turns and fitting a per-session 2-D layout. Watch the notification bar.</p>
  </body></html>`;
}

function errorHtml(msg: string): string {
  return `<!doctype html><html><body style="font-family: var(--vscode-font-family); color: var(--vscode-errorForeground); background: var(--vscode-editor-background); padding: 32px;">
    <h2>Trajectory failed</h2><pre>${escapeHtml(msg)}</pre>
  </body></html>`;
}

function trajectoryHtml(
  webview: vscode.Webview,
  points: TrajPoint[],
  segments: TrajSegment[],
  model: string,
  title: string,
): string {
  const nonce = nonceStr();
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join("; ");

  // Per-topic deterministic color (HSL hash). Unknown topic = grey.
  return `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); margin: 0; padding: 12px 16px; overflow: hidden; }
  header { display: flex; gap: 16px; align-items: baseline; margin-bottom: 8px; }
  h1 { margin: 0; font-size: 16px; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 11px; }
  #wrap { position: relative; width: 100vw; height: calc(100vh - 60px); }
  canvas { display: block; width: 100%; height: 100%; cursor: crosshair; }
  #tip { position: absolute; pointer-events: none; padding: 6px 10px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 3px; font-size: 11px; max-width: 380px; white-space: pre-wrap; display: none; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
  .legend { margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .legend span.drift { color: #e57373; }
</style>
</head><body>
<header>
  <h1>Trajectory · ${escapeHtml(title || "session")}</h1>
  <span class="sub">${points.length} turns · embedder: ${escapeHtml(model)}</span>
  <span class="legend">— continuous · <span class="drift">— — topic drift</span></span>
</header>
<div id="wrap">
  <canvas id="c"></canvas>
  <div id="tip"></div>
</div>
<script nonce="${nonce}">
(function() {
  const points = ${JSON.stringify(points)};
  const segments = ${JSON.stringify(segments)};
  const canvas = document.getElementById('c');
  const tip = document.getElementById('tip');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0;
  const PAD = 36;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  if (!isFinite(minX)) { minX = 0; maxX = 1; minY = 0; maxY = 1; }
  if (minX === maxX) maxX = minX + 1;
  if (minY === maxY) maxY = minY + 1;

  function hashColor(s) {
    if (!s) return '#888';
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    const hue = (h >>> 0) % 360;
    return 'hsl(' + hue + ', 65%, 55%)';
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

    // Connecting lines first
    for (const seg of segments) {
      const a = project(points[seg.from]);
      const b = project(points[seg.to]);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      if (seg.drift) {
        ctx.strokeStyle = '#e57373';
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.4;
      } else {
        ctx.strokeStyle = 'rgba(140,140,140,0.55)';
        ctx.setLineDash([]);
        ctx.lineWidth = 1.0;
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Dots + index labels
    ctx.font = '10px var(--vscode-font-family)';
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const [sx, sy] = project(p);
      ctx.fillStyle = hashColor(p.topic);
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(sx, sy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'var(--vscode-editor-background)';
      // contrast: small white outline + numeric label on top
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 0.5;
      ctx.strokeText(String(i + 1), sx - 3, sy + 3);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillText(String(i + 1), sx - 3, sy + 3);
    }
  }

  function findNear(mx, my) {
    let best = null, bestD2 = 100;
    for (const p of points) {
      const [sx, sy] = project(p);
      const d2 = (sx - mx) * (sx - mx) + (sy - my) * (sy - my);
      if (d2 < bestD2) { bestD2 = d2; best = p; }
    }
    return best;
  }

  function placeTip(mx, my) {
    // Clamp to wrap container so the tooltip never escapes the visible area.
    const wrap = document.getElementById('wrap');
    const wrapRect = wrap.getBoundingClientRect();
    // Show first so we can measure its size
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
      const t = p.topic ? p.topic : '(untagged)';
      tip.textContent = '#' + (p.index + 1) + '  ' + t + '\\n' + p.user_excerpt;
      placeTip(mx, my);
    } else {
      tip.style.display = 'none';
    }
  });
  window.addEventListener('resize', draw);
  draw();
})();
</script>
</body></html>`;
}
