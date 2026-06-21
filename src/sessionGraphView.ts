// Sessions × topics graph webview. Data from the CS library
// (`code-sessions graph --json`). Deterministic radial-cluster layout rendered
// as static SVG (no scripts): topics on an outer ring, their sessions clustered
// around each topic hub; sessions colored by agent, sized by cost.

import * as vscode from "vscode";
import { execFile } from "child_process";
import { preferredEditorColumn } from "./editorColumn";

interface GNode {
  id: string;
  kind: "session" | "topic";
  label: string;
  agent?: string;
  intent?: string | null;
  cost_usd: number;
  sessions: number;
}
interface GEdge { from: string; to: string; kind: string }
interface GraphData { nodes: GNode[]; edges: GEdge[] }

function runGraphCli(): Promise<GraphData> {
  const run = (cmd: string): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile("/bin/bash", ["-lc", cmd], { maxBuffer: 64 * 1024 * 1024 }, (err, out) =>
        err ? reject(err) : resolve(String(out)),
      );
    });
  const parse = (s: string): GraphData => JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)) as GraphData;
  return run("code-sessions graph --json")
    .then(parse)
    .catch(() => run("npx --yes @unpolarize/code-sessions graph --json").then(parse));
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
function agentColor(agent?: string): string {
  switch (agent) {
    case "claude-code": return "#4a90e2";
    case "grok": return "#3ecf8e";
    case "codex": return "#f0a050";
    default: return "#9aa0a6";
  }
}

function render(g: GraphData): string {
  const topics = g.nodes.filter((n) => n.kind === "topic");
  const sessByTopic = new Map<string, GNode[]>();
  const sessionById = new Map(g.nodes.filter((n) => n.kind === "session").map((n) => [n.id, n] as const));
  for (const e of g.edges) {
    if (e.kind !== "has-topic") continue;
    const s = sessionById.get(e.from);
    if (!s) continue;
    (sessByTopic.get(e.to) ?? sessByTopic.set(e.to, []).get(e.to)!).push(s);
  }

  const W = 1100;
  const H = 820;
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) * 0.36;
  const maxCost = Math.max(0.01, ...g.nodes.filter((n) => n.kind === "session").map((n) => n.cost_usd));
  // sort topics by session count desc for a stable, readable ring
  const ring = [...topics].sort((a, b) => b.sessions - a.sessions);
  const parts: string[] = [];
  const labels: string[] = [];

  ring.forEach((t, i) => {
    const ang = (i / ring.length) * Math.PI * 2 - Math.PI / 2;
    const tx = cx + R * Math.cos(ang);
    const ty = cy + R * Math.sin(ang);
    const sessions = (sessByTopic.get(t.id) ?? []).slice(0, 24);
    // session cluster around the topic hub
    sessions.forEach((s, j) => {
      const a2 = (j / Math.max(1, sessions.length)) * Math.PI * 2;
      const rr = 26 + Math.min(60, sessions.length * 3);
      const sx = tx + rr * Math.cos(a2);
      const sy = ty + rr * Math.sin(a2);
      const rad = 3 + Math.sqrt(s.cost_usd / maxCost) * 12;
      parts.push(`<line x1="${tx.toFixed(0)}" y1="${ty.toFixed(0)}" x2="${sx.toFixed(0)}" y2="${sy.toFixed(0)}" stroke="var(--vscode-panel-border)" stroke-width="0.5"/>`);
      parts.push(`<circle cx="${sx.toFixed(0)}" cy="${sy.toFixed(0)}" r="${rad.toFixed(1)}" fill="${agentColor(s.agent)}" fill-opacity="0.85"><title>${esc(s.label)} · ${esc(s.agent || "")}${s.intent ? " · " + esc(s.intent) : ""} · $${s.cost_usd.toFixed(2)}</title></circle>`);
    });
    // topic hub on top
    parts.push(`<circle cx="${tx.toFixed(0)}" cy="${ty.toFixed(0)}" r="6" fill="var(--vscode-foreground)"/>`);
    labels.push(`<text x="${tx.toFixed(0)}" y="${(ty - 12).toFixed(0)}" text-anchor="middle" font-size="11" fill="var(--vscode-foreground)">${esc(t.label.slice(0, 22))} (${t.sessions})</text>`);
  });

  const legend = ["claude-code", "grok", "codex"]
    .map((a, i) => `<circle cx="${20}" cy="${20 + i * 18}" r="6" fill="${agentColor(a)}"/><text x="32" y="${24 + i * 18}" font-size="11" fill="var(--vscode-foreground)">${a}</text>`)
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);margin:0;padding:.6rem 1rem}
    h1{font-size:1.1rem;margin:.2rem 0}.muted{color:var(--vscode-descriptionForeground)}
    svg{width:100%;height:auto;border:1px solid var(--vscode-panel-border);border-radius:6px;margin-top:.4rem}
  </style></head><body>
    <h1>Sessions × Topics <span class="muted">· ${g.nodes.filter((n) => n.kind === "session").length} sessions · ${topics.length} topics · from CS library</span></h1>
    <svg viewBox="0 0 ${W} ${H}">${legend}${parts.join("")}${labels.join("")}</svg>
  </body></html>`;
}

export async function openSessionGraphView(ctx: vscode.ExtensionContext): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "codeSessionsGraph",
    "Code Sessions: Graph",
    preferredEditorColumn(),
    { enableScripts: false, retainContextWhenHidden: true },
  );
  panel.webview.html = `<body style="font-family:var(--vscode-font-family);padding:1rem">Loading sessions graph from CS library…</body>`;
  try {
    panel.webview.html = render(await runGraphCli());
  } catch (e: any) {
    panel.webview.html = `<body style="font-family:var(--vscode-font-family);padding:1rem">
      <h2>Graph unavailable</h2><p>Could not run the CS library (<code>npm i -g @unpolarize/code-sessions</code>),
      or no sessions are indexed yet (run <b>Code Sessions: Enable capture</b>).</p>
      <pre>${esc(e?.message ?? String(e))}</pre></body>`;
  }
  ctx.subscriptions.push(panel);
}
