import * as vscode from "vscode";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openConversationViewer } from "./conversationView";
import { openInsightsView } from "./insightsView";
import { SessionStore } from "./db";
import { syncToStore } from "./jsonlIndexer";
import { classifySession } from "./topicClassifier";
import { openAgentGraph } from "./agentGraph";
import { openTrajectoryView } from "./trajectoryView";
import { openLiveMonitor, buildUpdate, UpdatePayload } from "./liveMonitor";

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
// Live status-bar item — always-visible compact indicator
// --------------------------------------------------------------------------- //

/**
 * Create a status-bar item that reflects current Claude Code activity. Polls
 * every 5 s when at least one session is active, drops to 30 s when idle.
 * Hover shows a per-session breakdown; click opens the live monitor.
 */
function createLiveStatusBar(
  ctx: vscode.ExtensionContext,
  store: SessionStore,
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = "claudeSessions.openLiveMonitor";
  item.name = "Claude · Live";
  item.show();

  const tooltipFor = (p: UpdatePayload): vscode.MarkdownString => {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.appendMarkdown(`**Claude · Live** &nbsp; *(updated ${new Date().toLocaleTimeString()})*\n\n`);
    md.appendMarkdown(
      `$(pulse) **${p.activeCount}** active · $(tools) **${p.toolsPerMin}** tools/min · $(credit-card) **\\$${p.costToday.toFixed(2)}** today\n\n`,
    );
    if (p.cards.length === 0) {
      md.appendMarkdown("_No active sessions in the last 2 minutes._\n");
    } else {
      md.appendMarkdown("---\n\n");
      for (const c of p.cards.slice(0, 8)) {
        let status = "";
        if (c.now.kind === "in_tool") status = `$(gear) ${c.now.detail} · ${c.now.ageSec}s`;
        else if (c.now.kind === "responding") status = `$(pencil) responding · ${c.now.ageSec}s`;
        else status = `$(circle-outline) idle${c.now.ageSec ? ` · ${c.now.ageSec}s` : ""}`;
        const proj = c.project ? c.project : "(no project)";
        const title = c.title.length > 64 ? c.title.slice(0, 64) + "…" : c.title;
        md.appendMarkdown(
          `**${escapeMd(title)}** &nbsp; \`${escapeMd(proj)}\`\n\n` +
            `${status} · 💬 ${c.messages} · 🔧 ${c.tools} · \\$${c.cost_usd.toFixed(2)}\n\n`,
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
  const tick = () => {
    try {
      const payload = buildUpdate(store);
      if (payload.activeCount > 0) {
        const top = payload.cards[0];
        const tag =
          top.now.kind === "in_tool"
            ? top.now.detail
            : top.now.kind === "responding"
              ? "responding"
              : "idle";
        item.text = `$(pulse) Claude · ${payload.activeCount} active · ${tag}`;
        item.backgroundColor = undefined;
      } else {
        item.text = `$(comment-discussion) Claude · idle`;
        item.backgroundColor = undefined;
      }
      item.tooltip = tooltipFor(payload);
      // Schedule next poll based on activity
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, payload.activeCount > 0 ? 5_000 : 30_000);
    } catch (e: any) {
      item.text = `$(warning) Claude`;
      item.tooltip = `claude-sessions: ${e.message}`;
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, 30_000);
    }
  };

  // Honor enabled flag dynamically
  const applyEnabledState = () => {
    const enabled = vscode.workspace
      .getConfiguration("claudeSessions")
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
      if (e.affectsConfiguration("claudeSessions.liveStatusBar.enabled")) applyEnabledState();
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
  first_ts_epoch?: number;
  entrypoint?: string;
  is_automated?: boolean;
  top_topics?: string[];
  topic_counts?: Array<[string, number]>;
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
    mtime_epoch: Math.floor(r.mtime_ns / 1e9),
    active: r.indexed_at && Date.now() / 1000 - r.mtime_ns / 1e9 < 120 ? "*" : " ",
    project: r.project_id || "",
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
    const cfg = vscode.workspace.getConfiguration("claudeSessions");
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

  getChildren(el?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
    if (this.lastError && !el) {
      const it = new vscode.TreeItem(`Error: ${this.lastError.split("\n")[0]}`);
      it.tooltip = this.lastError;
      it.iconPath = new vscode.ThemeIcon("error");
      return [it];
    }

    const cfg = vscode.workspace.getConfiguration("claudeSessions");
    const showAutomated = cfg.get<boolean>("showAutomated", false);

    if (!el) {
      // Filter automated rows up front so bucket totals match the displayed rows.
      const visibleRows = this.rows.filter((r) => showAutomated || !r.is_automated);
      const automatedCount = this.rows.length - visibleRows.length;
      const byBucket = new Map<string, SessionRow[]>();
      for (const r of visibleRows) {
        const b = dayBucket(new Date(r.mtime_epoch * 1000));
        const arr = byBucket.get(b) ?? [];
        arr.push(r);
        byBucket.set(b, arr);
      }
      const buckets = BUCKET_ORDER.filter((b) => byBucket.has(b)).map((b) => {
        const arr = byBucket.get(b)!;
        const totals = {
          tokens: arr.reduce((n, r) => n + r.tokens_total, 0),
          cost: arr.reduce((n, r) => n + r.cost_usd, 0),
          subagents: arr.reduce((n, r) => n + (r.subagents || 0), 0),
        };
        return new BucketItem(b, arr.length, "session", totals) as vscode.TreeItem;
      });
      if (!showAutomated && automatedCount > 0) {
        const tip = new vscode.TreeItem(
          `${automatedCount} automated/cron sessions hidden`,
          vscode.TreeItemCollapsibleState.None,
        );
        tip.iconPath = new vscode.ThemeIcon("eye-closed");
        tip.tooltip = new vscode.MarkdownString(
          "Sessions whose `entrypoint` is not interactive (e.g. `sdk-cli`) are hidden.\n\nToggle **Settings → Claude Sessions: Show Automated** to include them.",
        );
        tip.contextValue = "automatedHidden";
        buckets.push(tip);
      }
      return buckets;
    }

    if (el instanceof BucketItem && el.kind === "session") {
      const rows = this.rows
        .filter((r) => showAutomated || !r.is_automated)
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
    const ago = formatRelative(row.mtime_epoch);
    const durSec =
      row.first_ts_epoch && row.first_ts_epoch > 0
        ? Math.max(0, row.mtime_epoch - row.first_ts_epoch)
        : 0;
    const durStr = durSec > 0 ? formatDurationSec(durSec) : null;
    // Description: msgs · cost · duration · ago. Always-visible summary.
    const parts = [`💬${row.messages.toLocaleString()}`, `$${cost}`];
    if (durStr) parts.push(`⏱${durStr}`);
    if (row.top_topics && row.top_topics.length > 0) {
      parts.push(`🏷 ${row.top_topics.join(", ")}`);
    }
    parts.push(ago);
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
      row.is_automated
        ? "watch"
        : row.active === "*"
          ? "pulse"
          : "comment-discussion",
    );
    this.contextValue = row.is_automated ? "sessionAutomated" : "session";
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
      command: "claudeSessions.viewConversation",
      title: "View conversation",
      arguments: [this],
    };
    out.push(viewItem);

    // "Resume" — opens the conversation back in the Claude panel.
    const resumeItem = new vscode.TreeItem("▶ Resume in Claude");
    resumeItem.iconPath = new vscode.ThemeIcon("play");
    resumeItem.contextValue = "sessionResume";
    resumeItem.command = {
      command: "claudeSessions.resume",
      title: "Resume",
      arguments: [r],
    };
    out.push(resumeItem);

    // "Open raw JSONL" as a quick child too.
    const txItem = new vscode.TreeItem("📜 Open raw JSONL");
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
  // Output channel for diagnostics — visible under View → Output → "Claude Sessions".
  const log = vscode.window.createOutputChannel("Claude Sessions");
  ctx.subscriptions.push(log);
  log.appendLine(`[activate] claude-sessions starting (VS Code ${vscode.version})`);

  // Open the SQLite cache. If the user has disabled it, leave store null
  // and the providers will fall back to running session-center.sh.
  let store: SessionStore | null = null;
  try {
    const cacheEnabled = vscode.workspace
      .getConfiguration("claudeSessions")
      .get<boolean>("cacheEnabled", true);
    if (cacheEnabled) {
      store = SessionStore.open(ctx.globalStorageUri.fsPath);
      log.appendLine(`[activate] SQLite cache opened at ${ctx.globalStorageUri.fsPath}`);
    } else {
      log.appendLine(`[activate] cacheEnabled = false; using shell-script fallback`);
    }
  } catch (e: any) {
    const msg = `SQLite cache failed to open: ${e?.message || e}`;
    log.appendLine(`[activate] ERROR ${msg}`);
    log.appendLine(String(e?.stack || ""));
    vscode.window
      .showWarningMessage(
        `claude-sessions: ${msg}. Falling back to shell-script mode.`,
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

  // Keep track of open conversation viewers so the classifyTopics command can
  // refresh them after upserting new topics.
  const openViewerPanels = new Map<string, vscode.WebviewPanel>();

  sessions.refresh();
  kb.refresh();
  projects.refresh();

  // Initial background sync (incremental: mtime+size diff). First paint may
  // come from yesterday's cache while a fresh sync runs in parallel.
  if (store) {
    const s = store;
    setTimeout(() => {
      try {
        const stats = syncToStore(s);
        // Refresh providers when the sync finishes so they see new rows.
        sessions.refresh();
        console.log(`[claude-sessions] sync: ${JSON.stringify(stats)}`);
      } catch (e: any) {
        console.error("[claude-sessions] sync failed:", e);
      }
    }, 200);
  }

  ctx.subscriptions.push({ dispose: () => store?.close() });

  // Always-visible live status bar
  if (store) createLiveStatusBar(ctx, store);

  // KB view uses createTreeView so we can set its title dynamically based on
  // the configured repoPath (e.g. "docs changes" instead of "KB changes").
  const kbView = vscode.window.createTreeView("claudeKbChanges", {
    treeDataProvider: kb,
    showCollapseAll: false,
  });
  const refreshKbTitle = () => {
    const repo = vscode.workspace.getConfiguration("claudeKbChanges").get<string>("repoPath", "");
    const base = repo ? path.basename(expandHome(repo)) : "";
    kbView.title = base ? `${base} changes` : "KB changes";
  };
  refreshKbTitle();
  ctx.subscriptions.push(kbView);

  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider("claudeSessions", sessions),
    vscode.window.registerTreeDataProvider("claudeProjectsActivity", projects),

    vscode.commands.registerCommand("claudeSessions.refresh", () => sessions.refresh()),
    vscode.commands.registerCommand("claudeSessions.openInsights", () => openInsightsView(ctx, store)),
    vscode.commands.registerCommand("claudeSessions.openLiveMonitor", () => {
      if (!store) {
        vscode.window.showWarningMessage("Live monitor requires the SQLite cache. Enable claudeSessions.cacheEnabled.");
        return;
      }
      openLiveMonitor(ctx, store);
    }),
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
      const jsonl = await locateSessionJsonl(item.row.session);
      if (!jsonl) {
        vscode.window.showWarningMessage(`Transcript not found for session ${item.row.session}`);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(jsonl);
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand("claudeSessions.viewConversation", async (item: SessionItem) => {
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
      "claudeSessions.classifyTopics",
      async (sessionId: string, jsonlPath: string, title: string) => {
        if (!store) {
          vscode.window.showWarningMessage(
            "Topic classification requires the SQLite cache. Enable claudeSessions.cacheEnabled.",
          );
          return;
        }
        const cfg = vscode.workspace.getConfiguration("claudeSessions");
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
      "claudeSessions.showTrajectory",
      async (sessionId: string, title: string) => {
        if (!store) {
          vscode.window.showWarningMessage(
            "Trajectory view requires the SQLite cache. Enable claudeSessions.cacheEnabled.",
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

    vscode.commands.registerCommand("claudeSessions.reembedSessions", async () => {
      if (!store) {
        vscode.window.showWarningMessage("Re-embed requires the SQLite cache.");
        return;
      }
      const cfg = vscode.workspace.getConfiguration("claudeSessions");
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

    vscode.commands.registerCommand("claudeSessions.showAgentGraph", async () => {
      if (!store) {
        vscode.window.showWarningMessage(
          "Agent graph requires the SQLite cache. Enable claudeSessions.cacheEnabled.",
        );
        return;
      }
      await openAgentGraph(ctx, store, async (sessionId) => {
        const jsonl = await locateSessionJsonl(sessionId);
        if (!jsonl) {
          vscode.window.showWarningMessage(`Transcript not found for ${sessionId}`);
          return;
        }
        const row = store!.getById(sessionId);
        const title = row?.title || sessionId.slice(0, 8);
        const panel = openConversationViewer(ctx, jsonl, sessionId, title, store);
        openViewerPanels.set(sessionId, panel);
        panel.onDidDispose(() => {
          if (openViewerPanels.get(sessionId) === panel) openViewerPanels.delete(sessionId);
        });
      });
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
    refreshTimer = setTimeout(() => {
      // Re-sync only the changed JSONLs into SQLite, then refresh the view.
      if (store) {
        try {
          syncToStore(store);
        } catch (e: any) {
          console.error("[claude-sessions] sync failed in watcher:", e);
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
      if (e.affectsConfiguration("claudeSessions")) sessions.refresh();
      if (e.affectsConfiguration("claudeKbChanges")) {
        kb.refresh();
        if (e.affectsConfiguration("claudeKbChanges.repoPath")) refreshKbTitle();
      }
      if (e.affectsConfiguration("claudeProjectsActivity")) projects.refresh();
    }),
  );
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
