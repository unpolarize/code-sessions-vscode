// Code Sessions VS Code — interactive Planning mode.
//
// Turns the session viewer into a planning cockpit by reading the knowledge-planning
// store through its `kp` CLI (`kp export` for a one-shot JSON snapshot; `kp set-status`,
// `kp promote`, `kp link-session` for mutations). Decoupled by design: no cross-repo TS
// import — just a child process + JSON, so the extension and the planning package version
// independently. Contributes a Planning activity-bar container with Today / Inbox /
// Projects trees, a kanban board webview, an interactive graph webview, and a status bar.

import * as vscode from "vscode";
import { spawnSync, execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, readFileSync, unlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DashboardPanel, type DashboardDeps } from "./planningDashboard";
import { syncBridge } from "./storeSync";

interface SessionInfo {
  uuid: string;
  title?: string;
  agent?: string;
  host?: string;
  project?: string;
  projectPath?: string;
  source: "claude" | "grok" | "git";
  startedAt: number; // epoch ms (started_at, else file mtime)
  mtime: number;
  turns?: number;
  cost?: number;
  planningRefs: string[];
}

// The CS SQLite index (created in extension.ts, after registerPlanning) is the
// authoritative source of RECENT sessions — the ~/.sessions git store lags. The
// extension registers a provider here; the dashboard reads it lazily.
// Shape returned by store.listRecent() (db.ts rowToSession).
type CsSessionRow = {
  session_id: string;
  title?: string;
  source?: string;
  project_path?: string | null;
  mtime_ns?: number; // nanoseconds
  started_at?: number; // epoch ms
  message_count?: number;
  cost_usd?: number;
};
let _sessionProvider: (() => CsSessionRow[] | null) | undefined;
export function setSessionProvider(p: (() => CsSessionRow[] | null) | undefined): void {
  _sessionProvider = p;
}

/** Session list for the dashboard: prefer the CS SQLite index (recent + rich),
 * fall back to scanning the ~/.sessions git store when the cache is disabled. */
function listSessionsRich(): SessionInfo[] {
  const rows = _sessionProvider?.();
  if (rows && rows.length) {
    // The CS index has no host column; recover it from the git store's
    // hosts/<host>/… layout, else this machine (native transcripts are local).
    const hostMap = sessionHostMap();
    const localHost = shortHost(os.hostname());
    return rows.map((r) => {
      const s = listSessionsFromProvider(r);
      s.host = hostMap[s.uuid] ?? localHost;
      return s;
    });
  }
  return listGitStoreSessions();
}

/** Prettify a hostname for display: drop the .local/.lan suffix. */
function shortHost(h: string | undefined): string {
  return (h ?? "").replace(/\.(local|lan)$/i, "") || "unknown";
}

/** uuid → host, from the git session store directory layout hosts/<host>/<month>/<uuid>/. */
function sessionHostMap(): Record<string, string> {
  const root = path.join(os.homedir(), ".sessions", "hosts");
  const map: Record<string, string> = {};
  if (!existsSync(root)) return map;
  const ls = (p: string): string[] => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  };
  for (const host of ls(root))
    for (const month of ls(path.join(root, host)))
      for (const sid of ls(path.join(root, host, month))) map[sid] = shortHost(host);
  return map;
}

/** Map one CS-index row to a SessionInfo (host filled in by the caller). */
function listSessionsFromProvider(r: CsSessionRow): SessionInfo {
  const src: "claude" | "grok" | "git" = r.source === "grok" ? "grok" : r.source === "git" ? "git" : "claude";
  const mtime = r.mtime_ns ? Math.floor(r.mtime_ns / 1e6) : 0;
  const started = r.started_at || mtime;
  return {
    uuid: r.session_id,
    title: r.title,
    agent: r.source,
    project: r.project_path ? path.basename(r.project_path) : undefined,
    projectPath: r.project_path ?? undefined,
    source: src,
    startedAt: started,
    mtime: mtime || started,
    turns: r.message_count,
    cost: r.cost_usd,
    planningRefs: [],
  } as SessionInfo;
}

/** Scan the git session store (~/.sessions) for a rich, searchable session list. */
function listGitStoreSessions(): SessionInfo[] {
  const root = path.join(os.homedir(), ".sessions", "hosts");
  if (!existsSync(root)) return [];
  const ls = (p: string): string[] => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  };
  const out: SessionInfo[] = [];
  for (const host of ls(root))
    for (const month of ls(path.join(root, host)))
      for (const sid of ls(path.join(root, host, month))) {
        const f = path.join(root, host, month, sid, "session.json");
        if (!existsSync(f)) continue;
        try {
          const s = JSON.parse(readFileSync(f, "utf8"));
          const agent: string = s.agent ?? "";
          const source: "claude" | "grok" | "git" = /grok/i.test(agent) ? "grok" : /claude/i.test(agent) ? "claude" : "git";
          const started = s.started_at ? Date.parse(s.started_at) : NaN;
          out.push({
            uuid: s.session_id || sid,
            title: s.title,
            agent,
            host: s.host,
            projectPath: s.project_path,
            project: s.project_path ? path.basename(s.project_path) : undefined,
            source,
            startedAt: Number.isFinite(started) ? started : statSync(f).mtimeMs,
            mtime: statSync(f).mtimeMs,
            turns: s.turn_count,
            cost: s.totals?.cost_usd,
            planningRefs: Array.isArray(s.planning_refs) ? s.planning_refs : [],
          });
        } catch {
          /* skip */
        }
      }
  return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, 500);
}

