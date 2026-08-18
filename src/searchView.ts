// Search webview: topic full-text + conversation full-text search over the
// SQLite cache. LIKE-based; fast enough for tens of thousands of turns. The
// excerpt is rendered with the matched span highlighted.
//
// A "Semantic" toggle (default off, persisted in webview state) adds a
// cosine-ranked session pane on top; when Ollama or the vectors are missing
// the view stays on LIKE and says so via the status string.

import * as vscode from "vscode";
import { preferredEditorColumn } from "./editorColumn";
import { SessionStore } from "./db";
import { EmbedConfig } from "./embedding";
import { buildSearchResults } from "./semanticSearch";

function nonceStr(): string {
  let s = "";
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += charset[Math.floor(Math.random() * charset.length)];
  return s;
}

export function openSearchView(
  ctx: vscode.ExtensionContext,
  store: SessionStore,
  onOpenSession: (sessionId: string, title: string) => Promise<void>,
  initialQuery = "",
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    "claudeSearch",
    "Claude · Search",
    preferredEditorColumn(),
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = renderHtml(panel.webview, initialQuery);

  const cfg = vscode.workspace.getConfiguration("codeSessions");
  const embedCfg: EmbedConfig = {
    preferred: cfg.get<"ollama" | "transformersjs" | "fallback">("embedding.preferred", "ollama"),
    ollamaUrl: cfg.get<string>("embedding.ollamaUrl", "http://127.0.0.1:11434"),
    ollamaModel: cfg.get<string>("embedding.ollamaModel", "nomic-embed-text"),
  };

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.command === "query" && typeof msg.q === "string") {
      const payload = await buildSearchResults(msg.q, msg.semantic === true, store, embedCfg);
      panel.webview.postMessage(payload);
      return;
    }
    if (msg?.command === "open" && typeof msg.sessionId === "string") {
      const row = store.getById(msg.sessionId);
      await onOpenSession(msg.sessionId, row?.title || msg.sessionId.slice(0, 8));
      return;
    }
    if (msg?.command === "resume" && typeof msg.sessionId === "string") {
      // Route through the existing resume command. The handler reads .session
      // from whatever it's given, so we just hand it the id directly.
      await vscode.commands.executeCommand("codeSessions.resume", { session: msg.sessionId });
      return;
    }
  });

  // Kick off an initial query if one was passed in (e.g. from a command arg).
  if (initialQuery.trim().length > 0) {
    setTimeout(() => panel.webview.postMessage({ command: "prefill", q: initialQuery }), 50);
  }

  return panel;
}

