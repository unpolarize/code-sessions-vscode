// Code Sessions VS Code — interactive Planning mode.
//
// Turns the session viewer into a planning cockpit by reading the knowledge-planning
// store through its `kp` CLI (`kp export` for a one-shot JSON snapshot; `kp set-status`,
// `kp promote`, `kp link-session` for mutations). Decoupled by design: no cross-repo TS
// import — just a child process + JSON, so the extension and the planning package version
// independently. Contributes a Planning activity-bar container with Today / Inbox /
// Projects trees, a kanban board webview, an interactive graph webview, and a status bar.

import * as vscode from "vscode";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface ObjRow {
  id: string;
  type: string;
  title: string | null;
  status: string | null;
  domain: string | null;
  project: string | null;
  path: string;
}
interface BlockedRow {
  id: string;
  path: string;
  reason?: string;
  exists: boolean;
  decided: boolean;
  resolvable: boolean;
  status: string;
}
interface GraphNode {
  id: string;
  label: string;
  type: string;
  group: string;
  status?: string;
  blocked?: boolean;
}
interface GraphEdge {
  from: string;
  to: string;
  kind: string;
  status?: string;
}
interface Snapshot {
  root: string;
  kb_root: string;
  sessions_root: string;
  counts: Record<string, number>;
  objects: ObjRow[];
  inbox: ObjRow[];
  board: { date: string; daily_id: string | null; body: string; lanes: Record<string, ObjRow[]> };
  blocked: BlockedRow[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
}

const LANES = ["today", "in_progress", "inbox", "deferred", "done"] as const;

function planningConfig() {
  return vscode.workspace.getConfiguration("codeSessions.planning");
}
function defaultCli(): string {
  return path.join(os.homedir(), "projects/unpolarize/knowledge-planning/src/cli/index.ts");
}
// VS Code launched from the Dock/Finder usually has no /opt/homebrew/bin on PATH, so a
// bare `node` (needed ≥22 for TS stripping + node:sqlite) won't resolve. Resolve an
// absolute node binary, preferring the user's setting, then common install locations.
function resolveNode(): string {
  const configured = planningConfig().get<string>("nodePath");
  if (configured && configured.includes("/") && existsSync(configured)) return configured;
  for (const c of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/opt/local/bin/node", "/usr/bin/node"]) {
    if (existsSync(c)) return c;
  }
  return configured || "node";
}

function runKp(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const cfg = planningConfig();
  const node = resolveNode();
  const cli = cfg.get<string>("cliPath") || defaultCli();
  const root = cfg.get<string>("storeRoot") || "";
  const env = { ...process.env } as Record<string, string>;
  // ensure common bin dirs are on PATH for the child too
  env.PATH = `/opt/homebrew/bin:/usr/local/bin:${env.PATH || ""}`;
  if (root) env.KP_ROOT = root;
  const res = spawnSync(node, [cli, ...args], { encoding: "utf8", env, maxBuffer: 32 * 1024 * 1024 });
  return {
    ok: res.status === 0,
    stdout: res.stdout || "",
    stderr: res.stderr || (res.error ? res.error.message : ""),
  };
}

/** Shared snapshot, reloaded on refresh and consumed by every provider/view. */
class PlanningModel {
  private snap: Snapshot | null = null;
  readonly onDidChange = new vscode.EventEmitter<void>();

  reload(log?: vscode.OutputChannel): boolean {
    const res = runKp(["export", "--date", "today"]);
    if (!res.ok) {
      log?.appendLine(`[planning] kp export failed: ${res.stderr}`);
      this.snap = null;
      this.onDidChange.fire();
      return false;
    }
    try {
      this.snap = JSON.parse(res.stdout) as Snapshot;
    } catch (e) {
      log?.appendLine(`[planning] kp export parse error: ${(e as Error).message}`);
      this.snap = null;
    }
    this.onDidChange.fire();
    return this.snap != null;
  }
  get(): Snapshot | null {
    return this.snap;
  }
  absPath(relpath: string): string {
    return this.snap ? path.join(this.snap.root, relpath) : relpath;
  }
}

class PlanningItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly planningId: string,
    public readonly planningType: string,
    public readonly absFsPath: string | undefined,
    collapsible: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
  ) {
    super(label, collapsible);
  }
}

