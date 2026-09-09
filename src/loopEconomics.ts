// Loop runaway economics card (KP ideas/csv-loop-runaway-economics-card-multi-backend-lo).
// Pure module — no vscode imports — so the aggregator + renderer are
// fixture-testable.
//
// Claude Code's /usage Loops breakdown makes runaway /loop tasks visible, but
// only for Claude. This card joins loop/schedule-shaped *sessions* across every
// backend the CSV index knows (Claude night loops, Codex automations, Grok/CB
// host interval work), groups repeated runs of the same job, and ranks the
// groups by tokens/run so a forgotten overnight loop that re-buys growing
// context every tick surfaces before the invoice does.
//
// Read-only over the persisted session index: no live vendor API calls. The
// Kill / Rebind-to-KP / Soft-stop actions are host-command stubs — Kill always
// routes through a host confirm dialog, never a direct signal.

import { isAutomatedSession, type AutomationConfig, type AutomationMatchInput } from "./automation";

export const LOOP_ECON_SCHEMA = "code-sessions/loop-economics-card@1";

export const LOOP_KILL_COMMAND = "codeSessions.loopEconomics.kill";
export const LOOP_REBIND_COMMAND = "codeSessions.loopEconomics.rebindKp";
export const LOOP_SOFT_STOP_COMMAND = "codeSessions.loopEconomics.softStop";

/** Minimal session-row shape (SessionStore row or Insights mirror). */
export interface LoopSessionInput {
  session_id?: string | null;
  session?: string | null;
  source?: string | null;
  kind?: string | null;
  title?: string | null;
  first_user_msg?: string | null;
  entrypoint?: string | null;
  extras_json?: string | null;
  is_automated?: boolean | null;
  message_count?: number | null;
  messages?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  tokens_total?: number | null;
  cost_usd?: number | null;
  started_at?: number | null;
  ended_at?: number | null;
  mtime_ns?: number | null;
  mtime_epoch?: number | null;
}

export interface LoopGroup {
  /** Normalized job identity — same recurring prompt across runs/backends. */
  key: string;
  /** Human label (first run's title, un-normalized). */
  label: string;
  backends: string[];
  runs: number;
  totalTokens: number;
  tokensPerRun: number;
  totalCostUsd: number;
  messagesPerRun: number;
  /** True when no run recorded tokens (e.g. Grok) — messages/run is the
   * ranking proxy and the UI marks the figure approximate. */
  tokensProxy: boolean;
  /** Epoch ms of the most recent run's activity. */
  lastRunMs: number;
  sessionIds: string[];
}

export interface LoopEconomicsCard {
  groups: LoopGroup[];
  /** Automated sessions considered (before the min-runs grouping cut). */
  automatedSessions: number;
}

export interface LoopEconomicsOptions {
  /** Minimum runs for a group to count as a loop (default 2). Single-run
   * jobs whose labels already say loop/cron/schedule qualify regardless. */
  minRuns?: number;
  /** Max groups on the card (default 8). */
  maxGroups?: number;
  automation?: Partial<AutomationConfig>;
}

/** Labels that mark even a single run as schedule-shaped. */
const SCHEDULE_LABELS = ["loop", "cron", "schedule", "scheduled", "launchd", "routine", "night-loop"];

/**
 * Collapse a recurring job's per-run title variance (dates, times, uuids,
 * counters) so tonight's "Night IMPLEMENT 2026-09-07" and last night's group
 * together. Conservative: only volatile tokens are rewritten.
 */
export function normalizeLoopKey(title?: string | null, firstUserMsg?: string | null): string {
  const raw = (title || firstUserMsg || "").trim().toLowerCase();
  if (!raw) return "";
  return raw
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "#")
    .replace(/\d{4}-\d{2}-\d{2}/g, "#")
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

function tokensOf(r: LoopSessionInput): number {
  if (typeof r.tokens_total === "number") return r.tokens_total;
  return (r.input_tokens ?? 0) + (r.output_tokens ?? 0) + (r.cache_read_tokens ?? 0) + (r.cache_write_tokens ?? 0);
}

