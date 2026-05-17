// Webview-based conversation viewer.
//
// Opens a single HTML panel that renders a parsed conversation as a vertical
// timeline. Each turn is a card; assistant tools are <details> rows.
// Subagent (Agent) calls get a distinct icon and color.

import * as path from "path";
import * as vscode from "vscode";
import { ParsedConversation, parseConversation, ToolCall, Turn } from "./conversationParser";

function fmtClock(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleString();
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m${s ? ` ${s}s` : ""}`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h${m ? ` ${m}m` : ""}`;
}

function fmtTruncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderToolCall(tc: ToolCall): string {
  const icon = tc.isSubagent ? "🪄" : "🔧";
  const cls = tc.isSubagent ? "tool subagent" : tc.resultIsError ? "tool error" : "tool";
  const headerExtras = tc.isSubagent
    ? `<span class="subagent-type">${escapeHtml(tc.subagentType || "")}</span>`
    : "";
  const desc = tc.isSubagent
    ? `<div class="subagent-desc">${escapeHtml(tc.subagentDescription || "")}</div>`
    : "";
  const inputJson = (() => {
    try {
      return JSON.stringify(tc.input ?? {}, null, 2);
    } catch {
      return String(tc.input);
    }
  })();
  const outputText = tc.resultText ?? "";
  const outputPreview = fmtTruncate(outputText, 4000);

  return `
  <details class="${cls}">
    <summary>
      <span class="icon">${icon}</span>
      <span class="name">${escapeHtml(tc.name)}</span>
      ${headerExtras}
      <span class="duration">${fmtDuration(tc.durationMs)}</span>
      ${tc.resultIsError ? '<span class="err-pill">error</span>' : ""}
    </summary>
    ${desc}
    <div class="tool-body">
      <div class="kv">
        <span class="k">started</span>
        <span class="v">${fmtClock(tc.startMs)}</span>
      </div>
      <div class="kv">
        <span class="k">ended</span>
        <span class="v">${fmtClock(tc.endMs ?? 0)}</span>
      </div>
      <details class="block">
        <summary>input</summary>
        <pre>${escapeHtml(inputJson)}</pre>
      </details>
      <details class="block">
        <summary>output (${outputText.length.toLocaleString()} chars${
    outputText.length > outputPreview.length ? ", truncated" : ""
  })</summary>
        <pre>${escapeHtml(outputPreview)}</pre>
      </details>
    </div>
  </details>`;
}

function renderTurn(t: Turn): string {
  const turnDuration =
    t.userTimestampMs && t.turnEndMs ? t.turnEndMs - t.userTimestampMs : null;
  const toolsByKind = new Map<string, number>();
  for (const tc of t.toolCalls) {
    toolsByKind.set(tc.name, (toolsByKind.get(tc.name) ?? 0) + 1);
  }
  const toolSummary = Array.from(toolsByKind.entries())
    .map(([k, v]) => `${k}×${v}`)
    .join(" · ");

  return `
  <article class="turn">
    <header class="turn-head">
      <span class="turn-idx">#${t.index + 1}</span>
      <span class="turn-time">${fmtClock(t.userTimestampMs)}</span>
      <span class="sep">·</span>
      <span class="dur">duration ${fmtDuration(turnDuration)}</span>
      <span class="sep">·</span>
      <span class="tools-count">${t.toolCalls.length} tools${
    toolSummary ? ` (${toolSummary})` : ""
  }</span>
    </header>
    <section class="user">
      <div class="role">USER</div>
      <pre class="msg">${escapeHtml(fmtTruncate(t.userText, 5000))}</pre>
    </section>
    ${
      t.assistantText.trim().length > 0
        ? `<section class="assistant">
        <div class="role">ASSISTANT (${fmtDuration(
          t.assistantStartMs && t.turnEndMs ? t.turnEndMs - t.assistantStartMs : null,
        )})</div>
        <pre class="msg">${escapeHtml(fmtTruncate(t.assistantText, 5000))}</pre>
      </section>`
        : ""
    }
    ${
      t.toolCalls.length > 0
        ? `<details class="tools-wrap">
        <summary><span class="role">TOOLS</span> <span class="count">${t.toolCalls.length} calls</span></summary>
        ${t.toolCalls.map(renderToolCall).join("\n")}
      </details>`
        : ""
    }
  </article>`;
}

