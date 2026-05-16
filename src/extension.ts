import * as vscode from "vscode";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// --------------------------------------------------------------------------- //
// Shared helpers
// --------------------------------------------------------------------------- //

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

function dayBucket(d: Date): "today" | "yesterday" | "last7" | "older" {
  const now = new Date();
  const startOfDay = (dt: Date) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const today = startOfDay(now).getTime();
  const yest = today - 24 * 3600 * 1000;
  const week = today - 7 * 24 * 3600 * 1000;
  const t = d.getTime();
  if (t >= today) return "today";
  if (t >= yest) return "yesterday";
  if (t >= week) return "last7";
  return "older";
}

const BUCKET_LABEL: Record<ReturnType<typeof dayBucket>, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last7: "Last 7 days",
  older: "Older",
};

const BUCKET_ORDER: Array<ReturnType<typeof dayBucket>> = ["today", "yesterday", "last7", "older"];

function exec(
  cmd: string,
  args: string[],
  cwd?: string,
  maxBuffer = 64 * 1024 * 1024,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer }, (err, stdout, stderr) => {
      const code = err ? (err as any).code ?? 1 : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });
}

// --------------------------------------------------------------------------- //
// Sessions provider
// --------------------------------------------------------------------------- //

interface SessionRow {
  mtime_epoch: number;
  active: string;
  project: string;
  session: string;
  modified: string;
  messages: number;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  tokens_total: number;
  cost_usd: number;
  title: string;
  subagents: number;
  projects_touched: string[];
}

class SessionsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private rows: SessionRow[] = [];
  private lastError: string | null = null;

  refresh(): Promise<void> {
    return this.load().then(() => this._onDidChange.fire());
  }

  private async load(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("claudeSessions");
    const limit = cfg.get<number>("limit", 100);
    const scriptPath = expandHome(
      cfg.get<string>("scriptPath", "~/.claude/skills/sessions/session-center.sh"),
    );
    const { stdout, stderr, code } = await exec("bash", [scriptPath, "recent", String(limit), "json"]);
    if (code !== 0) {
      this.lastError = `session-center.sh exit ${code}: ${stderr.trim()}`;
      this.rows = [];
      return;
    }
    try {
      this.rows = JSON.parse(stdout) as SessionRow[];
      this.lastError = null;
    } catch (e: any) {
      this.lastError = `JSON parse failed: ${e.message}`;
      this.rows = [];
    }
  }

  getTreeItem(el: vscode.TreeItem): vscode.TreeItem {
    return el;
  }

  getChildren(el?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
    if (this.lastError && !el) {
      const it = new vscode.TreeItem(`Error: ${this.lastError.split("\n")[0]}`);
      it.tooltip = this.lastError;
      it.iconPath = new vscode.ThemeIcon("error");
      return [it];
    }

    if (!el) {
      const byBucket = new Map<string, SessionRow[]>();
      for (const r of this.rows) {
        const b = dayBucket(new Date(r.mtime_epoch * 1000));
        const arr = byBucket.get(b) ?? [];
        arr.push(r);
        byBucket.set(b, arr);
      }
      return BUCKET_ORDER.filter((b) => byBucket.has(b)).map((b) => {
        const arr = byBucket.get(b)!;
        const totals = {
          tokens: arr.reduce((n, r) => n + r.tokens_total, 0),
          cost: arr.reduce((n, r) => n + r.cost_usd, 0),
          subagents: arr.reduce((n, r) => n + (r.subagents || 0), 0),
        };
        return new BucketItem(b, arr.length, "session", totals);
      });
    }

    if (el instanceof BucketItem && el.kind === "session") {
      const rows = this.rows
        .filter((r) => dayBucket(new Date(r.mtime_epoch * 1000)) === el.bucket)
        .sort((a, b) => b.mtime_epoch - a.mtime_epoch);
      return rows.map((r) => new SessionItem(r));
    }
    if (el instanceof SessionItem) {
      return el.metricsChildren();
    }
    return [];
  }
}

