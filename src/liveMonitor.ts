// Real-time dashboard: cards for every currently-active Claude Code session.
// Polls the SQLite cache + tails each active session's JSONL every 2 s.

import * as fs from "fs";
import * as vscode from "vscode";
import { preferredEditorColumn } from "./editorColumn";
import { SessionStore, SessionRow } from "./db";
import { nowStatusFromTail, type NowStatus } from "./nowStatus";

const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;
const TAIL_BYTES = 8192;
// Wider tail window used only to locate the most recent assistant
// `message.usage` block for the context-window gauge. 64 KB comfortably
// spans a few large tool results without re-reading the whole transcript.
const CTX_TAIL_BYTES = 65536;

interface LiveCard {
  session_id: string;
  title: string;
  project: string | null;
  jsonl_path: string;
  startedAt: number | null;
  elapsedMs: number;
  messages: number;
  tools: number;
  subagents: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost_usd: number;
  now: NowStatus;
  toolsLast60s: number;
  /** Dominant / last-seen model id for the session (drives the context limit). */
  model: string | null;
  /** Tokens currently in the model's context window — sum of input +
   * cache_read + cache_creation from the latest assistant usage block in the
   * JSONL tail. Null when no usage block is visible in the tail window. */
  contextTokens: number | null;
  /** Context-window limit for the session's model (tokens). */
  contextLimit: number;
  /** Rounded percentage of the context window in use, or null when unknown. */
  contextPct: number | null;
}

export interface UpdatePayload {
  cards: LiveCard[];
  activeCount: number;
  toolsPerMin: number;
  costToday: number;
  tokensToday: number;
  subagentsToday: number;
  /** Total memory entries discovered across CLAUDE.md / AGENTS.md /
   * MEMORY.md / ~/.claude / ~/.codex sources visible to the user.
   * Populated by buildUpdate via summariseSources from
   * memoryView.ts. Refreshed every poll tick alongside session
   * cards so the live monitor reflects edits in real time. */
  memoryEntries: number;
  /** Number of source files with at least one entry. */
  memoryFiles: number;
  /** Today's spend divided by hours elapsed since today's first session
   * activity. Null when under 30 minutes have elapsed (too noisy) or when
   * there is no spend/activity today. */
  burnRateUsdPerHour: number | null;
}

export type LiveCardForExport = LiveCard;

/** Read the last N bytes of a file (returns "" on any error). */
function tailFile(path: string, bytes: number): string {
  try {
    const fd = fs.openSync(path, "r");
    try {
      const stat = fs.fstatSync(fd);
      const start = Math.max(0, stat.size - bytes);
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Context-window size (tokens) for a model id. `[1m]`-suffixed Claude models
 * run the 1M-token beta window; grok models are 256K; everything else
 * (Claude default + unknown) is 200K. */
function contextLimitForModel(model: string | null): number {
  const m = (model ?? "").toLowerCase();
  if (m.includes("[1m]")) return 1_000_000;
  if (m.includes("grok")) return 256_000;
  return 200_000; // Claude default / unknown
}

/** Sibling of nowStatusFromTail: scan the tail backwards for the most recent
 * assistant event carrying `message.usage` and return the tokens currently in
 * context (input + cache_read + cache_creation). Null when no usage block is
 * visible in the tail window. */
function contextTokensFromTail(tail: string): number | null {
  const lines = tail.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj?.type !== "assistant") continue;
      const u = obj.message?.usage;
      if (!u || typeof u.input_tokens !== "number") continue;
      return (
        (u.input_tokens || 0) +
        (typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0) +
        (typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0)
      );
    } catch {
      // skip partial / non-JSON line
    }
  }
  return null;
}