function iconFor(type: string, status?: string | null): vscode.ThemeIcon {
  switch (type) {
    case "idea":
      return new vscode.ThemeIcon("lightbulb");
    case "plan":
      return new vscode.ThemeIcon("checklist");
    case "task":
      return new vscode.ThemeIcon(status === "done" ? "pass-filled" : "circle-large-outline");
    case "project":
      return new vscode.ThemeIcon("repo");
    case "catalog_entry":
      return new vscode.ThemeIcon("bookmark");
    case "domain":
      return new vscode.ThemeIcon("symbol-namespace");
    case "daily_plan":
      return new vscode.ThemeIcon("calendar");
    case "insight":
      return new vscode.ThemeIcon("sparkle");
    case "reflection":
      return new vscode.ThemeIcon("note");
    case "knowledge":
      return new vscode.ThemeIcon("book");
    case "lane":
      return new vscode.ThemeIcon("layout");
    case "blocked":
      return new vscode.ThemeIcon("error");
    default:
      return new vscode.ThemeIcon("circle-outline");
  }
}

function leaf(model: PlanningModel, o: ObjRow): PlanningItem {
  const it = new PlanningItem(o.title || o.id, o.id, o.type, model.absPath(o.path));
  it.description = o.status || o.type;
  it.tooltip = `${o.id}\n${o.type}${o.status ? " · " + o.status : ""}${o.domain ? " · " + o.domain : ""}`;
  it.contextValue = `planning.${o.type}`;
  it.iconPath = iconFor(o.type, o.status);
  it.command = { command: "codePlanning.openObject", title: "Open", arguments: [it] };
  return it;
}

class TodayProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  readonly onDidChangeTreeData: vscode.Event<void>;
  constructor(private model: PlanningModel) {
    this.onDidChangeTreeData = model.onDidChange.event;
  }
  getTreeItem(e: vscode.TreeItem): vscode.TreeItem {
    return e;
  }
  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    const snap = this.model.get();
    if (!snap) return [emptyItem("Run kp export — store not found")];
    if (!element) {
      const out: vscode.TreeItem[] = [];
      const header = new PlanningItem(`📅 ${snap.board.date}`, snap.board.daily_id || "", "daily_plan", snap.board.daily_id ? this.model.absPath(`daily/${snap.board.date}.md`) : undefined);
      header.iconPath = iconFor("daily_plan");
      if (header.absFsPath) header.command = { command: "codePlanning.openObject", title: "Open", arguments: [header] };
      out.push(header);
      for (const lane of LANES) {
        const rows = snap.board.lanes[lane] || [];
        if (rows.length === 0) continue;
        const group = new PlanningItem(`${lane} (${rows.length})`, `lane:${lane}`, "lane", undefined, vscode.TreeItemCollapsibleState.Expanded);
        group.iconPath = iconFor("lane");
        out.push(group);
      }
      return out;
    }
    if (element instanceof PlanningItem && element.planningType === "lane") {
      const lane = element.planningId.slice("lane:".length);
      return (snap.board.lanes[lane] || []).map((o) => leaf(this.model, o));
    }
    return [];
  }
}

class InboxProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  readonly onDidChangeTreeData: vscode.Event<void>;
  constructor(private model: PlanningModel) {
    this.onDidChangeTreeData = model.onDidChange.event;
  }
  getTreeItem(e: vscode.TreeItem): vscode.TreeItem {
    return e;
  }
  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    const snap = this.model.get();
    if (!snap) return [emptyItem("Store not found")];
    if (!element) {
      const out: vscode.TreeItem[] = [];
      if (snap.blocked.length) {
        const g = new PlanningItem(`Blocked by knowledge (${snap.blocked.length})`, "blocked", "lane", undefined, vscode.TreeItemCollapsibleState.Expanded);
        g.iconPath = iconFor("blocked");
        out.push(g);
      }
      const captures = snap.inbox;
      if (captures.length === 0 && out.length === 0) return [emptyItem("Inbox empty — /planning-capture")];
      out.push(...captures.map((o) => leaf(this.model, o)));
      return out;
    }
    if (element instanceof PlanningItem && element.planningId === "blocked") {
      return snap.blocked.map((b) => {
        const label = b.id;
        const it = new PlanningItem(label, b.id, "knowledge", path.join(snap.kb_root, b.path));
        it.description = !b.exists ? "MISSING" : b.resolvable ? "resolvable" : "open";
        it.tooltip = `${b.id} blocked_by\n→ ${b.path}${b.reason ? "\n" + b.reason : ""}`;
        it.iconPath = iconFor("knowledge");
        it.contextValue = "planning.blocked";
        it.command = { command: "codePlanning.openObject", title: "Open KB", arguments: [it] };
        return it;
      });
    }
    return [];
  }
}

class ProjectsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  readonly onDidChangeTreeData: vscode.Event<void>;
  constructor(private model: PlanningModel) {
    this.onDidChangeTreeData = model.onDidChange.event;
  }
  getTreeItem(e: vscode.TreeItem): vscode.TreeItem {
    return e;
  }
  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    const snap = this.model.get();
    if (!snap) return [emptyItem("Store not found")];
    if (!element) {
      const containers = snap.objects.filter((o) => o.type === "project" || o.type === "catalog_entry");
      return containers.map((o) => {
        const it = leaf(this.model, o);
        (it as PlanningItem).collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        return it;
      });
    }
    if (element instanceof PlanningItem) {
      const kids = snap.objects.filter(
        (o) => o.project === element.planningId && o.type !== "project" && o.type !== "catalog_entry",
      );
      return kids.map((o) => leaf(this.model, o));
    }
    return [];
  }
}

function emptyItem(msg: string): vscode.TreeItem {
  const it = new vscode.TreeItem(msg);
  it.iconPath = new vscode.ThemeIcon("info");
  return it;
}

// --- Webviews --------------------------------------------------------------

function nonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 24; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