function renderHtml(webview: vscode.Webview, initialQuery: string): string {
  const nonce = nonceStr();
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join("; ");
  const seed = JSON.stringify(initialQuery || "");

  return `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px 20px; }
  h1 { margin: 0 0 12px; font-size: 18px; }
  .searchbar { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; }
  .searchbar input { flex: 1; padding: 6px 10px; font: 13px var(--vscode-font-family); color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; }
  .searchbar input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .grid { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(360px, 1.5fr); gap: 18px; }
  @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
  .panel { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; }
  .panel h2 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); }
  .row { position: relative; padding: 6px 4px 6px 4px; padding-right: 28px; border-radius: 3px; cursor: pointer; line-height: 1.4; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row:hover .resume { opacity: 1; }
  .row .title { color: var(--vscode-textLink-foreground); }
  .row .sub { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 2px; }
  .row .excerpt { font-size: 11.5px; color: var(--vscode-editor-foreground); margin-top: 4px; white-space: pre-wrap; max-height: 4.5em; overflow: hidden; }
  .row .resume { position: absolute; right: 4px; top: 6px; opacity: 0.55; font-size: 12px; padding: 2px 8px; border-radius: 3px; color: var(--vscode-textLink-foreground); user-select: none; cursor: pointer; }
  .row .resume:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.18)); opacity: 1; }
  .row .proj { display: inline-block; padding: 0 6px; font-size: 10.5px; border-radius: 8px; background: rgba(127,127,127,0.16); color: var(--vscode-descriptionForeground); margin-right: 6px; vertical-align: middle; font-family: var(--vscode-editor-font-family, monospace); }
  .badge { display: inline-block; padding: 1px 6px; font-size: 10px; border-radius: 8px; background: rgba(127,127,127,0.18); color: var(--vscode-descriptionForeground); margin-left: 6px; vertical-align: middle; }
  .badge.user { background: rgba(74, 144, 226, 0.20); color: #4a90e2; }
  .badge.assistant { background: rgba(62, 207, 142, 0.20); color: #3ecf8e; }
  mark { background: var(--vscode-editor-findMatchHighlightBackground, rgba(240,160,80,0.4)); color: inherit; padding: 0 1px; border-radius: 2px; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 4px 0; }
  .semtoggle { display: flex; align-items: center; gap: 4px; white-space: nowrap; cursor: pointer; user-select: none; }
  .sempane { margin-bottom: 14px; }
  .score { display: inline-block; min-width: 34px; font-size: 10.5px; font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-descriptionForeground); margin-right: 6px; }
</style>
</head><body>
<h1>Search Claude history</h1>
<div class="searchbar">
  <input id="q" type="search" placeholder="Search topics and conversations…" autofocus>
  <label class="meta semtoggle"><input id="sem" type="checkbox"> Semantic</label>
  <span class="meta" id="status">Type to search</span>
</div>
<section class="panel sempane" id="semPane" style="display:none">
  <h2>Sessions (semantic)</h2>
  <div id="semBody"></div>
</section>
<div class="grid">
  <section class="panel">
    <h2>Topics</h2>
    <div id="topicsBody"></div>
  </section>
  <section class="panel">
    <h2>Conversations</h2>
    <div id="convBody"></div>
  </section>
</div>
<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  const qEl = document.getElementById('q');
  const statusEl = document.getElementById('status');
  const topicsBody = document.getElementById('topicsBody');
  const convBody = document.getElementById('convBody');
  const semEl = document.getElementById('sem');
  const semPane = document.getElementById('semPane');
  const semBody = document.getElementById('semBody');

  const initial = ${seed};
  if (initial) { qEl.value = initial; }
  semEl.checked = !!(vscode.getState() || {}).semantic;

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function escRe(s) { return s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'); }
  // Multi-word queries AND their tokens in the DB; highlight each token
  // individually so "async runKp" marks both words (not only a contiguous phrase).
  function queryTokens(q) {
    return String(q || '').trim().split(/\\s+/).filter(Boolean);
  }
  function highlight(text, q) {
    const safe = escHtml(text || '');
    const toks = queryTokens(q);
    if (!toks.length) return safe;
    // Longer tokens first so a short token nested in a longer one doesn't
    // split a match mid-way after the first replace (best-effort).
    const ordered = toks.slice().sort((a, b) => b.length - a.length);
    const re = new RegExp('(' + ordered.map(escRe).join('|') + ')', 'gi');
    return safe.replace(re, '<mark>$1</mark>');
  }
  function timeAgo(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s/60) + 'm ago';
    if (s < 86400) return Math.floor(s/3600) + 'h ago';
    return Math.floor(s/86400) + 'd ago';
  }
  // Client-side fallback when a result has no server-built snippet (topics,
  // or older hosts). Windows on the earliest of any query token.
  function snippet(text, q, around) {
    if (!text) return '';
    const toks = queryTokens(q);
    const lc = text.toLowerCase();
    let best = -1;
    for (const t of toks) {
      const i = lc.indexOf(t.toLowerCase());
      if (i >= 0 && (best < 0 || i < best)) best = i;
    }
    if (best < 0) return text.length > around ? text.slice(0, around) + '…' : text;
    let start = Math.max(0, best - Math.floor(around / 2));
    let end = Math.min(text.length, start + around);
    if (end - start < around) start = Math.max(0, end - around);
    return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  }

  function renderTopics(rows, q) {
    if (!q.trim()) { topicsBody.innerHTML = '<div class="empty">Type to search.</div>'; return; }
    if (rows.length === 0) { topicsBody.innerHTML = '<div class="empty">No topic matches.</div>'; return; }
    topicsBody.innerHTML = rows.map(r => {
      const proj = r.project_id ? '<span class="proj" title="' + escHtml(r.project_path || '') + '">' + escHtml(r.project_id) + '</span>' : '';
      return '<div class="row" data-sid="' + escHtml(r.session_id) + '">' +
        '<div>' + proj + '<strong>' + highlight(r.topic, q) + '</strong><span class="badge">' + r.count + '</span></div>' +
        '<div class="sub">' + escHtml(r.title || r.session_id.slice(0,8)) + (r.last_ts ? ' · ' + timeAgo(r.last_ts) : '') + '</div>' +
        '<span class="resume" data-resume="' + escHtml(r.session_id) + '" title="Continue in Claude">▶</span>' +
      '</div>';
    }).join('');
  }
  function renderConversations(rows, q) {
    if (!q.trim()) { convBody.innerHTML = '<div class="empty">Type to search.</div>'; return; }
    if (rows.length === 0) { convBody.innerHTML = '<div class="empty">No turn matches.</div>'; return; }
    convBody.innerHTML = rows.map(r => {
      const which = r.matched;
      const badge = which === 'user' ? '<span class="badge user">user</span>'
                  : which === 'assistant' ? '<span class="badge assistant">assistant</span>'
                  : '<span class="badge">both</span>';
      // Prefer the server-built match-window (from assistant_full when needed)
      // so deep hits still show the matched term. Fall back for older payloads.
      const excerpt = (r.snippet && String(r.snippet)) || (() => {
        const source = which === 'assistant' ? r.assistant_excerpt : r.user_text;
        const fallback = source || r.assistant_excerpt || r.user_text || '';
        return snippet(fallback, q, 180);
      })();
      const proj = r.project_id ? '<span class="proj" title="' + escHtml(r.project_path || '') + '">' + escHtml(r.project_id) + '</span>' : '';
      return '<div class="row" data-sid="' + escHtml(r.session_id) + '">' +
        '<div>' + proj + '<span class="title">' + escHtml(r.title || r.session_id.slice(0,8)) + '</span>' + badge +
          '<span class="meta"> · turn ' + r.turn_index + (r.ts ? ' · ' + timeAgo(r.ts) : '') + '</span></div>' +
        '<div class="excerpt">' + highlight(excerpt, q) + '</div>' +
        '<span class="resume" data-resume="' + escHtml(r.session_id) + '" title="Continue in Claude">▶</span>' +
      '</div>';
    }).join('');
  }

  function renderSemantic(sem, q) {
    if (!semEl.checked || !sem) { semPane.style.display = 'none'; semBody.innerHTML = ''; return; }
    semPane.style.display = '';
    if (!sem.available) { semBody.innerHTML = '<div class="empty">' + escHtml(sem.status) + '</div>'; return; }
    if (sem.rows.length === 0) { semBody.innerHTML = '<div class="empty">No sessions above the score floor.</div>'; return; }
    semBody.innerHTML = sem.rows.map(r => {
      const proj = r.project_id ? '<span class="proj">' + escHtml(r.project_id) + '</span>' : '';
      return '<div class="row" data-sid="' + escHtml(r.session_id) + '">' +
        '<div><span class="score">' + r.score.toFixed(2) + '</span>' + proj +
          '<span class="title">' + escHtml(r.title || r.session_id.slice(0,8)) + '</span></div>' +
        '<span class="resume" data-resume="' + escHtml(r.session_id) + '" title="Continue in Claude">▶</span>' +
      '</div>';
    }).join('');
  }

  // Debounced query — semantic queries hit Ollama, so they debounce longer.
  let timer = null;
  function fireQuery() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const q = qEl.value;
      statusEl.textContent = q.trim() ? 'Searching…' : 'Type to search';
      vscode.postMessage({ command: 'query', q, semantic: semEl.checked });
    }, semEl.checked ? 300 : 180);
  }
  qEl.addEventListener('input', fireQuery);
  semEl.addEventListener('change', () => {
    vscode.setState(Object.assign({}, vscode.getState() || {}, { semantic: semEl.checked }));
    if (!semEl.checked) renderSemantic(null, '');
    fireQuery();
  });

  // Click delegation
  function onRowClick(ev) {
    // Resume button intercepts the row click — Continue-in-Claude path.
    const resumeEl = ev.target.closest('.resume');
    if (resumeEl) {
      ev.stopPropagation();
      const sid = resumeEl.getAttribute('data-resume');
      if (sid) vscode.postMessage({ command: 'resume', sessionId: sid });
      return;
    }
    const row = ev.target.closest('.row');
    if (!row) return;
    const sid = row.getAttribute('data-sid');
    if (sid) vscode.postMessage({ command: 'open', sessionId: sid });
  }
  topicsBody.addEventListener('click', onRowClick);
  convBody.addEventListener('click', onRowClick);
  semBody.addEventListener('click', onRowClick);

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m) return;
    if (m.command === 'results') {
      renderTopics(m.topics || [], m.q);
      renderConversations(m.conversations || [], m.q);
      renderSemantic(m.q.trim() ? m.semantic : null, m.q);
      const total = (m.topics?.length || 0) + (m.conversations?.length || 0);
      const counts = m.q.trim() ? (total + ' match' + (total === 1 ? '' : 'es')) : 'Type to search';
      statusEl.textContent = m.semantic ? counts + ' · ' + m.semantic.status : counts;
    } else if (m.command === 'prefill') {
      qEl.value = m.q;
      fireQuery();
    }
  });

  if (initial) fireQuery();
})();
</script>
</body></html>`;
}