function lastActivityMs(r: LoopSessionInput): number {
  if (r.ended_at) return r.ended_at;
  if (r.started_at) return r.started_at;
  if (r.mtime_ns) return r.mtime_ns / 1e6;
  if (r.mtime_epoch) return r.mtime_epoch * 1000;
  return 0;
}

function extrasLabels(extras_json?: string | null): string[] {
  if (!extras_json) return [];
  try {
    const o = JSON.parse(extras_json);
    return Array.isArray(o?.labels) ? o.labels.map((x: unknown) => String(x).toLowerCase()) : [];
  } catch {
    return [];
  }
}

/** Aggregate automated sessions into ranked loop groups. */
export function computeLoopEconomics(
  rows: LoopSessionInput[],
  opts: LoopEconomicsOptions = {},
): LoopEconomicsCard {
  const minRuns = opts.minRuns ?? 2;
  const maxGroups = opts.maxGroups ?? 8;

  const automated = rows.filter((r) => {
    const kind = r.kind ?? "session";
    if (kind !== "session") return false; // subagent/workflow spend rolls into its parent
    return isAutomatedSession(r as AutomationMatchInput, opts.automation);
  });

  const byKey = new Map<string, { rows: LoopSessionInput[]; label: string }>();
  for (const r of automated) {
    const key = normalizeLoopKey(r.title, r.first_user_msg);
    if (!key) continue;
    const g = byKey.get(key);
    if (g) g.rows.push(r);
    else byKey.set(key, { rows: [r], label: (r.title || r.first_user_msg || "").trim().slice(0, 80) });
  }

  const groups: LoopGroup[] = [];
  for (const [key, g] of byKey) {
    const scheduleLabelled = g.rows.some((r) =>
      extrasLabels(r.extras_json).some((l) => SCHEDULE_LABELS.includes(l)),
    );
    if (g.rows.length < minRuns && !scheduleLabelled) continue;
    const runs = g.rows.length;
    const totalTokens = g.rows.reduce((n, r) => n + tokensOf(r), 0);
    const totalMessages = g.rows.reduce((n, r) => n + (r.message_count ?? r.messages ?? 0), 0);
    groups.push({
      key,
      label: g.label || key,
      backends: [...new Set(g.rows.map((r) => r.source || "claude"))].sort(),
      runs,
      totalTokens,
      tokensPerRun: totalTokens / runs,
      totalCostUsd: g.rows.reduce((n, r) => n + (r.cost_usd ?? 0), 0),
      messagesPerRun: totalMessages / runs,
      tokensProxy: totalTokens === 0,
      lastRunMs: Math.max(...g.rows.map(lastActivityMs)),
      sessionIds: g.rows
        .slice()
        .sort((a, b) => lastActivityMs(b) - lastActivityMs(a))
        .map((r) => r.session_id || r.session || "")
        .filter(Boolean),
    });
  }

  // Token-bearing groups rank by tokens/run; token-silent backends fall back
  // to messages/run among themselves (never above a token-measured group).
  groups.sort((a, b) => {
    if (a.tokensProxy !== b.tokensProxy) return a.tokensProxy ? 1 : -1;
    if (a.tokensProxy) return b.messagesPerRun - a.messagesPerRun;
    return b.tokensPerRun - a.tokensPerRun;
  });

  return { groups: groups.slice(0, maxGroups), automatedSessions: automated.length };
}

// --------------------------------------------------------------------------- //
// HTML
// --------------------------------------------------------------------------- //

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtTokShort(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${Math.round(n)}`;
}

function agoStr(ms: number, now: number): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export interface LoopEconHtmlOpts {
  /** Emit command: links (default true). Set false for restricted webviews. */
  commandUris?: boolean;
  now?: number;
}

function actionHref(command: string, group: LoopGroup): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([group.label, group.sessionIds]))}`;
}

