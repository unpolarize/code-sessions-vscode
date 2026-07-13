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
  getSnapshot: () => unknown | null;
  reload: () => boolean;
  onChange: vscode.Event<void>;
  runKp: (args: string[]) => { ok: boolean; stdout: string; stderr: string };
  /** delegate open-file / agent actions to the host (needs vscode + terminals) */
  onAction: (msg: { type: string; [k: string]: unknown }) => void;
  /** rich session list from the ~/.sessions git store, for the Sessions view */
  listSessions?: () => unknown[];
  /** the user is interacting with the board — arm aggressive store polling */
  noteActivity?: () => void;
  /** current store-sync status for the header indicator */
  getSyncStatus?: () => unknown;
  /** subscribe to store-sync status changes (returns a disposable) */
  onSyncStatus?: (cb: (s: unknown) => void) => vscode.Disposable;
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
    this.panel = vscode.window.createWebviewPanel("codePlanningDashboard", "Planning Dashboard", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    this.deps.onChange(() => this.pushSnapshot(), null, this.disposables);
    // Store-sync status → header indicator; arm aggressive polling when the panel
    // has focus (a pull that advances HEAD reloads the snapshot via onChange).
    if (this.deps.onSyncStatus) this.disposables.push(this.deps.onSyncStatus((s) => this.post({ type: "syncStatus", data: s })));
    this.disposables.push(
      this.panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) this.deps.noteActivity?.();
      }),
    );
    this.panel.webview.html = this.html();
  }

  private pushSnapshot(): void {
    this.panel.webview.postMessage({ type: "snapshot", data: this.deps.getSnapshot() });
  }

  private onMessage(m: { type: string; [k: string]: unknown }): void {
    switch (m.type) {
      case "ready":
        this.pushSnapshot();
        if (this.deps.getSyncStatus) this.post({ type: "syncStatus", data: this.deps.getSyncStatus() });
        this.deps.noteActivity?.();
        if (this.initialView) this.panel.webview.postMessage({ type: "setView", view: this.initialView });
        if (this.initialItem) this.panel.webview.postMessage({ type: "openItem", id: this.initialItem });
        break;
      case "activity":
        this.deps.noteActivity?.();
        break;
      case "requestSessions":
        this.post({ type: "sessions", data: this.deps.listSessions?.() ?? [] });
        break;
      case "syncNow":
        void vscode.commands.executeCommand("codeSessions.syncStoresNow");
        break;
      case "refresh":
        this.deps.reload();
        this.pushSnapshot();
        break;
      case "show": {
        const res = this.deps.runKp(["show", String(m.id)]);
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
        this.deps.runKp(["set-status", String(m.id), String(m.status)]);
        this.deps.reload();
        this.pushSnapshot();
        // refresh the open drawer
        if (m.id) this.onMessage({ type: "show", id: m.id });
        break;
      case "setStatusApply": {
        // closing move with an optional resolution note (from the modal)
        const args = ["set-status", String(m.id), String(m.status)];
        const note = String(m.note ?? "").trim();
        if (note) args.push("--note", note);
        this.deps.runKp(args);
        this.deps.reload();
        this.pushSnapshot();
        if (m.id) this.onMessage({ type: "show", id: m.id });
        break;
      }
      case "setDue":
        this.deps.runKp(["set-due", String(m.id), String(m.due || "-")]);
        this.deps.reload();
        this.pushSnapshot();
        if (m.id) this.onMessage({ type: "show", id: m.id });
        break;
      case "setPriority":
        this.deps.runKp(["set-priority", String(m.id), String(m.priority || "-")]);
        this.deps.reload();
        this.pushSnapshot();
        if (m.id) this.onMessage({ type: "show", id: m.id });
        break;
      case "setProject":
        this.deps.runKp(["set-project", String(m.id), String(m.project || "-")]);
        this.deps.reload();
        this.pushSnapshot();
        if (m.id) this.onMessage({ type: "show", id: m.id });
        break;
      default:
        this.deps.onAction(m); // open / action (agent, CB, promote, link, capture)
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
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}'; img-src data:;`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${STYLE}</style></head>
<body>
<div id="topbar">
  <span class="brand">◧ Planning</span>
  <div class="seg" id="viewSeg">
    <button data-view="board" class="on">Board</button>
    <button data-view="projects">Projects</button>
    <button data-view="sessions">Sessions</button>
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
  <span id="syncPill" class="syncpill" title="Store sync status — click to sync now">◌ sync</span>
  <span id="counts" class="counts"></span>
  <input id="search" placeholder="Search… (⌘F)" style="display:none;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:6px;padding:3px 8px;width:180px">
  <button id="captureBtn" class="ghost">＋ New</button>
  <button id="syncBtn" class="ghost" title="Run a sync script (scripts/sync/ — sync.sh is the default)">⟳ Sync</button>
  <button id="refreshBtn" class="ghost" title="Refresh snapshot">⟳</button>
</div>
<div id="main">
  <div id="board" class="view"></div>
  <div id="projects" class="view hidden"></div>
  <div id="sessions" class="view hidden"></div>
  <div id="social" class="view hidden"></div>
  <div id="calendar" class="view hidden"></div>
  <svg id="graph" class="view hidden"></svg>
  <div id="canvas" class="view hidden"></div>
  <div id="gfilters" class="hidden"></div>
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
<script nonce="${n}">${SCRIPT}</script>
</body></html>`;
  }
}

// ---------------------------------------------------------------- styles -----
const STYLE = `
:root{ --gap:10px; }
*{box-sizing:border-box}
body{margin:0;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);height:100vh;overflow:hidden;display:flex;flex-direction:column}
#topbar{display:flex;align-items:center;gap:14px;padding:8px 14px;border-bottom:1px solid var(--vscode-widget-border);flex:0 0 auto}
.brand{font-weight:700;letter-spacing:.3px}
.spacer{flex:1}
.counts{opacity:.7;font-size:12px}
.syncpill{font-size:11px;padding:2px 9px;border-radius:11px;border:1px solid var(--vscode-widget-border);cursor:pointer;white-space:nowrap;display:inline-flex;gap:5px;align-items:center;opacity:.9}
.syncpill:hover{background:var(--vscode-toolbar-hoverBackground)}
.syncpill.ok{border-color:#4ec9b0}
.syncpill.syncing{border-color:var(--vscode-focusBorder)}
.syncpill.warn{border-color:#d16969;color:#e6a4a4}
.syncpill.active{box-shadow:0 0 0 1px var(--vscode-focusBorder) inset}
#resmodal{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}
#resmodal.hidden{display:none!important}
.resbox{background:var(--vscode-editorWidget-background,var(--vscode-editor-background));border:1px solid var(--vscode-widget-border);border-radius:10px;width:min(560px,92vw);max-height:80vh;display:flex;flex-direction:column;padding:16px 18px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
.reshead{display:flex;align-items:flex-start;gap:8px}
.reshead span{font-size:14px;font-weight:600;flex:1;line-height:1.3}
.ressub{font-size:12px;opacity:.7;margin:4px 0 10px}
#resNote{width:100%;min-height:160px;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:6px;padding:9px 10px;font-family:var(--vscode-editor-font-family);font-size:13px;line-height:1.5}
.resactions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
.resactions .primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:var(--vscode-button-background)}
#sessions{padding:16px;overflow-y:auto}
.sessbar{display:flex;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
.sesssearch{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:6px;padding:4px 9px;width:220px}
.sesscount{font-size:11px;opacity:.6;margin-bottom:10px}
.sesslist{display:flex;flex-direction:column;gap:8px;max-width:820px}
.sesscard{background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border);border-radius:8px;padding:10px 12px;cursor:pointer}
.sesscard:hover{border-color:var(--vscode-focusBorder)}
.sesscard .sh{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.sesscard .ct{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sesscard .cm{opacity:.6;font-size:11px;flex:none}
.sesscard .sm{display:flex;gap:8px;opacity:.7;font-size:11px;margin-top:5px;flex-wrap:wrap}
.srefs{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
#social{padding:16px;overflow-y:auto}
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
#main{flex:1;position:relative;overflow:hidden}
.view{position:absolute;inset:0}
.hidden{display:none!important}
/* board */
#board{display:flex;flex-direction:column;gap:10px;padding:14px}
.boardfilter{display:flex;gap:8px;align-items:center;font-size:12px;flex:0 0 auto}
.boardfilter select,.boardfilter input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:6px;padding:2px 6px}
.lanes{display:flex;gap:var(--gap);overflow-x:auto;align-items:flex-start;flex:1;min-height:0}
.col{flex:0 0 270px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border);border-radius:10px;display:flex;flex-direction:column;max-height:100%}
.col.over{outline:2px dashed var(--vscode-focusBorder);outline-offset:-2px}
.col h3{font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin:0;padding:10px 12px;display:flex;align-items:center;gap:7px;position:sticky;top:0}
.dot{width:8px;height:8px;border-radius:50%}
.col .cnt{margin-left:auto;opacity:.6;font-weight:400}
.donewin{font-size:10px;padding:0 2px;margin-left:2px;border-radius:4px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border)}
.col.max{flex:1 1 auto;max-width:none}
.card.compact{padding:4px 10px;display:flex;align-items:center;gap:10px}
.card.compact .ct{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.card.compact .cm{margin-top:0;flex:none;flex-wrap:nowrap}
.card.dropover{border-color:var(--vscode-focusBorder);box-shadow:0 -2px 0 0 var(--vscode-focusBorder)}
.savenote{font-size:10px;opacity:.6;min-width:52px;text-align:right}
#projects{padding:14px;overflow-y:auto}
.pgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px}
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
const SCRIPT = `
const vscode = acquireVsCodeApi();
const LANES = {
  task: ['inbox','today','in_progress','done','deferred','outdated'],
  idea: ['capture','refine','accepted','parked','done'],
  plan: ['plan','prototype','implement','validate','done','parked'],
  thought: ['new','kept','converted','archived'],
};
const TYPE_COLOR = {idea:'#d7ba7d',plan:'#4ec9b0',task:'#569cd6',project:'#c586c0',catalog_entry:'#c586c0',domain:'#808080',daily_plan:'#dcdcaa',insight:'#4fc1ff',reflection:'#9cdcfe',knowledge:'#ce9178',session:'#608b4e',thought:'#e2c08d'};
const LANE_COLOR = {inbox:'#888',today:'#569cd6',in_progress:'#dcdcaa',done:'#4ec9b0',deferred:'#a08',outdated:'#d16969',capture:'#d7ba7d',refine:'#dcdcaa',accepted:'#4ec9b0',parked:'#888',plan:'#569cd6',prototype:'#c586c0',implement:'#dcdcaa',validate:'#4fc1ff',new:'#d7ba7d',kept:'#4ec9b0',converted:'#569cd6',archived:'#666'};
let S = null, view='board', laneSet='task';
const _st=(vscode.getState&&vscode.getState())||{};
let groupBy = _st.groupBy || 'status';
let customLanes = _st.customLanes || [];
let doneWindow = _st.doneWindow || 'week'; // hide done items older than: yesterday|week|month|all
let sortBy = _st.sortBy || 'priority';
function saveState(){ try{ vscode.setState({groupBy, customLanes, doneWindow, sortBy}); }catch(e){} }
const BOARD_TYPES=['task','idea','plan','thought'];
const $=s=>document.querySelector(s), el=(t,c,h)=>{const e=document.createElement(t);if(c)e.className=c;if(h!=null)e.innerHTML=h;return e};
const esc=s=>(s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

window.addEventListener('message',e=>{const m=e.data;
  if(m.type==='snapshot'){S=m.data;render();}
  else if(m.type==='detail'){renderDrawer(m.data);}
  else if(m.type==='setView'){view=m.view;syncSeg();render();}
  else if(m.type==='laneAdded'){ if(groupBy!=='lane'){groupBy='lane';const gb=$('#groupBy');if(gb)gb.value='lane';} if(m.name&&!customLanes.includes(m.name))customLanes.push(m.name); saveState(); renderBoard(); }
  else if(m.type==='openItem'){ view='board'; syncSeg(); render(); if(m.id)openDetail(m.id); }
  else if(m.type==='syncStatus'){ renderSyncPill(m.data); }
  else if(m.type==='sessions'){ SESS=m.data||[]; if(view==='sessions')renderSessions(); }
});

// ── store-sync status pill + activity reporting ──────────────────────────────
let syncState=null;
function agoStr(t){ if(!t)return 'never'; const s=Math.round((Date.now()-t)/1000);
  return s<60?s+'s ago':s<3600?Math.round(s/60)+'m ago':Math.round(s/3600)+'h ago'; }
function renderSyncPill(s){ if(s)syncState=s; s=syncState; const p=$('#syncPill'); if(!p||!s)return;
  const cls=s.status==='syncing'?'syncing':(s.status==='conflict'||s.status==='error'||s.status==='offline')?'warn':'ok';
  p.className='syncpill '+cls+(s.active?' active':'');
  const icon=s.status==='syncing'?'⟳':(cls==='warn'?'⚠':'☁');
  p.textContent=icon+' '+(s.status==='syncing'?'syncing…':agoStr(s.lastSyncAt))+(s.active?' ⚡':'');
  p.title='Store sync — '+s.status+(s.detail?': '+s.detail:'')+
    '\\nLast: '+(s.lastSyncAt?new Date(s.lastSyncAt).toLocaleTimeString():'never')+
    (s.lastChanged&&s.lastChanged.length?'\\nUpdated: '+s.lastChanged.join(', '):'')+
    (s.active?'\\n⚡ active — polling aggressively':'')+'\\nClick to sync now.'; }
setInterval(()=>{ if(syncState&&syncState.status!=='syncing')renderSyncPill(); },15000); // keep "Xs ago" fresh
$('#syncPill')&&$('#syncPill').addEventListener('click',()=>vscode.postMessage({type:'syncNow'}));
// report activity (keyboard/click/scroll) so the host arms aggressive polling; throttled
let lastActivity=0;
function reportActivity(){ const now=Date.now(); if(now-lastActivity>10000){ lastActivity=now; vscode.postMessage({type:'activity'}); } }
['click','keydown','wheel'].forEach(ev=>document.addEventListener(ev,reportActivity,{passive:true}));

// top bar
$('#viewSeg').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;view=b.dataset.view;syncSeg();render();});
$('#laneSeg').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;laneSet=b.dataset.lane;syncSeg();renderBoard();});
$('#calModeSeg').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;calMode=b.dataset.cm;syncSeg();renderCalendar();});
$('#refreshBtn').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));
$('#captureBtn').addEventListener('click',()=>openCreateDrawer({}));
$('#syncBtn').addEventListener('click',()=>vscode.postMessage({type:'action',action:'runSync'}));
let searchTerm='', maxLane=null;
function applySearch(){const q=searchTerm.toLowerCase();
  document.querySelectorAll('#board .card').forEach(c=>{c.style.display=(!q||c.textContent.toLowerCase().includes(q))?'':'none';});}
document.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&e.key==='f'){e.preventDefault();const s=$('#search');s.style.display='inline-block';s.focus();s.select();}
  if(e.key==='Escape'){const s=$('#search');
    if(document.activeElement===s){searchTerm='';s.value='';s.style.display='none';applySearch();}
    else if(!$('#drawer').classList.contains('hidden')){closeDrawer();}
    else if(maxLane){maxLane=null;renderBoard();}
    else if(searchTerm){searchTerm='';s.value='';s.style.display='none';applySearch();}}
});
$('#search').addEventListener('input',e=>{searchTerm=e.target.value;applySearch();});
(function(){const gb=$('#groupBy'); if(gb){gb.value=groupBy; gb.addEventListener('change',()=>{groupBy=gb.value;saveState();renderBoard();});}
  const sb=$('#sortBy'); if(sb){sb.value=sortBy; sb.addEventListener('change',()=>{sortBy=sb.value;saveState();renderBoard();});}
  const al=$('#addLaneBtn'); if(al)al.addEventListener('click',()=>vscode.postMessage({type:'action',action:'addLane'}));})();
$('#backdrop').addEventListener('click',closeDrawer);
function syncSeg(){
  document.querySelectorAll('#viewSeg button').forEach(b=>b.classList.toggle('on',b.dataset.view===view));
  document.querySelectorAll('#laneSeg button').forEach(b=>b.classList.toggle('on',b.dataset.lane===laneSet));
  document.querySelectorAll('#calModeSeg button').forEach(b=>b.classList.toggle('on',b.dataset.cm===calMode));
  $('#laneSeg').style.display = view==='board'?'inline-flex':'none';
  $('#calModeSeg').style.display = view==='calendar'?'inline-flex':'none';
  $('#board').classList.toggle('hidden',view!=='board');
  $('#projects').classList.toggle('hidden',view!=='projects');
  $('#sessions').classList.toggle('hidden',view!=='sessions');
  $('#social').classList.toggle('hidden',view!=='social');
  $('#calendar').classList.toggle('hidden',view!=='calendar');
  $('#graph').classList.toggle('hidden',view!=='graph');
  $('#gfilters').classList.toggle('hidden',view!=='graph');
  $('#canvas').classList.toggle('hidden',view!=='canvas');
}
function render(){ if(!S){return;} syncSeg();
  $('#counts').textContent = Object.entries(S.counts||{}).map(([k,v])=>k+':'+v).join('  ');
  if(view==='board')renderBoard(); else if(view==='projects')renderProjects(); else if(view==='sessions')renderSessions(); else if(view==='social')renderSocial(); else if(view==='calendar')renderCalendar(); else if(view==='graph')requestAnimationFrame(renderGraph); else renderCanvas();
  applySearch();
}
const blockedSet=()=>new Set((S.blocked||[]).map(b=>b.id));

// closing statuses prompt for a resolution note (host shows the InputBox; Esc aborts)
const CLOSING=new Set(['done','deferred','outdated','parked','archived']);
function postStatus(id,status){ if(CLOSING.has(status))openResModal(id,status); else vscode.postMessage({type:'setStatus',id:id,status:status}); }
// Multi-line resolution note modal for closing moves (nicer than a one-line input).
let resCtx=null;
function openResModal(id,status){
  resCtx={id:id,status:status};
  const o=(S&&S.objects||[]).find(x=>x.id===id);
  $('#resTitle').textContent=(o&&(o.title||o.id))||id;
  $('#resSub').textContent='Moving to “'+status+'” — add a resolution note (optional).';
  const ta=$('#resNote'); ta.value='';
  $('#resmodal').classList.remove('hidden');
  setTimeout(()=>ta.focus(),40);
}
function closeResModal(apply,withNote){
  const m=$('#resmodal'); if(m.classList.contains('hidden'))return;
  const ctx=resCtx; m.classList.add('hidden'); resCtx=null;
  if(!ctx)return;
  if(apply)vscode.postMessage({type:'setStatusApply',id:ctx.id,status:ctx.status,note:withNote?$('#resNote').value.trim():''});
  else vscode.postMessage({type:'refresh'}); // cancel → snap the board back
}
$('#resSave').addEventListener('click',()=>closeResModal(true,true));
$('#resSkip').addEventListener('click',()=>closeResModal(true,false));
$('#resCancel').addEventListener('click',()=>closeResModal(false));
$('#resX').addEventListener('click',()=>closeResModal(false));
$('#resNote').addEventListener('keydown',e=>{ if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();closeResModal(true,true);} if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeResModal(false);} });
function laneFieldAndList(objs){
  if(groupBy==='status') return {field:'status', lanes:(LANES[laneSet]||[...new Set(objs.map(o=>o.status||'inbox'))])};
  if(groupBy==='type') return {field:'type', lanes:BOARD_TYPES.slice()};
  const vals=new Set(objs.map(o=>o[groupBy]||'(none)')); customLanes.forEach(l=>vals.add(l)); const lanes=[...vals]; if(!lanes.includes('(none)'))lanes.push('(none)');
  return {field:groupBy, lanes};
}
function renderBoard(){
  const bl=blockedSet();
  let objs = groupBy==='type' ? (S.objects||[]).filter(o=>BOARD_TYPES.indexOf(o.type)>=0) : (S.objects||[]).filter(o=>o.type===laneSet);
  const {field, lanes} = laneFieldAndList(objs);
  const board=$('#board'); board.innerHTML='';
  // date filter bar (worked-on / due) — full-width row above the lanes
  const fb=el('div','boardfilter');
  fb.innerHTML='<span style="opacity:.6">filter by</span>'+
    '<select id="bfField"><option value="updated"'+(boardDateField==='updated'?' selected':'')+'>worked on (updated)</option><option value="due"'+(boardDateField==='due'?' selected':'')+'>due</option></select>'+
    '<input type="date" id="bfDate" value="'+esc(boardDateVal||'')+'">'+
    '<button class="ghost" id="bfToday">today</button>'+
    (boardDateVal?'<button class="ghost" id="bfClear">clear ✕</button><span style="opacity:.6" id="bfN"></span>':'');
  board.appendChild(fb);
  fb.querySelector('#bfField').addEventListener('change',e=>{boardDateField=e.target.value;renderBoard();});
  fb.querySelector('#bfDate').addEventListener('change',e=>{boardDateVal=e.target.value;renderBoard();});
  fb.querySelector('#bfToday').addEventListener('click',()=>{boardDateVal=todayStr();renderBoard();});
  if(fb.querySelector('#bfClear'))fb.querySelector('#bfClear').addEventListener('click',()=>{boardDateVal='';renderBoard();});
  if(boardDateVal)objs=objs.filter(o=>String(o[boardDateField]||'').slice(0,10)===boardDateVal);
  if(fb.querySelector('#bfN'))fb.querySelector('#bfN').textContent=objs.length+' '+laneSet+'(s) '+boardDateField+' '+boardDateVal;
  const lanesWrap=el('div','lanes');board.appendChild(lanesWrap);
  const shown=(maxLane&&lanes.includes(maxLane))?[maxLane]:lanes;
  shown.forEach(lane=>{
    let rows=objs.filter(o=>String(o[field]||'(none)')===String(lane));
    const CMP={
      priority:(a,b)=>String(a.priority||'p9').localeCompare(String(b.priority||'p9')),
      due:(a,b)=>String(a.due||'9999').localeCompare(String(b.due||'9999')),
      updated:(a,b)=>String(b.updated||'').localeCompare(String(a.updated||'')),
      title:(a,b)=>String(a.title||a.id).localeCompare(String(b.title||b.id)),
      project:(a,b)=>String(a.project||'~').localeCompare(String(b.project||'~')),
      domain:(a,b)=>String(a.domain||'~').localeCompare(String(b.domain||'~')),
      type:(a,b)=>String(a.type).localeCompare(String(b.type)),
    };
    rows.sort(CMP[sortBy]||CMP.priority); // unset values sort last (except updated: newest first)
    const isDone = field==='status' && lane==='done';
    let hidDone=0;
    if(isDone && doneWindow!=='all'){
      const days={yesterday:1,week:7,month:30}[doneWindow]||7;
      const cut=addDays(todayStr(),-days);
      const before=rows.length;
      rows=rows.filter(o=>String(o.updated||'').slice(0,10)>=cut);
      hidDone=before-rows.length;
    }
    const isMax=maxLane===lane;
    const col=el('div','col'+(isMax?' max':'')); col.dataset.lane=lane;
    const h=el('h3',null,'<span class="dot" style="background:'+(LANE_COLOR[lane]||TYPE_COLOR[lane]||'#888')+'"></span>'+esc(lane)+(isMax?' <span style="opacity:.5;font-weight:400;text-transform:none">(double-click or Esc to restore)</span>':'')+'<span class="cnt">'+rows.length+(hidDone?' <span style="opacity:.55" title="'+hidDone+' older done hidden">+'+hidDone+' older</span>':'')+'</span>');
    col.title='double-click to '+(isMax?'restore':'maximize as a list');
    col.addEventListener('dblclick',ev=>{ if(ev.target.closest('.card')||ev.target.tagName==='SELECT')return; maxLane=isMax?null:lane; renderBoard(); });
    if(isDone){
      const sel=el('select','donewin');
      ['yesterday','week','month','all'].forEach(w=>{const op=el('option',null,w);op.value=w;if(w===doneWindow)op.selected=true;sel.appendChild(op);});
      sel.title='show items done (updated) within… — older ones are hidden';
      sel.addEventListener('click',ev=>ev.stopPropagation());
      sel.addEventListener('change',()=>{doneWindow=sel.value;saveState();renderBoard();});
      h.insertBefore(sel,h.querySelector('.cnt'));
    }
    col.appendChild(h);
    const cards=el('div','cards');
    rows.forEach(o=>{
      const card=el('div','card'+(bl.has(o.id)?' blocked':'')+(isMax?' compact':'')); card.draggable=true; card.dataset.id=o.id;
      const isThought=o.type==='thought';
      card.innerHTML='<div class="cact">'+(isThought?'<button data-act="toIdea" title="Convert → idea">→💡</button><button data-act="toTask" title="Convert → task">→☑</button>':'')+'<button data-act="edit" title="Edit">✎</button><button data-act="clone" title="Clone">⧉</button><button data-act="recat" title="Recategorize / move">⇄</button><button data-act="del" title="Delete">✕</button></div>'+
        '<div class="ct">'+esc(o.title||o.id)+'</div><div class="cm"><span class="badge">'+o.type+'</span>'+(o.priority?'<span class="prio '+esc(o.priority)+'">'+esc(o.priority)+'</span>':'')+(o.due?'<span class="due'+(o.due<todayStr()&&o.status!=='done'&&o.status!=='outdated'?' late':'')+'">⏰ '+esc(o.due)+'</span>':'')+(o.domain?'<span>'+esc(o.domain)+'</span>':'')+(o.lane?'<span>⋔ '+esc(o.lane)+'</span>':'')+(o.project?'<span>· '+esc(o.project.split('/').pop())+'</span>':'')+(isThought&&o.context?'<span title="where this was captured">◔ '+esc(o.context)+'</span>':'')+(isThought&&(o.surfaced_on||o.created)?'<span>'+esc(o.surfaced_on||o.created)+'</span>':'')+'</div>';
      card.addEventListener('click',ev=>{ if(ev.target.closest('[data-act]'))return; openDetail(o.id); });
      card.querySelectorAll('[data-act]').forEach(b=>b.addEventListener('click',ev=>{ev.stopPropagation();const a=b.dataset.act;vscode.postMessage({type:'action',action:a==='edit'?'editItem':a==='recat'?'recategorize':a==='clone'?'cloneItem':a==='toIdea'?'convertToIdea':a==='toTask'?'convertToTask':'deleteItem',id:o.id});}));
      card.addEventListener('dragstart',ev=>{ev.dataTransfer.setData('text/plain',o.id);card.classList.add('dragging');});
      card.addEventListener('dragend',()=>card.classList.remove('dragging'));
      // drop a card ON another card => adopt its priority (drag-to-sort within a lane);
      // across lanes it also takes the target lane's status
      card.addEventListener('dragover',ev=>{ev.preventDefault();ev.stopPropagation();card.classList.add('dropover');});
      card.addEventListener('dragleave',()=>card.classList.remove('dropover'));
      card.addEventListener('drop',ev=>{ev.preventDefault();ev.stopPropagation();card.classList.remove('dropover');
        const id=ev.dataTransfer.getData('text/plain'); if(!id||id===o.id)return;
        const src=(S.objects||[]).find(x=>x.id===id);
        if(field==='status'&&src&&String(src.status||'')!==String(lane))postStatus(id,lane);
        vscode.postMessage({type:'setPriority',id:id,priority:o.priority||'-'});});
      cards.appendChild(card);
    });
    col.appendChild(cards);
    col.addEventListener('dragover',ev=>{ev.preventDefault();col.classList.add('over');});
    col.addEventListener('dragleave',()=>col.classList.remove('over'));
    col.addEventListener('drop',ev=>{ev.preventDefault();col.classList.remove('over');const id=ev.dataTransfer.getData('text/plain');if(!id)return;
      if(field==='status')postStatus(id,lane);
      else if(field==='type')vscode.postMessage({type:'action',action:'setType',id:id,toType:lane});
      else vscode.postMessage({type:'action',action:'setField',id:id,field:field,value:lane==='(none)'?'':lane});});
    lanesWrap.appendChild(col);
  });
}

// ── project-centric view: each KP project with its open work + linked sessions ──
const expandedProjects=new Set();
function parseLinked(o){try{const v=typeof o.linked_sessions==='string'?JSON.parse(o.linked_sessions):(o.linked_sessions||[]);return Array.isArray(v)?v:[];}catch(e){return [];}}
function renderProjects(){
  const el2=$('#projects'); el2.innerHTML='';
  const wrap=el('div','pgrid'); el2.appendChild(wrap);
  const items=(S.objects||[]).filter(o=>BOARD_TYPES.indexOf(o.type)>=0);
  const projects=(S.objects||[]).filter(o=>o.type==='project').sort((a,b)=>String(a.title||a.id).localeCompare(String(b.title||b.id)));
  const buckets=projects.map(p=>({p,rows:items.filter(o=>o.project===p.id)}));
  buckets.push({p:{id:'(none)',title:'(no project)',type:'project'},rows:items.filter(o=>!o.project)});
  buckets.forEach(({p,rows})=>{
    if(p.id==='(none)'&&!rows.length)return;
    const open=rows.filter(o=>!CLOSING.has(String(o.status||'')));
    const closed=rows.length-open.length;
    const key=p.id, expanded=expandedProjects.has(key);
    const card=el('div','pcard');
    const byType={}; rows.forEach(o=>{byType[o.type]=(byType[o.type]||0)+1;});
    const counts=Object.entries(byType).map(([k,v])=>v+' '+k+(v>1?'s':'')).join(' · ');
    const h=el('h3',null,esc(p.title||p.id.split('/').pop())+'<span class="pn">'+open.length+' open'+(closed?' · '+closed+' closed':'')+(counts?' · '+counts:'')+'</span>');
    h.title=p.id==='(none)'?'items without a project':'open '+esc(p.id)+' — double-click card to '+(expanded?'collapse':'expand');
    if(p.id!=='(none)')h.addEventListener('click',()=>openDetail(p.id));
    card.appendChild(h);
    card.addEventListener('dblclick',ev=>{if(ev.target.closest('.pitem')||ev.target.closest('.psess'))return;expanded?expandedProjects.delete(key):expandedProjects.add(key);renderProjects();});
    const STATUS_ORDER=['in_progress','today','inbox','capture','refine','accepted','plan','prototype','implement','validate','new','kept'];
    const sorted=open.slice().sort((a,b)=>{const ai=STATUS_ORDER.indexOf(String(a.status)),bi=STATUS_ORDER.indexOf(String(b.status));return (ai<0?99:ai)-(bi<0?99:bi)||String(a.priority||'p9').localeCompare(String(b.priority||'p9'));});
    const show=expanded?sorted:sorted.slice(0,10);
    show.forEach(o=>{
      const it=el('div','pitem');
      it.innerHTML='<span class="dot" style="background:'+(TYPE_COLOR[o.type]||'#888')+'"></span><span class="st">'+esc(o.status||'')+(o.priority?' '+esc(o.priority):'')+'</span><span class="pt">'+esc(o.title||o.id)+'</span>';
      it.addEventListener('click',()=>openDetail(o.id));
      card.appendChild(it);
    });
    if(!expanded&&sorted.length>show.length){const m=el('div','pmore','…+'+(sorted.length-show.length)+' more — click to expand');m.addEventListener('click',()=>{expandedProjects.add(key);renderProjects();});card.appendChild(m);}
    if(expanded&&closed){const m=el('div','pmore',closed+' closed item(s) shown on the board (done lane)');card.appendChild(m);}
    const sess=new Set(parseLinked(p)); rows.forEach(o=>parseLinked(o).forEach(u=>sess.add(u)));
    if(sess.size){
      const ts=el('div','psess'); ts.appendChild(el('div','lbl','linked sessions ('+sess.size+')'));
      [...sess].slice(0,expanded?15:5).forEach(u=>{
        const it=el('div','pitem'); it.innerHTML='<span class="st">▸ session</span><span class="pt">'+esc(String(u).slice(0,18))+'…</span>';
        it.title='open chat — '+esc(u);
        it.addEventListener('click',()=>vscode.postMessage({type:'action',action:'openSession',uuid:u}));
        ts.appendChild(it);
      });
      card.appendChild(ts);
    }
    wrap.appendChild(card);
  });
  if(!wrap.children.length)wrap.appendChild(el('div',null,'<span style="opacity:.6">No projects yet — create type:project objects in the store, or assign items a Project in the drawer.</span>'));
}
// ── sessions view: CS git-store sessions with time filters + link-to-task ──
let SESS=null, sessFilter='week', sessSearch='';
function dayStart(offset){ const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()+(offset||0)); return d.getTime(); }
function sessInWindow(s){
  const t=s.startedAt||s.mtime||0;
  if(sessFilter==='all')return true;
  if(sessFilter==='today')return t>=dayStart(0);
  if(sessFilter==='yesterday')return t>=dayStart(-1)&&t<dayStart(0);
  if(sessFilter==='week')return t>=dayStart(-6);
  return true;
}
function titleForId(id){ const o=(S&&S.objects||[]).find(x=>x.id===id); return o?(o.title||o.id):id; }
function fmtWhen(t){ if(!t)return ''; const d=new Date(t); const today=dayStart(0);
  const hm=d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  if(t>=today)return 'today '+hm; if(t>=dayStart(-1))return 'yst '+hm;
  return d.toLocaleDateString([], {month:'short',day:'numeric'})+' '+hm; }
function renderSessions(){
  const el2=$('#sessions'); el2.innerHTML='';
  if(SESS===null){ el2.innerHTML='<div style="opacity:.6;padding:16px">Loading sessions…</div>'; vscode.postMessage({type:'requestSessions'}); return; }
  const bar=el('div','sessbar');
  const seg=el('div','seg');
  [['today','Today'],['yesterday','Yesterday'],['week','Last week'],['all','All']].forEach(([k,lbl])=>{
    const b=el('button',sessFilter===k?'on':null,lbl); b.addEventListener('click',()=>{sessFilter=k;renderSessions();}); seg.appendChild(b);
  });
  bar.appendChild(seg);
  const srch=el('input'); srch.placeholder='Search sessions…'; srch.value=sessSearch; srch.className='sesssearch';
  srch.addEventListener('input',e=>{sessSearch=e.target.value;renderSessions();});
  bar.appendChild(srch);
  const reload=el('button','ghost mini','⟳'); reload.title='reload sessions'; reload.addEventListener('click',()=>{SESS=null;vscode.postMessage({type:'requestSessions'});renderSessions();}); bar.appendChild(reload);
  el2.appendChild(bar);
  const q=sessSearch.toLowerCase();
  let rows=SESS.filter(sessInWindow).filter(s=>!q||((s.title||'')+' '+(s.project||'')+' '+(s.agent||'')).toLowerCase().includes(q));
  const cnt=el('div','sesscount',rows.length+' session(s) · '+sessFilter); el2.appendChild(cnt);
  if(!rows.length){ el2.appendChild(el('div',null,'<div style="opacity:.55;padding:14px 2px">No sessions in this window.</div>')); return; }
  const list=el('div','sesslist');
  rows.slice(0,300).forEach(s=>{
    const c=el('div','sesscard');
    const src=s.source==='grok'?'[G]':s.source==='git'?'[S]':'[C]';
    const refs=(s.planningRefs||[]).map(id=>'<span class="badge" title="linked">↔ '+esc(titleForId(id))+'</span>').join('');
    c.innerHTML='<div class="sh"><span class="ct">'+esc(s.title||s.uuid)+'</span><span class="cm">'+fmtWhen(s.startedAt||s.mtime)+'</span></div>'+
      '<div class="sm"><span class="badge">'+src+' '+esc(s.agent||'')+'</span>'+(s.project?'<span>'+esc(s.project)+'</span>':'')+(s.turns?'<span>'+s.turns+'t</span>':'')+'</div>'+
      (refs?'<div class="srefs">'+refs+'</div>':'');
    const acts=el('div','sacts');
    const open=el('button','ghost mini','Open'); open.title='view transcript'; open.addEventListener('click',()=>vscode.postMessage({type:'action',action:'openSession',uuid:s.uuid,title:s.title}));
    const resume=el('button','ghost mini','Resume ▸'); resume.title='resume in Code Build'; resume.addEventListener('click',()=>vscode.postMessage({type:'action',action:'resumeSession',uuid:s.uuid,cwd:s.projectPath,source:s.source,title:s.title}));
    const link=el('button','ghost mini','Link to task'); link.addEventListener('click',()=>vscode.postMessage({type:'action',action:'linkSessionToTask',uuid:s.uuid}));
    acts.appendChild(open); acts.appendChild(resume); acts.appendChild(link);
    if((s.planningRefs||[]).length){ const g=el('button','ghost mini','→ planning'); g.addEventListener('click',()=>openDetail(s.planningRefs[0])); acts.appendChild(g); }
    c.appendChild(acts);
    c.addEventListener('click',ev=>{ if(ev.target.closest('button'))return; vscode.postMessage({type:'action',action:'openSession',uuid:s.uuid,title:s.title}); });
    list.appendChild(c);
  });
  el2.appendChild(list);
}
// ── social: ideas/tasks flagged (lane==='social') to polish into a post ──
const SOCIAL_LANE='social';
function isSocial(o){ return String(o.lane||'')===SOCIAL_LANE; }
function renderSocial(){
  const el2=$('#social'); el2.innerHTML='';
  const rows=(S.objects||[]).filter(o=>(o.type==='idea'||o.type==='task'||o.type==='thought')&&isSocial(o));
  const bar=el('div',null,'<div style="font-size:13px;font-weight:600;margin-bottom:2px">✨ Polish → social media post</div><div style="opacity:.65;font-size:12px;margin-bottom:12px">Ideas / tasks / thoughts flagged for social. Flag any item from its drawer ("Mark for social"), or drag a card here. "Polish in Code Build" drafts a post from the item.</div>');
  el2.appendChild(bar);
  const drop=el('div','socialdrop'); drop.textContent='＋ drop a card here to flag it for social';
  drop.addEventListener('dragover',ev=>{ev.preventDefault();drop.classList.add('over');});
  drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
  drop.addEventListener('drop',ev=>{ev.preventDefault();drop.classList.remove('over');const id=ev.dataTransfer.getData('text/plain');if(id)vscode.postMessage({type:'action',action:'toggleSocial',id:id,on:true});});
  el2.appendChild(drop);
  if(!rows.length){ el2.appendChild(el('div',null,'<div style="opacity:.55;padding:14px 2px">Nothing flagged yet.</div>')); return; }
  const list=el('div','sociallist');
  rows.forEach(o=>{
    const c=el('div','socialcard');
    c.innerHTML='<div class="sh"><span class="ct">'+esc(o.title||o.id)+'</span><span class="cm"><span class="badge">'+o.type+'</span>'+(o.domain?'<span>'+esc(o.domain)+'</span>':'')+(o.status?'<span>'+esc(o.status)+'</span>':'')+'</span></div>';
    const acts=el('div','sacts');
    const polish=el('button','ghost mini','✨ Polish in Code Build'); polish.addEventListener('click',()=>vscode.postMessage({type:'action',action:'polishSocial',id:o.id}));
    const open=el('button','ghost mini','Open'); open.addEventListener('click',()=>openDetail(o.id));
    const unflag=el('button','ghost mini','Unflag'); unflag.addEventListener('click',()=>vscode.postMessage({type:'action',action:'toggleSocial',id:o.id,on:false}));
    acts.appendChild(polish); acts.appendChild(open); acts.appendChild(unflag);
    c.appendChild(acts); list.appendChild(c);
  });
  el2.appendChild(list);
}
function todayStr(){return (S&&S.board&&S.board.date)||new Date().toISOString().slice(0,10);}
let calFrom=null, calTo=null, calMode='month', calAnchor=null;
let boardDateField='updated', boardDateVal='';
const addDays=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
const weekStart=d=>{const x=new Date(d+'T00:00:00Z');return addDays(d,-((x.getUTCDay()+6)%7));}; // Monday
function dueByDay(){const m={};(S.objects||[]).filter(o=>o.type==='task'&&o.due).forEach(o=>{(m[o.due]??=[]).push(o);});
  for(const k in m)m[k].sort((a,b)=>((a.priority||'p9')).localeCompare(b.priority||'p9'));return m;}
function calDrop(elm,day){
  elm.addEventListener('dragover',ev=>{ev.preventDefault();ev.dataTransfer.dropEffect='move';elm.classList.add('over');});
  elm.addEventListener('dragleave',()=>elm.classList.remove('over'));
  elm.addEventListener('drop',ev=>{ev.preventDefault();elm.classList.remove('over');
    const id=ev.dataTransfer.getData('text/plain');
    if(id)vscode.postMessage({type:'setDue',id:id,due:day});});
}
function dueItem(o,cls){
  const now=todayStr();const closed=o.status==='done'||o.status==='outdated';
  const it=el('div',cls+(o.due<now&&!closed?' late':''));
  it.textContent=(o.priority?o.priority+' · ':'')+(o.title||o.id);
  it.draggable=true;
  it.addEventListener('dragstart',ev=>{ev.stopPropagation();ev.dataTransfer.setData('text/plain',o.id);ev.dataTransfer.effectAllowed='move';});
  it.addEventListener('click',ev=>{ev.stopPropagation();openDetail(o.id);});
  return it;
}
function renderCalendar(){
  const now=todayStr();
  if(!calAnchor)calAnchor=now;
  const cal=$('#calendar'); cal.innerHTML='';
  const by=dueByDay();
  if(calMode==='list'){ renderCalList(cal,by,now); return; }
  const bar=el('div','calbar');
  const title=calMode==='month'?new Date(calAnchor+'T00:00:00Z').toLocaleDateString(undefined,{month:'long',year:'numeric',timeZone:'UTC'}):'Week of '+weekStart(calAnchor);
  bar.innerHTML='<button class="ghost" id="cPrev">‹</button><span class="title">'+esc(title)+'</span><button class="ghost" id="cNext">›</button><button class="ghost" id="cToday">Today</button>';
  cal.appendChild(bar);
  bar.querySelector('#cToday').addEventListener('click',()=>{calAnchor=now;renderCalendar();});
  if(calMode==='month'){
    bar.querySelector('#cPrev').addEventListener('click',()=>{const d=new Date(calAnchor+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()-1,1);calAnchor=d.toISOString().slice(0,10);renderCalendar();});
    bar.querySelector('#cNext').addEventListener('click',()=>{const d=new Date(calAnchor+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+1,1);calAnchor=d.toISOString().slice(0,10);renderCalendar();});
    const gridStart=weekStart(calAnchor.slice(0,8)+'01');
    const grid=el('div','mgrid');
    ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach(d=>grid.appendChild(el('div','dow',d)));
    for(let i=0;i<42;i++){
      const d=addDays(gridStart,i);
      const cell=el('div','mcell'+(d.slice(0,7)!==calAnchor.slice(0,7)?' dim':'')+(d===now?' today':''));
      cell.appendChild(el('div','d','<span>'+Number(d.slice(8))+'</span>'));
      const due=by[d]||[];
      due.slice(0,3).forEach(o=>cell.appendChild(dueItem(o,'mi')));
      if(due.length>3)cell.appendChild(el('div','mi','+'+(due.length-3)+' more…'));
      cell.addEventListener('click',ev=>{ if(ev.target.closest('.mi'))return; openCreateDrawer({due:d}); });
      cell.querySelector('.d').addEventListener('click',ev=>{ev.stopPropagation();calMode='list';calFrom=d;calTo=d;renderCalendar();});
      cell.querySelector('.d').style.cursor='pointer';cell.querySelector('.d').title='open day list';
      calDrop(cell,d);
      grid.appendChild(cell);
    }
    cal.appendChild(grid);
  }else{
    const days=calMode==='workweek'?5:7;
    bar.querySelector('#cPrev').addEventListener('click',()=>{calAnchor=addDays(calAnchor,-7);renderCalendar();});
    bar.querySelector('#cNext').addEventListener('click',()=>{calAnchor=addDays(calAnchor,7);renderCalendar();});
    const start=weekStart(calAnchor);
    const grid=el('div','wgrid');grid.style.gridTemplateColumns='repeat('+days+',1fr)';
    for(let i=0;i<days;i++){
      const d=addDays(start,i);
      const col=el('div','wcol'+(d===now?' today':''));
      const label=new Date(d+'T00:00:00Z').toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'});
      const h=el('h4',null,'<span>'+esc(label)+'</span><span>›</span>');
      h.addEventListener('click',()=>{calMode='list';calFrom=d;calTo=d;renderCalendar();});
      col.appendChild(h);
      (by[d]||[]).forEach(o=>col.appendChild(dueItem(o,'witem')));
      col.addEventListener('click',ev=>{ if(ev.target.closest('.witem')||ev.target.closest('h4'))return; openCreateDrawer({due:d}); });
      col.style.cursor='pointer';col.title='click empty space to add a task due this day';
      calDrop(col,d);
      grid.appendChild(col);
    }
    cal.appendChild(grid);
  }
}
function renderCalList(cal,by,now){
  if(!calFrom){calFrom=now;}
  if(!calTo){calTo=addDays(now,14);}
  const bar=el('div','calbar');
  bar.innerHTML='<label>from <input type="date" id="calFrom" value="'+calFrom+'"></label> <label>to <input type="date" id="calTo" value="'+calTo+'"></label> <button id="calAll" class="ghost">All dated</button> <button id="calOverdue" class="ghost">+ Overdue</button>';
  cal.appendChild(bar);
  const inWin=Object.keys(by).filter(d=>d>=calFrom&&d<=calTo).sort();
  if(!inWin.length)cal.appendChild(el('div','calempty','(no tasks due between '+calFrom+' and '+calTo+')'));
  inWin.forEach(day=>{
    const dayEl=el('div','calday');
    const mark=day<now?' ⚠':day===now?' ← today':'';
    dayEl.appendChild(el('h3',null,esc(day)+mark));
    by[day].forEach(o=>{const done=o.status==='done'||o.status==='outdated';
      const row=el('div','calrow'+(done?' done':'')+(o.due<now&&!done?' late':''));
      row.innerHTML='<span class="dot" style="background:'+(LANE_COLOR[o.status]||'#888')+'"></span>'+(o.priority?'<span class="prio '+esc(o.priority)+'">'+esc(o.priority)+'</span>':'')+'<span class="ct">'+esc(o.title||o.id)+'</span><span class="cm">'+esc(o.status||'')+(o.domain?' · '+esc(o.domain):'')+'</span>';
      row.addEventListener('click',()=>openDetail(o.id));
      dayEl.appendChild(row);});
    cal.appendChild(dayEl);
  });
  bar.querySelector('#calFrom').addEventListener('change',e=>{calFrom=e.target.value;renderCalendar();});
  bar.querySelector('#calTo').addEventListener('change',e=>{calTo=e.target.value;renderCalendar();});
  bar.querySelector('#calAll').addEventListener('click',()=>{calFrom='0000-01-01';calTo='9999-12-31';renderCalendar();});
  bar.querySelector('#calOverdue').addEventListener('click',()=>{calFrom='0000-01-01';calTo=todayStr();renderCalendar();});
}

// force-directed graph
let gFilter={nodes:new Set(),edges:new Set()};
let gT={x:0,y:0,k:1};
function renderFilters(){
  const panel=$('#gfilters'); if(!panel)return;
  const types=[...new Set(((S&&S.graph&&S.graph.nodes)||[]).map(n=>n.type))].sort();
  const kinds=[...new Set(((S&&S.graph&&S.graph.edges)||[]).map(e=>e.kind))].sort();
  const btn=(label,active,color,attr,val)=>'<button class="gf-btn'+(active?'':' off')+'" '+attr+'="'+esc(val)+'">'+(color?'<span class="gf-dot" style="background:'+color+'"></span>':'')+esc(label)+'</button>';
  panel.innerHTML='<div class="gf-row"><span class="gf-lab">Nodes</span>'+types.map(t=>btn(t,!gFilter.nodes.has(t),TYPE_COLOR[t]||'#888','data-nt',t)).join('')+'</div>'+
    '<div class="gf-row"><span class="gf-lab">Edges</span>'+kinds.map(k=>btn(k,!gFilter.edges.has(k),'','data-ek',k)).join('')+'<button class="gf-btn gf-fit" id="gfFit">⊡ fit</button></div>';
  panel.querySelectorAll('[data-nt]').forEach(b=>b.addEventListener('click',()=>{const t=b.getAttribute('data-nt');gFilter.nodes.has(t)?gFilter.nodes.delete(t):gFilter.nodes.add(t);renderGraph();}));
  panel.querySelectorAll('[data-ek]').forEach(b=>b.addEventListener('click',()=>{const k=b.getAttribute('data-ek');gFilter.edges.has(k)?gFilter.edges.delete(k):gFilter.edges.add(k);renderGraph();}));
  const fit=$('#gfFit'); if(fit)fit.addEventListener('click',()=>renderGraph());
}
function renderGraph(){
  const svg=$('#graph'); const r=svg.getBoundingClientRect();
  const W=(r.width||window.innerWidth||900), H=(r.height||(window.innerHeight-100)||600);
  svg.setAttribute('viewBox','0 0 '+W+' '+H);
  renderFilters();
  const allNodes=((S&&S.graph&&S.graph.nodes)||[]).filter(n=>!gFilter.nodes.has(n.type));
  const present=new Set(allNodes.map(n=>n.id));
  const edges=((S&&S.graph&&S.graph.edges)||[]).filter(e=>!gFilter.edges.has(e.kind)&&present.has(e.from)&&present.has(e.to));
  if(!allNodes.length){ svg.innerHTML='<text x="20" y="40" fill="currentColor" opacity="0.6">No nodes (all hidden, or no data).</text>'; return; }
  // lay out around the origin, then auto-fit the bounding box to the viewport
  const N=allNodes.length, R0=Math.max(160,Math.sqrt(N)*80);
  const nodes=allNodes.map((n,i)=>{const a=i/N*6.283;return {...n,x:Math.cos(a)*R0*(0.55+0.45*((i*0.37)%1)),y:Math.sin(a)*R0*(0.55+0.45*((i*0.61)%1)),vx:0,vy:0};});
  const idx={}; nodes.forEach(n=>idx[n.id]=n);
  const E=edges.filter(e=>idx[e.from]&&idx[e.to]);
  for(let it=0;it<340;it++){
    for(let a=0;a<nodes.length;a++)for(let b=a+1;b<nodes.length;b++){
      const p=nodes[a],q=nodes[b];let dx=p.x-q.x,dy=p.y-q.y;let d=Math.sqrt(dx*dx+dy*dy)||0.5;let f=Math.min(9000/(d*d),45);p.vx+=dx/d*f;p.vy+=dy/d*f;q.vx-=dx/d*f;q.vy-=dy/d*f;}
    E.forEach(e=>{const p=idx[e.from],q=idx[e.to];let dx=q.x-p.x,dy=q.y-p.y;let d=Math.sqrt(dx*dx+dy*dy)||1;let f=(d-72)*0.05;p.vx+=dx/d*f;p.vy+=dy/d*f;q.vx-=dx/d*f;q.vy-=dy/d*f;});
    nodes.forEach(n=>{n.vx+=(-n.x)*0.013;n.vy+=(-n.y)*0.013;n.x+=Math.max(-18,Math.min(18,n.vx));n.y+=Math.max(-18,Math.min(18,n.vy));n.vx*=0.8;n.vy*=0.8;});
  }
  let mnx=1e9,mny=1e9,mxx=-1e9,mxy=-1e9;
  nodes.forEach(n=>{mnx=Math.min(mnx,n.x);mny=Math.min(mny,n.y);mxx=Math.max(mxx,n.x);mxy=Math.max(mxy,n.y);});
  const bw=Math.max(1,mxx-mnx),bh=Math.max(1,mxy-mny),pad=120;
  gT.k=Math.max(0.3,Math.min((W-pad)/bw,(H-pad)/bh,2.4)); gT.x=W/2-(mnx+bw/2)*gT.k; gT.y=H/2-(mny+bh/2)*gT.k;
  const k=gT.k, fs=(12/k).toFixed(1);
  const ns='http://www.w3.org/2000/svg';
  svg.innerHTML='';
  const g=document.createElementNS(ns,'g'); g.setAttribute('id','gz'); svg.appendChild(g);
  E.forEach(e=>{const p=idx[e.from],q=idx[e.to];const l=document.createElementNS(ns,'line');l.setAttribute('x1',p.x);l.setAttribute('y1',p.y);l.setAttribute('x2',q.x);l.setAttribute('y2',q.y);l.setAttribute('vector-effect','non-scaling-stroke');if(e.kind==='blocked_by'&&e.status!=='resolved')l.setAttribute('class','blocked');g.appendChild(l);});
  nodes.forEach(nd=>{const grp=document.createElementNS(ns,'g');
    const c=document.createElementNS(ns,'circle');c.setAttribute('cx',nd.x);c.setAttribute('cy',nd.y);c.setAttribute('r',((nd.blocked?9:7)/k).toFixed(1));c.setAttribute('fill',nd.blocked?'#e51400':(TYPE_COLOR[nd.type]||'#888'));
    c.addEventListener('click',()=>{ if(S.objects&&S.objects.some(o=>o.id===nd.id)) openDetail(nd.id); else vscode.postMessage({type:'open',id:nd.id,kbPath:nd.type==='knowledge'?nd.id:undefined}); });
    const t=document.createElementNS(ns,'text');t.setAttribute('x',nd.x+(10/k));t.setAttribute('y',nd.y+(4/k));t.setAttribute('font-size',fs);t.setAttribute('paint-order','stroke');t.setAttribute('stroke','var(--vscode-editor-background)');t.setAttribute('stroke-width',(3.5/k).toFixed(1));t.setAttribute('stroke-linejoin','round');t.textContent=(nd.label||nd.id).slice(0,30);
    grp.appendChild(c);grp.appendChild(t);g.appendChild(grp);});
  applyZoom();
}
function applyZoom(){const g=$('#gz');if(g)g.setAttribute('transform','translate('+gT.x+','+gT.y+') scale('+gT.k+')');}
(function(){const svg=$('#graph');let drag=false,sx,sy;
  svg.addEventListener('wheel',e=>{e.preventDefault();const f=e.deltaY<0?1.1:0.9;gT.k=Math.max(0.2,Math.min(4,gT.k*f));applyZoom();},{passive:false});
  svg.addEventListener('mousedown',e=>{if(e.target.tagName==='circle')return;drag=true;sx=e.clientX-gT.x;sy=e.clientY-gT.y;});
  window.addEventListener('mousemove',e=>{if(!drag)return;gT.x=e.clientX-sx;gT.y=e.clientY-sy;applyZoom();});
  window.addEventListener('mouseup',()=>drag=false);
})();

function renderCanvas(){ $('#canvas').innerHTML='<div style="font-size:40px">✎</div><div><b>Visual canvas — Excalidraw</b></div><div style="max-width:420px">A free-form sketch/whiteboard saved to <code>~/docs/planning/canvas/board.excalidraw</code> (versioned in git with the rest of the plan).</div><button class="ghost" id="cbtn" style="margin-top:6px">Open Excalidraw canvas →</button>'; const b=$('#cbtn'); if(b)b.addEventListener('click',()=>vscode.postMessage({type:'action',action:'openCanvas'})); }

// detail drawer
let flushAutosave=null;
function openDetail(id){ vscode.postMessage({type:'show',id:id}); $('#drawer').classList.remove('hidden'); $('#backdrop').classList.remove('hidden'); $('#drawerInner').innerHTML='<div style="opacity:.6">Loading '+esc(id)+'…</div>'; }
function closeDrawer(){ if(flushAutosave){try{flushAutosave();}catch(e){}} flushAutosave=null; $('#drawer').classList.add('hidden'); $('#backdrop').classList.add('hidden'); }
function domainOptions(){ const s=new Set(); ((S&&S.objects)||[]).forEach(x=>{ if(x.type==='domain')s.add(String(x.title||x.id.split('/').pop())); else if(x.domain)s.add(String(x.domain)); }); return [...s].sort(); }
function projectOptions(){ return ((S&&S.objects)||[]).filter(x=>x.type==='project').map(x=>({id:x.id,title:x.title||x.id.split('/').pop()})).sort((a,b)=>a.title.localeCompare(b.title)); }
// New-item editor rendered in the side drawer — all fields editable before it's
// created (replaces the cramped one-line top-bar input).
function openCreateDrawer(prefill){
  flushAutosave=null;
  prefill=prefill||{};
  $('#drawer').classList.remove('hidden'); $('#backdrop').classList.remove('hidden');
  const I=$('#drawerInner'); I.innerHTML='';
  const head=el('div','dh'); head.appendChild(el('h2',null,'New item')); const x=el('button','dclose','✕'); x.addEventListener('click',closeDrawer); head.appendChild(x); I.appendChild(head);
  const STAT={task:['inbox','today','in_progress','done','deferred','outdated'],idea:['capture','refine','accepted','parked','done'],plan:['plan','prototype','implement','validate','done','parked'],thought:['new','kept','converted','archived']};
  // tasks default to 'today' (new items are things to do now); ideas/plans/thoughts keep theirs
  const DEF={task:'today',idea:'capture',plan:'plan',thought:'new'};
  let type=prefill.type||'task';
  const row=(label,node)=>{const r=el('div','statusrow'); r.appendChild(el('span',null,label)); r.appendChild(node); I.appendChild(r); return r;};
  // Type
  const tSel=el('select'); ['task','idea','plan','thought'].forEach(t=>{const o=el('option',null,t);o.value=t;if(t===type)o.selected=true;tSel.appendChild(o);}); row('Type:',tSel);
  // Title
  const title=el('input','fldEdit'); title.style.width='100%'; title.placeholder='What needs doing?'; title.value=prefill.title||''; row('Title:',title); title.parentElement.style.flexWrap='wrap';
  // Status
  const sSel=el('select'); const fillStatus=()=>{sSel.innerHTML=''; (STAT[type]||STAT.task).forEach(s=>{const o=el('option',null,s);o.value=s;if(s===(prefill.status||DEF[type]))o.selected=true;sSel.appendChild(o);});}; fillStatus(); row('Status:',sSel);
  // Category/domain with datalist
  const dl=el('datalist'); dl.id='newDomList'; domainOptions().forEach(d=>{const o=el('option');o.value=d;dl.appendChild(o);}); I.appendChild(dl);
  const dom=el('input','fldEdit'); dom.setAttribute('list','newDomList'); dom.placeholder='kids / tech / career…'; dom.value=prefill.domain||''; row('Category:',dom);
  // Lane
  const lane=el('input','fldEdit'); lane.placeholder='(optional)'; lane.value=prefill.lane||''; row('Lane:',lane);
  // Project
  const pSel=el('select'); const pn=el('option',null,'(none)'); pn.value=''; pSel.appendChild(pn); projectOptions().forEach(p=>{const o=el('option',null,p.title);o.value=p.id;if(p.id===prefill.project)o.selected=true;pSel.appendChild(o);}); row('Project:',pSel);
  // Due + priority
  const due=el('input','fldEdit'); due.type='date'; due.value=prefill.due||todayStr(); const prio=el('select'); ['-','p0','p1','p2','p3'].forEach(p=>{const o=el('option',null,p);o.value=p;prio.appendChild(o);}); const dpr=el('div','statusrow'); dpr.appendChild(el('span',null,'Due:')); dpr.appendChild(due); dpr.appendChild(el('span',null,'Priority:')); dpr.appendChild(prio); I.appendChild(dpr);
  // Body
  { const s=el('div','sec'); s.appendChild(el('h4',null,'Notes / details')); const ta=el('textarea','bodyEdit'); ta.id='newBody'; ta.placeholder='Markdown details…'; ta.value=prefill.body||''; s.appendChild(ta); I.appendChild(s); }
  tSel.addEventListener('change',()=>{type=tSel.value;fillStatus();});
  // actions
  const act=el('div','actions'); act.style.marginTop='14px';
  const create=el('button','act primary','Create'); const cancel=el('button','act','Cancel');
  act.appendChild(create); act.appendChild(cancel); I.appendChild(act);
  cancel.addEventListener('click',closeDrawer);
  const submit=()=>{ const t=title.value.trim(); if(!t){title.focus();return;}
    vscode.postMessage({type:'action',action:'createItem',fields:{type:type,title:t,status:sSel.value,domain:dom.value.trim(),lane:lane.value.trim(),project:pSel.value,due:due.value,priority:prio.value==='-'?'':prio.value,body:$('#newBody').value}}); };
  create.addEventListener('click',submit);
  title.addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();submit();} });
  setTimeout(()=>title.focus(),50);
}
function mdLite(s){ return esc(s).replace(/^### (.*)$/gm,'<h3>$1</h3>').replace(/^## (.*)$/gm,'<h2>$1</h2>').replace(/^# (.*)$/gm,'<h2>$1</h2>').replace(/\\*\\*(.+?)\\*\\*/g,'<b>$1</b>').replace(/\`([^\`]+)\`/g,'<code>$1</code>'); }
function refRow(r,bad,onclick){ const d=el('div','refitem'+(bad?' bad':'')); d.innerHTML=esc(r.title||r.id||r.path); if(r.status)d.innerHTML+=' <span class="badge">'+esc(r.status)+'</span>'; if(onclick)d.addEventListener('click',onclick); return d; }
function renderDrawer(o){
  const I=$('#drawerInner'); I.innerHTML='';
  const head=el('div','dh'); const ti=el('input','titleEdit'); ti.value=o.title||''; ti.title='Edit name — Enter or click away to save'; ti.addEventListener('change',()=>vscode.postMessage({type:'action',action:'updateField',id:o.id,field:'title',value:ti.value})); head.appendChild(ti); const x=el('button','dclose','✕'); x.addEventListener('click',closeDrawer); head.appendChild(x); I.appendChild(head);
  const fm=o.frontmatter||{};
  const meta=el('div','drow'); meta.innerHTML='<span class="badge">'+o.type+'</span>'+(o.status?'<span class="badge">'+esc(o.status)+'</span>':'')+(o.domain?'<span class="badge">'+esc(o.domain)+'</span>':'')+(fm.context?'<span class="badge" title="captured under">◔ '+esc(fm.context)+'</span>':'')+(fm.surfaced_on?'<span class="badge" title="surfaced on">'+esc(fm.surfaced_on)+'</span>':''); I.appendChild(meta);
  if(fm.source_url){ const sr=el('div','drow'); const a=el('span','badge','↗ '+esc(fm.source||'source')); a.style.cursor='pointer'; a.title=fm.source_url; a.addEventListener('click',()=>vscode.postMessage({type:'action',action:'openUrl',url:fm.source_url})); sr.appendChild(a); I.appendChild(sr); }
  // status changer
  const lanes=LANES[o.type]; if(lanes){ const sr=el('div','statusrow'); const sel=el('select'); lanes.forEach(l=>{const op=el('option',null,l);op.value=l;if(l===o.status)op.selected=true;sel.appendChild(op);}); sel.addEventListener('change',()=>postStatus(o.id,sel.value)); sr.appendChild(el('span',null,'Status:')); sr.appendChild(sel); I.appendChild(sr); }
  { const fr=el('div','statusrow'); const mkf=(field,val)=>{ const inp=el('input','fldEdit'); inp.value=val||''; inp.placeholder=field; inp.title='Edit '+field; inp.addEventListener('change',()=>vscode.postMessage({type:'action',action:'updateField',id:o.id,field:field,value:inp.value})); return inp; };
    const dl=el('datalist'); dl.id='domList';
    const doms=new Set(); ((S&&S.objects)||[]).forEach(x=>{ if(x.type==='domain')doms.add(String(x.title||x.id.split('/').pop())); else if(x.domain)doms.add(String(x.domain)); });
    [...doms].sort().forEach(d=>{const op=el('option');op.value=d;dl.appendChild(op);});
    fr.appendChild(dl);
    fr.appendChild(el('span',null,'Category:')); const di2=mkf('domain',o.domain); di2.setAttribute('list','domList'); di2.title='Category / domain — pick an existing one or type a new one'; fr.appendChild(di2);
    fr.appendChild(el('span',null,'Lane:')); fr.appendChild(mkf('lane',o.lane)); I.appendChild(fr); }
  { const pr=el('div','statusrow'); pr.appendChild(el('span',null,'Project:'));
    const sel=el('select'); const none=el('option',null,'(none)'); none.value='-'; sel.appendChild(none);
    const cur=o.project||(o.frontmatter&&o.frontmatter.project)||'';
    ((S&&S.objects)||[]).filter(x=>x.type==='project').forEach(p=>{const op=el('option',null,p.title||p.id);op.value=p.id;if(p.id===cur)op.selected=true;sel.appendChild(op);});
    if(!cur)none.selected=true;
    sel.addEventListener('change',()=>vscode.postMessage({type:'setProject',id:o.id,project:sel.value}));
    pr.appendChild(sel); I.appendChild(pr); }
  { const dr=el('div','statusrow'); dr.appendChild(el('span',null,'Due:')); const di=el('input','fldEdit'); di.type='date'; di.style.width='150px';
    let lastDue=String(o.due||(o.frontmatter&&o.frontmatter.due)||'').slice(0,10); di.value=lastDue; di.title='Assign a due date — clear to unset';
    // chromium fires 'change' per keystroke in the year segment (year "2" => valid 0002-07-25),
    // so debounce and refuse implausible years instead of saving intermediates
    let dueT=null;
    const commitDue=()=>{const v=di.value; if(v===lastDue)return; if(v&&(!/^\\d{4}-\\d{2}-\\d{2}$/.test(v)||Number(v.slice(0,4))<1970))return; lastDue=v; vscode.postMessage({type:'setDue',id:o.id,due:v||'-'});};
    di.addEventListener('change',()=>{clearTimeout(dueT);dueT=setTimeout(commitDue,700);});
    di.addEventListener('blur',()=>{clearTimeout(dueT);commitDue();});
    di.addEventListener('click',()=>{try{if(di.showPicker)di.showPicker();}catch(e){}});
    dr.appendChild(di);
    // Priority: p0 (highest) … p3, or none
    dr.appendChild(el('span',null,'Priority:'));
    const pi=el('select'); ['-','p0','p1','p2','p3'].forEach(p=>{const op=el('option',null,p);op.value=p;if(p===((o.frontmatter&&o.frontmatter.priority)||'-'))op.selected=true;pi.appendChild(op);});
    pi.addEventListener('change',()=>vscode.postMessage({type:'setPriority',id:o.id,priority:pi.value}));
    dr.appendChild(pi);
    I.appendChild(dr); }
  // agent actions
  const act=el('div','sec'); act.appendChild(el('h4',null,'Agent actions'));
  const grid=el('div','actions');
  const mk=(k,d,action,primary)=>{const b=el('button','act'+(primary?' primary':''),'<span class="k">'+k+'</span><span class="d">'+d+'</span>');b.addEventListener('click',()=>vscode.postMessage({type:'action',action:action,id:o.id}));return b;};
  grid.appendChild(mk('Ideate','expand into sub-ideas','ideate'));
  grid.appendChild(mk('Draft spec','speckit FRs + criteria','spec'));
  grid.appendChild(mk('Decompose','break into tasks','decompose'));
  grid.appendChild(mk('Research KB','find + connect knowledge','research'));
  act.appendChild(grid);
  const grid2=el('div','actions'); grid2.style.marginTop='7px';
  grid2.appendChild(mk('Run in Code Build ▸','review prompt, then run','execute',true));
  grid2.appendChild(mk('Open in Code Build','whole-item context + @refs','openCB'));
  grid2.appendChild(mk('Open file','edit markdown','openFile'));
  grid2.appendChild(mk('Link session','search + attach','link'));
  act.appendChild(grid2);
  const grid3=el('div','actions'); grid3.style.marginTop='7px';
  grid3.appendChild(mk('Edit','title / fields','editItem'));
  grid3.appendChild(mk('Clone','duplicate this item','cloneItem'));
  grid3.appendChild(mk('Recategorize','type / domain / lane','recategorize'));
  if(o.type==='idea'){ grid3.appendChild(mk('Promote → plan','create a plan','promote')); grid3.appendChild(mk('Move → task','convert to task','moveToTask')); }
  if(o.type==='thought'){ grid3.appendChild(mk('Convert → idea','promote this thought','convertToIdea')); grid3.appendChild(mk('Convert → task','make it actionable','convertToTask')); }
  if(o.type==='idea'||o.type==='task'||o.type==='thought'){
    const soc=String((o.frontmatter&&o.frontmatter.lane)||o.lane||'')==='social';
    const b=el('button','act','<span class="k">'+(soc?'★ Unmark social':'✨ Mark for social')+'</span><span class="d">'+(soc?'flagged to polish':'polish → social post')+'</span>');
    b.addEventListener('click',()=>vscode.postMessage({type:'action',action:'toggleSocial',id:o.id,on:!soc}));
    grid3.appendChild(b);
    grid3.appendChild(mk('Polish → social post','draft in Code Build','polishSocial'));
  }
  grid3.appendChild(mk('Delete','remove item','deleteItem'));
  act.appendChild(grid3); I.appendChild(act);
  // body
  { const s=el('div','sec'); const h=el('div','bodyhead'); h.appendChild(el('h4',null,'Notes / details')); const st=el('span','savenote',''); h.appendChild(st); s.appendChild(h);
    const ta=el('textarea','bodyEdit'); ta.value=o.body||''; ta.placeholder='Markdown details… (autosaves)'; s.appendChild(ta);
    let t=null, saved=ta.value;
    const save=()=>{ if(ta.value===saved)return; saved=ta.value; vscode.postMessage({type:'action',action:'autosaveField',id:o.id,field:'body',value:ta.value}); st.textContent='saved ✓'; setTimeout(()=>{if(st.textContent==='saved ✓')st.textContent='';},1500); };
    ta.addEventListener('input',()=>{clearTimeout(t);st.textContent='…';t=setTimeout(save,800);});
    ta.addEventListener('blur',()=>{clearTimeout(t);save();});
    flushAutosave=save;
    I.appendChild(s); }
  // references
  const refs=[['Blocked by knowledge',o.blocked_by,true],['Cites',o.cites,false],['Children',o.children,false],['Depends on',o.depends_on,false],['Related',o.related,false]];
  refs.forEach(([label,list,isBlock])=>{ if(!list||!list.length)return; const s=el('div','sec'); s.appendChild(el('h4',null,label+' ('+list.length+')')); const rl=el('div','reflist'); list.forEach(r=>{ const bad=isBlock?(r.status!=='resolved'):(r.exists===false||r.missing); const open = r.id&&!r.missing? ()=>openDetail(r.id) : (r.path? ()=>vscode.postMessage({type:'open',kbPath:r.path}) : null); rl.appendChild(refRow(r,bad,open)); }); s.appendChild(rl); I.appendChild(s); });
  if(o.parent){ const s=el('div','sec'); s.appendChild(el('h4',null,'Parent')); const rl=el('div','reflist'); rl.appendChild(refRow(o.parent,false,()=>openDetail(o.parent.id))); s.appendChild(rl); I.appendChild(s); }
  if(o.linked_sessions&&o.linked_sessions.length){ const s=el('div','sec'); s.appendChild(el('h4',null,'Linked sessions ('+o.linked_sessions.length+')')); const rl=el('div','reflist'); o.linked_sessions.forEach(u=>rl.appendChild(refRow({id:u,title:'▸ open chat — '+u.slice(0,18)+'…'},false,()=>vscode.postMessage({type:'action',action:'openSession',uuid:u})))); s.appendChild(rl); I.appendChild(s); }
}
vscode.postMessage({type:'ready'});
`;
