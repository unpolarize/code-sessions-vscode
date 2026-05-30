import * as vscode from "vscode";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openConversationViewer } from "./conversationView";
import { openInsightsView } from "./insightsView";
import { SessionStore } from "./db";
import { syncToStore } from "./jsonlIndexer";
import { syncGrokToStore } from "./grokIndexer";
import { classifySession } from "./topicClassifier";
import { openAgentGraph } from "./agentGraph";
import { openTrajectoryView } from "./trajectoryView";
import { openLiveMonitor, buildUpdate, UpdatePayload } from "./liveMonitor";
import { openSearchView } from "./searchView";
import { BackgroundClassifier } from "./backgroundClassifier";

// --------------------------------------------------------------------------- //
// Shared helpers
// --------------------------------------------------------------------------- //

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

/** Returns the configured KB repo path, falling back to the first workspace folder. */
function resolveKbRepoPath(): string {
  const cfg = vscode.workspace.getConfiguration("coderKbChanges");
  const configured = cfg.get<string>("repoPath", "");
  if (configured) return expandHome(configured);
  const first = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return first ?? expandHome("~/docs");
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
// Live status-bar item — always-visible compact indicator
// --------------------------------------------------------------------------- //

/**
 * Create a status-bar item that reflects current Claude Code activity. Polls
 * every 5 s when at least one session is active, drops to 30 s when idle.
 * Hover shows a per-session breakdown; click opens the live monitor.
 */
/** Daily cost budget meter. Hidden when no budget is configured. Reuses
 * the live-monitor's `buildUpdate(store).costToday` so we don't double-poll. */
function createCostBudgetTile(
  ctx: vscode.ExtensionContext,
  store: SessionStore,
): { item: vscode.StatusBarItem; tick: () => void } {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  item.name = "AI Coders · cost today";
  item.command = "coderSessions.openInsights";

  const tick = () => {
    const cfg = vscode.workspace.getConfiguration("coderSessions");
    const budget = cfg.get<number>("costBudget.daily", 0);
    if (budget <= 0) {
      item.hide();
      return;
    }
    let costToday = 0;
    try {
      costToday = buildUpdate(store).costToday;
    } catch {
      item.hide();
      return;
    }
    const pct = budget > 0 ? Math.min(999, Math.round((costToday / budget) * 100)) : 0;
    let icon = "$(symbol-currency)";
    item.backgroundColor = undefined;
    if (pct >= 100) {
      icon = "$(error)";
      item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    } else if (pct >= 80) {
      icon = "$(warning)";
      item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }
    item.text = `${icon} \\$${costToday.toFixed(2)} / \\$${budget.toFixed(0)} (${pct}%)`;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Claude — today**\n\n`);
    md.appendMarkdown(`Spend: **\\$${costToday.toFixed(2)}**\n\n`);
    md.appendMarkdown(`Daily budget: \\$${budget.toFixed(2)}\n\n`);
    md.appendMarkdown(`Used: **${pct}%** of budget\n\n`);
    if (pct >= 100) md.appendMarkdown(`⚠ **Over budget.** Click for Insights.`);
    else if (pct >= 80) md.appendMarkdown(`Approaching budget — click for Insights.`);
    else md.appendMarkdown(`Click for Insights.`);
    item.tooltip = md;
    item.show();
  };
  tick();
  ctx.subscriptions.push(
    item,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("coderSessions.costBudget")) tick();
    }),
  );
  return { item, tick };
}

function createLiveStatusBar(
  ctx: vscode.ExtensionContext,
  store: SessionStore,
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = "coderSessions.openLiveMonitor";
  item.name = "Claude · Live";
  item.show();

  const fmtTok = (n: number): string => {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(n);
  };

  const tooltipFor = (p: UpdatePayload): vscode.MarkdownString => {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.appendMarkdown(`**AI Coders · Live** &nbsp; *(updated ${new Date().toLocaleTimeString()})*\n\n`);
    md.appendMarkdown(
      `$(pulse) **${p.activeCount}** active · $(tools) **${p.toolsPerMin}** tools/min · ` +
        `$(symbol-numeric) **${fmtTok(p.tokensToday)}** tokens · $(rocket) **${p.subagentsToday}** subagents · ` +
        `$(credit-card) **\\$${p.costToday.toFixed(2)}** today\n\n`,
    );
    if (p.cards.length === 0) {
      md.appendMarkdown("_No active sessions in the last 2 minutes._\n");
    } else {
      md.appendMarkdown("---\n\n");
      for (const c of p.cards.slice(0, 8)) {
        let status = "";
        if (c.now.kind === "awaiting_user") {
          const lbl = c.now.detail === "AskUserQuestion" ? "awaiting your answer" : c.now.detail === "ExitPlanMode" ? "awaiting plan approval" : "awaiting input";
          status = `$(warning) **${lbl}** · ${c.now.ageSec}s`;
        } else if (c.now.kind === "in_tool") status = `$(gear) ${c.now.detail} · ${c.now.ageSec}s`;
        else if (c.now.kind === "responding") status = `$(pencil) responding · ${c.now.ageSec}s`;
        else status = `$(circle-outline) idle${c.now.ageSec ? ` · ${c.now.ageSec}s` : ""}`;
        const proj = c.project ? c.project : "(no project)";
        const title = c.title.length > 64 ? c.title.slice(0, 64) + "…" : c.title;
        const cacheTot = c.cacheReadTokens + c.cacheWriteTokens;
        const tokDetail = [
          c.inputTokens ? `in ${fmtTok(c.inputTokens)}` : null,
          c.outputTokens ? `out ${fmtTok(c.outputTokens)}` : null,
          cacheTot ? `cache ${fmtTok(cacheTot)}` : null,
        ].filter(Boolean).join(" · ");
        const subagentStr = c.subagents > 0 ? ` · 🪄 ${c.subagents}` : "";
        md.appendMarkdown(
          `**${escapeMd(title)}** &nbsp; \`${escapeMd(proj)}\`\n\n` +
            `${status} · 💬 ${c.messages} · 🔧 ${c.tools}${subagentStr} · ` +
            `🔢 ${fmtTok(c.totalTokens)}${tokDetail ? ` _(${tokDetail})_` : ""} · ` +
            `\\$${c.cost_usd.toFixed(2)}\n\n`,
        );
      }
      if (p.cards.length > 8) {
        md.appendMarkdown(`_…and ${p.cards.length - 8} more — click to open the dashboard._\n`);
      } else {
        md.appendMarkdown("_Click to open the full live monitor._\n");
      }
    }
    return md;
  };

  let timer: NodeJS.Timeout | undefined;
  // Track which sessions we have already notified about so we don't fire a
  // toast every poll tick; clear an id once the session is no longer awaiting.
  const notifiedAwaiting = new Set<string>();
  const tick = () => {
    try {
      const payload = buildUpdate(store);
      const awaiting = payload.cards.filter((c) => c.now.kind === "awaiting_user");
      if (payload.activeCount > 0) {
        if (awaiting.length > 0) {
          // Prefer the awaiting session in the status-bar label.
          const a = awaiting[0];
          const lbl = a.now.detail === "ExitPlanMode" ? "awaiting plan" : "awaiting answer";
          item.text = `$(warning) AI Coders · ${awaiting.length} ${lbl}`;
          item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        } else {
          const top = payload.cards[0];
          const tag =
            top.now.kind === "in_tool"
              ? top.now.detail
              : top.now.kind === "responding"
                ? "responding"
                : "idle";
          item.text = `$(pulse) AI Coders · ${payload.activeCount} active · ${tag}`;
          item.backgroundColor = undefined;
        }
      } else {
        item.text = `$(comment-discussion) AI Coders · idle`;
        item.backgroundColor = undefined;
      }

      // One-shot notification per session entering the awaiting state.
      const stillAwaitingIds = new Set(awaiting.map((c) => c.session_id));
      for (const c of awaiting) {
        if (notifiedAwaiting.has(c.session_id)) continue;
        notifiedAwaiting.add(c.session_id);
        const cfg = vscode.workspace.getConfiguration("coderSessions");
        if (cfg.get<boolean>("awaitingUser.notify", true)) {
          const action = c.now.detail === "ExitPlanMode" ? "approve the plan" : "answer the question";
          vscode.window
            .showWarningMessage(
              `Claude session "${c.title}" is waiting for you to ${action}.`,
              "Open session",
              "Open live monitor",
            )
            .then((sel) => {
              if (sel === "Open live monitor") {
                vscode.commands.executeCommand("coderSessions.openLiveMonitor");
              } else if (sel === "Open session") {
                vscode.commands.executeCommand("coderSessions.showTrajectory", c.session_id, c.title);
              }
            });
        }
      }
      for (const id of [...notifiedAwaiting]) if (!stillAwaitingIds.has(id)) notifiedAwaiting.delete(id);
      item.tooltip = tooltipFor(payload);
      // Schedule next poll based on activity
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, payload.activeCount > 0 ? 5_000 : 30_000);
    } catch (e: any) {
      item.text = `$(warning) AI Coders`;
      item.tooltip = `coder-sessions: ${e.message}`;
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, 30_000);
    }
  };

  // Honor enabled flag dynamically
  const applyEnabledState = () => {
    const enabled = vscode.workspace
      .getConfiguration("coderSessions")
      .get<boolean>("liveStatusBar.enabled", true);
    if (enabled) {
      item.show();
      if (!timer) tick();
    } else {
      item.hide();
      if (timer) { clearTimeout(timer); timer = undefined; }
    }
  };
  applyEnabledState();

  ctx.subscriptions.push(
    item,
    { dispose: () => { if (timer) clearTimeout(timer); } },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("coderSessions.liveStatusBar.enabled")) applyEnabledState();
    }),
  );
  return item;
}