class BoardPanel {
  static current: BoardPanel | undefined;
  private panel: vscode.WebviewPanel;
  constructor(private model: PlanningModel, private onAction: (msg: any) => void) {
    this.panel = vscode.window.createWebviewPanel("codePlanningBoard", "Planning Board", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.onDidDispose(() => (BoardPanel.current = undefined));
    this.panel.webview.onDidReceiveMessage((m) => this.onAction(m));
    model.onDidChange.event(() => this.render());
    this.render();
  }
  reveal() {
    this.panel.reveal();
  }
  render() {
    this.panel.webview.html = this.html();
  }
  private html(): string {
    const snap = this.model.get();
    const n = nonce();
    if (!snap) return `<!DOCTYPE html><body>Store not found.</body>`;
    const cols = LANES.map((lane) => {
      const rows = snap.board.lanes[lane] || [];
      const cards = rows
        .map(
          (o) => `<div class="card" draggable="true" data-id="${esc(o.id)}" data-path="${esc(path.join(snap.root, o.path))}">
            <div class="t">${esc(o.title || o.id)}</div>
            <div class="m">${esc(o.type)}${o.domain ? " · " + esc(o.domain) : ""}</div>
            <div class="actions">
              <button data-act="open" data-id="${esc(o.id)}">open</button>
              <select data-act="move" data-id="${esc(o.id)}">
                ${["inbox", "today", "in_progress", "done", "deferred"]
                  .map((s) => `<option value="${s}"${s === o.status ? " selected" : ""}>${s}</option>`)
                  .join("")}
              </select>
            </div>
          </div>`,
        )
        .join("");
      return `<div class="col" data-lane="${lane}"><h3>${lane} <span class="count">${rows.length}</span></h3>${cards}</div>`;
    }).join("");
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
    <style>
      body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:8px}
      .board{display:flex;gap:10px;align-items:flex-start;overflow-x:auto}
      .col{min-width:200px;flex:1;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border);border-radius:6px;padding:6px;min-height:60px}
      .col.over{outline:2px dashed var(--vscode-focusBorder);outline-offset:-2px}
      h3{font-size:12px;text-transform:uppercase;margin:4px 0 8px}
      .count{opacity:.6}
      .card{background:var(--vscode-editor-background);border:1px solid var(--vscode-widget-border);border-radius:5px;padding:6px;margin-bottom:6px;cursor:grab}
      .card.dragging{opacity:.4}
      .t{font-weight:600;font-size:13px}
      .m{opacity:.7;font-size:11px;margin:2px 0 6px}
      .actions{display:flex;gap:6px}
      button{cursor:pointer}
      .bar{margin-bottom:8px;display:flex;gap:8px;align-items:center}
    </style></head><body>
    <div class="bar"><b>Daily — ${esc(snap.board.date)}</b>
      <button id="refresh">refresh</button>
      <span style="opacity:.7">${esc(JSON.stringify(snap.counts))}</span></div>
    <div class="board">${cols}</div>
    <script nonce="${n}">
      const vscode = acquireVsCodeApi();
      document.getElementById('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));
      document.querySelectorAll('button[data-act="open"]').forEach(b=>b.addEventListener('click',e=>{
        const c=e.target.closest('.card');vscode.postMessage({type:'open',path:c.getAttribute('data-path')});
      }));
      document.querySelectorAll('select[data-act="move"]').forEach(s=>s.addEventListener('change',e=>{
        vscode.postMessage({type:'setStatus',id:e.target.getAttribute('data-id'),status:e.target.value});
      }));
      // drag a card across lanes → set-status to the target lane
      document.querySelectorAll('.card').forEach(c=>{
        c.addEventListener('dragstart',e=>{e.dataTransfer.setData('text/plain',c.getAttribute('data-id'));e.dataTransfer.effectAllowed='move';c.classList.add('dragging');});
        c.addEventListener('dragend',()=>c.classList.remove('dragging'));
      });
      document.querySelectorAll('.col').forEach(col=>{
        col.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';col.classList.add('over');});
        col.addEventListener('dragleave',()=>col.classList.remove('over'));
        col.addEventListener('drop',e=>{e.preventDefault();col.classList.remove('over');const id=e.dataTransfer.getData('text/plain');const lane=col.getAttribute('data-lane');if(id&&lane)vscode.postMessage({type:'setStatus',id:id,status:lane});});
      });
    </script></body></html>`;
  }
}

class GraphPanel {
  static current: GraphPanel | undefined;
  private panel: vscode.WebviewPanel;
  constructor(private model: PlanningModel, private onAction: (msg: any) => void) {
    this.panel = vscode.window.createWebviewPanel("codePlanningGraph", "Planning Graph", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.onDidDispose(() => (GraphPanel.current = undefined));
    this.panel.webview.onDidReceiveMessage((m) => this.onAction(m));
    model.onDidChange.event(() => this.render());
    this.render();
  }
  reveal() {
    this.panel.reveal();
  }
  render() {
    this.panel.webview.html = this.html();
  }
  private html(): string {
    const snap = this.model.get();
    const n = nonce();
    if (!snap) return `<!DOCTYPE html><body>Store not found.</body>`;
    const objIndex: Record<string, string> = {};
    for (const o of snap.objects) objIndex[o.id] = path.join(snap.root, o.path);
    const payload = JSON.stringify({
      nodes: snap.graph.nodes,
      edges: snap.graph.edges,
      objPaths: objIndex,
      kbRoot: snap.kb_root,
    });
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
    <style>
      body{margin:0;font-family:var(--vscode-font-family);color:var(--vscode-foreground)}
      #c{width:100vw;height:100vh}
      .legend{position:fixed;top:8px;left:8px;font-size:11px;opacity:.8}
      text{fill:var(--vscode-foreground);font-size:10px;pointer-events:none}
      circle{cursor:pointer}
      line{stroke:var(--vscode-widget-border)}
      line.blocked{stroke:#e51400}
    </style></head><body>
    <div class="legend">click a node to open · red = blocked_by knowledge</div>
    <svg id="c"></svg>
    <script nonce="${n}">
      const data = ${payload};
      const vscode = acquireVsCodeApi();
      const svg = document.getElementById('c');
      const W = window.innerWidth, H = window.innerHeight, cx=W/2, cy=H/2, R=Math.min(W,H)/2-60;
      const colors = {idea:'#d7ba7d',plan:'#4ec9b0',task:'#569cd6',project:'#c586c0',catalog_entry:'#c586c0',domain:'#808080',daily_plan:'#dcdcaa',insight:'#4fc1ff',reflection:'#9cdcfe',knowledge:'#ce9178',session:'#608b4e'};
      const nodes = data.nodes; const pos = {};
      nodes.forEach((nd,i)=>{const a=(i/nodes.length)*2*Math.PI; pos[nd.id]={x:cx+R*Math.cos(a),y:cy+R*Math.sin(a)};});
      const NS='http://www.w3.org/2000/svg';
      for (const e of data.edges){const a=pos[e.from],b=pos[e.to];if(!a||!b)continue;const l=document.createElementNS(NS,'line');l.setAttribute('x1',a.x);l.setAttribute('y1',a.y);l.setAttribute('x2',b.x);l.setAttribute('y2',b.y);if(e.kind==='blocked_by'&&e.status!=='resolved')l.setAttribute('class','blocked');svg.appendChild(l);}
      for (const nd of nodes){const p=pos[nd.id];const g=document.createElementNS(NS,'g');
        const c=document.createElementNS(NS,'circle');c.setAttribute('cx',p.x);c.setAttribute('cy',p.y);c.setAttribute('r',nd.blocked?9:7);c.setAttribute('fill',nd.blocked?'#e51400':(colors[nd.type]||'#888'));
        c.addEventListener('click',()=>{const target=data.objPaths[nd.id]|| (nd.type==='knowledge'? (data.kbRoot+'/'+nd.id):null); if(target) vscode.postMessage({type:'open',path:target});});
        const t=document.createElementNS(NS,'text');t.setAttribute('x',p.x+10);t.setAttribute('y',p.y+3);t.textContent=(nd.label||nd.id).slice(0,28);
        g.appendChild(c);g.appendChild(t);svg.appendChild(g);}
    </script></body></html>`;
  }
}