const STYLE = `
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border);
    --accent: var(--vscode-textLink-foreground);
    --tool-bg: var(--vscode-sideBar-background);
    --subagent-bg: rgba(155, 89, 182, 0.08);
    --err: var(--vscode-errorForeground);
  }
  body { font-family: var(--vscode-font-family); color: var(--fg); background: var(--bg); margin: 0; padding: 16px 24px; }
  h1 { margin: 0 0 4px 0; font-size: 18px; }
  .hdr-sub { color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  .totals { display: flex; flex-wrap: wrap; gap: 16px 24px; padding: 12px 16px; background: var(--tool-bg); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 24px; }
  .totals .stat { display: flex; flex-direction: column; gap: 2px; }
  .totals .label { font-size: 10px; text-transform: uppercase; color: var(--muted); }
  .totals .value { font-size: 14px; font-weight: 600; }
  .turn { border-top: 1px solid var(--border); padding: 16px 0; }
  .turn:first-of-type { border-top: none; }
  .turn-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; color: var(--muted); font-size: 12px; margin-bottom: 12px; }
  .turn-idx { color: var(--accent); font-weight: 600; }
  .sep { opacity: 0.5; }
  .role { font-size: 10px; font-weight: 700; letter-spacing: 1px; color: var(--muted); margin-bottom: 4px; }
  .user, .assistant, .tools-wrap { margin-bottom: 12px; }
  details.tools-wrap { padding: 8px 0; }
  details.tools-wrap > summary { cursor: pointer; user-select: none; display: flex; align-items: center; gap: 8px; font-size: 11px; padding: 4px 0; }
  details.tools-wrap > summary .role { font-weight: 700; letter-spacing: 1px; color: var(--muted); }
  details.tools-wrap > summary .count { color: var(--accent); }
  details.tools-wrap > details.tool { margin-top: 6px; }
  pre.msg { background: var(--tool-bg); border: 1px solid var(--border); border-radius: 4px; padding: 10px 12px; margin: 0; white-space: pre-wrap; word-wrap: break-word; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); max-height: 320px; overflow-y: auto; }
  details.tool { background: var(--tool-bg); border: 1px solid var(--border); border-radius: 4px; padding: 6px 10px; margin-bottom: 6px; }
  details.tool.subagent { background: var(--subagent-bg); border-color: rgba(155, 89, 182, 0.5); }
  details.tool.error { border-color: var(--err); }
  details.tool > summary { cursor: pointer; user-select: none; display: flex; gap: 8px; align-items: center; font-size: 12px; }
  details.tool > summary .icon { font-size: 14px; }
  details.tool > summary .name { font-weight: 600; }
  details.tool > summary .subagent-type { font-style: italic; opacity: 0.85; }
  details.tool > summary .duration { margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums; }
  .err-pill { background: var(--err); color: var(--vscode-editor-background); padding: 0 6px; border-radius: 3px; font-size: 10px; font-weight: 600; }
  .subagent-desc { font-size: 11px; color: var(--muted); padding: 4px 0 0 22px; font-style: italic; }
  .tool-body { padding: 8px 0 4px 22px; }
  .kv { display: flex; gap: 8px; font-size: 11px; color: var(--muted); margin-bottom: 4px; }
  .kv .k { width: 60px; }
  details.block { margin-top: 6px; }
  details.block > summary { font-size: 11px; color: var(--muted); cursor: pointer; }
  details.block pre { background: var(--bg); border: 1px solid var(--border); border-radius: 3px; padding: 8px; margin-top: 4px; font-size: 11px; max-height: 360px; overflow: auto; white-space: pre-wrap; word-wrap: break-word; }
`;

function renderHtml(c: ParsedConversation, jsonlPath: string): string {
  const totalTurns = c.summary.totalTurns;
  const totalTools = c.summary.totalTools;
  const totalSubagents = c.summary.totalSubagents;
  const turnDur = c.summary.totalTurnDurationMs;
  const toolDur = c.summary.totalToolDurationMs;
  const sessionDur =
    c.startMs && c.endMs ? c.endMs - c.startMs : null;
  const waitingDur = sessionDur != null ? Math.max(0, sessionDur - toolDur) : null;

  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none';">
<style>${STYLE}</style>
</head><body>
<h1>${escapeHtml(c.title || "(no title)")}</h1>
<div class="hdr-sub">
  <code>${escapeHtml(c.sessionId)}</code>
  · ${escapeHtml(jsonlPath)}
</div>
<div class="totals">
  <div class="stat"><span class="label">Turns</span><span class="value">${totalTurns}</span></div>
  <div class="stat"><span class="label">Tool calls</span><span class="value">${totalTools}</span></div>
  <div class="stat"><span class="label">Subagents</span><span class="value">${totalSubagents}</span></div>
  <div class="stat"><span class="label">Session span</span><span class="value">${fmtDuration(sessionDur)}</span></div>
  <div class="stat"><span class="label">In tools</span><span class="value">${fmtDuration(toolDur)}</span></div>
  <div class="stat"><span class="label">Outside tools</span><span class="value">${fmtDuration(waitingDur)}</span></div>
  <div class="stat"><span class="label">First user msg</span><span class="value">${fmtClock(c.startMs ?? 0)}</span></div>
  <div class="stat"><span class="label">Last activity</span><span class="value">${fmtClock(c.endMs ?? 0)}</span></div>
</div>
${c.turns.map(renderTurn).join("\n")}
</body></html>`;
}

/**
 * Open the conversation viewer for a JSONL file. Returns the WebviewPanel
 * for the caller to attach lifecycle hooks if needed.
 */
export function openConversationViewer(
  ctx: vscode.ExtensionContext,
  jsonlPath: string,
  sessionId: string,
  title: string,
): vscode.WebviewPanel {
  const panelTitle = `${title || sessionId.slice(0, 8)} · conversation`;
  const panel = vscode.window.createWebviewPanel(
    "claudeConversationViewer",
    panelTitle,
    vscode.ViewColumn.Active,
    {
      enableScripts: false,
      retainContextWhenHidden: true,
    },
  );
  try {
    const parsed = parseConversation(jsonlPath);
    if (!parsed.title) parsed.title = title;
    if (!parsed.sessionId) parsed.sessionId = sessionId;
    panel.webview.html = renderHtml(parsed, jsonlPath);
  } catch (e: any) {
    panel.webview.html = `<pre>Failed to parse ${escapeHtml(jsonlPath)}\n\n${escapeHtml(e?.message || String(e))}</pre>`;
  }
  return panel;
}