function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${n}`;
}

class BucketItem extends vscode.TreeItem {
  constructor(
    public readonly bucket: ReturnType<typeof dayBucket>,
    public readonly count: number,
    public readonly kind: "session" | "kb" | "project",
    public readonly totals?: {
      tokens?: number;
      cost?: number;
      subagents?: number;
      commits?: number;
    },
  ) {
    let label = BUCKET_LABEL[bucket];
    if (kind === "session" && totals) {
      const parts = [`${count} sessions`];
      if (totals.cost && totals.cost > 0) parts.push(`$${totals.cost.toFixed(2)}`);
      if (totals.tokens && totals.tokens > 0) parts.push(`${formatTokens(totals.tokens)} tok`);
      if (totals.subagents && totals.subagents > 0) parts.push(`🪄${totals.subagents}`);
      label = `${BUCKET_LABEL[bucket]} — ${parts.join(" · ")}`;
    } else if ((kind === "kb" || kind === "project") && totals) {
      const parts = [`${count} files`];
      if (totals.commits && totals.commits > 0) parts.push(`${totals.commits} commits`);
      label = `${BUCKET_LABEL[bucket]} — ${parts.join(" · ")}`;
    } else {
      label = `${BUCKET_LABEL[bucket]} (${count})`;
    }
    super(
      label,
      bucket === "today"
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.iconPath = new vscode.ThemeIcon("calendar");
    this.contextValue = `bucket-${kind}`;
  }
}

class SessionItem extends vscode.TreeItem {
  constructor(public readonly row: SessionRow) {
    super(
      row.title || row.session,
      // Auto-expand active sessions; older ones stay collapsed to keep the tree readable.
      row.active === "*"
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    const cost = row.cost_usd.toFixed(2);
    const mins = Math.max(0, Math.round((Date.now() / 1000 - row.mtime_epoch) / 60));
    // Description: smallest-possible summary so the title is the headline.
    this.description = `$${cost} · ${mins}m`;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${row.title || "(no title)"}**`,
        ``,
        `\`${row.session}\``,
        `Modified: ${row.modified}`,
        `Messages: ${row.messages}  ·  Subagents: ${row.subagents}`,
        `Tokens: ${row.tokens_total.toLocaleString()} (in ${row.tokens_input}, out ${row.tokens_output}, cache R ${row.tokens_cache_read}, cache W ${row.tokens_cache_write})`,
        `Cost: $${cost}`,
        `Projects touched: ${row.projects_touched?.join(", ") || "(none recorded)"}`,
        row.active === "*" ? `\n_Active (mtime < 2 min)_` : "",
      ].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon(
      row.active === "*" ? "pulse" : "comment-discussion",
    );
    this.contextValue = "session";
    // No `command` here: clicking expands the children. Use the explicit
    // "Resume" command via the inline action / right-click instead.
  }

  /**
   * Children: a compact metrics row + a one-liner projects row.
   * Clicking the "Resume" child triggers the resume command.
   */
  metricsChildren(): vscode.TreeItem[] {
    const r = this.row;
    const out: vscode.TreeItem[] = [];

    const cost = r.cost_usd.toFixed(2);
    const mins = Math.max(0, Math.round((Date.now() / 1000 - r.mtime_epoch) / 60));
    const sub = r.subagents > 0 ? ` · 🪄${r.subagents}` : "";
    const stats = new vscode.TreeItem(
      `💬 ${r.messages.toLocaleString()} msgs  ·  $${cost}  ·  ${formatTokens(r.tokens_total)} tok${sub}  ·  ${mins}m ago`,
    );
    stats.iconPath = new vscode.ThemeIcon("graph");
    stats.contextValue = "sessionMetric";
    out.push(stats);

    if (r.projects_touched && r.projects_touched.length > 0) {
      const projItem = new vscode.TreeItem(`📁 ${r.projects_touched.join(", ")}`);
      projItem.iconPath = new vscode.ThemeIcon("folder-library");
      projItem.tooltip = `Projects touched in this session:\n${r.projects_touched.join("\n")}`;
      out.push(projItem);
    }

    // A small "Resume" action row at the bottom.
    const resumeItem = new vscode.TreeItem("▶ Resume in Claude");
    resumeItem.iconPath = new vscode.ThemeIcon("play");
    resumeItem.contextValue = "sessionResume";
    resumeItem.command = {
      command: "claudeSessions.resume",
      title: "Resume",
      arguments: [r],
    };
    out.push(resumeItem);

    // "Open transcript" as a quick child too.
    const txItem = new vscode.TreeItem("📜 Open transcript (JSONL)");
    txItem.iconPath = new vscode.ThemeIcon("file-text");
    txItem.command = {
      command: "claudeSessions.openTranscript",
      title: "Open transcript",
      arguments: [this],
    };
    out.push(txItem);

    return out;
  }
}

// --------------------------------------------------------------------------- //
// Git-log helpers
// --------------------------------------------------------------------------- //

interface FileChange {
  status: string; // A / M / D / R...
  path: string;
  abs: string;
  dateMs: number;
  commit: string;
  subject: string;
}