function cardFromSession(s: SessionRow, now: number): LiveCard {
  // Read one wide tail; the status parser keeps its original 8 KB window
  // (sliced off the end) so its behavior is unchanged, while the context
  // gauge scans the full 64 KB for the latest assistant usage block.
  const tail = tailFile(s.jsonl_path, CTX_TAIL_BYTES);
  const { status, toolsLast60s } = nowStatusFromTail(tail.slice(-TAIL_BYTES), now);
  const contextTokens = contextTokensFromTail(tail);
  const contextLimit = contextLimitForModel(s.model);
  const contextPct =
    contextTokens !== null ? Math.min(999, Math.round((contextTokens / contextLimit) * 100)) : null;
  return {
    session_id: s.session_id,
    title: s.title || s.session_id.slice(0, 8),
    project: s.project_id,
    jsonl_path: s.jsonl_path,
    startedAt: s.started_at,
    elapsedMs: s.started_at ? Math.max(0, now - s.started_at) : 0,
    messages: s.message_count,
    tools: s.tool_count,
    subagents: s.subagent_count,
    inputTokens: s.input_tokens,
    outputTokens: s.output_tokens,
    cacheReadTokens: s.cache_read_tokens,
    cacheWriteTokens: s.cache_write_tokens,
    totalTokens: s.input_tokens + s.output_tokens + s.cache_read_tokens + s.cache_write_tokens,
    cost_usd: s.cost_usd,
    now: status,
    toolsLast60s,
    model: s.model,
    contextTokens,
    contextLimit,
    contextPct,
  };
}

function startOfTodayMs(): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function buildUpdate(store: SessionStore): UpdatePayload {
  const now = Date.now();
  // Pull a wider window so "today" sums catch sessions that haven't recently
  // ticked their mtime. 200 covers a heavy day; cheap.
  const recent = store.listRecent(200, true);
  const active = recent.filter((r) => now - r.mtime_ns / 1e6 < ACTIVE_WINDOW_MS);
  const cards = active.map((s) => cardFromSession(s, now));
  const startToday = startOfTodayMs();
  const endToday = startToday + 86400_000;
  // Include any transcript (main session + subagent/workflow children) that
  // had activity today. Use ended_at when present, else mtime. This ensures
  // overnight sessions that did heavy work today + all child workflow runs
  // are counted toward "cost today" (the main user pain).
  const todays = recent.filter((r) => {
    const act = r.ended_at || Math.floor(r.mtime_ns / 1e6);
    return act >= startToday && act < endToday;
  });
  const costToday = todays.reduce((sum, r) => sum + (r.cost_usd || 0), 0);
  const tokensToday = todays.reduce(
    (sum, r) => sum + r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens,
    0,
  );
  const subagentsToday = todays.reduce((sum, r) => sum + (r.subagent_count || 0), 0);
  const toolsPerMin = cards.reduce((sum, c) => sum + c.toolsLast60s, 0);
  // Burn rate: costToday spread over the hours since today's first session
  // activity. Sessions that started before midnight are clamped to midnight
  // (only today's hours count). Suppressed under 30 min elapsed — a fresh
  // morning session extrapolates absurd $/hr figures.
  let firstActivityToday = Infinity;
  for (const r of todays) {
    const started = r.started_at ?? (r.ended_at || Math.floor(r.mtime_ns / 1e6));
    firstActivityToday = Math.min(firstActivityToday, Math.max(started, startToday));
  }
  const elapsedTodayMs = Number.isFinite(firstActivityToday) ? now - firstActivityToday : 0;
  const burnRateUsdPerHour =
    elapsedTodayMs > 30 * 60_000 && costToday > 0 ? costToday / (elapsedTodayMs / 3_600_000) : null;
  // Memory inventory snapshot — count entries across all configured
  // workspace folders + global ~/.claude / ~/.codex / ~/.grok files.
  // Cheap (≤ ~15 stat+read calls); refreshed every live-monitor
  // poll tick so the user sees CLAUDE.md edits in real-time.
  let memoryEntries = 0;
  let memoryFiles = 0;
  try {
    // Lazy-require so liveMonitor stays usable in test harnesses that
    // don't have the vscode module wired up; the catch handles the
    // import error too.
    const vscodeMod = require("vscode") as typeof import("vscode");
    const roots = (vscodeMod.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const { scanMemorySources, summariseSources } = require("./memoryView") as typeof import("./memoryView");
    const sources = scanMemorySources(roots);
    const totals = summariseSources(sources);
    memoryEntries = totals.totalEntries;
    memoryFiles = totals.totalFiles;
  } catch {
    /* memory module / vscode not available in this context — leave zeros */
  }
  return {
    cards,
    activeCount: cards.length,
    toolsPerMin,
    costToday,
    tokensToday,
    subagentsToday,
    memoryEntries,
    memoryFiles,
    burnRateUsdPerHour,
  };
}

export function openLiveMonitor(ctx: vscode.ExtensionContext, store: SessionStore): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    "codeLiveMonitor",
    "AI Agents · Live",
    preferredEditorColumn(),
    { enableScripts: true, retainContextWhenHidden: false },
  );

  panel.webview.html = liveHtml(panel.webview);

  let timer: NodeJS.Timeout | undefined;
  const tick = () => {
    if (!panel.visible) return;
    try {
      panel.webview.postMessage({ command: "update", payload: buildUpdate(store) });
    } catch {
      // panel disposed
    }
  };
  const start = () => {
    if (timer) return;
    tick();
    timer = setInterval(tick, POLL_INTERVAL_MS);
  };
  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  start();

  panel.onDidChangeViewState((e) => {
    if (e.webviewPanel.visible) start();
    else stop();
  });
  panel.onDidDispose(() => stop());

  return panel;
}

