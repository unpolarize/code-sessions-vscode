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
import { MemoryProvider, scanMemorySources, summariseSources } from "./memoryView";
import { preferredEditorColumn } from "./editorColumn";

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
  const cfg = vscode.workspace.getConfiguration("codeKbChanges");
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
  item.name = "AI Agents · cost today";
  item.command = "codeSessions.openInsights";

  const tick = () => {
    const cfg = vscode.workspace.getConfiguration("codeSessions");
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
      if (e.affectsConfiguration("codeSessions.costBudget")) tick();
    }),
  );
  return { item, tick };
}

function createLiveStatusBar(
  ctx: vscode.ExtensionContext,
  store: SessionStore,
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = "codeSessions.openLiveMonitor";
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
    md.appendMarkdown(`**AI Agents · Live** &nbsp; *(updated ${new Date().toLocaleTimeString()})*\n\n`);
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
          item.text = `$(warning) AI Agents · ${awaiting.length} ${lbl}`;
          item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        } else {
          const top = payload.cards[0];
          const tag =
            top.now.kind === "in_tool"
              ? top.now.detail
              : top.now.kind === "responding"
                ? "responding"
                : "idle";
          item.text = `$(pulse) AI Agents · ${payload.activeCount} active · ${tag}`;
          item.backgroundColor = undefined;
        }
      } else {
        item.text = `$(comment-discussion) AI Agents · idle`;
        item.backgroundColor = undefined;
      }

      // One-shot notification per session entering the awaiting state.
      const stillAwaitingIds = new Set(awaiting.map((c) => c.session_id));
      for (const c of awaiting) {
        if (notifiedAwaiting.has(c.session_id)) continue;
        notifiedAwaiting.add(c.session_id);
        const cfg = vscode.workspace.getConfiguration("codeSessions");
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
                vscode.commands.executeCommand("codeSessions.openLiveMonitor");
              } else if (sel === "Open session") {
                vscode.commands.executeCommand("codeSessions.showTrajectory", c.session_id, c.title);
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
      item.text = `$(warning) AI Agents`;
      item.tooltip = `code-sessions: ${e.message}`;
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, 30_000);
    }
  };

  // Honor enabled flag dynamically
  const applyEnabledState = () => {
    const enabled = vscode.workspace
      .getConfiguration("codeSessions")
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
      if (e.affectsConfiguration("codeSessions.liveStatusBar.enabled")) applyEnabledState();
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
  /** Dominant / last-seen model id from the JSONL (`claude-opus-4-7`,
   * `grok-build`, etc.). Null if the indexer hasn't pinned one yet. */
  model: string | null;
  /** Source-specific telemetry — currently grok signals.json contents
   * (turn/tool/file counts, latency, peak RSS). Serialised JSON. */
  extras_json: string | null;
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
  is_hidden?: boolean;
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
    model: r.model,
    extras_json: r.extras_json ?? null,
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

// Cost rates per 1M tokens — mirrors the table in jsonlIndexer.ts so the
// tooltip breakdown reconciles with the headline figure the indexer wrote
// to session.cost_usd. (We don't import the indexer's table because that
// pulls fs/native deps into the view module; the rates are stable enough
// that two-place duplication is cheaper than a refactor.)
interface CostRates { input: number; output: number; cacheRead: number; cacheWrite: number }
const COST_RATES: Record<string, CostRates> = {
  opus:   { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku:  { input: 1, output: 5,  cacheWrite: 1.25, cacheRead: 0.1 }
};
function ratesForModel(modelId: string | null | undefined): { rates: CostRates; family: string } {
  const m = (modelId ?? "").toLowerCase();
  if (m.includes("opus")) return { rates: COST_RATES.opus, family: "Opus" };
  if (m.includes("sonnet")) return { rates: COST_RATES.sonnet, family: "Sonnet" };
  if (m.includes("haiku")) return { rates: COST_RATES.haiku, family: "Haiku" };
  return { rates: COST_RATES.sonnet, family: "Sonnet (default)" };
}
function fmtNum(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}

/** Helper: decode the row's signals JSON blob (grok-only). Tolerates a
 * missing / malformed blob — returns null in either case. */
function readGrokSignals(row: SessionRow): Record<string, any> | null {
  if (!row.extras_json) return null;
  try { return JSON.parse(row.extras_json); } catch { return null; }
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

/** Multi-line markdown showing how the session's cost_usd splits across
 * input / output / cache-read / cache-write at the detected model's list
 * rates, plus a short explanation of what the cache lines mean and what
 * the discount/premium ratio is. Grok rows fall through to signals.json
 * telemetry — context size, tools, file-edit volume, latency, RSS — when
 * available; a stub when the signals sidecar is missing. */
function buildCostBreakdown(row: SessionRow): string[] {
  if (row.source === "grok") {
    const s = readGrokSignals(row);
    if (!s) {
      return [
        "",
        "**Grok session — no telemetry sidecar**",
        "This session was indexed before grok started writing `signals.json`,",
        "or the file was missing. Open the session in Grok Build to refresh it.",
      ];
    }
    const ctxPct =
      typeof s.contextWindowUsage === "number"
        ? `${s.contextWindowUsage}%`
        : s.contextTokensUsed && s.contextWindowTokens
          ? `${Math.round((s.contextTokensUsed / s.contextWindowTokens) * 100)}%`
          : "";
    const lines = [
      "",
      `**Grok telemetry** — from \`signals.json\` (Grok Build doesn't record per-turn input/output token splits, so cost can't be computed — these are the closest metrics it does expose)`,
      "| Metric | Value | Note |",
      "|---|---:|---|",
    ];
    if (typeof s.contextTokensUsed === "number") {
      lines.push(
        `| Context tokens | ${fmtNum(s.contextTokensUsed)}${s.contextWindowTokens ? ` / ${fmtNum(s.contextWindowTokens)}` : ""}${ctxPct ? ` (${ctxPct})` : ""} | how full the context window got |`
      );
    }
    if (typeof s.totalTokensBeforeCompaction === "number" && s.totalTokensBeforeCompaction > 0) {
      lines.push(`| Tokens before compaction | ${fmtNum(s.totalTokensBeforeCompaction)} | trimmed by ${s.compactionCount ?? "?"} compaction event(s) |`);
    }
    if (typeof s.toolCallCount === "number") {
      const toolList = Array.isArray(s.toolsUsed) && s.toolsUsed.length > 0 ? s.toolsUsed.slice(0, 6).join(", ") : "";
      lines.push(`| Tool calls | ${s.toolCallCount.toLocaleString()} | ${toolList || "—"} |`);
    }
    if (Array.isArray(s.modelsUsed) && s.modelsUsed.length > 0) {
      lines.push(`| Models used | ${s.modelsUsed.length} | ${s.modelsUsed.join(", ")} |`);
    }
    if (typeof s.agentLinesAdded === "number" || typeof s.agentLinesRemoved === "number" || typeof s.agentFilesTouched === "number") {
      const added = s.agentLinesAdded ?? 0;
      const removed = s.agentLinesRemoved ?? 0;
      const files = s.agentFilesTouched ?? 0;
      lines.push(`| File edits | +${added.toLocaleString()} / -${removed.toLocaleString()} | across ${files} file${files === 1 ? "" : "s"} |`);
    }
    if (typeof s.avgTimeToFirstTokenMs === "number" || typeof s.avgResponseTimeMs === "number") {
      const ttft = typeof s.avgTimeToFirstTokenMs === "number" ? `${Math.round(s.avgTimeToFirstTokenMs)}ms` : "—";
      const rt = typeof s.avgResponseTimeMs === "number" ? `${Math.round(s.avgResponseTimeMs)}ms` : "—";
      lines.push(`| Latency (avg) | ${ttft} TTFT · ${rt} response | first-token / full-response |`);
    }
    if (typeof s.peakRssBytes === "number") {
      lines.push(`| Peak RAM | ${fmtBytes(s.peakRssBytes)} | local grok process (laptop memory) |`);
    }
    if (typeof s.sessionDurationSeconds === "number" && s.sessionDurationSeconds > 0) {
      lines.push(`| Duration | ${formatDurationSec(s.sessionDurationSeconds)} | wall-clock |`);
    }
    lines.push("", "_Grok Build runs against xAI's API; per-turn input/output token splits are not persisted to disk, so $ cost can't be computed locally. xAI bills via subscription (SuperGrok Heavy) or API key (per-token, visible in console.x.ai)._");
    return lines;
  }
  const { rates, family } = ratesForModel(row.model);
  const input = row.tokens_input ?? 0;
  const output = row.tokens_output ?? 0;
  const cacheR = row.tokens_cache_read ?? 0;
  const cacheW = row.tokens_cache_write ?? 0;
  const inputCost = (input * rates.input) / 1_000_000;
  const outputCost = (output * rates.output) / 1_000_000;
  const cacheRCost = (cacheR * rates.cacheRead) / 1_000_000;
  const cacheWCost = (cacheW * rates.cacheWrite) / 1_000_000;
  const total = row.cost_usd;
  // Pad token figures to a fixed width so the columns line up in the tooltip.
  const lines = [
    "",
    `**Cost breakdown** — ${family} list rates (USD per 1M tokens)`,
    "| Bucket | Tokens | Rate | Cost |",
    "|---|---:|---:|---:|",
    `| Input | ${fmtNum(input)} | $${rates.input} | $${inputCost.toFixed(2)} |`,
    `| Output | ${fmtNum(output)} | $${rates.output} | $${outputCost.toFixed(2)} |`,
    `| Cache **read** (hits) | ${fmtNum(cacheR)} | $${rates.cacheRead} | $${cacheRCost.toFixed(2)} |`,
    `| Cache **write** (seeds) | ${fmtNum(cacheW)} | $${rates.cacheWrite} | $${cacheWCost.toFixed(2)} |`,
    `| **Total** | ${fmtNum(input + output + cacheR + cacheW)} | | **$${total.toFixed(2)}** |`,
    "",
    "_Cache **read** = the prompt already lived in Anthropic's prompt cache and was billed at **10% of input** (90% discount). Cache hits are the single biggest cost lever for long-running sessions._",
    "_Cache **write** = the first time a prefix is seeded into the cache; billed at **125% of input**. Paid once per cache entry; subsequent reads of that prefix are cheap._"
  ];
  return lines;
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
    const cfg = vscode.workspace.getConfiguration("codeSessions");
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
        // Decorate with hidden state.
        try {
          const hidden = this.store.hiddenSessionIds();
          for (const r of this.rows) r.is_hidden = hidden.has(r.session);
        } catch { /* ignore */ }
        this.lastError = null;
        return;
      } catch (e: any) {
        // Surface the original sqlite error class + message so a
        // "out of memory" / "database disk image is malformed"
        // report gives us something to act on. `code` and `errno`
        // come from node-sqlite3-wasm when SQLite returns
        // SQLITE_NOMEM / SQLITE_CORRUPT / etc.
        const code = e?.code ? ` [${e.code}]` : "";
        const errno = e?.errno != null ? ` errno=${e.errno}` : "";
        this.lastError = `SQLite read failed:${code}${errno} ${e?.message ?? e}. Check Output → "Code Sessions" for the stack trace, then click the refresh icon in the Sessions title bar.`;
        try { console.error("[code-sessions] db read failed:", e?.stack || e); } catch {}
        this.rows = [];
        return;
      }
    }

    // No SQLite cache available (cacheEnabled=false OR
    // SessionStore.open threw during activate). Pre-1.2.2 we fell
    // back to running ~/.claude/skills/sessions/session-center.sh —
    // the developer's personal pre-v1 tool that doesn't exist on
    // any other user's machine. Symptom on a fresh install:
    //
    //   Error: session-center.sh exit 127: bash: /Users/<you>/.claude/
    //   skills/sessions/session-center.sh: No such file or directory
    //
    // The cache is the real product surface; the script was never
    // meant to ship. Replace the fallback with a clear actionable
    // empty-state instead of trying to invoke an external script.
    this.lastError =
      "Code Sessions: SQLite cache unavailable. Re-enable with `codeSessions.cacheEnabled = true` (default) and reload the window. If it was on, the cache failed to open — check Output → \"Code Sessions\" for details.";
    this.rows = [];
  }

  getTreeItem(el: vscode.TreeItem): vscode.TreeItem {
    return el;
  }

  /** Returns the absolute path to the workspace's first folder when the
   * "filter by current workspace" setting is on, else null. */
  private workspaceFilter(): string | null {
    const cfg = vscode.workspace.getConfiguration("codeSessions");
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
   * `/Users/you/docs`) — those should pass through unchanged.
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

  /** Run the existing visible-row filtering pipeline (automated + hidden +
   * workspace scoping). Centralised so root and any sub-expansion share
   * exactly the same predicate. Also drops "opened but never used"
   * sessions — claude-vscode touches the jsonl when a chat panel opens
   * (recording entrypoint, etc.) even if the user never sends a message;
   * those rows have last_response_epoch === 0 and used to dilute the
   * "today" bucket with sessions where the agent didn't actually do any
   * work. */
  private filterVisible(rows: SessionRow[]): SessionRow[] {
    const cfg = vscode.workspace.getConfiguration("codeSessions");
    const showAutomated = cfg.get<boolean>("showAutomated", false);
    const showHidden = cfg.get<boolean>("showHidden", false);
    const wsFilter = this.workspaceFilter();
    return rows
      .filter((r) => showAutomated || !r.is_automated)
      .filter((r) => showHidden || !r.is_hidden)
      .filter((r) => (r.last_response_epoch ?? 0) > 0)
      .filter((r) => !wsFilter || SessionsProvider.sessionInWorkspace(r.project_path, wsFilter));
  }

  /** Returns the epoch-second timestamp we treat as the session's
   * "activity moment" for day-bucket grouping. Prefer the last assistant
   * TEXT timestamp (the moment the agent last said something to the
   * user) over file mtime, which fires on session-open too. */
  private static activityEpoch(r: SessionRow): number {
    return (r.last_response_epoch && r.last_response_epoch > 0)
      ? r.last_response_epoch
      : r.mtime_epoch;
  }

  /** Aggregate per-turn tokens AND USD cost per day bucket, scoped to
   * whichever sessions are visible right now. Returns two maps keyed by
   * the same bucket strings dayBucket() returns. Used to populate the
   * bucket headers with the tokens/cost ACTUALLY spent that day, not
   * the lifetime totals of every session that happened to be touched. */
  private tokensByBucket(
    visible: SessionRow[]
  ): {
    tokens: Record<ReturnType<typeof dayBucket>, number>;
    cost: Record<ReturnType<typeof dayBucket>, number>;
  } {
    const emptyT = { today: 0, yesterday: 0, last7: 0, older: 0 };
    const emptyC = { today: 0, yesterday: 0, last7: 0, older: 0 };
    if (!this.store || visible.length === 0) return { tokens: { ...emptyT }, cost: { ...emptyC } };
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 86_400_000;
    const startOfLast7 = startOfToday - 7 * 86_400_000;
    const ids = visible.map((r) => r.session);
    const placeholders = ids.map(() => "?").join(",");
    const sql = `
      SELECT
        COALESCE(SUM(CASE WHEN ended_at >= ? THEN
          input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
          ELSE 0 END), 0) AS today_t,
        COALESCE(SUM(CASE WHEN ended_at >= ? AND ended_at < ? THEN
          input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
          ELSE 0 END), 0) AS yesterday_t,
        COALESCE(SUM(CASE WHEN ended_at >= ? AND ended_at < ? THEN
          input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
          ELSE 0 END), 0) AS last7_t,
        COALESCE(SUM(CASE WHEN ended_at IS NULL OR ended_at < ? THEN
          input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
          ELSE 0 END), 0) AS older_t,
        COALESCE(SUM(CASE WHEN ended_at >= ? THEN cost_usd ELSE 0 END), 0) AS today_c,
        COALESCE(SUM(CASE WHEN ended_at >= ? AND ended_at < ? THEN cost_usd ELSE 0 END), 0) AS yesterday_c,
        COALESCE(SUM(CASE WHEN ended_at >= ? AND ended_at < ? THEN cost_usd ELSE 0 END), 0) AS last7_c,
        COALESCE(SUM(CASE WHEN ended_at IS NULL OR ended_at < ? THEN cost_usd ELSE 0 END), 0) AS older_c
      FROM turn
      WHERE session_id IN (${placeholders})
    `;
    try {
      const row = this.store.db
        .prepare(sql)
        .get(
          startOfToday,
          startOfYesterday, startOfToday,
          startOfLast7, startOfYesterday,
          startOfLast7,
          startOfToday,
          startOfYesterday, startOfToday,
          startOfLast7, startOfYesterday,
          startOfLast7,
          ...ids
        ) as {
          today_t: number; yesterday_t: number; last7_t: number; older_t: number;
          today_c: number; yesterday_c: number; last7_c: number; older_c: number;
        };
      return {
        tokens: {
          today: Number(row.today_t ?? 0),
          yesterday: Number(row.yesterday_t ?? 0),
          last7: Number(row.last7_t ?? 0),
          older: Number(row.older_t ?? 0),
        },
        cost: {
          today: Number(row.today_c ?? 0),
          yesterday: Number(row.yesterday_c ?? 0),
          last7: Number(row.last7_c ?? 0),
          older: Number(row.older_c ?? 0),
        },
      };
    } catch {
      return { tokens: { ...emptyT }, cost: { ...emptyC } };
    }
  }

  /** Build the root children: day buckets across both sources interleaved
   * by time, plus the workspace-filter / automated-hidden / hidden-count
   * tips. Replaces the v1.0 SourceBucketItem-first layout — sources are
   * still visible per-row via the `[C]`/`[G]` label prefix and the
   * source-derived default icon. */
  private buildRootChildren(): vscode.TreeItem[] {
    const cfg = vscode.workspace.getConfiguration("codeSessions");
    const showAutomated = cfg.get<boolean>("showAutomated", false);
    const showHidden = cfg.get<boolean>("showHidden", false);
    const wsFilter = this.workspaceFilter();

    const allRows = this.rows;
    const visibleRows = this.filterVisible(allRows);

    // Counts for the "N hidden by X" tips below. These count rows that
    // would otherwise pass through the rest of the filters but are
    // suppressed only by the named axis, so the user sees actionable
    // numbers instead of cumulative hides.
    const automatedCount = showAutomated ? 0 :
      allRows.filter((r) => r.is_automated && (showHidden || !r.is_hidden)
        && (!wsFilter || SessionsProvider.sessionInWorkspace(r.project_path, wsFilter))).length;
    const hiddenCount = showHidden ? 0 :
      allRows.filter((r) => r.is_hidden && (showAutomated || !r.is_automated)
        && (!wsFilter || SessionsProvider.sessionInWorkspace(r.project_path, wsFilter))).length;

    const out: vscode.TreeItem[] = [];

    if (wsFilter) {
      const hiddenByWs = allRows.filter((r) => (showAutomated || !r.is_automated)
        && (showHidden || !r.is_hidden)
        && !SessionsProvider.sessionInWorkspace(r.project_path, wsFilter)).length;
      if (hiddenByWs > 0) {
        const tip = new vscode.TreeItem(
          `Filtered to ${path.basename(wsFilter)} — ${hiddenByWs} sessions from other folders hidden`,
          vscode.TreeItemCollapsibleState.None,
        );
        tip.iconPath = new vscode.ThemeIcon("filter");
        tip.tooltip = new vscode.MarkdownString(
          `Showing only sessions whose project path is **${wsFilter}** (or a subfolder).\n\nToggle **Settings → Code Sessions: Filter By Current Workspace** to see everything.`,
        );
        tip.contextValue = "workspaceFilterTip";
        tip.command = {
          command: "workbench.action.openSettings",
          title: "Open setting",
          arguments: ["@ext:zhirafovod.code-sessions filterByCurrentWorkspace"],
        };
        out.push(tip);
      }
    }

    // Starred section (only when there are any). Always rendered first.
    const starredRows = visibleRows.filter((r) => r.is_starred);
    if (starredRows.length > 0) {
      out.push(new StarredBucketItem(starredRows.length));
    }

    // Bucket by the agent's "last actually-said-something" timestamp,
    // not file mtime — mtime ticks on session-open even when the agent
    // never wrote a reply, which used to drag empty sessions into the
    // Today bucket.
    const byBucket = new Map<string, SessionRow[]>();
    for (const r of visibleRows) {
      const b = dayBucket(new Date(SessionsProvider.activityEpoch(r) * 1000));
      const arr = byBucket.get(b) ?? [];
      arr.push(r);
      byBucket.set(b, arr);
    }
    // Bucket-header token AND cost sums come from per-turn tokens scoped
    // to that day's date range (migrations v11+v12). The previous code
    // summed the lifetime totals of every session touched that day,
    // which over-counted by orders of magnitude for sessions whose work
    // mostly happened on a different day.
    const dayTotals = this.tokensByBucket(visibleRows);
    for (const b of BUCKET_ORDER.filter((bb) => byBucket.has(bb))) {
      const arr = byBucket.get(b)!;
      const totals = {
        tokens: dayTotals.tokens[b],
        cost: dayTotals.cost[b],
        subagents: arr.reduce((n, r) => n + (r.subagents || 0), 0),
      };
      out.push(new BucketItem(b, arr.length, "session", totals));
    }
    if (!showAutomated && automatedCount > 0) {
      const tip = new vscode.TreeItem(
        `${automatedCount} automated/cron sessions hidden`,
        vscode.TreeItemCollapsibleState.None,
      );
      tip.iconPath = new vscode.ThemeIcon("watch");
      tip.tooltip = new vscode.MarkdownString(
        "Sessions whose `entrypoint` is not interactive (e.g. `sdk-cli`) are hidden.\n\nToggle **Settings → Code Sessions: Show Automated** to include them.",
      );
      tip.contextValue = "automatedHidden";
      out.push(tip);
    }
    if (!showHidden && hiddenCount > 0) {
      const tip = new vscode.TreeItem(
        `${hiddenCount} hidden session${hiddenCount === 1 ? "" : "s"}`,
        vscode.TreeItemCollapsibleState.None,
      );
      tip.iconPath = new vscode.ThemeIcon("eye-closed");
      tip.tooltip = new vscode.MarkdownString(
        "Sessions you've right-clicked → **Hide session**.\n\nToggle **Settings → Code Sessions: Show Hidden** to reveal them (with an unhide action).",
      );
      tip.contextValue = "userHidden";
      tip.command = {
        command: "workbench.action.openSettings",
        title: "Open setting",
        arguments: ["@ext:zhirafovod.code-sessions showHidden"],
      };
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

    if (!el) {
      // Root: day buckets across both sources interleaved by time. Sources
      // are still visible per-row via the `[C]` / `[G]` label prefix.
      return this.buildRootChildren();
    }

    if (el instanceof StarredBucketItem) {
      const rows = this.filterVisible(this.rows.filter((r) => r.is_starred))
        .sort((a, b) => SessionsProvider.activityEpoch(b) - SessionsProvider.activityEpoch(a));
      return rows.map((r) => new SessionItem(r));
    }
    if (el instanceof BucketItem && el.kind === "session") {
      const rows = this.filterVisible(this.rows)
        .filter((r) => dayBucket(new Date(SessionsProvider.activityEpoch(r) * 1000)) === el.bucket)
        .sort((a, b) => SessionsProvider.activityEpoch(b) - SessionsProvider.activityEpoch(a));
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
    // Source marker — always visible regardless of state. Prefix the label
    // so it lines up with the ago column. [C] = Claude, [G] = Grok.
    const sourceMarker = row.source === "grok" ? "[G]" : "[C]";
    super(
      `${sourceMarker} ${ago}  ·  ${titleText}`,
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
    // Cost breakdown — split the headline figure across input/output/cache-R/cache-W
    // at the model's list rates so the user sees where the spend went and what the
    // cache lines mean. Falls back to the Sonnet rates for unknown models (matches
    // the indexer's default).
    const costLines = buildCostBreakdown(row);
    const md = new vscode.MarkdownString(
      [
        `**${row.title || "(no title)"}**`,
        ``,
        `\`${row.session}\``,
        `Source: ${row.source === "grok" ? "Grok Build" : "Claude Code"}` +
          (row.model ? `  ·  Model: \`${row.model}\`` : ""),
        `Modified: ${row.modified}`,
        `Messages: ${row.messages}  ·  Subagents: ${row.subagents}`,
        ...costLines,
        `Projects touched: ${row.projects_touched?.join(", ") || "(none recorded)"}`,
        ...topicLines,
        row.active === "*" ? `\n_Active (mtime < 2 min)_` : "",
      ].join("\n"),
    );
    md.isTrusted = true; // allows markdown tables to render
    md.supportHtml = true;
    this.tooltip = md;
    // Icon precedence: hidden > starred > automated > active > source default.
    // Hidden is highest so the user can see at a glance which rows would
    // disappear once `showHidden` flips off; source default (`rocket` for
    // grok, `comment-discussion` for claude) carries the source signal in
    // the default state, doubling up with the `[C]` / `[G]` label prefix.
    this.iconPath = new vscode.ThemeIcon(
      row.is_hidden
        ? "eye-closed"
        : row.is_starred
          ? "star-full"
          : row.is_automated
            ? "watch"
            : row.active === "*"
              ? "pulse"
              : row.source === "grok"
                ? "rocket"
                : "comment-discussion",
    );
    const base = row.is_automated ? "sessionAutomated" : "session";
    const starred = row.is_starred ? `${base}-starred` : base;
    this.contextValue = row.is_hidden ? `${starred}-hidden` : starred;
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
    // Mirror the parent SessionItem's rich breakdown tooltip onto this row
    // so the user sees the cost-by-bucket / signals table when hovering the
    // metrics line they're actually pointing at. Without this, hover only
    // worked on the collapsed parent and felt broken on the unfolded child.
    const statsTooltip = new vscode.MarkdownString(
      [
        `**${r.title || "(no title)"}**`,
        ``,
        `Source: ${r.source === "grok" ? "Grok Build" : "Claude Code"}` +
          (r.model ? `  ·  Model: \`${r.model}\`` : ""),
        ...buildCostBreakdown(r),
      ].join("\n"),
    );
    statsTooltip.isTrusted = true;
    statsTooltip.supportHtml = true;
    stats.tooltip = statsTooltip;
    // Click to open Coder Insights filtered to this session — turns the
    // metric line into a clickable shortcut into the deeper drilldown view.
    stats.command = {
      command: "codeSessions.openInsightsForSession",
      title: "Open insights filtered to this session",
      arguments: [r],
    };
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
      command: "codeSessions.viewConversation",
      title: "View conversation",
      arguments: [this],
    };
    out.push(viewItem);

    // Both resume targets are always shown so the user can pick at
    // click-time without flipping the global `resumeBackend` setting.
    // The setting still drives the inline (toolbar) "Resume" action's
    // default — these explicit children always hard-target their backend.
    const codeBuildInstalled =
      vscode.extensions.getExtension("zhirafovod.code-build-vscode") != null;
    const codeBuildItem = new vscode.TreeItem("▶ Open in Code Build");
    codeBuildItem.iconPath = new vscode.ThemeIcon("rocket");
    codeBuildItem.contextValue = "sessionResume";
    codeBuildItem.tooltip = codeBuildInstalled
      ? "Open this session in Code Build's chat UI. For claude this imports the original transcript; for grok it opens a fresh conversation in the same cwd."
      : "Code Build is not installed — clicking will fall back to opening the native CLI extension.";
    codeBuildItem.command = {
      command: "codeSessions.resumeInCodeBuild",
      title: "Open in Code Build",
      arguments: [r],
    };
    out.push(codeBuildItem);

    const nativeLabel = r.source === "grok"
      ? "▶ Open in native Grok"
      : "▶ Resume in native Claude";
    const nativeItem = new vscode.TreeItem(nativeLabel);
    nativeItem.iconPath = new vscode.ThemeIcon("terminal");
    nativeItem.contextValue = "sessionResume";
    nativeItem.tooltip = r.source === "grok"
      ? "Open the grok-vscode-phuryn panel and pick this session from the clock-icon history. Falls back to `grok` in a terminal in the session's cwd."
      : "Open the anthropic.claude-code editor with a true `--resume` by session id. Falls back to `claude --resume <id>` in a terminal.";
    nativeItem.command = {
      command: "codeSessions.resumeInNative",
      title: "Resume in native CLI",
      arguments: [r],
    };
    out.push(nativeItem);

    // "Open raw JSONL" as a quick child too.
    const txItem = new vscode.TreeItem("📜 Open raw JSONL");
    txItem.iconPath = new vscode.ThemeIcon("file-text");
    txItem.command = {
      command: "codeSessions.openTranscript",
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
      command: this.repoIsKB() ? "codeKbChanges.openFile" : "codeProjectsActivity.openFile",
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
    const cfg = vscode.workspace.getConfiguration("codeKbChanges");
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
    const cfg = vscode.workspace.getConfiguration("codeProjectsActivity");
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
    const cfg = vscode.workspace.getConfiguration("codeTasks");
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
      command: "codeTasks.openSession",
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
      command: "codeTasks.editCrontab",
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
  const tmpDir = path.join(os.tmpdir(), "code-sessions");
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

/**
 * One-time migration of user settings from the legacy `coder*` / `claude*`
 * configuration namespaces to the current `code*` namespace.
 *
 * The extension's command ids, view ids, and config keys were renamed
 * (`claude*` → `coder*` → `code*`). VS Code keys settings by their literal
 * dotted name, so a rename orphans whatever the user had customized. This reads
 * the keys this build actually declares (from its own package.json) and, for
 * each, copies a value found under the old prefixes into the new key — at both
 * the Global and Workspace scope — without overwriting a value already set on
 * the new key. Gated on globalState so it runs at most once per profile.
 */
async function migrateSettingsToCodeNamespace(
  ctx: vscode.ExtensionContext,
  log: vscode.OutputChannel
): Promise<void> {
  const FLAG = "settingsMigratedToCodeNamespace_v1";
  if (ctx.globalState.get<boolean>(FLAG)) return;

  const OLD_PREFIXES: Record<string, string[]> = {
    codeSessions: ["coderSessions", "claudeSessions"],
    codeKbChanges: ["coderKbChanges", "claudeKbChanges"],
    codeProjectsActivity: ["coderProjectsActivity", "claudeProjectsActivity"],
    codeTasks: ["coderTasks", "claudeTasks"],
  };

  try {
    // Collect every config key this build declares (contributes.configuration
    // may be a single object or an array of them).
    const contrib = (ctx.extension.packageJSON?.contributes?.configuration ?? []) as
      | { properties?: Record<string, unknown> }
      | { properties?: Record<string, unknown> }[];
    const blocks = Array.isArray(contrib) ? contrib : [contrib];
    const newKeys = blocks.flatMap((b) => Object.keys(b.properties ?? {}));

    const cfg = vscode.workspace.getConfiguration();
    const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    let migrated = 0;

    for (const newKey of newKeys) {
      const dot = newKey.indexOf(".");
      if (dot < 0) continue;
      const section = newKey.slice(0, dot);
      const leaf = newKey.slice(dot + 1);
      const candidates = OLD_PREFIXES[section];
      if (!candidates) continue;

      const dest = cfg.inspect(newKey);
      for (const oldPrefix of candidates) {
        const oldKey = `${oldPrefix}.${leaf}`;
        const src = cfg.inspect(oldKey);
        if (!src) continue;
        if (src.globalValue !== undefined && dest?.globalValue === undefined) {
          await cfg.update(newKey, src.globalValue, vscode.ConfigurationTarget.Global);
          migrated++;
        }
        if (hasWorkspace && src.workspaceValue !== undefined && dest?.workspaceValue === undefined) {
          await cfg.update(newKey, src.workspaceValue, vscode.ConfigurationTarget.Workspace);
          migrated++;
        }
      }
    }

    if (migrated > 0) {
      log.appendLine(`[migrate] copied ${migrated} setting(s) to the code* namespace`);
      void vscode.window.showInformationMessage(
        `Code Sessions: migrated ${migrated} setting(s) from the old namespace. Old keys can be removed from settings.json.`
      );
    }
  } catch (e: unknown) {
    log.appendLine(`[migrate] settings migration skipped: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await ctx.globalState.update(FLAG, true);
  }
}

export function activate(ctx: vscode.ExtensionContext) {
  // Output channel for diagnostics — visible under View → Output → "Code Sessions".
  const log = vscode.window.createOutputChannel("Code Sessions");
  ctx.subscriptions.push(log);
  log.appendLine(`[activate] code-sessions starting (VS Code ${vscode.version})`);

  // One-time settings migration: copy any values the user set under the old
  // `coderSessions.*` / `claudeSessions.*` (and the KbChanges/ProjectsActivity/
  // Tasks siblings) keys to the current `code*` namespace. Idempotent and gated
  // on globalState so it runs once per profile. Safe no-op when nothing is set.
  void migrateSettingsToCodeNamespace(ctx, log);

  // Open the SQLite cache. If `cacheEnabled = false` OR the open fails,
  // `store` stays null and the providers show an empty-state error
  // instead of trying to fall back to a personal bash script (which
  // is what they used to do, and broke on every user's machine
  // other than the developer's — see notes in SessionsProvider.load
  // / openInsightsView).
  let store: SessionStore | null = null;
  try {
    const cacheEnabled = vscode.workspace
      .getConfiguration("codeSessions")
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
        `code-sessions: ${msg}. The Sessions tree will be empty until this is resolved — see the log for stack and try the Refresh command after fixing.`,
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
  const memory = new MemoryProvider();

  // Keep track of open conversation viewers so the classifyTopics command can
  // refresh them after upserting new topics.
  const openViewerPanels = new Map<string, vscode.WebviewPanel>();

  sessions.refresh();
  kb.refresh();
  projects.refresh();
  tasks.refresh();
  memory.refresh();

  // Initial background sync (incremental: mtime+size diff). First paint may
  // come from yesterday's cache while a fresh sync runs in parallel.
  if (store) {
    const s = store;
    setTimeout(() => {
      try {
        const stats = syncToStore(s);
        console.log(`[code-sessions] claude sync: ${JSON.stringify(stats)}`);
      } catch (e: any) {
        console.error("[code-sessions] claude sync failed:", e);
      }
      if (vscode.workspace.getConfiguration("codeSessions").get<boolean>("grok.enabled", true)) {
        try {
          const grokStats = syncGrokToStore(s);
          console.log(`[code-sessions] grok sync: ${JSON.stringify(grokStats)}`);
        } catch (e: any) {
          console.error("[code-sessions] grok sync failed:", e);
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
  const kbView = vscode.window.createTreeView("codeKbChanges", {
    treeDataProvider: kb,
    showCollapseAll: false,
  });
  const refreshKbTitle = () => {
    const base = path.basename(resolveKbRepoPath());
    kbView.title = base ? `${base} changes` : "KB changes";
  };
  refreshKbTitle();
  ctx.subscriptions.push(kbView);

  // createTreeView (not registerTreeDataProvider) so the toggle command can
  // observe `.visible` — the other three providers don't need toggle
  // behaviour and stay on the cheaper API.
  const sessionsTreeView = vscode.window.createTreeView("codeSessions", {
    treeDataProvider: sessions,
    showCollapseAll: true,
  });
  ctx.subscriptions.push(
    sessionsTreeView,
    vscode.window.registerTreeDataProvider("codeProjectsActivity", projects),
    vscode.window.registerTreeDataProvider("codeTasks", tasks),
    vscode.window.registerTreeDataProvider("codeMemory", memory),

    vscode.commands.registerCommand("codeSessions.classifyTogglePause", () => {
      if (!bgClassifier) return;
      bgClassifier.togglePause();
      vscode.window.setStatusBarMessage(
        bgClassifier.isPaused() ? "Auto-classify paused" : "Auto-classify resumed",
        2500,
      );
    }),
    vscode.commands.registerCommand("codeSessions.classifyRetryFailed", () => {
      if (!bgClassifier) return;
      const added = bgClassifier.retryFailed();
      vscode.window.setStatusBarMessage(
        added > 0 ? `Re-queued ${added} failed session(s)` : "No failed sessions to retry",
        2500,
      );
    }),
    vscode.commands.registerCommand("codeSessions.classifyControls", async () => {
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
        description: "codeSessions.classify.*",
      });
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: "Background topic classification",
      });
      if (!pick) return;
      if (pick.id === "pause") vscode.commands.executeCommand("codeSessions.classifyTogglePause");
      else if (pick.id === "retry") vscode.commands.executeCommand("codeSessions.classifyRetryFailed");
      else if (pick.id === "settings")
        vscode.commands.executeCommand("workbench.action.openSettings", "@ext:zhirafovod.code-sessions classify");
    }),

    vscode.commands.registerCommand("codeSessions.search", async (initialQ?: string) => {
      if (!store) {
        vscode.window.showWarningMessage(
          "Search requires the SQLite cache. Enable codeSessions.cacheEnabled.",
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

    vscode.commands.registerCommand("codeTasks.refresh", () => tasks.refresh()),
    vscode.commands.registerCommand("codeMemory.refresh", () => memory.refresh()),
    vscode.commands.registerCommand("codeMemory.openFile", async (absPath: string) => {
      if (!absPath) return;
      try {
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(absPath));
      } catch (e: any) {
        vscode.window.showWarningMessage(`Cannot open ${absPath}: ${e.message}`);
      }
    }),
    vscode.commands.registerCommand("codeTasks.editCrontab", () =>
      openCrontabEditor(ctx, () => tasks.refresh()),
    ),
    vscode.commands.registerCommand("codeTasks.openSession", async (sessionId: string) => {
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

    vscode.commands.registerCommand("codeSessions.refresh", async () => {
      // Incremental sync from disk + force re-parse the top-N most-recent
      // sessions. The forced top-N catches on-disk edits that don't reliably
      // bump mtime (most notably claude-code session renames, which sometimes
      // overwrite the JSONL in place at the same size).
      if (store) {
        const cfg = vscode.workspace.getConfiguration("codeSessions");
        const recent = Math.max(0, cfg.get<number>("refresh.forceRecent", 100));
        try {
          syncToStore(store, recent > 0 ? { forceRecentN: recent } : {});
        } catch (e) {
          console.error("[code-sessions] refresh sync failed", e);
        }
        if (cfg.get<boolean>("grok.enabled", true)) {
          try {
            syncGrokToStore(store, recent > 0 ? { forceRecentN: recent } : {});
          } catch (e) {
            console.error("[code-sessions] refresh grok sync failed", e);
          }
        }
      }
      await sessions.refresh();
    }),
    vscode.commands.registerCommand("codeSessions.refreshFull", async () => {
      // Force a full re-parse of every JSONL on disk. Use this if the
      // incremental sync looks stuck (e.g. titles still stale after a
      // claude rename) — slow on large catalogs.
      if (!store) {
        vscode.window.showWarningMessage("Full rescan requires the SQLite cache.");
        return;
      }
      const s = store;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Code Sessions: full rescan…" },
        async (progress) => {
          const stats = syncToStore(s, {
            force: true,
            onProgress: (done, total) => progress.report({ message: `claude ${done}/${total}` }),
          });
          let grokParsed = 0;
          if (vscode.workspace.getConfiguration("codeSessions").get<boolean>("grok.enabled", true)) {
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
    vscode.commands.registerCommand("codeSessions.openInsights", () => openInsightsView(ctx, store)),
    // Drilldown variant: called from a session row's metrics line. Opens the
    // Insights panel but pre-filters every chart and KPI to just that session
    // so the user sees its cost/tokens/messages in context of the dashboards.
    vscode.commands.registerCommand("codeSessions.openInsightsForSession", (row: SessionRow | undefined) => {
      if (!row || !row.session) return;
      openInsightsView(ctx, store, { focusSessionId: row.session });
    }),
    vscode.commands.registerCommand("codeSessions.openLiveMonitor", () => {
      if (!store) {
        vscode.window.showWarningMessage("Live monitor requires the SQLite cache. Enable codeSessions.cacheEnabled.");
        return;
      }
      openLiveMonitor(ctx, store);
    }),
    vscode.commands.registerCommand("codeKbChanges.refresh", () => kb.refresh()),
    vscode.commands.registerCommand("codeProjectsActivity.refresh", () => projects.refresh()),

    vscode.commands.registerCommand("codeSessions.resume", async (arg: SessionRow | SessionItem | undefined) => {
      const row = unwrapRow(arg);
      if (!row) { vscode.window.showWarningMessage("No session to resume."); return; }
      const cfg = vscode.workspace.getConfiguration("codeSessions");
      const preferredBackend = cfg.get<"code-build" | "native">("resumeBackend", "code-build");
      if (preferredBackend === "code-build") {
        await resumeInCodeBuild(row);
      } else {
        await resumeInNative(row);
      }
    }),
    vscode.commands.registerCommand("codeSessions.resumeInCodeBuild", async (arg: SessionRow | SessionItem | undefined) => {
      const row = unwrapRow(arg);
      if (!row) { vscode.window.showWarningMessage("No session to resume."); return; }
      await resumeInCodeBuild(row);
    }),
    vscode.commands.registerCommand("codeSessions.resumeInNative", async (arg: SessionRow | SessionItem | undefined) => {
      const row = unwrapRow(arg);
      if (!row) { vscode.window.showWarningMessage("No session to resume."); return; }
      await resumeInNative(row);
    }),

    vscode.commands.registerCommand("codeSessions.openTranscript", async (item: SessionItem) => {
      const jsonl = await locateSessionJsonl(item.row.session);
      if (!jsonl) {
        vscode.window.showWarningMessage(`Transcript not found for session ${item.row.session}`);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(jsonl);
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand("codeSessions.viewConversation", async (item: SessionItem) => {
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
      "codeSessions.classifyTopics",
      async (sessionId: string, jsonlPath: string, title: string) => {
        if (!store) {
          vscode.window.showWarningMessage(
            "Topic classification requires the SQLite cache. Enable codeSessions.cacheEnabled.",
          );
          return;
        }
        const cfg = vscode.workspace.getConfiguration("codeSessions");
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
      "codeSessions.showTrajectory",
      async (sessionId: string, title: string) => {
        if (!store) {
          vscode.window.showWarningMessage(
            "Trajectory view requires the SQLite cache. Enable codeSessions.cacheEnabled.",
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

    vscode.commands.registerCommand("codeSessions.reembedSessions", async () => {
      if (!store) {
        vscode.window.showWarningMessage("Re-embed requires the SQLite cache.");
        return;
      }
      const cfg = vscode.workspace.getConfiguration("codeSessions");
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

    vscode.commands.registerCommand("codeSessions.showAgentGraph", async () => {
      if (!store) {
        vscode.window.showWarningMessage(
          "Agent graph requires the SQLite cache. Enable codeSessions.cacheEnabled.",
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
    vscode.commands.registerCommand("codeSessions.agentGraphToggleMode", () => {
      if (!currentAgentGraphPanel) {
        vscode.window.setStatusBarMessage("Open the agent graph first (Cmd+Alt+G)", 2500);
        return;
      }
      currentAgentGraphPanel.reveal();
      currentAgentGraphPanel.webview.postMessage({ command: "toggleMode" });
    }),
    vscode.commands.registerCommand("codeSessions.starSession", async (arg: SessionRow | SessionItem | undefined) => {
      if (!store) return;
      const row = arg && typeof arg === "object" && "row" in arg ? (arg as SessionItem).row : (arg as SessionRow | undefined);
      if (!row?.session) return;
      store.starSession(row.session);
      sessions.refresh();
    }),
    vscode.commands.registerCommand("codeSessions.unstarSession", async (arg: SessionRow | SessionItem | undefined) => {
      if (!store) return;
      const row = arg && typeof arg === "object" && "row" in arg ? (arg as SessionItem).row : (arg as SessionRow | undefined);
      if (!row?.session) return;
      store.unstarSession(row.session);
      sessions.refresh();
    }),
    vscode.commands.registerCommand("codeSessions.revealProjectFolder", async (projectPath: string) => {
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
    vscode.commands.registerCommand("codeSessions.focusActivityView", async () => {
      // VS Code provides workbench.view.extension.<containerId> to focus a
      // view container. Wrapping it makes the keybinding discoverable in the
      // palette under the Claude namespace.
      try {
        await vscode.commands.executeCommand("workbench.view.extension.code-activity");
      } catch (e: any) {
        vscode.window.showErrorMessage(`Cannot focus Code Sessions: ${e.message}`);
      }
    }),
    vscode.commands.registerCommand("codeSessions.toggleActivityView", async () => {
      // If our Sessions tree is currently visible, the side bar is open and
      // our container is the active one → close the side bar. Otherwise
      // reveal our container (which also focuses the tree).
      try {
        if (sessionsTreeView.visible) {
          await vscode.commands.executeCommand("workbench.action.closeSidebar");
        } else {
          await vscode.commands.executeCommand("workbench.view.extension.code-activity");
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`Toggle failed: ${e.message}`);
      }
    }),
    vscode.commands.registerCommand("codeSessions.hideSession", async (arg: SessionRow | SessionItem | undefined) => {
      if (!store) {
        vscode.window.showWarningMessage("Hide requires the SQLite cache. Enable codeSessions.cacheEnabled.");
        return;
      }
      const row = unwrapRow(arg);
      if (!row?.session) return;
      store.setHidden(row.session, true);
      sessions.refresh();
      vscode.window.setStatusBarMessage(
        `Hidden “${(row.title || row.session).slice(0, 40)}”. Toggle “Show Hidden” to bring it back.`,
        5000,
      );
    }),
    vscode.commands.registerCommand("codeSessions.unhideSession", async (arg: SessionRow | SessionItem | undefined) => {
      if (!store) return;
      const row = unwrapRow(arg);
      if (!row?.session) return;
      store.setHidden(row.session, false);
      sessions.refresh();
    }),
    vscode.commands.registerCommand("codeSessions.renameSession", async (arg: SessionRow | SessionItem | undefined) => {
      if (!store) {
        vscode.window.showWarningMessage("Rename requires the SQLite cache. Enable codeSessions.cacheEnabled.");
        return;
      }
      const row = unwrapRow(arg);
      if (!row?.session) return;
      const current = row.title || "";
      const input = await vscode.window.showInputBox({
        prompt: `Rename ${row.source === "grok" ? "Grok" : "Claude"} session — writes to the source-of-truth file so the native CLI sees the new name on its next --resume listing.`,
        value: current,
        placeHolder: "New session title",
        validateInput: (v) => v.trim().length === 0 ? "Title cannot be empty (cancel with Esc to keep current)" : null,
      });
      if (input === undefined) return; // cancelled
      const next = input.trim();
      if (next === current.trim()) return; // no-op
      const result = await renameSessionFile(row, next);
      if (!result.ok) {
        vscode.window.showErrorMessage(`Rename failed: ${result.error}`);
        return;
      }
      // Optimistic cache update — the next indexer pass will re-derive the
      // same value from the file we just wrote.
      try { store.updateSessionTitle(row.session, next); } catch { /* indexer will fix */ }
      sessions.refresh();
      vscode.window.setStatusBarMessage(
        `Renamed session — the native ${row.source === "grok" ? "grok" : "claude"} CLI will show the new title next time you resume.`,
        5000,
      );
    }),

    vscode.commands.registerCommand("codeKbChanges.openFile", (c: FileChange) => openChangedFile(c)),
    vscode.commands.registerCommand("codeProjectsActivity.openFile", (c: FileChange) => openChangedFile(c)),
    vscode.commands.registerCommand("codeKbChanges.diff", (item: FileChangeItem) => showDiff(item.change)),
    vscode.commands.registerCommand("codeProjectsActivity.diff", (item: FileChangeItem) => showDiff(item.change)),
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
          if (vscode.workspace.getConfiguration("codeSessions").get<boolean>("grok.enabled", true)) {
            syncGrokToStore(store);
          }
        } catch (e: any) {
          console.error("[code-sessions] sync failed in watcher:", e);
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
      if (e.affectsConfiguration("codeSessions")) sessions.refresh();
      if (e.affectsConfiguration("codeKbChanges")) {
        kb.refresh();
        if (e.affectsConfiguration("codeKbChanges.repoPath")) refreshKbTitle();
      }
      if (e.affectsConfiguration("codeProjectsActivity")) projects.refresh();
      if (e.affectsConfiguration("codeTasks")) tasks.refresh();
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
  // Memory inventory refresh: same 60s cadence as kb/projects. The
  // scan is cheap (a handful of fs.statSync + readFileSync); the
  // user can still hit the title-bar refresh button for instant
  // re-scan after editing CLAUDE.md.
  const memoryTimer = setInterval(() => memory.refresh(), 60_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(memoryTimer) });

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
      if (vscode.workspace.getConfiguration("codeSessions").get<boolean>("grok.enabled", true)) {
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-sessions-"));
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

// --------------------------------------------------------------------------- //
// Resume helpers
// --------------------------------------------------------------------------- //

/** TreeItem (inline action) and the explicit per-child commands both feed
 * the resume handlers — accept either and unwrap to the underlying row. */
function unwrapRow(arg: SessionRow | SessionItem | undefined): SessionRow | null {
  if (!arg) return null;
  if (typeof arg === "object" && "row" in arg) return (arg as SessionItem).row;
  return arg as SessionRow;
}

/** Open the session in zhirafovod.code-build-vscode's chat UI. Falls back
 * to the native per-source extension when code-build isn't installed. */
async function resumeInCodeBuild(row: SessionRow): Promise<void> {
  const cwd = SessionsProvider.sessionCwd(row) ?? undefined;
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
  vscode.window.setStatusBarMessage(
    `Code Build not installed — opening native ${row.source} instead.`,
    5000,
  );
  await resumeInNative(row);
}

/** Open the session in its source's native extension; fall back to a
 * terminal CLI in the session's cwd. */
async function resumeInNative(row: SessionRow): Promise<void> {
  const cwd = SessionsProvider.sessionCwd(row) ?? undefined;
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
  // Claude — anthropic.claude-code truly resumes by session id.
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
        preferredEditorColumn(),
      );
      return;
    } catch {
      // try the next one
    }
  }
  const term = vscode.window.createTerminal({
    name: `claude:${row.session.slice(0, 8)}`,
    cwd,
  });
  term.show();
  term.sendText(`claude --resume ${row.session}`);
}

// --------------------------------------------------------------------------- //
// Rename helper — writes the new title to the source-of-truth file so the
// native CLI's resume picker sees it too.
// --------------------------------------------------------------------------- //

const RENAME_MIN_IDLE_SECONDS = 60;

/** Rewrite the session's title on disk. Claude rows mutate the
 * `{type:"ai-title", aiTitle:"..."}` line in the JSONL; Grok rows mutate
 * `summary.json.generated_title`. Returns `{ok}` or `{error}` — caller is
 * responsible for showing toast.
 *
 * Refuses to write when the session was touched in the last
 * RENAME_MIN_IDLE_SECONDS — claude appends with O_APPEND, so a concurrent
 * write during our atomic-rename would lose in-flight data. */
async function renameSessionFile(
  row: SessionRow,
  newTitle: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const text = newTitle.trim();
  if (!text) return { ok: false, error: "Empty title — nothing to write." };
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000 - row.mtime_epoch));
  if (ageSec < RENAME_MIN_IDLE_SECONDS) {
    return {
      ok: false,
      error: `Session was active ${ageSec}s ago. Wait at least ${RENAME_MIN_IDLE_SECONDS}s after the last turn before renaming, so an in-flight write isn't lost.`,
    };
  }
  if (row.source === "grok") {
    return renameGrokSession(row, text);
  }
  return renameClaudeSession(row, text);
}

async function renameClaudeSession(
  row: SessionRow,
  newTitle: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const jsonl = await locateSessionJsonl(row.session);
  if (!jsonl) return { ok: false, error: `Transcript not found for ${row.session}` };
  let raw: string;
  try { raw = fs.readFileSync(jsonl, "utf-8"); }
  catch (e: any) { return { ok: false, error: `Read failed: ${e.message}` }; }
  const lines = raw.split("\n");
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln) continue;
    try {
      const obj = JSON.parse(ln);
      if (obj && obj.type === "ai-title") {
        obj.aiTitle = newTitle;
        lines[i] = JSON.stringify(obj);
        found = true;
        break;
      }
    } catch { /* skip malformed line */ }
  }
  if (!found) {
    // Prepend a new ai-title line. Keep a trailing newline so JSONL append
    // semantics on the next claude write keep working.
    lines.unshift(JSON.stringify({ type: "ai-title", aiTitle: newTitle }));
  }
  const out = lines.join("\n");
  return writeAtomic(jsonl, out);
}

async function renameGrokSession(
  row: SessionRow,
  newTitle: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Grok stores chat_history.jsonl alongside summary.json in a session dir.
  // The cache row's `project_path` points at the cwd (NOT the session dir);
  // we use the JSONL path from disk discovery instead via locateGrokSummary.
  const summaryPath = locateGrokSummary(row);
  if (!summaryPath) {
    return { ok: false, error: `summary.json not found for grok session ${row.session}` };
  }
  let raw: string;
  try { raw = fs.readFileSync(summaryPath, "utf-8"); }
  catch (e: any) { return { ok: false, error: `Read failed: ${e.message}` }; }
  let obj: any;
  try { obj = JSON.parse(raw); }
  catch (e: any) { return { ok: false, error: `summary.json parse failed: ${e.message}` }; }
  obj.generated_title = newTitle;
  if (typeof obj.session_summary === "string") obj.session_summary = newTitle;
  return writeAtomic(summaryPath, JSON.stringify(obj, null, 2));
}

/** Walk ~/.grok/sessions/* looking for the directory containing this
 * session id. Grok stores each session as a directory whose name is the
 * uuid; chat_history.jsonl and summary.json live inside. */
function locateGrokSummary(row: SessionRow): string | null {
  const grokRoot = path.join(os.homedir(), ".grok", "sessions");
  if (!fs.existsSync(grokRoot)) return null;
  // Heuristic 1: the session uuid is the directory name in flat layouts.
  const direct = path.join(grokRoot, row.session, "summary.json");
  if (fs.existsSync(direct)) return direct;
  // Heuristic 2: walk one level deeper for cwd-encoded layouts.
  try {
    const entries = fs.readdirSync(grokRoot, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const inner = path.join(grokRoot, e.name, row.session, "summary.json");
      if (fs.existsSync(inner)) return inner;
    }
  } catch { /* ignore */ }
  return null;
}

/** Same-filesystem atomic write via temp + rename. Safe against partial
 * writes; UNSAFE against a concurrent O_APPEND writer that has the inode
 * open — RENAME_MIN_IDLE_SECONDS guards that case at the caller. */
function writeAtomic(target: string, contents: string): { ok: true } | { ok: false; error: string } {
  const tmp = `${target}.rename.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, "utf-8");
    fs.renameSync(tmp, target);
    return { ok: true };
  } catch (e: any) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    return { ok: false, error: `Write failed: ${e.message}` };
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