async function gitChanges(
  repoPath: string,
  sinceDays: number,
): Promise<FileChange[]> {
  if (!fs.existsSync(path.join(repoPath, ".git"))) return [];

  const { stdout, code } = await exec(
    "git",
    [
      "log",
      `--since=${sinceDays} days ago`,
      "--name-status",
      "--no-merges",
      "--date=iso-strict",
      "--pretty=format:%x01%H%x09%aI%x09%s",
    ],
    repoPath,
  );
  if (code !== 0) return [];

  const out: FileChange[] = [];
  let commit = "";
  let dateMs = 0;
  let subject = "";
  for (const rawLine of stdout.split("\n")) {
    if (!rawLine) continue;
    if (rawLine.startsWith("")) {
      const [c, iso, ...rest] = rawLine.slice(1).split("\t");
      commit = c;
      dateMs = new Date(iso).getTime();
      subject = rest.join("\t");
      continue;
    }
    const m = rawLine.match(/^([A-Z])(\d*)\s+(.+)$/);
    if (!m) continue;
    const status = m[1];
    const filePath = m[3].split("\t").pop()!;
    out.push({
      status,
      path: filePath,
      abs: path.join(repoPath, filePath),
      dateMs,
      commit,
      subject,
    });
  }
  // Also include uncommitted changes
  const { stdout: stStdout } = await exec(
    "git",
    ["status", "--porcelain=v1"],
    repoPath,
  );
  for (const ln of stStdout.split("\n")) {
    if (!ln.trim()) continue;
    const status = ln.slice(0, 2).trim() || "?";
    const filePath = ln.slice(3);
    out.unshift({
      status,
      path: filePath,
      abs: path.join(repoPath, filePath),
      dateMs: Date.now(),
      commit: "WORKING",
      subject: "(uncommitted)",
    });
  }
  return out;
}

