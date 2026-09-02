// Full-page Planning Dashboard webview — the interactive cockpit.
//
// One editor tab with a Board (polished kanban, drag-and-drop), a meaningful
// force-directed Graph, and a Canvas (Excalidraw, staged), plus a right-hand detail
// drawer that loads `kp show <id>` (body + resolved references + children) and exposes
// agent actions (Ideate / Draft spec / Decompose / Execute) and Open-in-Code-Build.
//
// The host (planning.ts) injects the data/runner deps so this file stays UI-only.

import * as vscode from "vscode";

export interface DashboardDeps {
  /** extension install root — used to load media/planning-dashboard.js into the webview */
  extensionUri: vscode.Uri;
  getSnapshot: () => unknown | null;
  reload: () => Promise<boolean>;
  onChange: vscode.Event<void>;
  runKp: (args: string[], input?: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  /** delegate open-file / agent actions to the host (needs vscode + terminals) */
  onAction: (msg: { type: string; [k: string]: unknown }) => void | Promise<void>;
  /** rich session list from the ~/.sessions git store, for the Sessions view */
  listSessions?: () => unknown[];
  /** the user is interacting with the board — arm aggressive store polling */
  noteActivity?: () => void;
  /** current store-sync status for the header indicator */
  getSyncStatus?: () => unknown;
  /** subscribe to store-sync status changes (returns a disposable) */
  onSyncStatus?: (cb: (s: unknown) => void) => vscode.Disposable;
  /** kp export / parse progress for the load overlay */
  getLoadStatus?: () => unknown;
  onLoadStatus?: (cb: (s: unknown) => void) => vscode.Disposable;
  /** Embedded planning chat (headless claude with kp access). */
  chat?: {
    send: (text: string, runtime?: unknown) => void;
    cancel: () => void;
    onEvent: vscode.Event<unknown>;
    history: () => unknown[];
    busy: () => boolean;
    /** { fullAllowed, defaultModel } for the drawer's runtime controls. */
    runtimeInfo?: () => unknown;
  };
}

function nonce(): string {
  let s = "";
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 24; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

export class DashboardPanel {
  static current: DashboardPanel | undefined;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  /** Open (or reveal) the dashboard with the chat drawer opened. */
  static showChat(deps: DashboardDeps): void {
    DashboardPanel.show(deps);
    DashboardPanel.current?.post({ type: "openChat" });
  }

  /** Close the board if open (planning-mode toggle keybinding). */
  static close(): void {
    DashboardPanel.current?.panel.dispose();
  }

  static show(deps: DashboardDeps, view?: string, itemId?: string): void {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      if (view) DashboardPanel.current.panel.webview.postMessage({ type: "setView", view });
      if (itemId) DashboardPanel.current.panel.webview.postMessage({ type: "openItem", id: itemId });
      return;
    }
    DashboardPanel.current = new DashboardPanel(deps, view, itemId);
  }

  private constructor(private deps: DashboardDeps, private initialView?: string, private initialItem?: string) {
    const mediaRoot = vscode.Uri.joinPath(deps.extensionUri, "media");
    this.panel = vscode.window.createWebviewPanel("codePlanningDashboard", "Planning Dashboard", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot],
    });
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), null, this.disposables);
    this.deps.onChange(() => this.pushSnapshot(), null, this.disposables);
    // Store-sync status → header indicator; arm aggressive polling when the panel
    // has focus (a pull that advances HEAD reloads the snapshot via onChange).
    if (this.deps.onSyncStatus) this.disposables.push(this.deps.onSyncStatus((s) => this.post({ type: "syncStatus", data: s })));
    if (this.deps.onLoadStatus) this.disposables.push(this.deps.onLoadStatus((s) => this.post({ type: "loadStatus", data: s })));
    if (this.deps.chat) this.disposables.push(this.deps.chat.onEvent((ev) => this.post({ type: "chatEvent", data: ev })));
    this.disposables.push(
      this.panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) this.deps.noteActivity?.();
      }),
    );
    this.panel.webview.html = this.html();
    // Don't wait for the webview `ready` ping — if the big script fails to
    // parse, we'd otherwise sit on the HTML default forever. Pump status
    // and kick export immediately.
    this.post({ type: "loadStatus", data: this.deps.getLoadStatus?.() ?? { phase: "idle", detail: "webview opened" } });
    if (!this.deps.getSnapshot()) void this.deps.reload();
    const pump = setInterval(() => {
      this.post({ type: "loadStatus", data: this.deps.getLoadStatus?.() });
    }, 1000);
    this.disposables.push({ dispose: () => clearInterval(pump) });
  }

  private pushSnapshot(): void {
    this.panel.webview.postMessage({ type: "snapshot", data: this.deps.getSnapshot() });
  }

  private async onMessage(m: { type: string; [k: string]: unknown }): Promise<void> {
    switch (m.type) {
      case "ready":
        if (this.deps.getLoadStatus) this.post({ type: "loadStatus", data: this.deps.getLoadStatus() });
        this.pushSnapshot();
        if (this.deps.getSyncStatus) this.post({ type: "syncStatus", data: this.deps.getSyncStatus() });
        this.deps.noteActivity?.();
        if (this.initialView) this.panel.webview.postMessage({ type: "setView", view: this.initialView });
        if (this.initialItem) this.panel.webview.postMessage({ type: "openItem", id: this.initialItem });
        break;
      case "activity":
        this.deps.noteActivity?.();
        break;
      case "chatSend":
        this.deps.chat?.send(String(m.text ?? ""), m.runtime);
        break;
      case "chatCancel":
        this.deps.chat?.cancel();
        break;
      case "chatHistory":
        this.post({
          type: "chatHistory",
          data: this.deps.chat?.history() ?? [],
          busy: this.deps.chat?.busy() ?? false,
          enabled: !!this.deps.chat,
          runtime: this.deps.chat?.runtimeInfo?.(),
        });
        break;
      case "requestSessions":
        this.post({ type: "sessions", data: this.deps.listSessions?.() ?? [] });
        break;
      case "syncNow":
        void vscode.commands.executeCommand("codeSessions.syncStoresNow");
        break;
      case "refresh":
        await this.deps.reload();
        this.pushSnapshot();
        break;
      case "show": {
        const res = await this.deps.runKp(["show", String(m.id)]);
        if (res.ok) {
          try {
            this.panel.webview.postMessage({ type: "detail", data: JSON.parse(res.stdout) });
          } catch {
            /* ignore */
          }
        }
        break;
      }
      case "setStatus":
        await this.deps.runKp(["set-status", String(m.id), String(m.status)]);
        await this.deps.reload();
        this.pushSnapshot();
        // refresh the open drawer
        if (m.id) await this.onMessage({ type: "show", id: m.id });
        break;
      case "setStatusApply": {
        // closing move with an optional resolution note (from the modal)
        const args = ["set-status", String(m.id), String(m.status)];
        const note = String(m.note ?? "").trim();
        if (note) args.push("--note", note);
        await this.deps.runKp(args);
        await this.deps.reload();
        this.pushSnapshot();
        if (m.id) await this.onMessage({ type: "show", id: m.id });
        break;
      }
      case "setDue":
        await this.deps.runKp(["set-due", String(m.id), String(m.due || "-")]);
        await this.deps.reload();
        this.pushSnapshot();
        if (m.id) await this.onMessage({ type: "show", id: m.id });
        break;
      case "setPriority":
        await this.deps.runKp(["set-priority", String(m.id), String(m.priority || "-")]);
        await this.deps.reload();
        this.pushSnapshot();
        if (m.id) await this.onMessage({ type: "show", id: m.id });
        break;
      case "setProject":
        await this.deps.runKp(["set-project", String(m.id), String(m.project || "-")]);
        await this.deps.reload();
        this.pushSnapshot();
        if (m.id) await this.onMessage({ type: "show", id: m.id });
        break;
      default:
        await this.deps.onAction(m); // open / action (agent, CB, promote, link, capture)
    }
  }

  post(msg: unknown): void {
    this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    DashboardPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private html(): string {
    const n = nonce();
    const cs = this.panel.webview.cspSource;
    const jsUri = this.panel.webview
      .asWebviewUri(vscode.Uri.joinPath(this.deps.extensionUri, "media", "planning-dashboard.js"))
      .toString();
    // script-src must allow the vscode-webview: origin so <script src> loads.
    // The dashboard JS is an external file — never interpolate it through a
    // TS template (that turns '\n' into a real newline and document.write throws).
    const csp = `default-src 'none'; style-src 'unsafe-inline' ${cs}; script-src 'nonce-${n}' ${cs}; img-src data:;`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${STYLE}</style></head>
<body>
<div id="topbar">
  <span class="brand">◧ Planning</span>
  <div class="seg" id="viewSeg">
    <button data-view="board" class="on">Board</button>
    <button data-view="inbox">Inbox</button>
    <button data-view="autonomous">🤖 Auto</button>
    <button data-view="projects">Projects</button>
    <button data-view="sessions">Fleet</button>
    <button data-view="social">✨ Social</button>
    <button data-view="calendar">Calendar</button>
    <button data-view="graph">Graph</button>
    <button data-view="canvas">Canvas</button>
  </div>
  <div class="seg" id="laneSeg">
    <button data-lane="task" class="on">Tasks</button>
    <button data-lane="idea">Ideas</button>
    <button data-lane="plan">Plans</button>
    <button data-lane="thought">Thoughts</button>
  </div>
  <div class="seg" id="calModeSeg" style="display:none">
    <button data-cm="month" class="on">Month</button>
    <button data-cm="week">Week</button>
    <button data-cm="workweek">Work week</button>
    <button data-cm="list">List</button>
  </div>
  <select id="groupBy" title="Group lanes by">
    <option value="status">▦ status</option>
    <option value="domain">▦ domain</option>
    <option value="type">▦ type</option>
    <option value="lane">▦ lane</option>
    <option value="project">▦ project</option>
  </select>
  <select id="sortBy" title="Sort cards within lanes">
    <option value="priority">↕ priority</option>
    <option value="due">↕ due</option>
    <option value="updated">↕ updated</option>
    <option value="title">↕ title</option>
    <option value="project">↕ project</option>
    <option value="domain">↕ domain</option>
    <option value="type">↕ type</option>
  </select>
  <button id="addLaneBtn" class="ghost" title="Add a custom lane">＋ lane</button>
  <span class="spacer"></span>
  <span id="inboxPill" class="ipill" title="Freshly-captured items to triage — click to open the Inbox" style="display:none"></span>
  <span id="overduePill" class="opill" title="Past-due, not-completed tasks — click to filter the board" style="display:none"></span>
  <span id="syncPill" class="syncpill" title="Store sync status — click to sync now">◌ sync</span>
  <span id="counts" class="counts"></span>
  <input id="search" placeholder="Search… (⌘F)" style="display:none;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:6px;padding:3px 8px;width:180px">
  <button id="chatBtn" class="ghost" title="Chat with the planning agent — ask it to find, create, link, and review ideas/sessions">💬 Chat</button>
  <button id="captureBtn" class="ghost">＋ New</button>
  <button id="syncBtn" class="ghost" title="Run a sync script (scripts/sync/ — sync.sh is the default)">⟳ Sync</button>
  <button id="refreshBtn" class="ghost" title="Refresh snapshot">⟳</button>
</div>
<div id="chatDrawer" class="hidden">
  <div class="chat-head">
    <b>Planning chat</b>
    <span id="chatCost" class="chat-cost"></span>
    <span class="spacer"></span>
    <button id="chatStop" class="ghost" style="display:none">■ Stop</button>
    <button id="chatClose" class="ghost">✕</button>
  </div>
  <div id="chatMsgs" class="chat-msgs">
    <div class="chat-hint">Ask the agent to work the plan — it can read and modify the knowledge base via <code>kp</code>.</div>
    <div class="chat-chips">
      <button class="chat-chip">Identify all ideas for today</button>
      <button class="chat-chip">Find and connect sessions to ideas</button>
      <button class="chat-chip">Review recent sessions — which ideas are missing?</button>
      <button class="chat-chip">Create ideas from my list, skip duplicates</button>
    </div>
  </div>
  <div class="chat-ctlrow">
    <select id="chatProvider" title="Provider"></select>
    <select id="chatModel" title="Model"></select>
    <select id="chatEffort" title="Reasoning effort"></select>
    <select id="chatAccess" title="Tool access — kp-only is an enforced boundary; full requires the fullAccess setting">
      <option value="kp">kp-only</option>
      <option value="full">full access</option>
    </select>
  </div>
  <div class="chat-inputrow">
    <textarea id="chatInput" rows="2" placeholder="Ask about or modify the plan… (Enter to send, Shift+Enter newline)"></textarea>
    <button id="chatSend">Send</button>
  </div>
</div>
<div id="main">
  <div id="board" class="view"></div>
  <div id="inbox" class="view hidden"></div>
  <div id="autonomous" class="view hidden"></div>
  <div id="projects" class="view hidden"></div>
  <div id="sessions" class="view hidden"></div>
  <div id="social" class="view hidden"></div>
  <div id="calendar" class="view hidden"></div>
  <svg id="graph" class="view hidden"></svg>
  <div id="canvas" class="view hidden"></div>
  <div id="gfilters" class="hidden"></div>
  <div id="loadOverlay">
    <div class="loadcard">
      <div class="loadspin" id="loadSpin"></div>
      <div id="loadTitle">Loading planning store</div>
      <div id="loadDetail">waiting for kp export…</div>
      <div id="loadTime"></div>
      <button id="loadRetry" class="ghost" style="display:none">Retry export</button>
    </div>
  </div>
</div>
<div id="drawer" class="hidden"><div id="drawerInner"></div></div>
<div id="backdrop" class="hidden"></div>
<div id="resmodal" class="hidden">
  <div class="resbox">
    <div class="reshead"><span id="resTitle"></span><button id="resX" class="dclose">✕</button></div>
    <div id="resSub" class="ressub"></div>
    <textarea id="resNote" placeholder="What resolved it / why is it being closed? (optional — leave empty to move without a note)"></textarea>
    <div class="resactions">
      <button id="resCancel" class="ghost">Cancel move</button>
      <button id="resSkip" class="ghost">Move, no note</button>
      <button id="resSave" class="ghost primary">Save note & move</button>
    </div>
  </div>
</div>
<script nonce="${n}">
document.body.dataset.view = document.body.dataset.view || 'board';
window.addEventListener('error', function (ev) {
  var d = document.getElementById('loadDetail');
  var t = document.getElementById('loadTitle');
  if (t) t.textContent = 'Dashboard script error';
  if (d) d.textContent = String(ev.message || ev.error || 'unknown') + (ev.lineno ? ' @' + ev.lineno : '');
});
</script>
<script nonce="${n}" src="${jsUri}"></script>
</body></html>`;
  }
}

// ---------------------------------------------------------------- styles -----
const STYLE = `
/* ---- embedded planning chat drawer ---- */
#chatDrawer{position:fixed;top:40px;right:0;bottom:0;width:380px;max-width:85vw;z-index:30;display:flex;flex-direction:column;
  background:var(--vscode-sideBar-background,#1e1e1e);border-left:1px solid var(--vscode-widget-border,#444);}
#chatDrawer.hidden{display:none}
.chat-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--vscode-widget-border,#444)}
.chat-cost{font-size:11px;opacity:.7}
.chat-msgs{flex:1;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:8px;font-size:12.5px;line-height:1.5}
.chat-hint{opacity:.75;font-size:12px}
.chat-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.chat-chip{font-size:11.5px;padding:4px 8px;border-radius:10px;cursor:pointer;border:1px solid var(--vscode-widget-border,#555);
  background:var(--vscode-button-secondaryBackground,#333);color:var(--vscode-button-secondaryForeground,#ddd)}
.chat-chip:hover{filter:brightness(1.15)}
.chat-m{white-space:pre-wrap;word-break:break-word;border-radius:8px;padding:6px 9px;max-width:96%}
.chat-m.user{align-self:flex-end;background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff)}
.chat-m.agent{align-self:flex-start;background:var(--vscode-editorWidget-background,#2a2a2a)}
.chat-m.result{align-self:flex-start;background:var(--vscode-editorWidget-background,#2a2a2a);border:1px solid var(--vscode-widget-border,#444)}
.chat-m.error{align-self:flex-start;background:rgba(200,60,60,.18);border:1px solid rgba(200,60,60,.5)}
.chat-tool{align-self:flex-start;font-size:11px;opacity:.65;font-family:var(--vscode-editor-font-family,monospace)}
.chat-status{align-self:center;font-size:11px;opacity:.6;font-style:italic}
.chat-ctlrow{display:flex;gap:6px;padding:6px 8px 0 8px;border-top:1px solid var(--vscode-widget-border,#444)}
.chat-ctlrow select{flex:1;min-width:0;font-size:11px;background:var(--vscode-dropdown-background,#3c3c3c);color:var(--vscode-dropdown-foreground,#ddd);border:1px solid var(--vscode-dropdown-border,#555);border-radius:5px;padding:2px 4px}
.chat-inputrow{display:flex;gap:6px;padding:8px;border-top:none}
.chat-inputrow textarea{flex:1;resize:none;background:var(--vscode-input-background);color:var(--vscode-input-foreground);
  border:1px solid var(--vscode-input-border,#555);border-radius:6px;padding:6px 8px;font:inherit;font-size:12.5px}
.chat-inputrow button{border:none;border-radius:6px;padding:0 14px;cursor:pointer;
  background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff)}
.chat-inputrow button:disabled{opacity:.5;cursor:default}
#chatBtn.on{outline:1px solid var(--vscode-focusBorder,#0e639c)}

:root{ --gap:10px; }
*{box-sizing:border-box}
html,body{position:fixed;inset:0;width:100%;height:100%;margin:0}
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);overflow:hidden;display:flex;flex-direction:column}
/* Top bar must wrap when the editor group is minimized/narrow so view tabs
   (Sessions, Projects, …) never fall off-screen past the right edge. */
#topbar{display:flex;align-items:center;gap:8px 10px;padding:8px 10px;border-bottom:1px solid var(--vscode-widget-border);flex:0 0 auto;flex-wrap:wrap;row-gap:6px;min-width:0}
.brand{font-weight:700;letter-spacing:.3px;flex:none}
/* View tabs are the primary nav — keep them fully reachable via wrap/scroll. */
#viewSeg{flex:1 1 auto;min-width:min(100%,220px);max-width:100%;overflow-x:auto;flex-wrap:nowrap;scrollbar-width:thin}
#viewSeg button{flex:none;white-space:nowrap}
.spacer{flex:1 1 40px;min-width:8px}
.counts{opacity:.7;font-size:12px;flex:none}
.syncpill{font-size:11px;padding:2px 9px;border-radius:11px;border:1px solid var(--vscode-widget-border);cursor:pointer;white-space:nowrap;display:inline-flex;gap:5px;align-items:center;opacity:.9}
.syncpill:hover{background:var(--vscode-toolbar-hoverBackground)}
.syncpill.ok{border-color:#4ec9b0}
.syncpill.syncing{border-color:var(--vscode-focusBorder)}
.syncpill.warn{border-color:#d16969;color:#e6a4a4}
.syncpill.active{box-shadow:0 0 0 1px var(--vscode-focusBorder) inset}
.ipill{font-size:11px;padding:2px 9px;border-radius:11px;border:1px solid var(--vscode-widget-border);color:var(--vscode-foreground);cursor:pointer;white-space:nowrap;align-items:center;opacity:.9}
.ipill:hover{background:var(--vscode-toolbar-hoverBackground)}
.ipill.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:var(--vscode-button-background)}
.opill{font-size:11px;padding:2px 9px;border-radius:11px;border:1px solid #d16969;color:#e6a4a4;cursor:pointer;white-space:nowrap;align-items:center}
.opill:hover{background:var(--vscode-toolbar-hoverBackground)}
.opill.on{background:#d16969;color:#fff;border-color:#d16969}
.boardfilter .ghost.on{background:#d16969;color:#fff;border-color:#d16969}
#resmodal{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}
#resmodal.hidden{display:none!important}
.resbox{background:var(--vscode-editorWidget-background,var(--vscode-editor-background));border:1px solid var(--vscode-widget-border);border-radius:10px;width:min(560px,92vw);max-height:80vh;display:flex;flex-direction:column;padding:16px 18px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
.reshead{display:flex;align-items:flex-start;gap:8px}
.reshead span{font-size:14px;font-weight:600;flex:1;line-height:1.3}
.ressub{font-size:12px;opacity:.7;margin:4px 0 10px}
#resNote{width:100%;min-height:160px;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:6px;padding:9px 10px;font-family:var(--vscode-editor-font-family);font-size:13px;line-height:1.5}
.resactions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
.resactions .primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:var(--vscode-button-background)}
/* Scrollable content views: fill #main (absolute inset:0) and scroll inside.
   Without overflow + min-height chain, minimized panes clip sessions/lists. */
#autonomous,#sessions,#social,#inbox,#projects,#calendar{padding:16px;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;min-height:0}
#sessions.fleet-shell{padding:0;overflow:hidden;display:flex;flex-direction:column}
#autonomous{max-width:900px}
.autorow{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:14px}
.autostat{display:flex;flex-direction:column;gap:2px}
.autostat .l{font-size:10px;text-transform:uppercase;letter-spacing:.5px;opacity:.55}
.autostat .v{font-size:13px;font-weight:600}
.autosec{margin:14px 0;border-top:1px solid var(--vscode-widget-border);padding-top:10px}
.autosec h4{margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;opacity:.6}
.autoline{font-size:12px;padding:4px 0;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.autoline .lnk{color:var(--vscode-textLink-foreground);cursor:pointer}
.speclnk{color:var(--vscode-textLink-foreground);cursor:pointer;font-size:12px}
.speclnk:hover{text-decoration:underline}
.ph{font-size:10px;padding:1px 7px;border-radius:9px;font-weight:600;flex:none}
.ph.ide{background:#3b6ea5;color:#fff}.ph.imp{background:#4e8f6e;color:#fff}.ph.nxt{background:#7a6ea0;color:#fff}.ph.rep{background:#8a6d3b;color:#fff}
.usagebar{height:8px;border-radius:5px;background:var(--vscode-widget-border);overflow:hidden;margin:4px 0 10px;max-width:360px}
.usagefill{height:100%;background:var(--vscode-progressBar-background,#3b6ea5)}
.sessbar{display:flex;gap:8px;align-items:center;margin:0;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--vscode-widget-border);background:var(--vscode-editor-background);flex:none}
.sesssearch{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:6px;padding:4px 9px;width:min(220px,100%);min-width:120px;flex:1 1 140px}
.sesscount{font-size:11px;opacity:.7;padding:4px 12px 0;flex:none}
.sesslist{display:flex;flex-direction:column;gap:8px;max-width:820px;min-width:0;width:100%}
.sesscard{background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border);border-radius:8px;padding:10px 12px;cursor:pointer;min-width:0}
.sesscard:hover{border-color:var(--vscode-focusBorder)}
.sesscard .sh{display:flex;justify-content:space-between;gap:10px;align-items:baseline;min-width:0}
.sesscard .ct{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.sesscard .cm{opacity:.6;font-size:11px;flex:none}
.sesscard .sm{display:flex;gap:8px;opacity:.7;font-size:11px;margin-top:5px;flex-wrap:wrap}
.sesscard .sacts{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
#fleetBoard{flex:1 1 auto;min-height:0;overflow:auto;padding:8px 10px 10px;display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:10px;align-content:start}
.fleetcol{background:color-mix(in srgb, var(--vscode-editorWidget-background) 88%, transparent);border:1px solid var(--vscode-widget-border);border-radius:10px;padding:6px;min-width:0;display:flex;flex-direction:column;min-height:0}
.fleethost{display:flex;align-items:center;gap:8px;font-weight:700;font-size:12px;padding:4px 8px 6px;letter-spacing:.2px;position:sticky;top:0;background:var(--vscode-editorWidget-background);z-index:1}
.fleet-row{display:grid;grid-template-columns:10px 52px minmax(0,1fr) auto;gap:8px;align-items:center;padding:5px 8px;border-radius:7px;cursor:pointer;min-width:0}
.fleet-row:hover{background:var(--vscode-list-hoverBackground)}
.fleet-row.on{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.fleet-row.auto{opacity:.72}
.fleet-row.live{box-shadow:inset 2px 0 0 #4ec9b0}
.fleet-row .when{font-variant-numeric:tabular-nums;opacity:.55;font-size:11px}
.fleet-row .ttl{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.fleet-row .meta{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;opacity:.75;font-size:10px}
.fleet-row .acts{display:none;grid-column:1/-1;gap:6px;padding:2px 0 4px}
.fleet-row:hover .acts,.fleet-row.on .acts{display:flex;flex-wrap:wrap}
.badge.auto{background:#6b5b3a;color:#f3e6c4}
.pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:#4ec9b0;box-shadow:0 0 0 0 rgba(78,201,176,.7);animation:pulse 1.6s infinite}
.pulse.remote{background:#dcdcaa;box-shadow:0 0 0 0 rgba(220,220,170,.7)}
.pulse.open{background:#888;box-shadow:none;animation:none}
.pulse.ended{background:#555;box-shadow:none;animation:none}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(78,201,176,.55)}70%{box-shadow:0 0 0 8px rgba(78,201,176,0)}100%{box-shadow:0 0 0 0 rgba(78,201,176,0)}}
.sesscard.live{border-color:#4ec9b0}
.sessdrawer{margin:4px 8px 8px;border:1px solid var(--vscode-widget-border);border-radius:8px;padding:10px;background:var(--vscode-editor-background)}
.sessdrawer textarea{width:100%;min-height:56px;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:6px;padding:8px;font-family:var(--vscode-font-family);font-size:12px}
.sessdrawer .ans{white-space:pre-wrap;font-size:12px;line-height:1.45;margin-top:8px}
#fleetChat{flex:none;border-top:1px solid var(--vscode-widget-border);background:var(--vscode-editorWidget-background);display:flex;flex-direction:column;min-height:36px;max-height:46%}
#fleetChat.open{min-height:220px}
.fc-bar{display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;font-size:12px;user-select:none}
.fc-bar:hover{background:var(--vscode-toolbar-hoverBackground)}
.fc-bar .hint{opacity:.6;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fc-body{display:none;flex-direction:column;min-height:0;flex:1;border-top:1px solid var(--vscode-widget-border)}
#fleetChat.open .fc-body{display:flex}
.fc-chips{display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px 0}
.fc-chip{font-size:11px;padding:3px 8px;border-radius:999px;border:1px solid var(--vscode-widget-border);background:transparent;color:var(--vscode-foreground);cursor:pointer}
.fc-chip:hover{border-color:var(--vscode-focusBorder)}
.fc-log{flex:1;overflow:auto;padding:8px 12px;font-size:12px;line-height:1.45}
.fc-msg{margin:0 0 8px;padding:8px 10px;border-radius:8px;max-width:95%}
.fc-msg.user{background:var(--vscode-button-background);color:var(--vscode-button-foreground);margin-left:auto}
.fc-msg.bot{background:var(--vscode-editor-background);border:1px solid var(--vscode-widget-border)}
.fc-msg .md{white-space:pre-wrap}
.fc-suggest{padding:0 12px 8px;display:flex;flex-direction:column;gap:6px;max-height:140px;overflow:auto}
.fc-act{display:flex;align-items:center;gap:8px;font-size:12px;padding:5px 8px;border:1px solid var(--vscode-widget-border);border-radius:7px}
.fc-act .lab{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fc-input{display:flex;gap:8px;padding:8px 12px 10px;align-items:flex-end}
.fc-input textarea{flex:1;min-height:40px;max-height:90px;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:7px;padding:7px 9px;font-family:var(--vscode-font-family);font-size:12px}
.srefs{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;min-width:0}
.socialdrop{border:1px dashed var(--vscode-widget-border);border-radius:8px;padding:10px;text-align:center;font-size:12px;opacity:.6;margin-bottom:12px}
.socialdrop.over{border-color:var(--vscode-focusBorder);background:var(--vscode-list-hoverBackground);opacity:1}
.sociallist{display:flex;flex-direction:column;gap:8px;max-width:760px}
.socialcard{background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border);border-radius:8px;padding:10px 12px}
.socialcard .sh{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.socialcard .ct{font-weight:600;font-size:13px}
.socialcard .cm{display:flex;gap:6px;opacity:.7;font-size:11px;flex:none}
.sacts{display:flex;gap:6px;margin-top:8px}
.seg{display:inline-flex;border:1px solid var(--vscode-widget-border);border-radius:7px;overflow:hidden}
.seg button{background:transparent;color:var(--vscode-foreground);border:0;padding:4px 11px;cursor:pointer;font-size:12px}
.seg button.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.ghost{background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-widget-border);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px}
.ghost:hover{background:var(--vscode-toolbar-hoverBackground)}
/* min-height:0 is required so a flex child can shrink when the VS Code
   editor group is minimized — otherwise content (Sessions list, etc.) is
   clipped by overflow:hidden with no inner scroll. */
#main{flex:1 1 0%;min-height:0;position:relative;overflow:hidden}
#loadOverlay{position:absolute;inset:0;z-index:8;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);backdrop-filter:blur(2px)}
#loadOverlay.hidden{display:none!important}
#loadOverlay.err .loadspin{display:none}
.loadcard{min-width:min(420px,86vw);max-width:560px;padding:22px 24px;border:1px solid var(--vscode-widget-border);border-radius:12px;background:var(--vscode-editorWidget-background);box-shadow:0 12px 40px rgba(0,0,0,.25)}
#loadTitle{font-weight:700;font-size:14px;margin:8px 0 4px}
#loadDetail{font-size:12px;opacity:.8;line-height:1.45;white-space:pre-wrap}
#loadTime{font-size:11px;opacity:.55;margin-top:8px;font-variant-numeric:tabular-nums}
#loadRetry{margin-top:12px}
.loadspin{width:22px;height:22px;border-radius:50%;border:2px solid var(--vscode-widget-border);border-top-color:var(--vscode-progressBar-background,#4ec9b0);animation:spin 0.8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.view{position:absolute;inset:0;min-width:0;min-height:0}
.hidden{display:none!important}
/* Board-only chrome: hide when not on the board so Sessions / Projects /
   Auto tabs stay visible in a minimized pane (group/sort/lane ate the bar). */
body:not([data-view="board"]) #laneSeg,
body:not([data-view="board"]) #groupBy,
body:not([data-view="board"]) #sortBy,
body:not([data-view="board"]) #addLaneBtn{display:none!important}
body:not([data-view="calendar"]) #calModeSeg{display:none!important}
/* board */
#board{display:flex;flex-direction:column;gap:10px;padding:14px;min-height:0;height:100%;overflow:hidden}
.boardfilter{display:flex;gap:8px;align-items:center;font-size:12px;flex:0 0 auto;flex-wrap:wrap}
.boardfilter select,.boardfilter input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:6px;padding:2px 6px}
.lanes{display:flex;gap:var(--gap);overflow-x:auto;align-items:flex-start;flex:1;min-height:0}
.col{flex:0 0 270px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border);border-radius:10px;display:flex;flex-direction:column;max-height:100%;min-width:0}
.col.over{outline:2px dashed var(--vscode-focusBorder);outline-offset:-2px}
.col h3{font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin:0;padding:10px 12px;display:flex;align-items:center;gap:7px;position:sticky;top:0}
.dot{width:8px;height:8px;border-radius:50%}
.col .cnt{margin-left:auto;opacity:.6;font-weight:400}
.donewin{font-size:10px;padding:0 2px;margin-left:2px;border-radius:4px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border)}
.col.max{flex:1 1 auto;max-width:none}
/* Narrow panes (side bar open / small window): stack lanes full-width so cards stay
   readable instead of being crushed into a horizontal scroll of tiny columns. */
@media (max-width:900px){
  .lanes{flex-wrap:wrap;overflow-x:hidden;overflow-y:auto}
  .col{flex:1 1 100%;max-width:none;max-height:none}
  .cards{max-height:min(50vh,420px)}
  .brand{display:none} /* reclaim space for view tabs */
  #counts{display:none}
  body[data-view="board"] #groupBy,
  body[data-view="board"] #sortBy{max-width:110px}
}
@media (max-width:560px){
  body[data-view="board"] #addLaneBtn{display:none}
  .seg button{padding:4px 8px;font-size:11px}
}
.card .ct{overflow-wrap:anywhere}
.card.compact{padding:4px 10px;display:flex;align-items:center;gap:10px}
.card.compact .ct{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.card.compact .cm{margin-top:0;flex:none;flex-wrap:nowrap}
.card.dropover{border-color:var(--vscode-focusBorder);box-shadow:0 -2px 0 0 var(--vscode-focusBorder)}
.savenote{font-size:10px;opacity:.6;min-width:52px;text-align:right}
#projects{padding:14px;overflow-y:auto}
.pgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr));gap:12px}
.pcard{background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border);border-radius:10px;padding:12px;min-width:0}
.pcard h3{margin:0 0 8px;font-size:13px;display:flex;gap:8px;align-items:baseline;cursor:pointer}
.pcard h3:hover{color:var(--vscode-focusBorder)}
.pcard h3 .pn{margin-left:auto;font-weight:400;font-size:11px;opacity:.6;flex:none}
.pitem{display:flex;gap:7px;align-items:baseline;font-size:12px;padding:3px 2px;cursor:pointer;border-radius:4px;min-width:0}
.pitem:hover{background:var(--vscode-list-hoverBackground)}
.pitem .st{font-size:10px;opacity:.65;flex:none;width:74px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pitem .pt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.pitem .dot{width:7px;height:7px;border-radius:50%;flex:none;align-self:center}
.pmore{color:var(--vscode-textLink-foreground);cursor:pointer;font-size:11px;padding:3px 2px}
.psess{margin-top:8px;border-top:1px dotted var(--vscode-widget-border);padding-top:6px}
.psess .lbl{font-size:10px;text-transform:uppercase;opacity:.55;letter-spacing:.5px}
.cards{padding:0 10px 10px;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
.card{background:var(--vscode-editor-background);border:1px solid var(--vscode-widget-border);border-radius:8px;padding:10px;cursor:grab;transition:border-color .1s,transform .05s}
.card:hover{border-color:var(--vscode-focusBorder)}
.card.dragging{opacity:.4}
.card .ct{font-weight:600;font-size:13px;line-height:1.3}
.card .cm{display:flex;gap:6px;align-items:center;margin-top:6px;font-size:11px;opacity:.75;flex-wrap:wrap}
.badge{border-radius:4px;padding:1px 6px;font-size:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.prio{border-radius:4px;padding:1px 5px;font-size:10px;font-weight:700;background:#444;color:#ddd}
.prio.p0{background:#d16969;color:#fff}.prio.p1{background:#d7ba7d;color:#222}.prio.p2{background:#569cd6;color:#fff}
.due{font-size:10px;opacity:.9}.due.late{color:#d16969;font-weight:700}
.calbar{display:flex;gap:10px;align-items:center;padding:8px 4px;font-size:12px}
.calbar input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:2px 4px}
.calday h3{margin:14px 0 4px;font-size:12px;text-transform:none;opacity:.85;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:3px}
.calrow{display:flex;gap:8px;align-items:center;padding:5px 6px;border-radius:6px;cursor:pointer;font-size:12px}
.calrow:hover{background:var(--vscode-list-hoverBackground)}
.calrow.done{opacity:.5;text-decoration:line-through}
.calrow.late .ct{color:#d16969}
.calrow .cm{opacity:.6;font-size:11px;margin-left:auto}
.calrow .dot{width:8px;height:8px;border-radius:50%;flex:none}
.calempty{opacity:.6;padding:16px;font-size:12px}
.calbar .title{font-weight:700;font-size:14px;min-width:150px}
.mgrid{display:grid;grid-template-columns:repeat(7,1fr);gap:5px}
.mgrid .dow{opacity:.6;font-size:10px;text-transform:uppercase;text-align:center;padding:2px}
.mcell{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:6px;min-height:88px;padding:5px;cursor:pointer;overflow:hidden}
.mcell:hover{border-color:var(--vscode-focusBorder)}
.mcell.dim{opacity:.35}
.mcell.today{border-color:var(--vscode-focusBorder);box-shadow:0 0 0 1px var(--vscode-focusBorder) inset}
.mcell .d{font-size:11px;opacity:.7;display:flex;justify-content:space-between}
.mcell .mi{font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;padding:1px 3px;border-radius:3px;background:var(--vscode-editorWidget-background)}
.mcell .mi.late{color:#d16969}
.mcell.over{border-color:var(--vscode-focusBorder);background:var(--vscode-list-hoverBackground)}
.wgrid{display:grid;gap:6px}
.wcol{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:8px;padding:6px;min-height:180px;min-width:0}
.wcol.today{border-color:var(--vscode-focusBorder)}
.wcol.over{background:var(--vscode-list-hoverBackground)}
.wcol h4{margin:0 0 5px;font-size:11px;opacity:.75;cursor:pointer;display:flex;justify-content:space-between}
.wcol h4:hover{opacity:1}
.witem{font-size:11px;padding:3px 5px;border-radius:5px;margin-top:3px;background:var(--vscode-editorWidget-background);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;border-left:3px solid var(--vscode-charts-yellow)}
.witem.late{border-left-color:#d16969}
.card.blocked{border-left:3px solid #e51400}
/* graph */
#graph{width:100%;height:100%;cursor:grab}
#gfilters{position:absolute;top:8px;left:10px;right:10px;z-index:4;display:flex;flex-direction:column;gap:5px;pointer-events:none}
#gfilters.hidden{display:none}
.gf-row{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.gf-lab{font-size:10px;opacity:.55;text-transform:uppercase;width:44px;flex:0 0 44px}
.gf-btn{pointer-events:auto;display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 8px;border-radius:11px;border:1px solid var(--vscode-widget-border);background:var(--vscode-editorWidget-background);color:var(--vscode-foreground);cursor:pointer;opacity:.95}
.gf-btn.off{opacity:.38;text-decoration:line-through}
.gf-dot{width:8px;height:8px;border-radius:50%}
.gf-fit{margin-left:auto;opacity:.8}
#graph text{fill:var(--vscode-foreground);font-size:10px;pointer-events:none}
#graph line{stroke:var(--vscode-widget-border);stroke-opacity:.6}
#graph line.blocked{stroke:#e51400;stroke-opacity:.9}
#graph circle{cursor:pointer;stroke:var(--vscode-editor-background);stroke-width:1.5}
.glegend{position:absolute;top:10px;left:14px;font-size:11px;opacity:.7}
/* canvas */
#canvas{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;opacity:.7;text-align:center;padding:40px}
/* drawer */
#backdrop{position:absolute;inset:0;background:rgba(0,0,0,.35);z-index:5}
#drawer{position:absolute;top:0;right:0;bottom:0;width:440px;max-width:90vw;background:var(--vscode-sideBar-background,var(--vscode-editorWidget-background));border-left:1px solid var(--vscode-widget-border);z-index:6;overflow-y:auto;box-shadow:-8px 0 24px rgba(0,0,0,.25)}
#drawerInner{padding:16px 18px}
.dh{display:flex;align-items:flex-start;gap:8px}
.dh h2{font-size:16px;margin:0;flex:1;line-height:1.3}
.dclose{background:transparent;border:0;color:var(--vscode-foreground);cursor:pointer;font-size:18px;opacity:.7}
.drow{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
.sec{margin-top:16px}
.sec h4{font-size:11px;text-transform:uppercase;letter-spacing:.5px;opacity:.6;margin:0 0 6px}
.body{background:var(--vscode-textCodeBlock-background,var(--vscode-editor-background));border:1px solid var(--vscode-widget-border);border-radius:6px;padding:10px;font-size:12.5px;line-height:1.5;white-space:pre-wrap;max-height:280px;overflow:auto}
.body h1,.body h2,.body h3{font-size:13px;margin:8px 0 4px}
.body code{background:var(--vscode-textPreformat-background);padding:1px 4px;border-radius:3px}
.reflist{display:flex;flex-direction:column;gap:5px}
.refitem{display:flex;align-items:center;gap:7px;font-size:12px;padding:5px 8px;border:1px solid var(--vscode-widget-border);border-radius:6px;cursor:pointer}
.refitem:hover{background:var(--vscode-toolbar-hoverBackground)}
.refitem.bad{border-color:#e51400}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:7px}
.act{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;border-radius:6px;padding:8px;cursor:pointer;font-size:12px;text-align:left}
.act:hover{background:var(--vscode-button-hoverBackground)}
.act.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.act .k{font-weight:600}.act .d{opacity:.7;font-size:10.5px;display:block}
.statusrow{display:flex;gap:6px;align-items:center;margin-top:6px}
select{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);border-radius:5px;padding:3px 6px;font-size:12px}
.card{position:relative}
.cact{position:absolute;top:4px;right:5px;display:none;gap:2px;z-index:2}
.card:hover .cact{display:flex}
.cact button{background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border);border-radius:4px;color:var(--vscode-descriptionForeground);cursor:pointer;font-size:11px;line-height:1;padding:2px 4px}
.cact button:hover{color:var(--vscode-foreground)}
.col.over{outline:2px dashed var(--vscode-focusBorder);outline-offset:-2px}
.titleEdit{flex:1;font-size:16px;font-weight:600;background:transparent;border:1px solid transparent;border-radius:5px;color:var(--vscode-foreground);padding:3px 5px}
.titleEdit:hover,.titleEdit:focus{border-color:var(--vscode-input-border);background:var(--vscode-input-background);outline:none}
.bodyhead{display:flex;align-items:center;justify-content:space-between;gap:8px}
.bodyEdit{width:100%;min-height:120px;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:5px;padding:6px;font-family:var(--vscode-editor-font-family);font-size:12px;margin-top:4px}
.fldEdit{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:5px;padding:2px 6px;width:120px}
.ghost.mini{padding:2px 8px;font-size:11px}
`;

// ---------------------------------------------------------------- script -----
// Webview JS lives in media/planning-dashboard.js and is loaded via <script src>.