function escapeMd(s: string): string {
  return String(s).replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
}

// --------------------------------------------------------------------------- //
// Sessions provider
// --------------------------------------------------------------------------- //

interface SessionRow {
  source: "claude" | "grok";
  mtime_epoch: number;
  active: string;
  project: string;
  project_path: string | null;
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
  first_ts_epoch?: number;
  entrypoint?: string;
  is_automated?: boolean;
  top_topics?: string[];
  topic_counts?: Array<[string, number]>;
  /** Epoch seconds of the last assistant text response, or 0 when unknown. */
  last_response_epoch?: number;
  is_starred?: boolean;
}

/**
 * Format a "Nm ago" / "Nh ago" / "Nd ago" relative timestamp.
 * Uses minute thresholds up to 90 min, then hours up to 36 h, then days.
 */
function formatRelative(epochSec: number): string {
  if (!epochSec) return "—";
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000 - epochSec));
  if (diffSec < 60) return "just now";
  const min = Math.floor(diffSec / 60);
  if (min < 90) return `${min}m ago`;
  const hr = Math.floor(diffSec / 3600);
  if (hr < 36) return `${hr}h ago`;
  const day = Math.floor(diffSec / 86400);
  if (day < 14) return `${day}d ago`;
  const week = Math.floor(diffSec / (7 * 86400));
  if (week < 8) return `${week}w ago`;
  const month = Math.floor(diffSec / (30 * 86400));
  return `${month}mo ago`;
}

/**
 * Format a duration in seconds as a compact "1h 23m" / "45m" / "12s" string.
 */
/** Compact, fixed-width "ago" label for the sessions list. Uses figure-space
 * (U+2007, same width as a digit in most fonts) so values line up visually
 * even in proportional fonts: "  5s", " 12m", "  3h", " 14d". */
function formatAgoFixed(epochSec: number): string {
  if (!epochSec || epochSec <= 0) return "  —  ";
  const FS = " ";
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - epochSec));
  const pad = (n: number) => String(n).padStart(3, FS);
  if (diff < 60) return pad(diff) + "s";
  if (diff < 3600) return pad(Math.floor(diff / 60)) + "m";
  if (diff < 86400) return pad(Math.floor(diff / 3600)) + "h";
  return pad(Math.floor(diff / 86400)) + "d";
}

function formatDurationSec(sec: number): string {
  if (sec < 1) return "<1s";
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) {
    const rem = Math.round(sec - min * 60);
    return rem >= 5 ? `${min}m ${rem}s` : `${min}m`;
  }
  const hr = Math.floor(sec / 3600);
  const remMin = Math.floor((sec - hr * 3600) / 60);
  if (hr < 24) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
  const day = Math.floor(sec / 86400);
  const remHr = Math.floor((sec - day * 86400) / 3600);
  return remHr > 0 ? `${day}d ${remHr}h` : `${day}d`;
}

function dbRowToSessionRow(r: import("./db").SessionRow): SessionRow {
  return {
    source: r.source,
    mtime_epoch: Math.floor(r.mtime_ns / 1e9),
    active: r.indexed_at && Date.now() / 1000 - r.mtime_ns / 1e9 < 120 ? "*" : " ",
    project: r.project_id || "",
    project_path: r.project_path ?? null,
    session: r.session_id,
    modified: r.ended_at
      ? new Date(r.ended_at).toISOString().slice(0, 16)
      : new Date(r.mtime_ns / 1e6).toISOString().slice(0, 16),
    messages: r.message_count,
    tokens_input: r.input_tokens,
    tokens_output: r.output_tokens,
    tokens_cache_read: r.cache_read_tokens,
    tokens_cache_write: r.cache_write_tokens,
    tokens_total: r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens,
    cost_usd: r.cost_usd,
    title: r.title || (r.first_user_msg ?? "").slice(0, 70),
    subagents: r.subagent_count,
    projects_touched: r.projects_touched,
    first_ts_epoch: r.started_at ? Math.floor(r.started_at / 1000) : 0,
    entrypoint: r.entrypoint ?? "",
    is_automated: r.is_automated,
    last_response_epoch: r.last_assistant_text_at ? Math.floor(r.last_assistant_text_at / 1000) : 0,
  };
}

class SessionsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private rows: SessionRow[] = [];
  private lastError: string | null = null;

  constructor(private readonly store: SessionStore | null) {}

  refresh(): Promise<void> {
    return this.load().then(() => this._onDidChange.fire());
  }

  private async load(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("coderSessions");
    const limit = cfg.get<number>("limit", 100);
    const cacheEnabled = cfg.get<boolean>("cacheEnabled", true);

    // Fast path: SQLite cache.
    if (cacheEnabled && this.store) {
      try {
        const dbRows = this.store.listRecent(limit, true);
        this.rows = dbRows.map(dbRowToSessionRow);
        // Decorate with top_topics in one batched query.
        try {
          const topics = this.store.topTopicsBySession(this.rows.map((r) => r.session), 3);
          for (const r of this.rows) {
            const entry = topics.get(r.session);
            if (entry) {
              r.top_topics = entry.top;
              r.topic_counts = Array.from(entry.counts.entries()).sort((a, b) => b[1] - a[1]);
            }
          }
        } catch {
          // topics are decorative; ignore errors
        }
        // Decorate with starred state.
        try {
          const starred = this.store.starredSessionIds();
          for (const r of this.rows) r.is_starred = starred.has(r.session);
        } catch { /* ignore */ }
        this.lastError = null;
        return;
      } catch (e: any) {
        this.lastError = `SQLite read failed, falling back to script: ${e.message}`;
        // fall through to script path
      }
    }

    // Fallback: run session-center.sh (v0.6.x behavior).
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

  /** Returns the absolute path to the workspace's first folder when the
   * "filter by current workspace" setting is on, else null. */
  private workspaceFilter(): string | null {
    const cfg = vscode.workspace.getConfiguration("coderSessions");
    if (!cfg.get<boolean>("filterByCurrentWorkspace", true)) return null;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return null;
    return path.resolve(folder);
  }

  /** Decode the dash-encoded `~/.claude/projects/-Users-...` directory back
   * to its real source path (`/Users/...`). claude-code stores each session
   * under a folder whose name is the absolute source path with `/`
   * replaced by `-`. This is lossy when the real path itself contains a
   * dash — there's no perfect inverse — but for typical layouts (`/Users/
   * <name>/docs`, `/Users/<name>/projects/<repo>`) it round-trips.
   *
   * Grok rows store the *already decoded* cwd directly (e.g.
   * `/Users/zhirafovod/docs`) — those should pass through unchanged.
   * Heuristic: only apply the dash-decode when the basename starts with
   * a `-`, which is the marker of claude-code's encoding scheme. */
  private static decodeClaudeProjectDir(projectPath: string): string {
    const base = path.basename(projectPath);
    if (!base.startsWith("-")) return projectPath;
    return "/" + base.replace(/^-/, "").replace(/-/g, "/");
  }

  /** Resolve a session row's `project_path` to the absolute cwd it ran in.
   * Source-aware: claude stores `~/.claude/projects/-Users-...` (dash-encoded);
   * grok stores `/Users/...` directly. Re-uses the dash-start heuristic so
   * either form is handled correctly. */
  static sessionCwd(row: SessionRow): string | null {
    if (!row.project_path) return null;
    return path.resolve(SessionsProvider.decodeClaudeProjectDir(row.project_path));
  }

  /** Same-path or under-path test. Treats trailing-slash and case
   * differences (macOS HFS+) leniently. */
  private static sessionInWorkspace(sessionProjectPath: string | null, workspace: string): boolean {
    if (!sessionProjectPath) return false;
    // Claude rows store `~/.claude/projects/-Users-...` and need decoding;
    // Grok rows already store `/Users/...` and pass through.
    const decoded = SessionsProvider.decodeClaudeProjectDir(sessionProjectPath);
    const sp = path.resolve(decoded);
    if (sp === workspace) return true;
    return sp.startsWith(workspace + path.sep);
  }

  /** Run the existing visible-row filtering pipeline (automated + workspace
   * scoping). Centralised so both root and source-bucket expansions share
   * exactly the same predicate. */
  private filterVisible(rows: SessionRow[]): SessionRow[] {
    const cfg = vscode.workspace.getConfiguration("coderSessions");
    const showAutomated = cfg.get<boolean>("showAutomated", false);
    const wsFilter = this.workspaceFilter();
    return rows
      .filter((r) => showAutomated || !r.is_automated)
      .filter((r) => !wsFilter || SessionsProvider.sessionInWorkspace(r.project_path, wsFilter));
  }

  /** Build the per-source children (day buckets + tips). Same shape as the
   * pre-v1.0 root structure. */
  private buildSourceChildren(source: "claude" | "grok"): vscode.TreeItem[] {
    const cfg = vscode.workspace.getConfiguration("coderSessions");
    const showAutomated = cfg.get<boolean>("showAutomated", false);
    const wsFilter = this.workspaceFilter();

    const sourceRows = this.rows.filter((r) => r.source === source);
    const visibleRows = this.filterVisible(sourceRows);
    const automatedCount = sourceRows.length - sourceRows.filter((r) => showAutomated || !r.is_automated).length;
    const out: vscode.TreeItem[] = [];

    if (wsFilter) {
      const hiddenByWs = sourceRows.filter((r) => (showAutomated || !r.is_automated)
        && !SessionsProvider.sessionInWorkspace(r.project_path, wsFilter)).length;
      if (hiddenByWs > 0) {
        const tip = new vscode.TreeItem(
          `Filtered to ${path.basename(wsFilter)} — ${hiddenByWs} sessions from other folders hidden`,
          vscode.TreeItemCollapsibleState.None,
        );
        tip.iconPath = new vscode.ThemeIcon("filter");
        tip.tooltip = new vscode.MarkdownString(
          `Showing only sessions whose project path is **${wsFilter}** (or a subfolder).\n\nToggle **Settings → Coder Sessions: Filter By Current Workspace** to see everything.`,
        );
        tip.contextValue = "workspaceFilterTip";
        tip.command = {
          command: "workbench.action.openSettings",
          title: "Open setting",
          arguments: ["@ext:zhirafovod.coder-sessions filterByCurrentWorkspace"],
        };
        out.push(tip);
      }
    }

    // Starred section (only when there are any). Always rendered first.
    const starredRows = visibleRows.filter((r) => r.is_starred);
    if (starredRows.length > 0) {
      out.push(new StarredBucketItem(starredRows.length));
    }

    const byBucket = new Map<string, SessionRow[]>();
    for (const r of visibleRows) {
      const b = dayBucket(new Date(r.mtime_epoch * 1000));
      const arr = byBucket.get(b) ?? [];
      arr.push(r);
      byBucket.set(b, arr);
    }
    for (const b of BUCKET_ORDER.filter((bb) => byBucket.has(bb))) {
      const arr = byBucket.get(b)!;
      const totals = {
        tokens: arr.reduce((n, r) => n + r.tokens_total, 0),
        cost: arr.reduce((n, r) => n + r.cost_usd, 0),
        subagents: arr.reduce((n, r) => n + (r.subagents || 0), 0),
      };
      // Tag the bucket with the source so child expansion can filter back
      // to the right rows without re-deriving from the label.
      out.push(new BucketItem(b, arr.length, "session", totals, source));
    }
    if (!showAutomated && automatedCount > 0) {
      const tip = new vscode.TreeItem(
        `${automatedCount} automated/cron sessions hidden`,
        vscode.TreeItemCollapsibleState.None,
      );
      tip.iconPath = new vscode.ThemeIcon("eye-closed");
      tip.tooltip = new vscode.MarkdownString(
        "Sessions whose `entrypoint` is not interactive (e.g. `sdk-cli`) are hidden.\n\nToggle **Settings → Coder Sessions: Show Automated** to include them.",
      );
      tip.contextValue = "automatedHidden";
      out.push(tip);
    }
    return out;
  }

  getChildren(el?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
    if (this.lastError && !el) {
      const it = new vscode.TreeItem(`Error: ${this.lastError.split("\n")[0]}`);
      it.tooltip = this.lastError;
      it.iconPath = new vscode.ThemeIcon("error");
      return [it];
    }

    const cfg = vscode.workspace.getConfiguration("coderSessions");
    const showAutomated = cfg.get<boolean>("showAutomated", false);
    const wsFilter = this.workspaceFilter();

    if (!el) {
      // Root: group by source. When only one source has rows we collapse
      // back to the pre-v1.0 flat layout so single-CLI users don't see a
      // redundant top-level wrapper.
      const claudeRows = this.filterVisible(this.rows.filter((r) => r.source === "claude"));
      const grokRows = this.filterVisible(this.rows.filter((r) => r.source === "grok"));
      const sourcesPresent: Array<"claude" | "grok"> = [];
      if (claudeRows.length > 0) sourcesPresent.push("claude");
      if (grokRows.length > 0) sourcesPresent.push("grok");

      if (sourcesPresent.length >= 2) {
        return [
          new SourceBucketItem("claude", claudeRows.length),
          new SourceBucketItem("grok", grokRows.length),
        ];
      }

      // Single-source fallback: render the existing flat layout, scoped to
      // whichever source has rows (so the "no sessions yet" empty state for
      // a missing source still works).
      const onlySource: "claude" | "grok" = sourcesPresent[0] ?? "claude";
      return this.buildSourceChildren(onlySource);
    }

    if (el instanceof SourceBucketItem) {
      return this.buildSourceChildren(el.source);
    }

    if (el instanceof StarredBucketItem) {
      const rows = this.filterVisible(this.rows.filter((r) => r.is_starred))
        .sort((a, b) => b.mtime_epoch - a.mtime_epoch);
      return rows.map((r) => new SessionItem(r));
    }
    if (el instanceof BucketItem && el.kind === "session") {
      const rows = this.filterVisible(this.rows)
        .filter((r) => !el.source || r.source === el.source)
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

class StarredBucketItem extends vscode.TreeItem {
  constructor(public readonly count: number) {
    super(`★ Starred — ${count} session${count === 1 ? "" : "s"}`, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon("star-full");
    this.contextValue = "bucket-starred";
  }
}

class SourceBucketItem extends vscode.TreeItem {
  constructor(
    public readonly source: "claude" | "grok",
    public readonly count: number,
  ) {
    const label = source === "claude"
      ? `Claude Code — ${count} session${count === 1 ? "" : "s"}`
      : `Grok Build — ${count} session${count === 1 ? "" : "s"}`;
    // Both sources start expanded so the user sees activity from both
    // immediately. Single-source environments collapse to the same UX as
    // before because we skip emitting source buckets when only one source
    // is present.
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon(source === "claude" ? "comment-discussion" : "rocket");
    this.contextValue = `bucket-source-${source}`;
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
    /** Optional source filter — set when the bucket sits under a
     * SourceBucketItem so child expansion restricts to that source. Undefined
     * for kb/project buckets which are claude-only today. */
    public readonly source?: "claude" | "grok",
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
    // Lead with fixed-width "time since the last assistant text" so the column
    // lines up across rows. Falls back to mtime for rows that pre-date the v5
    // migration (which adds `last_assistant_text_at`).
    const responseEpoch = row.last_response_epoch && row.last_response_epoch > 0
      ? row.last_response_epoch
      : row.mtime_epoch;
    const ago = formatAgoFixed(responseEpoch);
    const titleText = row.title || row.session;
    super(
      `${ago}  ·  ${titleText}`,
      // Always collapse by default — the user opens children on demand instead
      // of every active session auto-expanding.
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    const cost = row.cost_usd.toFixed(2);
    const durSec =
      row.first_ts_epoch && row.first_ts_epoch > 0
        ? Math.max(0, row.mtime_epoch - row.first_ts_epoch)
        : 0;
    const durStr = durSec > 0 ? formatDurationSec(durSec) : null;
    // Description: msgs · cost · duration · topics. The leading "ago" lives in
    // the label (so it lines up); we drop it from the description here.
    const parts = [`💬${row.messages.toLocaleString()}`, `$${cost}`];
    if (durStr) parts.push(`⏱${durStr}`);
    if (row.top_topics && row.top_topics.length > 0) {
      parts.push(`🏷 ${row.top_topics.join(", ")}`);
    }
    this.description = parts.join(" · ");
    const topicLines =
      row.topic_counts && row.topic_counts.length > 0
        ? [
            "",
            "**Topics:**",
            ...row.topic_counts.slice(0, 12).map(([t, n]) => `- \`${t}\` _(${n})_`),
          ]
        : [];
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
        ...topicLines,
        row.active === "*" ? `\n_Active (mtime < 2 min)_` : "",
      ].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon(
      row.is_starred
        ? "star-full"
        : row.is_automated
          ? "watch"
          : row.active === "*"
            ? "pulse"
            : "comment-discussion",
    );
    const base = row.is_automated ? "sessionAutomated" : "session";
    this.contextValue = row.is_starred ? `${base}-starred` : base;
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
    const ago = formatRelative(r.mtime_epoch);
    const durSec =
      r.first_ts_epoch && r.first_ts_epoch > 0
        ? Math.max(0, r.mtime_epoch - r.first_ts_epoch)
        : 0;
    const durStr = durSec > 0 ? ` · ⏱${formatDurationSec(durSec)}` : "";
    const sub = r.subagents > 0 ? ` · 🪄${r.subagents}` : "";
    const stats = new vscode.TreeItem(
      `💬 ${r.messages.toLocaleString()} msgs · $${cost} · ${formatTokens(r.tokens_total)} tok${sub}${durStr} · ${ago}`,
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

    // "View conversation" — open the rich timeline webview.
    const viewItem = new vscode.TreeItem("🔍 View conversation");
    viewItem.iconPath = new vscode.ThemeIcon("preview");
    viewItem.tooltip =
      "Open a per-turn timeline: user prompt, assistant response, every tool call with input/output, durations, and subagent details.";
    viewItem.command = {
      command: "coderSessions.viewConversation",
      title: "View conversation",
      arguments: [this],
    };
    out.push(viewItem);

    // "Resume" — dispatch decided at click-time based on
    // `coderSessions.resumeBackend` (code-build vs native per-source) and
    // the source-specific install state. Label hints at the preferred
    // target so the user knows what to expect; the actual handler picks.
    const resumePref = vscode.workspace
      .getConfiguration("coderSessions")
      .get<"code-build" | "native">("resumeBackend", "code-build");
    const codeBuildInstalled =
      vscode.extensions.getExtension("zhirafovod.code-build-vscode") != null;
    const resumeLabel =
      resumePref === "code-build" && codeBuildInstalled
        ? "▶ Open in Code Build"
        : r.source === "grok"
          ? "▶ Resume in Grok"
          : "▶ Resume in Claude";
    const resumeItem = new vscode.TreeItem(resumeLabel);
    resumeItem.iconPath = new vscode.ThemeIcon("play");
    resumeItem.contextValue = "sessionResume";
    resumeItem.command = {
      command: "coderSessions.resume",
      title: "Resume",
      arguments: [r],
    };
    out.push(resumeItem);

    // "Open raw JSONL" as a quick child too.
    const txItem = new vscode.TreeItem("📜 Open raw JSONL");
    txItem.iconPath = new vscode.ThemeIcon("file-text");
    txItem.command = {
      command: "coderSessions.openTranscript",
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
      command: this.repoIsKB() ? "coderKbChanges.openFile" : "coderProjectsActivity.openFile",
      title: "Open file",
      arguments: [this.change],
    };
  }

  private repoIsKB(): boolean {
    return this.change.abs.startsWith(resolveKbRepoPath());
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
    const cfg = vscode.workspace.getConfiguration("coderKbChanges");
    this.repoPath = resolveKbRepoPath();
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
    const cfg = vscode.workspace.getConfiguration("coderProjectsActivity");
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
// Tasks provider — crontab + active Claude sub-agents
// --------------------------------------------------------------------------- //

interface CrontabRow {
  raw: string;
  schedule: string;
  command: string;
}

interface ActiveSubagentRow {
  sessionId: string;
  title: string;
  project: string | null;
  subagents: number;
  detail: string;
}

/** Best-effort parse of a single crontab line. Returns null for blank/comment lines. */
function parseCrontabLine(raw: string): CrontabRow | null {
  const line = raw.trim();
  if (line.length === 0 || line.startsWith("#")) return null;
  // Either an @-shortcut (@daily, @reboot, @hourly, ...) followed by a command,
  // or a 5-field schedule. Don't try to validate — just split off the prefix.
  if (line.startsWith("@")) {
    const m = line.match(/^(@\S+)\s+(.+)$/);
    if (!m) return { raw, schedule: line, command: "" };
    return { raw, schedule: m[1], command: m[2] };
  }
  const parts = line.split(/\s+/);
  if (parts.length < 6) return { raw, schedule: line, command: "" };
  return { raw, schedule: parts.slice(0, 5).join(" "), command: parts.slice(5).join(" ") };
}

class TasksProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private crontab: CrontabRow[] = [];
  private crontabAvailable = true;
  private crontabError = "";
  private subagents: ActiveSubagentRow[] = [];
  private showCrontab = true;

  constructor(private readonly store: SessionStore | null) {}

  async refresh(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("coderTasks");
    this.showCrontab = cfg.get<boolean>("showCrontab", true);
    const lookback = cfg.get<number>("subagentLookbackMin", 5);

    // --- Crontab ---
    if (this.showCrontab) {
      const { stdout, stderr, code } = await exec("crontab", ["-l"]);
      if (code === 0) {
        this.crontab = stdout.split(/\r?\n/).map(parseCrontabLine).filter((r): r is CrontabRow => r !== null);
        this.crontabAvailable = true;
        this.crontabError = "";
      } else if (/no crontab for/i.test(stderr)) {
        this.crontab = [];
        this.crontabAvailable = true;
        this.crontabError = "";
      } else {
        this.crontab = [];
        this.crontabAvailable = false;
        this.crontabError = stderr.trim() || `crontab exited with code ${code}`;
      }
    } else {
      this.crontab = [];
    }

    // --- Active Claude sub-agents (derived from live-monitor data) ---
    if (this.store && lookback > 0) {
      try {
        const up = buildUpdate(this.store);
        this.subagents = up.cards
          .filter((c) => c.subagents > 0)
          .map((c) => ({
            sessionId: c.session_id,
            title: c.title,
            project: c.project,
            subagents: c.subagents,
            detail:
              c.now.kind === "in_tool"
                ? `${c.now.detail} · ${c.now.ageSec}s`
                : c.now.kind === "responding"
                  ? `responding · ${c.now.ageSec}s`
                  : `idle`,
          }));
      } catch {
        this.subagents = [];
      }
    } else {
      this.subagents = [];
    }

    this._onDidChange.fire();
  }

  getTreeItem(el: vscode.TreeItem): vscode.TreeItem {
    return el;
  }

  getChildren(el?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
    if (!el) {
      const out: vscode.TreeItem[] = [];
      out.push(new TaskSectionItem("subagents", `Active sub-agents (${this.subagents.length})`));
      out.push(new TaskSectionItem("routines", "Scheduled routines"));
      if (this.showCrontab) {
        out.push(new TaskSectionItem("crontab", `Crontab (${this.crontab.length})`));
      }
      return out;
    }
    if (el instanceof TaskSectionItem) {
      if (el.section === "subagents") {
        if (this.subagents.length === 0) {
          return [makeInfoItem("No sessions with active sub-agents right now.")];
        }
        return this.subagents.map((s) => new ActiveSubagentItem(s));
      }
      if (el.section === "routines") {
        return [
          makeInfoItem("Scheduled routines run remotely — manage them via /schedule in Claude Code."),
        ];
      }
      if (el.section === "crontab") {
        if (!this.crontabAvailable) {
          return [makeInfoItem(`crontab unavailable: ${this.crontabError}`)];
        }
        if (this.crontab.length === 0) {
          return [makeInfoItem("(no crontab entries — click the pencil to add one)")];
        }
        return this.crontab.map((r) => new CrontabItem(r));
      }
    }
    return [];
  }
}

class TaskSectionItem extends vscode.TreeItem {
  constructor(public readonly section: "subagents" | "routines" | "crontab", label: string) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon(
      section === "subagents" ? "rocket" : section === "routines" ? "clock" : "calendar",
    );
    this.contextValue = `taskSection:${section}`;
  }
}

class ActiveSubagentItem extends vscode.TreeItem {
  constructor(public readonly row: ActiveSubagentRow) {
    super(row.title, vscode.TreeItemCollapsibleState.None);
    this.description = `${row.subagents} agent${row.subagents === 1 ? "" : "s"} · ${row.detail}${row.project ? " · " + row.project : ""}`;
    this.tooltip = new vscode.MarkdownString(
      `**${row.title}**\n\n${row.subagents} active sub-agent(s)\n\n${row.detail}${row.project ? `\n\nProject: \`${row.project}\`` : ""}`,
    );
    this.iconPath = new vscode.ThemeIcon("pulse");
    this.contextValue = "activeSubagent";
    this.command = {
      command: "coderTasks.openSession",
      title: "Open session",
      arguments: [row.sessionId],
    };
  }
}

class CrontabItem extends vscode.TreeItem {
  constructor(public readonly row: CrontabRow) {
    super(row.schedule, vscode.TreeItemCollapsibleState.None);
    this.description = row.command;
    this.tooltip = new vscode.MarkdownString("```\n" + row.raw + "\n```");
    this.iconPath = new vscode.ThemeIcon("calendar");
    this.contextValue = "crontabRow";
    this.command = {
      command: "coderTasks.editCrontab",
      title: "Edit crontab",
      arguments: [],
    };
  }
}

function makeInfoItem(text: string): vscode.TreeItem {
  const t = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
  t.iconPath = new vscode.ThemeIcon("info");
  t.contextValue = "taskInfo";
  return t;
}

/** Edit-flow for the user's crontab. Reads `crontab -l`, opens it in a temp
 * VS Code editor, and installs via `crontab <file>` on save. */
async function openCrontabEditor(ctx: vscode.ExtensionContext, onInstalled: () => void): Promise<void> {
  const { stdout, stderr, code } = await exec("crontab", ["-l"]);
  const content = code === 0 ? stdout : /no crontab for/i.test(stderr) ? "" : "";
  const tmpDir = path.join(os.tmpdir(), "coder-sessions");
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
  const tmpFile = path.join(tmpDir, "crontab.cron");
  fs.writeFileSync(tmpFile, content, "utf-8");
  const doc = await vscode.workspace.openTextDocument(tmpFile);
  await vscode.languages.setTextDocumentLanguage(doc, "shellscript");
  await vscode.window.showTextDocument(doc, { preview: false });

  // Install when this specific file is saved.
  const sub = vscode.workspace.onDidSaveTextDocument(async (saved) => {
    if (saved.uri.fsPath !== tmpFile) return;
    const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      execFile("crontab", [tmpFile], (err, so, se) => {
        const c = err ? (err as any).code ?? 1 : 0;
        resolve({ stdout: String(so), stderr: String(se), code: c });
      });
    });
    if (result.code === 0) {
      vscode.window.setStatusBarMessage("✓ crontab installed", 4000);
      onInstalled();
    } else {
      vscode.window.showErrorMessage(`crontab install failed: ${result.stderr.trim() || result.code}`);
    }
  });
  ctx.subscriptions.push(sub);
}

// --------------------------------------------------------------------------- //
// Activation
// --------------------------------------------------------------------------- //

export function activate(ctx: vscode.ExtensionContext) {
  // Output channel for diagnostics — visible under View → Output → "Coder Sessions".
  const log = vscode.window.createOutputChannel("Coder Sessions");
  ctx.subscriptions.push(log);
  log.appendLine(`[activate] coder-sessions starting (VS Code ${vscode.version})`);

  // Open the SQLite cache. If the user has disabled it, leave store null
  // and the providers will fall back to running session-center.sh.
  let store: SessionStore | null = null;
  try {
    const cacheEnabled = vscode.workspace
      .getConfiguration("coderSessions")
      .get<boolean>("cacheEnabled", true);
    if (cacheEnabled) {
      store = SessionStore.open(ctx.globalStorageUri.fsPath);
      log.appendLine(`[activate] SQLite cache opened at ${ctx.globalStorageUri.fsPath}`);

      // Migration toast — fires once, the first time we open a DB copied
      // from the pre-v1.0 `zhirafovod.claude-sessions` extension dir. We
      // don't gate on globalState because the file-existence check inside
      // SessionStore.open is already idempotent.
      const report = SessionStore.migrationReport;
      if (report?.migrated) {
        const msg = `Imported ${report.sessions} sessions and ${report.classifiedTurns} topic classifications from your previous Claude Sessions install.`;
        log.appendLine(`[activate] ${msg}`);
        vscode.window.showInformationMessage(msg);
      }
    } else {
      log.appendLine(`[activate] cacheEnabled = false; using shell-script fallback`);
    }
  } catch (e: any) {
    const msg = `SQLite cache failed to open: ${e?.message || e}`;
    log.appendLine(`[activate] ERROR ${msg}`);
    log.appendLine(String(e?.stack || ""));
    vscode.window
      .showWarningMessage(
        `coder-sessions: ${msg}. Falling back to shell-script mode.`,
        "Show log",
      )
      .then((sel) => {
        if (sel === "Show log") log.show(true);
      });
    store = null;
  }

  const sessions = new SessionsProvider(store);
  const kb = new KbChangesProvider();
  const projects = new ProjectsActivityProvider();
  const tasks = new TasksProvider(store);

  // Keep track of open conversation viewers so the classifyTopics command can
  // refresh them after upserting new topics.
  const openViewerPanels = new Map<string, vscode.WebviewPanel>();

  sessions.refresh();
  kb.refresh();
  projects.refresh();
  tasks.refresh();

  // Initial background sync (incremental: mtime+size diff). First paint may
  // come from yesterday's cache while a fresh sync runs in parallel.
  if (store) {
    const s = store;
    setTimeout(() => {
      try {
        const stats = syncToStore(s);
        console.log(`[coder-sessions] claude sync: ${JSON.stringify(stats)}`);
      } catch (e: any) {
        console.error("[coder-sessions] claude sync failed:", e);
      }
      if (vscode.workspace.getConfiguration("coderSessions").get<boolean>("grok.enabled", true)) {
        try {
          const grokStats = syncGrokToStore(s);
          console.log(`[coder-sessions] grok sync: ${JSON.stringify(grokStats)}`);
        } catch (e: any) {
          console.error("[coder-sessions] grok sync failed:", e);
        }
      }
      // Refresh providers when both syncs finish so they see new rows.
      sessions.refresh();
    }, 200);
  }

  ctx.subscriptions.push({ dispose: () => store?.close() });

  // Always-visible live status bar
  let costBudgetTick: (() => void) | null = null;
  if (store) {
    createLiveStatusBar(ctx, store);
    costBudgetTick = createCostBudgetTile(ctx, store).tick;
  }

  // Background topic classifier — picks up unclassified turns and works
  // through them via Ollama (opt-in via settings for claude-p).
  let bgClassifier: BackgroundClassifier | null = null;
  // Most-recently-opened agent graph webview; cleared when the panel is
  // disposed. The 2D/3D toggle keybinding posts a message at this panel.
  let currentAgentGraphPanel: vscode.WebviewPanel | null = null;
  if (store) {
    bgClassifier = new BackgroundClassifier(ctx, store);
    bgClassifier.start();
  }

  // KB view uses createTreeView so we can set its title dynamically based on
  // the configured repoPath (e.g. "docs changes" instead of "KB changes").
  const kbView = vscode.window.createTreeView("coderKbChanges", {
    treeDataProvider: kb,
    showCollapseAll: false,
  });
  const refreshKbTitle = () => {
    const base = path.basename(resolveKbRepoPath());
    kbView.title = base ? `${base} changes` : "KB changes";
  };
  refreshKbTitle();
  ctx.subscriptions.push(kbView);

  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider("coderSessions", sessions),
    vscode.window.registerTreeDataProvider("coderProjectsActivity", projects),
    vscode.window.registerTreeDataProvider("coderTasks", tasks),

    vscode.commands.registerCommand("coderSessions.classifyTogglePause", () => {
      if (!bgClassifier) return;
      bgClassifier.togglePause();
      vscode.window.setStatusBarMessage(
        bgClassifier.isPaused() ? "Auto-classify paused" : "Auto-classify resumed",
        2500,
      );
    }),
    vscode.commands.registerCommand("coderSessions.classifyRetryFailed", () => {
      if (!bgClassifier) return;
      const added = bgClassifier.retryFailed();
      vscode.window.setStatusBarMessage(
        added > 0 ? `Re-queued ${added} failed session(s)` : "No failed sessions to retry",
        2500,
      );
    }),
    vscode.commands.registerCommand("coderSessions.classifyControls", async () => {
      if (!bgClassifier) return;
      const paused = bgClassifier.isPaused();
      const failed = bgClassifier.failedCount();
      type Item = vscode.QuickPickItem & { id: "pause" | "retry" | "settings" };
      const items: Item[] = [];
      items.push({
        id: "pause",
        label: paused ? "$(play) Resume auto-classify" : "$(debug-pause) Pause auto-classify",
        description: paused ? "Queue keeps growing while paused" : "Pause the worker; discovery keeps running",
      });
      if (failed > 0) {
        items.push({
          id: "retry",
          label: `$(refresh) Retry ${failed} failed session${failed === 1 ? "" : "s"}`,
          description: "Re-queue every session that errored this run",
        });
      }
      items.push({
        id: "settings",
        label: "$(settings-gear) Open auto-classify settings",
        description: "coderSessions.classify.*",
      });
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: "Background topic classification",
      });
      if (!pick) return;
      if (pick.id === "pause") vscode.commands.executeCommand("coderSessions.classifyTogglePause");
      else if (pick.id === "retry") vscode.commands.executeCommand("coderSessions.classifyRetryFailed");
      else if (pick.id === "settings")
        vscode.commands.executeCommand("workbench.action.openSettings", "@ext:zhirafovod.coder-sessions classify");
    }),

    vscode.commands.registerCommand("coderSessions.search", async (initialQ?: string) => {
      if (!store) {
        vscode.window.showWarningMessage(
          "Search requires the SQLite cache. Enable coderSessions.cacheEnabled.",
        );
        return;
      }
      const s = store;
      openSearchView(ctx, s, async (sessionId, title) => {
        const jsonl = await locateSessionJsonl(sessionId);
        if (!jsonl) {
          vscode.window.showWarningMessage(`Transcript not found for ${sessionId}`);
          return;
        }
        const panel = openConversationViewer(ctx, jsonl, sessionId, title, s);
        openViewerPanels.set(sessionId, panel);
        panel.onDidDispose(() => {
          if (openViewerPanels.get(sessionId) === panel) openViewerPanels.delete(sessionId);
        });
      }, typeof initialQ === "string" ? initialQ : "");
    }),

    vscode.commands.registerCommand("coderTasks.refresh", () => tasks.refresh()),
    vscode.commands.registerCommand("coderTasks.editCrontab", () =>
      openCrontabEditor(ctx, () => tasks.refresh()),
    ),
    vscode.commands.registerCommand("coderTasks.openSession", async (sessionId: string) => {
      if (!store) return;
      const row = store.getById(sessionId);
      if (!row) {
        vscode.window.showWarningMessage(`Session ${sessionId.slice(0, 8)} not found.`);
        return;
      }
      try {
        await openTrajectoryView(ctx, store, sessionId, row.title || sessionId.slice(0, 8));
      } catch (e: any) {
        vscode.window.showErrorMessage(`Trajectory failed: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("coderSessions.refresh", async () => {
      // Incremental sync from disk + force re-parse the top-N most-recent
      // sessions. The forced top-N catches on-disk edits that don't reliably
      // bump mtime (most notably claude-code session renames, which sometimes
      // overwrite the JSONL in place at the same size).
      if (store) {
        const cfg = vscode.workspace.getConfiguration("coderSessions");
        const recent = Math.max(0, cfg.get<number>("refresh.forceRecent", 100));
        try {
          syncToStore(store, recent > 0 ? { forceRecentN: recent } : {});
        } catch (e) {
          console.error("[coder-sessions] refresh sync failed", e);
        }
        if (cfg.get<boolean>("grok.enabled", true)) {
          try {
            syncGrokToStore(store, recent > 0 ? { forceRecentN: recent } : {});
          } catch (e) {
            console.error("[coder-sessions] refresh grok sync failed", e);
          }
        }
      }
      await sessions.refresh();
    }),
    vscode.commands.registerCommand("coderSessions.refreshFull", async () => {
      // Force a full re-parse of every JSONL on disk. Use this if the
      // incremental sync looks stuck (e.g. titles still stale after a
      // claude rename) — slow on large catalogs.
      if (!store) {
        vscode.window.showWarningMessage("Full rescan requires the SQLite cache.");
        return;
      }
      const s = store;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Coder sessions: full rescan…" },
        async (progress) => {
          const stats = syncToStore(s, {
            force: true,
            onProgress: (done, total) => progress.report({ message: `claude ${done}/${total}` }),
          });
          let grokParsed = 0;
          if (vscode.workspace.getConfiguration("coderSessions").get<boolean>("grok.enabled", true)) {
            const grokStats = syncGrokToStore(s, {
              force: true,
              onProgress: (done, total) => progress.report({ message: `grok ${done}/${total}` }),
            });
            grokParsed = grokStats.parsed;
          }
          vscode.window.setStatusBarMessage(
            `Rescanned ${stats.parsed + grokParsed} session(s) in ${Math.round(stats.elapsed_ms / 1000)}s`,
            4000,
          );
        },
      );
      await sessions.refresh();
    }),
    vscode.commands.registerCommand("coderSessions.openInsights", () => openInsightsView(ctx, store)),
    vscode.commands.registerCommand("coderSessions.openLiveMonitor", () => {
      if (!store) {
        vscode.window.showWarningMessage("Live monitor requires the SQLite cache. Enable coderSessions.cacheEnabled.");
        return;
      }
      openLiveMonitor(ctx, store);
    }),
    vscode.commands.registerCommand("coderKbChanges.refresh", () => kb.refresh()),
    vscode.commands.registerCommand("coderProjectsActivity.refresh", () => projects.refresh()),

    vscode.commands.registerCommand("coderSessions.resume", async (arg: SessionRow | SessionItem | undefined) => {
      // The inline action passes the TreeItem; the per-child "Resume" child
      // passes a SessionRow directly. Accept either.
      const row: SessionRow | null =
        arg && typeof arg === "object" && "row" in arg
          ? (arg as SessionItem).row
          : (arg as SessionRow) ?? null;
      if (!row || !row.session) {
        vscode.window.showWarningMessage("No session to resume.");
        return;
      }

      // Cwd resolution is source-aware: claude stores a dash-encoded JSONL
      // container path, grok stores the absolute cwd. The terminal-fallback
      // branches cd into this when spawning the CLI.
      const cwd = SessionsProvider.sessionCwd(row) ?? undefined;
      const cfg = vscode.workspace.getConfiguration("coderSessions");
      const preferredBackend = cfg.get<"code-build" | "native">("resumeBackend", "code-build");

      // Preferred backend = code-build: open zhirafovod.code-build-vscode's
      // chat UI. The newer `codeBuild.openExternalSession` command (v0.0.2+)
      // imports the upstream session — for claude that's a true `--resume`,
      // for grok a fresh chat in the same cwd. Older code-build builds only
      // offer `codeBuild.newConversation` (a blank chat); we fall through to
      // that, and the user can still access the original transcript via
      // "View conversation" on the row.
      if (preferredBackend === "code-build") {
        const codeBuildExt = vscode.extensions.getExtension("zhirafovod.code-build-vscode");
        if (codeBuildExt) {
          try {
            if (!codeBuildExt.isActive) await codeBuildExt.activate();
            const allCommands = await vscode.commands.getCommands(true);
            if (allCommands.includes("codeBuild.openExternalSession") && cwd) {
              await vscode.commands.executeCommand("codeBuild.openExternalSession", {
                source: row.source,
                sessionId: row.session,
                cwd,
                title: row.title,
              });
              vscode.window.setStatusBarMessage(
                row.source === "claude"
                  ? `Code Build is resuming claude session ${row.session.slice(0, 8)}…`
                  : `Code Build opened a Grok session in ${path.basename(cwd)} (grok has no external resume yet — pick from clock-icon if needed).`,
                8000,
              );
            } else {
              await vscode.commands.executeCommand("codeBuild.newConversation");
              vscode.window.setStatusBarMessage(
                `Code Build opened (new conversation; upgrade code-build for true session import). Original ${row.source} session ${row.session.slice(0, 8)} stays in "View conversation".`,
                8000,
              );
            }
            return;
          } catch {
            // fall through to native dispatch below
          }
        }
        // code-build not installed → continue with native dispatch
      }

      // Native per-source dispatch. Each branch tries the corresponding
      // sidebar extension first (claude-vscode does a TRUE resume by id;
      // grok-build-vscode opens its panel and the user picks from history),
      // falling back to spawning the CLI in a terminal cd'd to the cwd.
      if (row.source === "grok") {
        const grokExt = vscode.extensions.getExtension("pawelhuryn.grok-vscode-phuryn");
        if (grokExt) {
          try {
            if (!grokExt.isActive) await grokExt.activate();
            await vscode.commands.executeCommand("grok.open");
            vscode.window.setStatusBarMessage(
              `Opened Grok Build — pick session ${row.session.slice(0, 8)} from the clock-icon history.`,
              6000,
            );
            return;
          } catch {
            // fall through to terminal
          }
        }
        const term = vscode.window.createTerminal({
          name: `grok:${row.session.slice(0, 8)}`,
          cwd,
        });
        term.show();
        term.sendText("grok");
        vscode.window.setStatusBarMessage(
          `Launched grok CLI — pick session ${row.session.slice(0, 8)} from the history.`,
          6000,
        );
        return;
      }

      // Claude branch — anthropic.claude-code truly resumes by session id.
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
      // Terminal fallback: `claude --resume <id>` in the session's cwd.
      const term = vscode.window.createTerminal({
        name: `claude:${row.session.slice(0, 8)}`,
        cwd,
      });
      term.show();
      term.sendText(`claude --resume ${row.session}`);
    }),

    vscode.commands.registerCommand("coderSessions.openTranscript", async (item: SessionItem) => {
      const jsonl = await locateSessionJsonl(item.row.session);
      if (!jsonl) {
        vscode.window.showWarningMessage(`Transcript not found for session ${item.row.session}`);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(jsonl);
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand("coderSessions.viewConversation", async (item: SessionItem) => {
      const jsonl = await locateSessionJsonl(item.row.session);
      if (!jsonl) {
        vscode.window.showWarningMessage(`Transcript not found for session ${item.row.session}`);
        return;
      }
      const panel = openConversationViewer(ctx, jsonl, item.row.session, item.row.title, store);
      openViewerPanels.set(item.row.session, panel);
      panel.onDidDispose(() => {
        if (openViewerPanels.get(item.row.session) === panel) {
          openViewerPanels.delete(item.row.session);
        }
      });
    }),

    vscode.commands.registerCommand(
      "coderSessions.classifyTopics",
      async (sessionId: string, jsonlPath: string, title: string) => {
        if (!store) {
          vscode.window.showWarningMessage(
            "Topic classification requires the SQLite cache. Enable coderSessions.cacheEnabled.",
          );
          return;
        }
        const cfg = vscode.workspace.getConfiguration("coderSessions");
        const backend = cfg.get<"ollama" | "claude-p">("classify.backend", "ollama");
        const model = cfg.get<string>("classify.model", "llama3.2:3b");
        const batchSize = cfg.get<number>("classify.batchSize", 20);
        const claudeBin = cfg.get<string>("classify.claudeBin", "") || undefined;
        const ollamaUrl = cfg.get<string>("embedding.ollamaUrl", "http://127.0.0.1:11434");

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Classifying topics (${backend}/${model})…`,
            cancellable: false,
          },
          async (progress) => {
            try {
              const result = await classifySession(store!, sessionId, {
                backend,
                model,
                batchSize,
                claudeBin,
                ollamaUrl,
                onProgress: (done, total) =>
                  progress.report({ message: `${done}/${total} turns` }),
              });
              const msg = `Classified ${result.classified} turns in ${result.batches} batches (in ${result.inputTokens} / out ${result.outputTokens} tokens)${
                result.errors.length ? `; ${result.errors.length} warnings` : ""
              }`;
              if (result.errors.length > 0) {
                vscode.window.showWarningMessage(
                  msg + ". First: " + result.errors[0].slice(0, 200),
                );
              } else {
                vscode.window.showInformationMessage(msg);
              }
            } catch (e: any) {
              vscode.window.showErrorMessage(`Classify failed: ${e.message}`);
              return;
            }
            // Re-render the viewer if it's open. Otherwise open it fresh.
            const existing = openViewerPanels.get(sessionId);
            if (existing && (existing as any).__refresh) {
              (existing as any).__refresh();
              existing.reveal();
            } else {
              const panel = openConversationViewer(ctx, jsonlPath, sessionId, title, store);
              openViewerPanels.set(sessionId, panel);
              panel.onDidDispose(() => {
                if (openViewerPanels.get(sessionId) === panel) {
                  openViewerPanels.delete(sessionId);
                }
              });
            }
          },
        );
      },
    ),

    vscode.commands.registerCommand(
      "coderSessions.showTrajectory",
      async (sessionId: string, title: string) => {
        if (!store) {
          vscode.window.showWarningMessage(
            "Trajectory view requires the SQLite cache. Enable coderSessions.cacheEnabled.",
          );
          return;
        }
        try {
          await openTrajectoryView(ctx, store, sessionId, title || "");
        } catch (e: any) {
          vscode.window.showErrorMessage(`Trajectory failed: ${e.message}`);
        }
      },
    ),

    vscode.commands.registerCommand("coderSessions.reembedSessions", async () => {
      if (!store) {
        vscode.window.showWarningMessage("Re-embed requires the SQLite cache.");
        return;
      }
      const cfg = vscode.workspace.getConfiguration("coderSessions");
      const wantedOllama = cfg.get<string>("embedding.ollamaModel", "nomic-embed-text");
      const choice = await vscode.window.showInformationMessage(
        `Drop cached embeddings and re-embed on next graph open?\nCurrent model: ollama/${wantedOllama}`,
        { modal: false },
        "Drop all",
        "Cancel",
      );
      if (choice !== "Drop all") return;
      const keepModel = `ollama/${wantedOllama}`;
      const dropped = store.deleteEmbeddingsExceptModel(keepModel) + store.deleteTurnEmbeddingsExceptModel(keepModel);
      vscode.window.showInformationMessage(
        `Dropped ${dropped} stale embedding row(s). Open the agent graph to re-embed.`,
      );
    }),

    vscode.commands.registerCommand("coderSessions.showAgentGraph", async () => {
      if (!store) {
        vscode.window.showWarningMessage(
          "Agent graph requires the SQLite cache. Enable coderSessions.cacheEnabled.",
        );
        return;
      }
      const panel = await openAgentGraph(ctx, store, async (sessionId) => {
        const row = store!.getById(sessionId);
        const title = row?.title || sessionId.slice(0, 8);
        try {
          await openTrajectoryView(ctx, store!, sessionId, title);
        } catch (e: any) {
          vscode.window.showErrorMessage(`Trajectory failed: ${e.message}`);
        }
      });
      currentAgentGraphPanel = panel;
      panel.onDidDispose(() => {
        if (currentAgentGraphPanel === panel) currentAgentGraphPanel = null;
      });
    }),
    vscode.commands.registerCommand("coderSessions.agentGraphToggleMode", () => {
      if (!currentAgentGraphPanel) {
        vscode.window.setStatusBarMessage("Open the agent graph first (Cmd+Alt+G)", 2500);
        return;
      }
      currentAgentGraphPanel.reveal();
      currentAgentGraphPanel.webview.postMessage({ command: "toggleMode" });
    }),
    vscode.commands.registerCommand("coderSessions.starSession", async (arg: SessionRow | SessionItem | undefined) => {
      if (!store) return;
      const row = arg && typeof arg === "object" && "row" in arg ? (arg as SessionItem).row : (arg as SessionRow | undefined);
      if (!row?.session) return;
      store.starSession(row.session);
      sessions.refresh();
    }),
    vscode.commands.registerCommand("coderSessions.unstarSession", async (arg: SessionRow | SessionItem | undefined) => {
      if (!store) return;
      const row = arg && typeof arg === "object" && "row" in arg ? (arg as SessionItem).row : (arg as SessionRow | undefined);
      if (!row?.session) return;
      store.unstarSession(row.session);
      sessions.refresh();
    }),
    vscode.commands.registerCommand("coderSessions.revealProjectFolder", async (projectPath: string) => {
      if (!projectPath || typeof projectPath !== "string") return;
      const expanded = expandHome(projectPath);
      try {
        const uri = vscode.Uri.file(expanded);
        // `revealFileInOS` opens Finder/Explorer pointing at the folder.
        await vscode.commands.executeCommand("revealFileInOS", uri);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Cannot reveal ${expanded}: ${e.message}`);
      }
    }),
    vscode.commands.registerCommand("coderSessions.focusActivityView", async () => {
      // VS Code provides workbench.view.extension.<containerId> to focus a
      // view container. Wrapping it makes the keybinding discoverable in the
      // palette under the Claude namespace.
      try {
        await vscode.commands.executeCommand("workbench.view.extension.coder-activity");
      } catch (e: any) {
        vscode.window.showErrorMessage(`Cannot focus Coder Activity: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("coderKbChanges.openFile", (c: FileChange) => openChangedFile(c)),
    vscode.commands.registerCommand("coderProjectsActivity.openFile", (c: FileChange) => openChangedFile(c)),
    vscode.commands.registerCommand("coderKbChanges.diff", (item: FileChangeItem) => showDiff(item.change)),
    vscode.commands.registerCommand("coderProjectsActivity.diff", (item: FileChangeItem) => showDiff(item.change)),
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
    refreshTimer = setTimeout(() => {
      // Re-sync only the changed JSONLs into SQLite, then refresh the view.
      if (store) {
        try {
          syncToStore(store);
          if (vscode.workspace.getConfiguration("coderSessions").get<boolean>("grok.enabled", true)) {
            syncGrokToStore(store);
          }
        } catch (e: any) {
          console.error("[coder-sessions] sync failed in watcher:", e);
        }
      }
      sessions.refresh();
    }, 1500);
  };
  watcher.onDidChange(queueRefresh);
  watcher.onDidCreate(queueRefresh);
  ctx.subscriptions.push(watcher);

  // Re-render trees when relevant settings flip (e.g. showAutomated).
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("coderSessions")) sessions.refresh();
      if (e.affectsConfiguration("coderKbChanges")) {
        kb.refresh();
        if (e.affectsConfiguration("coderKbChanges.repoPath")) refreshKbTitle();
      }
      if (e.affectsConfiguration("coderProjectsActivity")) projects.refresh();
      if (e.affectsConfiguration("coderTasks")) tasks.refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshKbTitle();
      kb.refresh();
      // Sessions view is filtered by the workspace's first folder — refresh
      // so the filter (and the "N other-folder sessions hidden" notice)
      // re-evaluates against the new workspace.
      sessions.refresh();
    }),
  );

  // Keep the Tasks view fresh: re-poll every 30 s so the active sub-agent
  // section reflects the current live-monitor state without user action.
  const tasksTimer = setInterval(() => tasks.refresh(), 30_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(tasksTimer) });

  // KB-changes + Projects views are git-log driven, so they don't move unless
  // we re-read git or the local-day rolls past midnight. Re-poll every 2 min
  // so new commits / new days show up automatically.
  const kbProjectsTimer = setInterval(() => {
    kb.refresh();
    projects.refresh();
  }, 2 * 60 * 1000);
  ctx.subscriptions.push({ dispose: () => clearInterval(kbProjectsTimer) });

  // Day-rollover detection. The date-bucket label is computed at render time
  // from `new Date()`, so when local midnight passes nothing moves from
  // "Today" to "Yesterday" until something else triggers a refresh. We
  // detect the rollover once a minute and refresh every bucketed view.
  let lastDayKey = todayKey();
  function todayKey(): number {
    const d = new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }
  const dayRolloverTimer = setInterval(() => {
    const k = todayKey();
    if (k === lastDayKey) return;
    lastDayKey = k;
    sessions.refresh();
    kb.refresh();
    projects.refresh();
    tasks.refresh();
  }, 60_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(dayRolloverTimer) });

  // Sessions view: incremental re-sync + re-render every 10 s so the
  // leading "time since last activity" column stays close to real-time.
  // syncToStore is incremental — it only re-parses JSONLs whose (mtime,size)
  // changed, so the cost when nothing has happened is essentially a stat()
  // per known session.
  const sessionsTimer = setInterval(() => {
    if (store) {
      try { syncToStore(store); } catch { /* swallow; next tick retries */ }
      if (vscode.workspace.getConfiguration("coderSessions").get<boolean>("grok.enabled", true)) {
        try { syncGrokToStore(store); } catch { /* swallow; next tick retries */ }
      }
    }
    sessions.refresh();
    // Give the background classifier a nudge so newly-detected turns get
    // queued without waiting for its own discovery interval.
    bgClassifier?.notifySyncCompleted();
    // Refresh the daily cost budget tile alongside the live tile.
    costBudgetTick?.();
  }, 10_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(sessionsTimer) });
}

async function openChangedFile(c: FileChange) {
  try {
    // `vscode.open` respects the user's workbench.editorAssociations, so .md
    // files open in markdown-for-humans (or whatever they've configured) when
    // the association is set. Falls back to the default text editor otherwise.
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(c.abs));
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-sessions-"));
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

async function locateSessionJsonl(sessionId: string): Promise<string | null> {
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  let dirs: [string, vscode.FileType][];
  try {
    dirs = await vscode.workspace.fs.readDirectory(vscode.Uri.file(projectsRoot));
  } catch {
    return null;
  }
  for (const [dirName, kind] of dirs) {
    if (kind !== vscode.FileType.Directory) continue;
    const candidate = path.join(projectsRoot, dirName, `${sessionId}.jsonl`);
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
      return candidate;
    } catch {
      // not in this project; keep searching
    }
  }
  return null;
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