class FileChangeItem extends vscode.TreeItem {
  constructor(public readonly change: FileChange, public readonly repoLabel: string) {
    super(change.path, vscode.TreeItemCollapsibleState.None);
    const statusIcon: Record<string, string> = {
      A: "diff-added",
      M: "diff-modified",
      D: "diff-removed",
      R: "diff-renamed",
      "??": "diff-added",
    };
    this.iconPath = new vscode.ThemeIcon(statusIcon[change.status] ?? "diff");
    this.description = `${change.status}  ${change.commit === "WORKING" ? "(uncommitted)" : change.commit.slice(0, 7) + " " + change.subject.slice(0, 80)}`;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${change.path}**`,
        ``,
        `Status: ${change.status}`,
        `Commit: \`${change.commit}\``,
        `Subject: ${change.subject}`,
        change.dateMs > 0
          ? `Date: ${new Date(change.dateMs).toISOString()}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    this.contextValue = "fileChange";
    this.command = {
      command: this.repoIsKB() ? "claudeKbChanges.openFile" : "claudeProjectsActivity.openFile",
      title: "Open file",
      arguments: [this.change],
    };
  }

  private repoIsKB(): boolean {
    const kbPath = expandHome(
      vscode.workspace.getConfiguration("claudeKbChanges").get<string>("repoPath", "~/docs"),
    );
    return this.change.abs.startsWith(kbPath);
  }
}

// --------------------------------------------------------------------------- //
// KB changes provider
// --------------------------------------------------------------------------- //

class KbChangesProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private changes: FileChange[] = [];
  private repoPath = "";

  refresh(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("claudeKbChanges");
    this.repoPath = expandHome(cfg.get<string>("repoPath", "~/docs"));
    const days = cfg.get<number>("lookbackDays", 14);
    return gitChanges(this.repoPath, days).then((c) => {
      this.changes = c;
      this._onDidChange.fire();
    });
  }

  getTreeItem(el: vscode.TreeItem): vscode.TreeItem {
    return el;
  }

  getChildren(el?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
    if (!el) {
      const byBucket = new Map<string, FileChange[]>();
      for (const c of this.changes) {
        const b = dayBucket(new Date(c.dateMs));
        const arr = byBucket.get(b) ?? [];
        arr.push(c);
        byBucket.set(b, arr);
      }
      return BUCKET_ORDER.filter((b) => byBucket.has(b)).map((b) => {
        const arr = byBucket.get(b)!;
        const commits = new Set(arr.map((c) => c.commit)).size;
        return new BucketItem(b, arr.length, "kb", { commits });
      });
    }
    if (el instanceof BucketItem && el.kind === "kb") {
      return this.changes
        .filter((c) => dayBucket(new Date(c.dateMs)) === el.bucket)
        .map((c) => new FileChangeItem(c, "docs"));
    }
    return [];
  }
}

// --------------------------------------------------------------------------- //
// Projects activity provider
// --------------------------------------------------------------------------- //

class ProjectsActivityProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  // bucket → projectLabel → FileChange[]
  private grouped: Map<string, Map<string, FileChange[]>> = new Map();

  async refresh(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("claudeProjectsActivity");
    const explicit = (cfg.get<string[]>("repoPaths") ?? []).map(expandHome);
    const days = cfg.get<number>("lookbackDays", 14);
    const autoDiscover = cfg.get<boolean>("autoDiscover", true);
    const discoveryRoot = expandHome(cfg.get<string>("discoveryRoot", "~/projects"));

    const repos = new Set<string>(explicit);
    if (autoDiscover) {
      for (const r of await this.discover(discoveryRoot, days)) repos.add(r);
    }

    this.grouped.clear();
    for (const repo of repos) {
      const changes = await gitChanges(repo, days);
      for (const c of changes) {
        const bucket = dayBucket(new Date(c.dateMs));
        const projectLabel = path.relative(expandHome("~/projects"), repo) || path.basename(repo);
        const bucketMap = this.grouped.get(bucket) ?? new Map<string, FileChange[]>();
        const arr = bucketMap.get(projectLabel) ?? [];
        arr.push(c);
        bucketMap.set(projectLabel, arr);
        this.grouped.set(bucket, bucketMap);
      }
    }
    this._onDidChange.fire();
  }

  private async discover(root: string, days: number): Promise<string[]> {
    const found: string[] = [];
    if (!fs.existsSync(root)) return found;
    const visit = (dir: string, depth: number) => {
      if (depth < 0) return;
      if (fs.existsSync(path.join(dir, ".git"))) {
        found.push(dir);
        return; // don't descend further once we hit a repo
      }
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith(".")) continue;
        visit(path.join(dir, e.name), depth - 1);
      }
    };
    visit(root, 2);
    // Filter to repos with commits in window — cheap check
    const filtered: string[] = [];
    for (const r of found) {
      const { stdout, code } = await exec(
        "git",
        ["log", `--since=${days} days ago`, "--oneline", "-n", "1"],
        r,
      );
      if (code === 0 && stdout.trim().length > 0) filtered.push(r);
    }
    return filtered;
  }

  getTreeItem(el: vscode.TreeItem): vscode.TreeItem {
    return el;
  }

  getChildren(el?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
    if (!el) {
      const buckets = BUCKET_ORDER.filter((b) => this.grouped.has(b));
      return buckets.map((b) => {
        const projMap = this.grouped.get(b)!;
        const flat = Array.from(projMap.values()).flat();
        const count = flat.length;
        const commits = new Set(flat.map((c) => c.commit)).size;
        return new BucketItem(b, count, "project", { commits });
      });
    }
    if (el instanceof BucketItem && el.kind === "project") {
      const projMap = this.grouped.get(el.bucket);
      if (!projMap) return [];
      // sort projects by total file count desc
      const entries = Array.from(projMap.entries()).sort((a, b) => b[1].length - a[1].length);
      return entries.map(([label, changes]) => new ProjectGroupItem(label, changes, el.bucket));
    }
    if (el instanceof ProjectGroupItem) {
      return el.changes.map((c) => new FileChangeItem(c, el.project));
    }
    return [];
  }
}

class ProjectGroupItem extends vscode.TreeItem {
  constructor(
    public readonly project: string,
    public readonly changes: FileChange[],
    public readonly bucket: ReturnType<typeof dayBucket>,
  ) {
    super(`${project} (${changes.length})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon("repo");
    this.contextValue = "projectGroup";
  }
}

// --------------------------------------------------------------------------- //
// Activation
// --------------------------------------------------------------------------- //

