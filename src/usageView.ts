// Usage dashboard webview. Data comes from the CS library (`code-sessions usage
// --json`), which aggregates the git-backed sessions store / SQLite index.
// Static SVG charts (no scripts needed).

import * as vscode from "vscode";
import { execFile } from "child_process";
import { preferredEditorColumn } from "./editorColumn";

interface UsageBucket {
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}
interface UsageSummary {
  totals: { sessions: number; input_tokens: number; output_tokens: number; cost_usd: number };
  byAgent: Record<string, UsageBucket>;
  byDay: Array<{ day: string } & UsageBucket>;
  byProject: Record<string, UsageBucket>;
  topByCost: Array<{ session_id: string; agent: string; cost_usd: number; label: string }>;
}

/** Run the CS CLI, preferring a global install (login shell PATH), falling back to npx. */
function runUsageCli(): Promise<UsageSummary> {
  const tryRun = (cmd: string): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile("/bin/bash", ["-lc", cmd], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout));
      });
    });
  const parse = (s: string): UsageSummary => {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    return JSON.parse(s.slice(start, end + 1)) as UsageSummary;
  };
  return tryRun("code-sessions usage --json")
    .then(parse)
    .catch(() => tryRun("npx --yes @unpolarize/code-sessions usage --json").then(parse));
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
function fmtTok(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${n}`;
}

function dayBars(byDay: UsageSummary["byDay"]): string {
  const days = [...byDay].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-30);
  if (days.length === 0) return '<div class="muted">no data</div>';
  const max = Math.max(1, ...days.map((d) => d.cost_usd));
  const W = 720;
  const H = 140;
  const bw = (W - 16) / days.length;
  const bars = days
    .map((d, i) => {
      const h = (d.cost_usd / max) * (H - 24);
      const x = 8 + i * bw;
      const y = H - 18 - h;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.8).toFixed(1)}" height="${h.toFixed(1)}" fill="var(--vscode-charts-blue,#4a90e2)"><title>${esc(d.day)}: $${d.cost_usd.toFixed(2)} · ${d.sessions} sess</title></rect>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">${bars}</svg>`;
}

function table(rows: [string, string, string, string][]): string {
  const head = "<tr><th>name</th><th>sessions</th><th>tokens</th><th>cost</th></tr>";
  const body = rows
    .map((r) => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td>${esc(r[3])}</td></tr>`)
    .join("");
  return `<table>${head}${body}</table>`;
}

function render(u: UsageSummary): string {
  const agentRows = Object.entries(u.byAgent)
    .sort((a, b) => b[1].cost_usd - a[1].cost_usd)
    .map(
      (e): [string, string, string, string] => [
        e[0],
        String(e[1].sessions),
        fmtTok(e[1].input_tokens + e[1].output_tokens),
        `$${e[1].cost_usd.toFixed(2)}`,
      ],
    );
  const projRows = Object.entries(u.byProject)
    .sort((a, b) => b[1].cost_usd - a[1].cost_usd)
    .slice(0, 12)
    .map(
      (e): [string, string, string, string] => [
        e[0],
        String(e[1].sessions),
        fmtTok(e[1].input_tokens + e[1].output_tokens),
        `$${e[1].cost_usd.toFixed(2)}`,
      ],
    );
  const top = u.topByCost
    .map(
      (t) =>
        `<tr><td>$${t.cost_usd.toFixed(2)}</td><td>${esc(t.agent)}</td><td>${esc(t.label.slice(0, 70))}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font:13px/1.5 var(--vscode-font-family);color:var(--vscode-foreground);padding:1rem 1.2rem}
    h1{font-size:1.2rem;margin:.2rem 0}.muted{color:var(--vscode-descriptionForeground)}
    .kpis{display:flex;gap:1.5rem;margin:.6rem 0 1rem}.kpi b{font-size:1.3rem}
    table{border-collapse:collapse;margin:.4rem 0 1.2rem;width:100%}
    td,th{text-align:left;padding:.25rem .6rem;border-bottom:1px solid var(--vscode-panel-border)}
    th{color:var(--vscode-descriptionForeground);font-weight:600}h2{font-size:1rem;margin:1rem 0 .3rem}
  </style></head><body>
  <h1>Usage <span class="muted">· from CS library</span></h1>
  <div class="kpis">
    <div class="kpi"><div class="muted">sessions</div><b>${u.totals.sessions}</b></div>
    <div class="kpi"><div class="muted">tokens in/out</div><b>${fmtTok(u.totals.input_tokens)}/${fmtTok(u.totals.output_tokens)}</b></div>
    <div class="kpi"><div class="muted">cost</div><b>$${u.totals.cost_usd.toFixed(2)}</b></div>
  </div>
  <h2>Cost by day (last 30)</h2>${dayBars(u.byDay)}
  <h2>By agent</h2>${table(agentRows)}
  <h2>By project</h2>${table(projRows)}
  <h2>Top sessions by cost</h2><table><tr><th>cost</th><th>agent</th><th>session</th></tr>${top}</table>
  </body></html>`;
}

export async function openUsageView(ctx: vscode.ExtensionContext): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "codeSessionsUsage",
    "Code Sessions: Usage",
    preferredEditorColumn(),
    { enableScripts: false, retainContextWhenHidden: true },
  );
  panel.webview.html = `<body style="font-family:var(--vscode-font-family);padding:1rem">Loading usage from CS library…</body>`;
  try {
    const u = await runUsageCli();
    panel.webview.html = render(u);
  } catch (e: any) {
    panel.webview.html = `<body style="font-family:var(--vscode-font-family);padding:1rem">
      <h2>Usage unavailable</h2>
      <p>Could not run the CS library. Install it with <code>npm i -g @unpolarize/code-sessions</code>
      and ensure sessions are captured (Command Palette → <b>Code Sessions: Enable capture</b>).</p>
      <pre>${esc(e?.message ?? String(e))}</pre></body>`;
  }
  ctx.subscriptions.push(panel);
}
