// Full-page Planning Dashboard webview — the interactive cockpit.
//
// One editor tab with a Board (polished kanban, drag-and-drop), a meaningful
// force-directed Graph, and a Canvas (Excalidraw, staged), plus a right-hand detail
// drawer that loads `kp show <id>` (body + resolved references + children) and exposes
// agent actions (Ideate / Draft spec / Decompose / Execute) and Open-in-Code-Build.
//
// The host (planning.ts) injects the data/runner deps so this file stays UI-only.

import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
  /** last provider/model route chosen for auto-implement (globalState-persisted) */
  getImplPrefs?: () => unknown;
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
    const snap = deps.getSnapshot() as { root?: string } | null;
    const storeRoot = snap?.root || path.join(os.homedir(), "docs", "planning");
    this.panel = vscode.window.createWebviewPanel("codePlanningDashboard", "Planning Dashboard", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot, vscode.Uri.file(storeRoot)],
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
    this.panel.webview.postMessage({ type: "snapshot", data: this.deps.getSnapshot(), implPrefs: this.deps.getImplPrefs?.() });
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
            this.panel.webview.postMessage({ type: "detail", data: this.rewriteMedia(JSON.parse(res.stdout)) });
          } catch {
            /* ignore */
          }
        }
        break;
      }
      case "setStatus": {
        const ids = Array.isArray(m.ids) && m.ids.length
          ? (m.ids as unknown[]).map((x) => String(x)).filter(Boolean)
          : m.id ? [String(m.id)] : [];
        for (const oid of ids) await this.deps.runKp(["set-status", oid, String(m.status)]);
        await this.deps.reload();
        this.pushSnapshot();
        if (ids[0]) await this.onMessage({ type: "show", id: ids[0] });
        break;
      }
      case "setStatusApply": {
        // closing move with an optional resolution note (from the modal)
        const ids = Array.isArray(m.ids) && m.ids.length
          ? (m.ids as unknown[]).map((x) => String(x)).filter(Boolean)
          : m.id ? [String(m.id)] : [];
        const note = String(m.note ?? "").trim();
        for (const oid of ids) {
          const args = ["set-status", oid, String(m.status)];
          if (note) args.push("--note", note);
          await this.deps.runKp(args);
        }
        await this.deps.reload();
        this.pushSnapshot();
        if (ids[0]) await this.onMessage({ type: "show", id: ids[0] });
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
    const m = msg as { type?: string; data?: unknown };
    if (m && m.type === "detail" && m.data) {
      this.panel.webview.postMessage({ ...m, data: this.rewriteMedia(m.data) });
      return;
    }
    this.panel.webview.postMessage(msg);
  }

  /** Turn store-relative `](media/…)` markdown into webview URIs so screenshots render. */
  private rewriteMedia(data: unknown): unknown {
    if (!data || typeof data !== "object") return data;
    const rec = data as { body?: unknown };
    const body = typeof rec.body === "string" ? rec.body : "";
    if (!body.includes("](media/")) return data;
    const snap = this.deps.getSnapshot() as { root?: string } | null;
    const root = snap?.root || path.join(os.homedir(), "docs", "planning");
    const next = body.replace(/!\[([^\]]*)\]\((media\/[^)]+)\)/g, (_m, alt, rel) => {
      const uri = this.panel.webview.asWebviewUri(vscode.Uri.file(path.join(root, String(rel))));
      return `![${alt}](${uri.toString()})`;
    });
    return { ...(data as object), body: next };
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
    const csp = `default-src 'none'; style-src 'unsafe-inline' ${cs}; script-src 'nonce-${n}' ${cs}; img-src data: ${cs} https:;`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${this.dashboardCss()}</style></head>
<body>
<div id="topbar">
  <span class="brand">◧ Planning</span>
  <div class="seg" id="viewSeg">
    <button data-view="board" class="on">Board</button>
    <button data-view="pipeline" title="Coding pipeline: bugs/features/auto items — inbox → approved → implementation → done">🚀 Pipeline</button>
    <button data-view="issues">Bugs / Features</button>
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
<div id="tagBar"></div>
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
  <div id="pipeline" class="view hidden"></div>
  <div id="issues" class="view hidden"></div>
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
    <div id="resWarn" class="reswarn hidden"></div>
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

  private dashboardCss(): string {
    return readFileSync(path.join(this.deps.extensionUri.fsPath, "media", "planning-dashboard.css"), "utf8");
  }

}

// Dashboard CSS lives in media/planning-dashboard.css (loaded by html() and the browser harness).

// ---------------------------------------------------------------- script -----
// Webview JS lives in media/planning-dashboard.js and is loaded via <script src>.