export function activate(ctx: vscode.ExtensionContext) {
  const sessions = new SessionsProvider();
  const kb = new KbChangesProvider();
  const projects = new ProjectsActivityProvider();

  sessions.refresh();
  kb.refresh();
  projects.refresh();

  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider("claudeSessions", sessions),
    vscode.window.registerTreeDataProvider("claudeKbChanges", kb),
    vscode.window.registerTreeDataProvider("claudeProjectsActivity", projects),

    vscode.commands.registerCommand("claudeSessions.refresh", () => sessions.refresh()),
    vscode.commands.registerCommand("claudeKbChanges.refresh", () => kb.refresh()),
    vscode.commands.registerCommand("claudeProjectsActivity.refresh", () => projects.refresh()),

    vscode.commands.registerCommand("claudeSessions.resume", async (row: SessionRow) => {
      // Prefer the official Claude Code VS Code extension panel.
      // Discovered signature (from extension internals):
      //   claude-vscode.primaryEditor.open(sessionId, prompt?, viewColumn?)
      //   claude-vscode.editor.open(sessionId, prompt?, viewColumn?)
      // Both call createPanel(sessionId, prompt, viewColumn) under the hood.
      const candidates = [
        "claude-vscode.primaryEditor.open",
        "claude-vscode.editor.open",
      ];
      for (const cmd of candidates) {
        try {
          await vscode.commands.executeCommand(
            cmd,
            row.session,
            undefined,
            vscode.ViewColumn.Active,
          );
          return;
        } catch {
          // try the next one
        }
      }
      // Fallback: open in a terminal (e.g., if anthropic.claude-code isn't installed).
      const term = vscode.window.createTerminal({
        name: `claude:${row.session.slice(0, 8)}`,
      });
      term.show();
      term.sendText(`claude --resume ${row.session}`);
    }),

    vscode.commands.registerCommand("claudeSessions.openTranscript", async (item: SessionItem) => {
      const projectsRoot = path.join(os.homedir(), ".claude", "projects");
      const dirs = await vscode.workspace.fs.readDirectory(vscode.Uri.file(projectsRoot));
      for (const [dirName, kind] of dirs) {
        if (kind !== vscode.FileType.Directory) continue;
        const candidate = path.join(projectsRoot, dirName, `${item.row.session}.jsonl`);
        try {
          await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
          const doc = await vscode.workspace.openTextDocument(candidate);
          await vscode.window.showTextDocument(doc);
          return;
        } catch {
          // not in this project; keep searching
        }
      }
      vscode.window.showWarningMessage(`Transcript not found for session ${item.row.session}`);
    }),

    vscode.commands.registerCommand("claudeKbChanges.openFile", (c: FileChange) => openChangedFile(c)),
    vscode.commands.registerCommand("claudeProjectsActivity.openFile", (c: FileChange) => openChangedFile(c)),
    vscode.commands.registerCommand("claudeKbChanges.diff", (item: FileChangeItem) => showDiff(item.change)),
    vscode.commands.registerCommand("claudeProjectsActivity.diff", (item: FileChangeItem) => showDiff(item.change)),
  );

  // Auto-refresh on JSONL changes
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      vscode.Uri.file(path.join(os.homedir(), ".claude", "projects")),
      "**/*.jsonl",
    ),
  );
  let refreshTimer: NodeJS.Timeout | undefined;
  const queueRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => sessions.refresh(), 1500);
  };
  watcher.onDidChange(queueRefresh);
  watcher.onDidCreate(queueRefresh);
  ctx.subscriptions.push(watcher);
}

async function openChangedFile(c: FileChange) {
  try {
    const doc = await vscode.workspace.openTextDocument(c.abs);
    await vscode.window.showTextDocument(doc);
  } catch (e: any) {
    vscode.window.showWarningMessage(`Cannot open ${c.abs}: ${e.message}`);
  }
}

async function showDiff(c: FileChange) {
  // Use VS Code's git diff via vscode.diff against the parent commit's blob
  const repoPath = findRepoRoot(c.abs);
  if (!repoPath) {
    vscode.window.showWarningMessage(`Not inside a git repo: ${c.abs}`);
    return;
  }
  const rel = path.relative(repoPath, c.abs);
  const ref = c.commit === "WORKING" ? "HEAD" : `${c.commit}~1`;
  const previousUri = vscode.Uri.parse(
    `git-show:${ref}:${rel.replace(/\\/g, "/")}`,
  );
  // VS Code git extension URI for show.
  // Simpler fallback: spawn `git show` to a temp file and open diff.
  try {
    await vscode.commands.executeCommand(
      "vscode.diff",
      previousUri,
      vscode.Uri.file(c.abs),
      `${path.basename(c.abs)} (${ref} vs working)`,
    );
  } catch {
    // Fallback: spawn git show, write to a temp file, then open diff
    const { stdout } = await exec("git", ["show", `${ref}:${rel}`], repoPath);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sessions-"));
    const tmpFile = path.join(tmpDir, `${ref}-${path.basename(rel)}`);
    fs.writeFileSync(tmpFile, stdout);
    await vscode.commands.executeCommand(
      "vscode.diff",
      vscode.Uri.file(tmpFile),
      vscode.Uri.file(c.abs),
      `${path.basename(c.abs)} (${ref} vs working)`,
    );
  }
}

function findRepoRoot(file: string): string | null {
  let dir = path.dirname(file);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function deactivate() {}