function nonceStr(): string {
  let s = "";
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += charset[Math.floor(Math.random() * charset.length)];
  return s;
}

function liveHtml(webview: vscode.Webview): string {
  const nonce = nonceStr();
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join("; ");

  return `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px 20px; }
  h1 { margin: 0 0 4px; font-size: 18px; }
  .summary { display: flex; gap: 22px; padding: 10px 14px; background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-bottom: 18px; flex-wrap: wrap; }
  .summary .stat { display: flex; flex-direction: column; gap: 2px; }
  .summary .label { font-size: 10px; text-transform: uppercase; color: var(--vscode-descriptionForeground); letter-spacing: 0.5px; }
  .summary .value { font-size: 16px; font-weight: 600; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; }
  .card { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px 14px; }
  .card .title { font-weight: 600; font-size: 13px; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .sub { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
  .card .now { font-size: 12px; padding: 6px 8px; border-radius: 4px; margin-bottom: 8px; font-variant-numeric: tabular-nums; }
  .now.in_tool { background: rgba(74, 144, 226, 0.15); color: #4a90e2; border: 1px solid rgba(74, 144, 226, 0.5); }
  .now.responding { background: rgba(62, 207, 142, 0.15); color: #3ecf8e; border: 1px solid rgba(62, 207, 142, 0.5); }
  .now.awaiting_user { background: rgba(229, 159, 73, 0.20); color: #f0a050; border: 1px solid rgba(229, 159, 73, 0.65); font-weight: 600; animation: pulseAwait 1.8s ease-in-out infinite; }
  @keyframes pulseAwait { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
  .card.awaiting { outline: 1px solid rgba(229, 159, 73, 0.7); outline-offset: -1px; }
  .alert-banner { display: none; padding: 8px 12px; margin-bottom: 14px; background: rgba(229, 159, 73, 0.18); border: 1px solid rgba(229, 159, 73, 0.7); border-radius: 6px; color: var(--vscode-editor-foreground); font-size: 12px; }
  .alert-banner.on { display: flex; align-items: center; gap: 8px; }
  .alert-banner .dot { width: 8px; height: 8px; border-radius: 50%; background: #f0a050; box-shadow: 0 0 0 0 rgba(240,160,80,0.7); animation: pulseDot 1.5s infinite; flex: 0 0 auto; }
  @keyframes pulseDot { 0% { box-shadow: 0 0 0 0 rgba(240,160,80,0.7); } 70% { box-shadow: 0 0 0 8px rgba(240,160,80,0); } 100% { box-shadow: 0 0 0 0 rgba(240,160,80,0); } }
  .now.idle { background: rgba(160, 160, 160, 0.15); color: var(--vscode-descriptionForeground); border: 1px solid rgba(160, 160, 160, 0.4); }
  .card .row { display: flex; gap: 10px; font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; flex-wrap: wrap; }
  .card .ctx { display: none; align-items: center; gap: 8px; margin-top: 8px; font-size: 10px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  .card .ctx.on { display: flex; }
  .card .ctx .bar { flex: 1; height: 4px; border-radius: 2px; background: rgba(160,160,160,0.18); overflow: hidden; }
  .card .ctx .fill { height: 100%; border-radius: 2px; background: #3ecf8e; }
  .card .ctx .fill.mid { background: #e5b567; }
  .card .ctx .fill.high { background: #e06c75; }
  .card .ctx .pct.high { color: #e06c75; font-weight: 600; }
  .card .row .pill { background: rgba(160,160,160,0.12); padding: 2px 8px; border-radius: 10px; }
  .empty { padding: 32px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 13px; border: 1px dashed var(--vscode-panel-border); border-radius: 8px; }
  .pulse { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #3ecf8e; margin-right: 6px; vertical-align: 1px; animation: pulse 1.4s infinite ease-in-out; }
  @keyframes pulse { 0% { opacity: 0.35; transform: scale(0.85); } 50% { opacity: 1; transform: scale(1.1); } 100% { opacity: 0.35; transform: scale(0.85); } }
</style>
</head><body>
<h1><span class="pulse"></span>Live monitor</h1>
<div class="summary">
  <div class="stat"><span class="label">Active sessions</span><span class="value" id="vActive">0</span></div>
  <div class="stat"><span class="label">Tools / min</span><span class="value" id="vTools">0</span></div>
  <div class="stat"><span class="label">Tokens today</span><span class="value" id="vTokens">0</span></div>
  <div class="stat"><span class="label">Subagents today</span><span class="value" id="vAgents">0</span></div>
  <div class="stat"><span class="label">Cost today</span><span class="value" id="vCost">$0</span></div>
  <div class="stat" title="Cost today divided by hours elapsed since today's first session activity (shown after 30 min of activity)."><span class="label">Burn rate</span><span class="value" id="vBurn">—</span></div>
  <div class="stat" title="Total memory entries discovered across CLAUDE.md / AGENTS.md / MEMORY.md / ~/.claude / ~/.codex sources. Open the Memory tab in the sidebar for per-source breakdown."><span class="label">Memory</span><span class="value" id="vMem">0</span></div>
  <div class="stat"><span class="label">Last update</span><span class="value" id="vClock">—</span></div>
</div>
<div id="alert" class="alert-banner"></div>
<div id="cards" class="cards"></div>
<div id="empty" class="empty">No active sessions in the last 2 minutes.</div>
<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  const cardsEl = document.getElementById('cards');
  const emptyEl = document.getElementById('empty');
  const alertEl = document.getElementById('alert');
  const vActive = document.getElementById('vActive');
  const vTools = document.getElementById('vTools');
  const vTokens = document.getElementById('vTokens');
  const vAgents = document.getElementById('vAgents');
  const vCost = document.getElementById('vCost');
  const vBurn = document.getElementById('vBurn');
  const vMem = document.getElementById('vMem');
  const vClock = document.getElementById('vClock');

  function fmtTok(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  function fmtDur(ms) {
    if (!ms) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s - m*60) + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m - h*60) + 'm';
  }
  function nowText(now) {
    if (now.kind === 'awaiting_user') {
      const label = now.detail === 'AskUserQuestion' ? 'awaiting your answer' : now.detail === 'ExitPlanMode' ? 'awaiting plan approval' : 'awaiting input';
      return '⚠ ' + label + (now.ageSec ? '  ·  ' + now.ageSec + 's' : '');
    }
    if (now.kind === 'in_tool') return '⚙ in tool: ' + now.detail + (now.ageSec ? '  ·  ' + now.ageSec + 's' : '');
    if (now.kind === 'responding') return '✎ responding  ·  ' + now.ageSec + 's';
    return '◌ idle  ·  ' + (now.ageSec ? 'last activity ' + now.ageSec + 's ago' : '');
  }

  function render(payload) {
    vActive.textContent = String(payload.activeCount);
    vTools.textContent = String(payload.toolsPerMin);
    vTokens.textContent = fmtTok(payload.tokensToday);
    vAgents.textContent = String(payload.subagentsToday);
    vCost.textContent = '$' + payload.costToday.toFixed(2);
    if (vBurn) {
      vBurn.textContent = payload.burnRateUsdPerHour != null
        ? '$' + payload.burnRateUsdPerHour.toFixed(2) + '/hr'
        : '—';
    }
    if (vMem) {
      const entries = payload.memoryEntries || 0;
      const files = payload.memoryFiles || 0;
      vMem.textContent = String(entries);
      vMem.title = entries + ' entries across ' + files + ' file(s)';
    }
    vClock.textContent = new Date().toLocaleTimeString();

    // Alert banner: list sessions currently parked on user input.
    const awaiting = payload.cards.filter(c => c.now.kind === 'awaiting_user');
    if (awaiting.length === 0) {
      alertEl.className = 'alert-banner';
      alertEl.textContent = '';
    } else {
      alertEl.className = 'alert-banner on';
      const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const titles = awaiting.map(a => esc(a.title)).slice(0, 3).join(', ');
      const more = awaiting.length > 3 ? ' (+' + (awaiting.length - 3) + ' more)' : '';
      alertEl.innerHTML = '<span class="dot"></span><strong>' + awaiting.length + ' session' + (awaiting.length === 1 ? '' : 's') + '</strong> awaiting your response — ' + titles + more;
    }

    if (payload.cards.length === 0) {
      emptyEl.style.display = 'block';
      cardsEl.innerHTML = '';
      return;
    }
    emptyEl.style.display = 'none';

    // Build card DOM diff-friendly: index by session_id
    const have = new Map();
    for (const child of cardsEl.children) have.set(child.dataset.id, child);

    const seen = new Set();
    for (const c of payload.cards) {
      seen.add(c.session_id);
      let el = have.get(c.session_id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'card';
        el.dataset.id = c.session_id;
        el.innerHTML = '<div class="title"></div><div class="sub"></div><div class="now"></div><div class="row"></div><div class="ctx"><span>ctx</span><div class="bar"><div class="fill"></div></div><span class="pct"></span></div>';
        cardsEl.appendChild(el);
      }
      el.classList.toggle('awaiting', c.now.kind === 'awaiting_user');
      el.querySelector('.title').textContent = c.title;
      el.querySelector('.sub').textContent = (c.project || '(no project)') + '  ·  elapsed ' + fmtDur(c.elapsedMs);
      const nowEl = el.querySelector('.now');
      nowEl.className = 'now ' + c.now.kind;
      nowEl.textContent = nowText(c.now);
      const row = el.querySelector('.row');
      row.innerHTML = '';
      const tokParts = [];
      if (c.inputTokens) tokParts.push('in ' + fmtTok(c.inputTokens));
      if (c.outputTokens) tokParts.push('out ' + fmtTok(c.outputTokens));
      const cacheTot = c.cacheReadTokens + c.cacheWriteTokens;
      if (cacheTot) tokParts.push('cache ' + fmtTok(cacheTot));
      const pills = [
        '💬 ' + c.messages + ' msgs',
        '🔧 ' + c.tools + ' tools' + (c.toolsLast60s > 0 ? ' (' + c.toolsLast60s + '/min)' : ''),
        c.subagents > 0 ? '🪄 ' + c.subagents + ' agents' : null,
        '🔢 ' + fmtTok(c.totalTokens) + (tokParts.length ? ' (' + tokParts.join(' · ') + ')' : ''),
        '$' + c.cost_usd.toFixed(2),
      ].filter(Boolean);
      for (const p of pills) {
        const span = document.createElement('span');
        span.className = 'pill';
        span.textContent = p;
        row.appendChild(span);
      }
      // Context-window gauge: green < 50%, yellow 50–79%, red ≥ 80%.
      const ctxEl = el.querySelector('.ctx');
      if (c.contextPct == null) {
        ctxEl.classList.remove('on');
      } else {
        ctxEl.classList.add('on');
        const level = c.contextPct >= 80 ? 'high' : c.contextPct >= 50 ? 'mid' : '';
        const fill = ctxEl.querySelector('.fill');
        fill.className = 'fill' + (level ? ' ' + level : '');
        fill.style.width = Math.min(100, c.contextPct) + '%';
        const pctEl = ctxEl.querySelector('.pct');
        pctEl.className = 'pct' + (level === 'high' ? ' high' : '');
        pctEl.textContent = c.contextPct + '% · ' + fmtTok(c.contextTokens) + '/' + fmtTok(c.contextLimit);
      }
    }
    // Remove cards that vanished
    for (const [id, el] of have) {
      if (!seen.has(id)) el.remove();
    }
  }

  window.addEventListener('message', (e) => {
    if (e.data?.command === 'update') render(e.data.payload);
  });
})();
</script>
</body></html>`;
}