// --- Registration ----------------------------------------------------------

export function registerPlanning(ctx: vscode.ExtensionContext, log?: vscode.OutputChannel): void {
  const model = new PlanningModel();
  const today = new TodayProvider(model);
  const inbox = new InboxProvider(model);
  const projects = new ProjectsProvider(model);

  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider("codePlanningToday", today),
    vscode.window.registerTreeDataProvider("codePlanningInbox", inbox),
    vscode.window.registerTreeDataProvider("codePlanningProjects", projects),
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "codePlanning.showBoard";
  ctx.subscriptions.push(status);
  const refreshStatus = () => {
    const snap = model.get();
    if (!snap) {
      status.text = "$(checklist) Planning: —";
      status.tooltip = "knowledge-planning store not found (configure codeSessions.planning.cliPath)";
    } else {
      const lanes = snap.board.lanes;
      const done = (lanes.done || []).length;
      const total = LANES.reduce((a, l) => a + (lanes[l] || []).length, 0);
      const cap = snap.counts.idea ? (snap.inbox || []).length : 0;
      status.text = `$(checklist) ${snap.blocked.length}b · ${cap}c · ${done}/${total}`;
      status.tooltip = "Planning — blocked · capture ideas · today done/total";
    }
    status.show();
  };
  model.onDidChange.event(refreshStatus);

  const openObject = (item: PlanningItem | vscode.TreeItem | undefined) => {
    const abs = item instanceof PlanningItem ? item.absFsPath : undefined;
    if (abs) void vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: true });
  };
  const idOf = (item: any): string | undefined =>
    item instanceof PlanningItem ? item.planningId : typeof item === "string" ? item : undefined;

  const onWebviewAction = (msg: any) => {
    if (!msg) return;
    if (msg.type === "open" && msg.path) void vscode.window.showTextDocument(vscode.Uri.file(msg.path), { preview: true });
    else if (msg.type === "setStatus" && msg.id && msg.status) {
      runKp(["set-status", msg.id, msg.status]);
      model.reload(log);
    } else if (msg.type === "refresh") model.reload(log);
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand("codePlanning.refresh", () => {
      if (!model.reload(log)) vscode.window.showWarningMessage("Planning: kp export failed — check codeSessions.planning settings.");
    }),
    vscode.commands.registerCommand("codePlanning.openObject", openObject),
    vscode.commands.registerCommand("codePlanning.accept", (item) => {
      const id = idOf(item);
      if (!id) return;
      runKp(["set-status", id, "accepted"]);
      model.reload(log);
    }),
    vscode.commands.registerCommand("codePlanning.promote", (item) => {
      const id = idOf(item);
      if (!id) return;
      const res = runKp(["promote", id]);
      vscode.window.showInformationMessage(res.ok ? res.stdout.trim() : `promote failed: ${res.stderr}`);
      model.reload(log);
    }),
    vscode.commands.registerCommand("codePlanning.setStatus", async (item) => {
      const id = idOf(item);
      if (!id) return;
      const status = await vscode.window.showQuickPick(["inbox", "today", "in_progress", "done", "deferred", "accepted", "parked"], {
        placeHolder: `New status for ${id}`,
      });
      if (status) {
        runKp(["set-status", id, status]);
        model.reload(log);
      }
    }),
    vscode.commands.registerCommand("codePlanning.linkSession", async (item) => {
      const id = idOf(item);
      if (!id) return;
      const uuid = await vscode.window.showInputBox({ prompt: `Session uuid to link to ${id}` });
      if (uuid) {
        const res = runKp(["link-session", id, uuid]);
        vscode.window.showInformationMessage(res.ok ? res.stdout.trim() : `link failed: ${res.stderr}`);
        model.reload(log);
      }
    }),
    vscode.commands.registerCommand("codePlanning.startWork", async (item) => {
      const id = idOf(item);
      const abs = item instanceof PlanningItem ? item.absFsPath : undefined;
      const snap = model.get();
      const blockers = (snap?.blocked ?? []).filter((b) => b.id === id);
      if (blockers.length && snap) {
        const choice = await vscode.window.showWarningMessage(
          `${id} is blocked by ${blockers.length} unresolved knowledge ref(s): ${blockers.map((b) => b.path).join(", ")}`,
          "Open blocker",
          "Start anyway",
        );
        if (choice === "Open blocker") {
          void vscode.window.showTextDocument(vscode.Uri.file(path.join(snap.kb_root, blockers[0].path)));
          return;
        }
        if (choice !== "Start anyway") return;
      }
      if (abs) void vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: false });
      const term = vscode.window.createTerminal({ name: `plan:${id ?? "work"}` });
      term.show();
      if (id) term.sendText(`# Working on ${id}. After the session: kp link-session ${id} <session-uuid>`, false);
    }),
    vscode.commands.registerCommand("codePlanning.showBoard", () => {
      if (BoardPanel.current) BoardPanel.current.reveal();
      else BoardPanel.current = new BoardPanel(model, onWebviewAction);
    }),
    vscode.commands.registerCommand("codePlanning.showGraph", () => {
      if (GraphPanel.current) GraphPanel.current.reveal();
      else GraphPanel.current = new GraphPanel(model, onWebviewAction);
    }),
    vscode.commands.registerCommand("codePlanning.capture", async () => {
      const text = await vscode.window.showInputBox({ prompt: "Capture an idea" });
      if (text) {
        const res = runKp(["capture", text]);
        vscode.window.showInformationMessage(res.ok ? res.stdout.trim() : `capture failed: ${res.stderr}`);
        model.reload(log);
      }
    }),
  );

  model.reload(log);
  log?.appendLine("[planning] registered Planning mode");
}