/** Back-compat thin list for codePlanning.linkSession's QuickPick. */
function listStoreSessions(): { uuid: string; title?: string; agent?: string; mtime: number }[] {
  return listSessionsRich().map((s) => ({ uuid: s.uuid, title: s.title, agent: s.agent, mtime: s.mtime }));
}
import { openCanvas } from "./planningCanvas";

/** planning_refs from a session's ~/.sessions envelope (session → planning fallback). */
function envelopePlanningRefs(uuid: string): string[] {
  const root = path.join(os.homedir(), ".sessions", "hosts");
  if (!existsSync(root)) return [];
  const ls = (p: string): string[] => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  };
  for (const host of ls(root))
    for (const month of ls(path.join(root, host))) {
      const f = path.join(root, host, month, uuid, "session.json");
      if (!existsSync(f)) continue;
      try {
        const s = JSON.parse(readFileSync(f, "utf8"));
        return Array.isArray(s.planning_refs) ? s.planning_refs : [];
      } catch {
        return [];
      }
    }
  return [];
}

interface ObjRow {
  priority?: string | null;
  due?: string | null;
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

const LANES = ["today", "in_progress", "inbox", "deferred", "done", "outdated"] as const;

function planningConfig() {
  return vscode.workspace.getConfiguration("codeSessions.planning");
}

/** Extension install dir — set at activation; used to resolve the bundled kp CLI. */
let extensionRoot = "";

/**
 * Resolve the `kp` CLI. Prefer the npm package `@unpolarize/knowledge-planning`
 * bundled into the extension (dist/cli.js — plain JS, versioned with the .vsix),
 * then a globally-resolvable install, then a local source checkout for dev.
 */
function defaultCli(): string {
  const bundled = extensionRoot
    ? path.join(extensionRoot, "node_modules", "@unpolarize", "knowledge-planning", "dist", "cli.js")
    : "";
  if (bundled && existsSync(bundled)) return bundled;
  try {
    // resolves the package's '.' export (dist/index.js); cli.js is its sibling
    const idx = require.resolve("@unpolarize/knowledge-planning");
    const cli = path.join(path.dirname(idx), "cli.js");
    if (existsSync(cli)) return cli;
  } catch {
    /* not installed here — fall through to the dev checkout */
  }
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

function runKp(args: string[], input?: string): { ok: boolean; stdout: string; stderr: string } {
  const cfg = planningConfig();
  const node = resolveNode();
  const cli = cfg.get<string>("cliPath") || defaultCli();
  // KP's own default store root is generic; this extension's store lives in the KB.
  const root = cfg.get<string>("storeRoot") || path.join(os.homedir(), "docs", "planning");
  const env = { ...process.env } as Record<string, string>;
  // ensure common bin dirs are on PATH for the child too
  env.PATH = `/opt/homebrew/bin:/usr/local/bin:${env.PATH || ""}`;
  env.KP_ROOT = root;
  const res = spawnSync(node, [cli, ...args], {
    encoding: "utf8",
    env,
    maxBuffer: 32 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
  });
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
    case "thought":
      return new vscode.ThemeIcon("comment-discussion");
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
  it.command = { command: "codePlanning.openInBoard", title: "Open in board", arguments: [it] };
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
      const tasksByStatus = (st: string) => snap.objects.filter((o) => o.type === "task" && (o.status || "inbox") === st);
      for (const lane of LANES) {
        const rows = tasksByStatus(lane);
        if (rows.length === 0) continue;
        const group = new PlanningItem(`${lane} (${rows.length})`, `lane:${lane}`, "lane", undefined, vscode.TreeItemCollapsibleState.Expanded);
        group.iconPath = iconFor("lane");
        out.push(group);
      }
      if (out.length === 1) out.push(emptyItem("No tasks scheduled — drag tasks to 'today' on the board"));
      return out;
    }
    if (element instanceof PlanningItem && element.planningType === "lane") {
      const lane = element.planningId.slice("lane:".length);
      return snap.objects.filter((o) => o.type === "task" && (o.status || "inbox") === lane).map((o) => leaf(this.model, o));
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
    const byType = (t: string) => snap.objects.filter((o) => o.type === t);
    if (!element) {
      const out: vscode.TreeItem[] = [];
      if (snap.blocked.length) {
        const g = new PlanningItem(`Blocked by knowledge (${snap.blocked.length})`, "blocked", "lane", undefined, vscode.TreeItemCollapsibleState.Expanded);
        g.iconPath = iconFor("blocked");
        out.push(g);
      }
      const grp = (label: string, key: string, exp: boolean) => {
        const n = byType(key).length;
        const g = new PlanningItem(
          `${label} (${n})`,
          `group:${key}`,
          "lane",
          undefined,
          n ? (exp ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None,
        );
        g.iconPath = iconFor(key);
        return g;
      };
      out.push(grp("Tasks", "task", true));
      out.push(grp("Ideas", "idea", false));
      out.push(grp("Plans", "plan", false));
      out.push(grp("Thoughts", "thought", false));
      return out;
    }
    if (element instanceof PlanningItem && element.planningId.startsWith("group:")) {
      return byType(element.planningId.slice("group:".length)).map((o) => leaf(this.model, o));
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
                ${["inbox", "today", "in_progress", "done", "deferred", "outdated"]
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
  extensionRoot = ctx.extensionUri.fsPath; // resolve the bundled kp CLI relative to here
  const model = new PlanningModel();
  const today = new TodayProvider(model);
  const inbox = new InboxProvider(model);
  const projects = new ProjectsProvider(model);

  // createTreeView (not registerTreeDataProvider) for Today so the planning-mode
  // toggle keybinding can read container visibility, mirroring the sessions toggle.
  const todayTreeView = vscode.window.createTreeView("codePlanningToday", { treeDataProvider: today });
  ctx.subscriptions.push(
    todayTreeView,
    vscode.window.registerTreeDataProvider("codePlanningInbox", inbox),
    vscode.window.registerTreeDataProvider("codePlanningProjects", projects),
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "codePlanning.openDashboard";
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

  // --- Agent actions: build a context-rich prompt and launch an agent (item 4) ---
  const stateDir = path.join(os.homedir(), ".local/state/kp");
  const detailOf = (id: string): any | null => {
    const r = runKp(["show", id]);
    if (!r.ok) return null;
    try {
      return JSON.parse(r.stdout);
    } catch {
      return null;
    }
  };
  const agentPrompt = (action: string, d: any): string => {
    const head =
      `Work item: ${d.title} (id: ${d.id}, type: ${d.type})\n` +
      `Planning store: ~/docs/planning · file: ~/docs/planning/${d.relpath}\n` +
      `Use the kp CLI (\`node ~/projects/unpolarize/knowledge-planning/src/cli/index.ts <cmd>\`) and the /planning-* skills. Reindex when done.\n`;
    const body = d.body ? `\nNotes:\n${d.body}\n` : "";
    const refLines = [
      ...((d.blocked_by || []) as any[]).map((b) => `- blocked_by ${b.path}${b.decided ? " (decided)" : " (OPEN — resolve first)"}`),
      ...((d.cites || []) as any[]).map((c) => `- cites ${c.path}`),
      ...((d.children || []) as any[]).map((c) => `- child ${c.id}`),
    ].join("\n");
    const refs = refLines ? `\nReferences:\n${refLines}\n` : "";
    const tasks: Record<string, string> = {
      ideate: "Task: brainstorm and expand this into 3–6 concrete sub-ideas/directions. Append shaped notes to the file and create sub-idea files (type:idea, status:capture) under ~/docs/planning/ideas/ where useful. Follow /planning-refine.",
      spec: `Task: draft a speckit spec — Problem, Functional Requirements (FR-n), Success criteria, Non-goals — for this item. If it is an idea, first promote it (\`kp promote ${d.id}\`) then write the spec into the plan body.`,
      decompose: `Task: break this into concrete deliverable tasks. Create task files under ~/docs/planning/tasks/ (type:task, status:inbox, plan:${d.id}) and reindex.`,
      execute: `Task: implement this work item. Use the repos/paths referenced above. When the session is done, run: \`kp link-session ${d.id} <session-uuid>\`.`,
    };
    return head + body + refs + "\n" + (tasks[action] || tasks.execute);
  };
  const linkedRefs = (d: any): string[] =>
    [...((d?.cites || []) as any[]).map((c) => c.path || c.id), ...((d?.kb_paths || []) as string[])].filter(Boolean);

  // Copy a seed prompt to the clipboard and open a real Code Build chat (no terminals).
  // Code Build activates lazily (only on its own webview/view), so its command isn't
  // registered until then — activate the extension by id first, otherwise the check
  // wrongly reports "not installed".
  const runInCB = async (seed: string, label: string) => {
    await vscode.env.clipboard.writeText(seed);
    const ext = vscode.extensions.getExtension("zhirafovod.code-build-vscode");
    if (ext && !ext.isActive) {
      try {
        await ext.activate();
      } catch (e) {
        log?.appendLine(`[planning] Code Build activate failed: ${String(e)}`);
      }
    }
    const cmds = await vscode.commands.getCommands(true);
    if (ext || cmds.includes("codeBuild.newConversation")) {
      await vscode.commands.executeCommand("codeBuild.newConversation");
      void vscode.window.showInformationMessage(`Code Build opened (${label}) — prompt copied; paste into the composer to review & send.`);
    } else {
      void vscode.window.showWarningMessage("Code Build not installed. Prompt copied to clipboard.");
    }
  };

  // Build the prepopulated prompt and open it straight in Code Build (review/edit happens
  // in the CB composer before you send — no throwaway editor file).
  const reviewAndRun = async (action: string, id: string) => {
    const d = detailOf(id);
    if (!d) {
      void vscode.window.showWarningMessage(`Planning: could not load ${id}`);
      return;
    }
    let prompt: string;
    if (action === "research") {
      const r = runKp(["research", id]);
      prompt = r.ok && r.stdout.trim() ? r.stdout : agentPrompt(action, d);
    } else {
      prompt = agentPrompt(action, d);
    }
    await runInCB(prompt, action);
  };

  const openInCB = async (id: string) => {
    const d = detailOf(id);
    const refs = linkedRefs(d);
    let seed = d ? agentPrompt("execute", d) : id;
    if (refs.length) {
      const pick = await vscode.window.showQuickPick(["Yes — attach as @-references", "No"], {
        placeHolder: `Include ${refs.length} linked knowledge doc(s) as references?`,
      });
      if (pick && pick.startsWith("Yes")) {
        seed = refs.map((r) => "@" + (r.startsWith("/") ? r : "~/docs/" + r)).join(" ") + "\n\n" + seed;
      }
    }
    await runInCB(seed, "open");
  };

  const editItem = async (id: string) => {
    const d = detailOf(id);
    if (!d) return;
    const title = await vscode.window.showInputBox({ prompt: "Title", value: d.title });
    if (title === undefined) return;
    const r = runKp(["edit", id, "--title", title]);
    if (!r.ok) void vscode.window.showWarningMessage(`edit failed: ${r.stderr}`);
    model.reload(log);
  };

  // Create an item from the drawer's new-item editor (all fields at once).
  // The dashboard collects everything; here we run `kp create` for the fields it
  // supports, then follow-ups for lane/project/body, and open the result.
  const createItemFromFields = (f: {
    type?: string;
    title?: string;
    status?: string;
    domain?: string;
    lane?: string;
    project?: string;
    due?: string;
    priority?: string;
    body?: string;
  }): void => {
    const title = (f.title ?? "").trim();
    if (!title) return;
    const type = f.type || "task";
    const args = ["create", title, "--type", type];
    if (f.status) args.push("--status", f.status);
    if (f.domain) args.push("--domain", f.domain);
    if (f.priority) args.push("--priority", f.priority);
    if (f.due && /^\d{4}-\d{2}-\d{2}$/.test(f.due)) args.push("--due", f.due);
    const r = runKp(args);
    if (!r.ok) {
      void vscode.window.showWarningMessage(`create failed: ${r.stderr}`);
      return;
    }
    const newId = /created\s+(\S+)/.exec(r.stdout)?.[1];
    if (newId) {
      if (f.lane) runKp(["edit", newId, "--lane", f.lane]);
      if (f.project) runKp(["set-project", newId, f.project]);
      if (f.body && f.body.trim()) runKp(["edit", newId, "--body", "-"], f.body);
    }
    model.reload(log);
    if (newId) DashboardPanel.current?.post({ type: "openItem", id: newId });
  };

  const recategorizeItem = async (id: string) => {
    const d = detailOf(id);
    if (!d) return;
    const choice = await vscode.window.showQuickPick(
      ["Move to task", "Move to idea", "Move to plan", "Change domain…", "Set lane…"],
      { placeHolder: `Recategorize ${id}` },
    );
    if (!choice) return;
    let r;
    if (choice.startsWith("Move to ")) r = runKp(["recategorize", id, "--to-type", choice.replace("Move to ", "")]);
    else if (choice.startsWith("Change domain")) {
      const dom = await vscode.window.showInputBox({ prompt: "Domain", value: d.domain });
      if (dom === undefined) return;
      r = runKp(["recategorize", id, "--domain", dom]);
    } else {
      const lane = await vscode.window.showInputBox({ prompt: "Lane", value: d.lane });
      if (lane === undefined) return;
      r = runKp(["edit", id, "--lane", lane]);
    }
    if (r && !r.ok) void vscode.window.showWarningMessage(`recategorize failed: ${r.stderr}`);
    model.reload(log);
  };

  const deleteItem = async (id: string) => {
    const yes = await vscode.window.showWarningMessage(`Delete ${id}? This removes its markdown file.`, { modal: true }, "Delete");
    if (yes !== "Delete") return;
    const r = runKp(["delete", id]);
    if (!r.ok) void vscode.window.showWarningMessage(`delete failed: ${r.stderr}`);
    model.reload(log);
  };

  // Clone — kp create with the source's fields, then copy body/lane via kp edit.
  // A clone of a closed item restarts at the type's default open status. No title
  // prompt: the copy opens in the drawer, where the title is editable in place.
  const cloneItem = async (id: string) => {
    const d = detailOf(id);
    if (!d) {
      void vscode.window.showWarningMessage(`Planning: could not load ${id}`);
      return;
    }
    const fm = (d.frontmatter || {}) as Record<string, unknown>;
    const title = `${d.title} (copy)`;
    const type = String(d.type || "task");
    const openDefault: Record<string, string> = { task: "inbox", idea: "capture", plan: "plan" };
    let status = String(d.status || "");
    if (!status || status === "done" || status === "outdated") status = openDefault[type] || "inbox";
    const args = ["create", title.trim(), "--type", type, "--status", status];
    if (d.domain) args.push("--domain", String(d.domain));
    if (fm.priority) args.push("--priority", String(fm.priority));
    if (fm.due) args.push("--due", String(fm.due));
    const r = runKp(args);
    if (!r.ok) {
      void vscode.window.showWarningMessage(`clone failed: ${r.stderr}`);
      return;
    }
    const newId = /created\s+(\S+)/.exec(r.stdout)?.[1];
    if (newId) {
      if (d.body && String(d.body).trim()) runKp(["edit", newId, "--body", "-"], String(d.body));
      if (fm.lane) runKp(["edit", newId, "--lane", String(fm.lane)]);
    }
    model.reload(log);
    if (newId) DashboardPanel.current?.post({ type: "openItem", id: newId });
    else void vscode.window.showInformationMessage(r.stdout.trim());
  };

  const dashAction = (msg: any) => {
    if (!msg) return;
    const snap = model.get();
    if (msg.type === "open") {
      if (msg.kbPath && snap) void vscode.window.showTextDocument(vscode.Uri.file(path.join(snap.kb_root, msg.kbPath)));
      else if (msg.id && snap) {
        const o = (snap.objects || []).find((x: any) => x.id === msg.id);
        if (o) void vscode.window.showTextDocument(vscode.Uri.file(path.join(snap.root, o.path)));
      } else if (msg.path) void vscode.window.showTextDocument(vscode.Uri.file(msg.path));
      return;
    }
    if (msg.type !== "action") return;
    const id = msg.id as string;
    switch (msg.action) {
      case "createItem":
        createItemFromFields((msg.fields as Record<string, string>) || {});
        break;
      case "openFile":
        dashAction({ type: "open", id });
        break;
      case "promote": {
        const r = runKp(["promote", id]);
        void vscode.window.showInformationMessage(r.ok ? r.stdout.trim() : `promote failed: ${r.stderr}`);
        model.reload(log);
        break;
      }
      case "toggleSocial": {
        // flag/unflag an item to polish into a social post (stored in the lane field)
        runKp(["edit", id, "--lane", msg.on ? "social" : ""]);
        model.reload(log);
        const det = runKp(["show", id]);
        if (det.ok) {
          try {
            DashboardPanel.current?.post({ type: "detail", data: JSON.parse(det.stdout) });
          } catch {
            /* best-effort */
          }
        }
        break;
      }
      case "polishSocial": {
        const d = detailOf(id);
        if (!d) {
          void vscode.window.showWarningMessage(`Planning: could not load ${id}`);
          break;
        }
        const prompt =
          `Polish the following ${d.type} into a short, engaging social-media post (LinkedIn/X). ` +
          `Keep it authentic and specific; 1–3 tight paragraphs, optional 3–5 hashtags. ` +
          `Offer 2 variants (a concise one and a slightly longer one). Do not invent facts beyond what's given.\n\n` +
          `Title: ${d.title}\n` +
          (d.domain ? `Domain: ${d.domain}\n` : "") +
          `\n${(d.body || "").trim() || "(no additional notes)"}\n`;
        void runInCB(prompt, "polish→social");
        break;
      }
      case "convertToIdea":
      case "convertToTask": {
        const toType = msg.action === "convertToTask" ? "task" : "idea";
        const r = runKp(["recategorize", id, "--to-type", toType]);
        model.reload(log);
        const newId = /→\s+(\S+)\s*$/.exec(r.stdout.trim())?.[1];
        if (r.ok && newId) DashboardPanel.current?.post({ type: "openItem", id: newId });
        else if (!r.ok) void vscode.window.showWarningMessage(`convert failed: ${r.stderr}`);
        break;
      }
      case "openUrl":
        if (msg.url) void vscode.env.openExternal(vscode.Uri.parse(String(msg.url)));
        break;
      case "runSync":
        void vscode.commands.executeCommand("codePlanning.runSync");
        break;
      case "openSpec": {
        // Specs live in a target repo (e.g. specs/NNN-slug); resolve across the
        // unpolarize checkouts and prefer spec.md inside the folder.
        const spec = String(msg.spec || "");
        if (!spec) break;
        const bases = [
          path.join(os.homedir(), "projects/unpolarize/knowledge-planning"),
          path.join(os.homedir(), "projects/unpolarize/code-sessions-vscode"),
          path.join(os.homedir(), "projects/unpolarize/code-build-vscode"),
          path.join(os.homedir(), "projects/unpolarize"),
        ];
        let found: string | undefined;
        for (const b of bases) {
          for (const cand of [path.join(b, spec, "spec.md"), path.join(b, spec)]) {
            try {
              if (existsSync(cand) && statSync(cand).isFile()) { found = cand; break; }
            } catch { /* keep looking */ }
          }
          if (found) break;
        }
        if (found) void vscode.window.showTextDocument(vscode.Uri.file(found), { preview: true });
        else void vscode.window.showWarningMessage(`Spec not found locally: ${spec} (it may be on the work branch — pull auto/night-build)`);
        break;
      }
      case "autoToggle": {
        // Flip <store>/autonomous/STOP — git-synced, honored by the orchestrator.
        const root = snap?.root || path.join(os.homedir(), "docs", "planning");
        const dir = path.join(root, "autonomous");
        const stop = path.join(dir, "STOP");
        try {
          if (msg.on) {
            if (existsSync(stop)) unlinkSync(stop);
            // also clear the legacy scripts STOP so enabling always works
            const legacy = path.join(os.homedir(), "docs", "scripts", ".night-build.STOP");
            if (existsSync(legacy)) unlinkSync(legacy);
          } else {
            mkdirSync(dir, { recursive: true });
            writeFileSync(stop, `stopped ${new Date().toISOString()}\n`);
          }
          void vscode.window.setStatusBarMessage(`🤖 autonomous builder ${msg.on ? "enabled" : "paused"}`, 5000);
        } catch (e) {
          void vscode.window.showWarningMessage(`toggle failed: ${String(e)}`);
        }
        model.reload(log);
        break;
      }
      case "moveToTask": {
        const r = runKp(["recategorize", id, "--to-type", "task"]);
        void vscode.window.showInformationMessage(r.ok ? r.stdout.trim() : `move failed: ${r.stderr}`);
        model.reload(log);
        break;
      }
      case "link":
        void vscode.commands.executeCommand("codePlanning.linkSession", id);
        break;
      case "openCB":
        void openInCB(id);
        break;
      case "openSession":
        // default: open the session's conversation ("insides"), not the trajectory graph
        void vscode.commands.executeCommand("codeSessions.viewConversation", {
          row: { session: String(msg.uuid), title: String(msg.title || msg.uuid) },
        });
        break;
      case "openTrajectory":
        void vscode.commands.executeCommand("codeSessions.showTrajectory", String(msg.uuid), String(msg.title || msg.uuid));
        break;
      case "resumeSession": {
        // Delegate to codeSessions.resume so cross-device sessions (no native
        // transcript here) get the ~/.sessions seed fallback, not a blank chat.
        void vscode.commands.executeCommand("codeSessions.resume", {
          session: String(msg.uuid),
          title: msg.title ? String(msg.title) : "",
          source: String(msg.source || "claude"),
          project_path: msg.cwd ? String(msg.cwd) : null,
        });
        break;
      }
      case "linkSessionToTask": {
        // from a session, pick a planning item (searchable) and link it
        void (async () => {
          const uuid = String(msg.uuid);
          const snap = model.get();
          const items = (snap?.objects ?? []).filter((o: any) => ["task", "idea", "plan", "thought"].includes(o.type));
          const pick = await vscode.window.showQuickPick(
            items.map((o: any) => ({ label: o.title || o.id, description: `${o.type} · ${o.status ?? ""}`, id: o.id })),
            { title: `Link session ${uuid.slice(0, 8)}… → planning`, placeHolder: "Search a task/idea/plan to link this session to", matchOnDescription: true },
          );
          if (!pick) return;
          const r = runKp(["link-session", (pick as { id: string }).id, uuid]);
          if (!r.ok) {
            void vscode.window.showWarningMessage(`link failed: ${r.stderr}`);
            return;
          }
          model.reload(log);
          DashboardPanel.current?.post({ type: "sessions", data: listSessionsRich() });
          void vscode.window.showInformationMessage(`Linked session → ${(pick as { id: string }).id}`);
        })();
        break;
      }
      case "openCanvas": {
        const root = snap?.root || path.join(os.homedir(), "docs", "planning");
        openCanvas(ctx, root);
        break;
      }
      case "editItem":
        void editItem(id);
        break;
      case "recategorize":
        void recategorizeItem(id);
        break;
      case "cloneItem":
        void cloneItem(id);
        break;
      case "deleteItem":
        void deleteItem(id);
        break;
      case "setField": {
        if (msg.field === "project") runKp(["set-project", id, String(msg.value ?? "") || "-"]);
        else runKp(["edit", id, msg.field === "domain" ? "--domain" : "--lane", String(msg.value ?? "")]);
        model.reload(log);
        break;
      }
      case "autosaveField": {
        // background save from the drawer's autosave — refresh the board but leave
        // the drawer alone so typing is never clobbered by a re-render
        const field = String(msg.field);
        const value = String(msg.value ?? "");
        const r = field === "body" ? runKp(["edit", id, "--body", "-"], value) : runKp(["edit", id, "--" + field, value]);
        if (!r.ok) void vscode.window.showWarningMessage(`autosave failed: ${r.stderr}`);
        model.reload(log);
        break;
      }
      case "updateField": {
        const field = String(msg.field);
        const value = String(msg.value ?? "");
        let r;
        if (field === "status") r = runKp(["set-status", id, value]);
        else if (field === "body") r = runKp(["edit", id, "--body", "-"], value);
        else r = runKp(["edit", id, "--" + field, value]); // title / domain / lane
        if (r && !r.ok) void vscode.window.showWarningMessage(`update failed: ${r.stderr}`);
        model.reload(log);
        const det = runKp(["show", id]); // refresh the open drawer with saved values
        if (det.ok) {
          try {
            DashboardPanel.current?.post({ type: "detail", data: JSON.parse(det.stdout) });
          } catch {
            /* ignore */
          }
        }
        break;
      }
      case "setType": {
        runKp(["recategorize", id, "--to-type", String(msg.toType)]);
        model.reload(log);
        break;
      }
      case "addLane":
        void (async () => {
          const name = await vscode.window.showInputBox({ prompt: "New lane name" });
          if (name) DashboardPanel.current?.post({ type: "laneAdded", name });
        })();
        break;
      case "ideate":
      case "spec":
      case "decompose":
      case "research":
      case "execute":
        void reviewAndRun(msg.action, id);
        break;
    }
  };

  const dashDeps: DashboardDeps = {
    getSnapshot: () => model.get(),
    reload: () => model.reload(log),
    onChange: model.onDidChange.event,
    runKp: (args) => runKp(args),
    onAction: dashAction,
    listSessions: () => listSessionsRich(),
    noteActivity: () => syncBridge()?.noteActivity(),
    getSyncStatus: () => syncBridge()?.getStatus(),
    onSyncStatus: (cb) => {
      const b = syncBridge();
      return b ? b.onDidSync(cb) : new vscode.Disposable(() => {});
    },
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand("codePlanning.refresh", () => {
      if (!model.reload(log)) vscode.window.showWarningMessage("Planning: kp export failed — check codeSessions.planning settings.");
    }),
    vscode.commands.registerCommand("codePlanning.openObject", openObject),
    vscode.commands.registerCommand("codePlanning.openInBoard", (item) => {
      const id = idOf(item);
      DashboardPanel.show(dashDeps, "board", id || undefined);
    }),
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
      const status = await vscode.window.showQuickPick(["inbox", "today", "in_progress", "done", "deferred", "outdated", "accepted", "parked"], {
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
      const sessions = listStoreSessions();
      let uuid: string | undefined;
      if (sessions.length) {
        type Pick = vscode.QuickPickItem & { uuid: string };
        const picks: Pick[] = [
          ...sessions.map((s) => ({
            label: s.title || s.uuid.slice(0, 8),
            description: `${s.agent ?? "?"} · ${s.uuid.slice(0, 8)}`,
            detail: new Date(s.mtime).toLocaleString(),
            uuid: s.uuid,
          })),
          { label: "$(edit) Enter a uuid manually…", uuid: "" },
        ];
        const pick = await vscode.window.showQuickPick<Pick>(picks, {
          placeHolder: `Link a session to ${id} (type to search)`,
          matchOnDescription: true,
          matchOnDetail: true,
        });
        if (!pick) return;
        uuid = pick.uuid || (await vscode.window.showInputBox({ prompt: `Session uuid to link to ${id}` }));
      } else {
        uuid = await vscode.window.showInputBox({ prompt: `Session uuid to link to ${id}` });
      }
      if (!uuid) return;
      const res = runKp(["link-session", id, uuid]);
      vscode.window.showInformationMessage(res.ok ? res.stdout.trim() : `link failed: ${res.stderr}`);
      model.reload(log);
      if (res.ok) {
        const p = await vscode.window.showInformationMessage(`Linked session to ${id}.`, "Preview session");
        if (p === "Preview session") void vscode.commands.executeCommand("codeSessions.showTrajectory", uuid);
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
    vscode.commands.registerCommand("codePlanning.openDashboard", () => DashboardPanel.show(dashDeps)),
    // Session → planning: from a session item, jump to the planning object(s) it is
    // linked to (object.linked_sessions ∪ envelope.planning_refs); offer to link if none.
    vscode.commands.registerCommand("codePlanning.openFromSession", async (arg?: any) => {
      const uuid: string | undefined =
        typeof arg === "string" ? arg : (arg?.row?.session ?? arg?.session ?? arg?.row?.session_id ?? arg?.uuid);
      if (!uuid) {
        void vscode.window.showWarningMessage("Planning: no session id on this item.");
        return;
      }
      if (!model.get()) model.reload(log);
      const objs = (model.get()?.objects ?? []) as (ObjRow & { linked_sessions?: string | null })[];
      const parseLS = (v: unknown): string[] => {
        try {
          const a = typeof v === "string" ? JSON.parse(v) : v;
          return Array.isArray(a) ? (a as string[]) : [];
        } catch {
          return [];
        }
      };
      let linked = objs.filter((o) => parseLS(o.linked_sessions).includes(uuid));
      if (!linked.length) {
        // fallback: the session envelope's planning_refs in ~/.sessions
        const refs = envelopePlanningRefs(uuid);
        linked = objs.filter((o) => refs.includes(o.id));
      }
      const openItem = (id: string) => DashboardPanel.show(dashDeps, "board", id);
      if (linked.length === 1) {
        openItem(linked[0].id);
        return;
      }
      if (linked.length > 1) {
        const pick = await vscode.window.showQuickPick(
          linked.map((o) => ({ label: o.title || o.id, description: `${o.type} · ${o.status ?? ""}`, id: o.id })),
          { placeHolder: "Planning items linked to this session" },
        );
        if (pick) openItem((pick as { id: string }).id);
        return;
      }
      const choice = await vscode.window.showQuickPick(
        objs
          .filter((o) => ["task", "idea", "plan", "thought"].includes(o.type))
          .map((o) => ({ label: o.title || o.id, description: `${o.type} · ${o.status ?? ""}`, id: o.id })),
        { title: "Link session → planning", placeHolder: "No planning links yet — pick an item to link this session to (Esc = cancel)" },
      );
      if (!choice) return;
      const r = runKp(["link-session", (choice as { id: string }).id, uuid]);
      if (!r.ok) {
        void vscode.window.showWarningMessage(`link failed: ${r.stderr}`);
        return;
      }
      model.reload(log);
      openItem((choice as { id: string }).id);
    }),
    // Cmd+Ctrl+Shift+P — planning mode toggle: open the Planning sidebar + board
    // together; press again to hide the sidebar and close the board.
    vscode.commands.registerCommand("codePlanning.togglePlanningMode", async () => {
      try {
        if (todayTreeView.visible || DashboardPanel.current) {
          DashboardPanel.close();
          if (todayTreeView.visible) await vscode.commands.executeCommand("workbench.action.closeSidebar");
        } else {
          await vscode.commands.executeCommand("workbench.view.extension.code-planning");
          DashboardPanel.show(dashDeps);
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`Planning toggle failed: ${e.message}`);
      }
    }),
    // ⟳ Sync — run an on-demand sync script from the KB's scripts/sync/ folder
    // (convention: ~/docs/scripts/sync/README.md; sync.sh is the standard action).
    vscode.commands.registerCommand("codePlanning.runSync", async (scriptArg?: string) => {
      const dir =
        planningConfig().get<string>("syncDir") || path.join(os.homedir(), "docs", "scripts", "sync");
      let names: string[] = [];
      try {
        names = readdirSync(dir).filter((f) => {
          if (!f.endsWith(".sh")) return false;
          try {
            const st = statSync(path.join(dir, f));
            return st.isFile() && (st.mode & 0o111) !== 0;
          } catch {
            return false;
          }
        });
      } catch {
        void vscode.window.showWarningMessage(`No sync folder at ${dir} (codeSessions.planning.syncDir)`);
        return;
      }
      if (!names.length) {
        void vscode.window.showWarningMessage(`No executable *.sh in ${dir}`);
        return;
      }
      names.sort((a, b) => (a === "sync.sh" ? -1 : b === "sync.sh" ? 1 : a.localeCompare(b)));
      let script = scriptArg && names.includes(scriptArg) ? scriptArg : undefined;
      if (!script) {
        script =
          names.length === 1
            ? names[0]
            : await vscode.window.showQuickPick(names, {
                placeHolder: `Run a sync script from ${dir}`,
                title: "⟳ Sync",
              });
      }
      if (!script) return;
      const file = path.join(dir, script);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `⟳ ${script}` },
        () =>
          new Promise<void>((resolveP) => {
            execFile(file, { timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
              const out = `${stdout ?? ""}${stderr ? "\n" + stderr : ""}`.trim();
              log?.appendLine(`[sync] ${script}${err ? ` FAILED (${(err as any).code})` : ""}\n${out}`);
              if (err) {
                void vscode.window
                  .showWarningMessage(`${script} failed — see output`, "Show output")
                  .then((c) => c && log?.show(true));
              } else {
                void vscode.window.showInformationMessage(`${script} ✓`);
              }
              model.reload(log);
              resolveP();
            });
          }),
      );
    }),
    vscode.commands.registerCommand("codePlanning.openCanvas", () => {
      const root = model.get()?.root || path.join(os.homedir(), "docs", "planning");
      openCanvas(ctx, root);
    }),
    vscode.commands.registerCommand("codePlanning.showBoard", () => DashboardPanel.show(dashDeps, "board")),
    vscode.commands.registerCommand("codePlanning.showGraph", () => DashboardPanel.show(dashDeps, "graph")),
    vscode.commands.registerCommand("codePlanning.capture", async () => {
      const text = await vscode.window.showInputBox({ prompt: "Capture an idea" });
      if (text) {
        const res = runKp(["capture", text]);
        vscode.window.showInformationMessage(res.ok ? res.stdout.trim() : `capture failed: ${res.stderr}`);
        model.reload(log);
      }
    }),
  );

  // ── autonomous-run notifications: watch plan.json and toast when a phase lands ──
  // (plan.json is git-synced, so runs from the other laptop notify here too.)
  const autoDir = path.join(os.homedir(), "docs", "planning", "autonomous");
  const notifyAutonomous = () => {
    let plan: any;
    try {
      plan = JSON.parse(readFileSync(path.join(autoDir, "plan.json"), "utf8"));
    } catch {
      return;
    }
    const cw = plan?.current_window;
    if (!cw) return;
    const openAuto = "Open Auto view";
    const seenIdeate = ctx.globalState.get<string>("kp.auto.lastIdeate");
    if (cw.ideate?.ran && cw.ideate.ran !== seenIdeate) {
      void ctx.globalState.update("kp.auto.lastIdeate", cw.ideate.ran);
      if (seenIdeate !== undefined) {
        const n = cw.ideate.created_count ?? (cw.ideate.created || []).length;
        void vscode.window
          .showInformationMessage(`🤖 Ideation ready: ${n} idea(s)${cw.ideate.spec ? ` · spec ${cw.ideate.spec}` : ""} — review in the Auto view.`, openAuto, ...(cw.ideate.spec ? ["Open spec"] : []))
          .then((pick) => {
            if (pick === openAuto) DashboardPanel.show(dashDeps, "autonomous");
            else if (pick === "Open spec") dashAction({ type: "action", action: "openSpec", spec: cw.ideate.spec });
          });
      }
    }
    const seenImpl = ctx.globalState.get<string>("kp.auto.lastImplement");
    if (cw.implement?.ran && cw.implement.ran !== seenImpl) {
      void ctx.globalState.update("kp.auto.lastImplement", cw.implement.ran);
      if (seenImpl !== undefined) {
        void vscode.window
          .showInformationMessage(`🤖 Implementation ${cw.implement.status || "done"}${cw.implement.report ? ` — report ready` : ""}.`, openAuto, ...(cw.implement.report ? ["Open report"] : []))
          .then((pick) => {
            if (pick === openAuto) DashboardPanel.show(dashDeps, "autonomous");
            else if (pick === "Open report") dashAction({ type: "open", kbPath: cw.implement.report });
          });
      }
    }
  };
  try {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(autoDir), "plan.json"));
    let deb: NodeJS.Timeout | undefined;
    const kick = () => {
      if (deb) clearTimeout(deb);
      deb = setTimeout(notifyAutonomous, 1500);
    };
    w.onDidChange(kick);
    w.onDidCreate(kick);
    ctx.subscriptions.push(w);
    notifyAutonomous(); // seed the baseline so only NEW completions notify
  } catch (e) {
    log?.appendLine(`[planning] autonomous watcher unavailable: ${String(e)}`);
  }

  model.reload(log);
  log?.appendLine("[planning] registered Planning mode");
}