/** Insights section ("" when no loop-shaped groups). */
export function renderLoopEconomicsSectionHtml(
  card: LoopEconomicsCard,
  opts: LoopEconHtmlOpts = {},
): string {
  if (card.groups.length === 0) return "";
  const now = opts.now ?? Date.now();
  const commandUris = opts.commandUris !== false;

  const rows = card.groups
    .map((g) => {
      const perRun = g.tokensProxy
        ? `~${g.messagesPerRun.toFixed(0)} msgs`
        : fmtTokShort(g.tokensPerRun);
      const actions = commandUris
        ? `<a class="lec-btn lec-kill" href="${actionHref(LOOP_KILL_COMMAND, g)}" title="Signal the host to stop this loop (asks to confirm first)">Kill</a>
           <a class="lec-btn" href="${actionHref(LOOP_REBIND_COMMAND, g)}" title="Link this loop's spend to a KP item">Rebind</a>
           <a class="lec-btn" href="${actionHref(LOOP_SOFT_STOP_COMMAND, g)}" title="Ask the loop to wrap up cleanly at its next tick">Soft-stop</a>`
        : "";
      return `<tr>
        <td class="lec-label" title="${esc(g.sessionIds.slice(0, 5).join(", "))}">${esc(g.label.slice(0, 60))}</td>
        <td>${esc(g.backends.join(" + "))}</td>
        <td class="num">${g.runs}</td>
        <td class="num"${g.tokensProxy ? ' title="Backend records no tokens; messages/run shown as proxy"' : ""}>${esc(perRun)}</td>
        <td class="num">${esc(g.tokensProxy ? "—" : fmtTokShort(g.totalTokens))}</td>
        <td>${esc(agoStr(g.lastRunMs, now))}</td>
        <td class="lec-actions">${actions}</td>
      </tr>`;
    })
    .join("");

  return `<section class="lec-card" data-schema="${esc(LOOP_ECON_SCHEMA)}">
  <div class="lec-head"><span class="lec-title">Loop runaway economics</span></div>
  <div class="lec-sub">${card.groups.length} loop/schedule-shaped job${card.groups.length === 1 ? "" : "s"} across ${card.automatedSessions} automated sessions, ranked by tokens/run.</div>
  <table class="lec-table"><tr><th>loop</th><th>backend</th><th>runs</th><th>tok/run</th><th>total</th><th>last run</th><th></th></tr>${rows}</table>
  <div class="lec-disclaimer">Read-only over the local session index — no vendor APIs. Kill/Rebind/Soft-stop signal the host; Kill always confirms before touching anything.</div>
</section>`;
}

/** CSS for Insights / harness — keep in sync with `.lec-*` markup above. */
export const LOOP_ECON_CARD_CSS = `
.lec-card { background: var(--card-bg, var(--vscode-editorWidget-background, #1e1e1e)); border: 1px solid var(--border, var(--vscode-panel-border, #333)); border-radius: 6px; padding: 12px 14px; margin-top: 8px; }
.lec-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; }
.lec-title { font-size: 11px; text-transform: uppercase; color: var(--muted, var(--vscode-descriptionForeground, #999)); letter-spacing: 0.5px; font-weight: 600; }
.lec-sub { font-size: 12px; color: var(--muted, var(--vscode-descriptionForeground, #999)); line-height: 1.45; margin-bottom: 8px; }
.lec-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 4px; }
.lec-table th, .lec-table td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--border, var(--vscode-panel-border, #333)); }
.lec-table th { color: var(--muted, var(--vscode-descriptionForeground, #999)); font-weight: 500; font-size: 10px; text-transform: uppercase; }
.lec-table td.num { font-variant-numeric: tabular-nums; text-align: right; }
.lec-table th:nth-child(3), .lec-table th:nth-child(4), .lec-table th:nth-child(5) { text-align: right; }
.lec-label { font-family: var(--vscode-editor-font-family, monospace); }
.lec-actions { white-space: nowrap; }
.lec-btn { font-size: 11px; color: var(--accent, var(--vscode-textLink-foreground, #6af)); text-decoration: none; font-weight: 500; margin-right: 8px; }
.lec-btn:hover { text-decoration: underline; }
.lec-kill { color: var(--vscode-inputValidation-errorForeground, #f88); }
.lec-disclaimer { font-size: 11px; color: var(--muted, var(--vscode-descriptionForeground, #999)); margin-top: 10px; line-height: 1.45; border-top: 1px solid var(--border, var(--vscode-panel-border, #333)); padding-top: 8px; }
`;
