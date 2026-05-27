// Insights dashboard webview. Static SVG charts (enableScripts:false-friendly),
// theme-aware colors via VS Code CSS variables.
//
// Two data sources:
//   1. The session-center.sh JSON output for cheap aggregates (cost / tokens /
//      counts / project mix / heatmap, across the last N sessions).
//   2. Parsed JSONL of the top M most-recent sessions for deep metrics
//      (thinking time, tool mix by count, top subagents). M is small
//      (default 20) because each JSONL is megabytes.

import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { parseConversation, ParsedConversation } from "./conversationParser";

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
  topic_counts?: Array<[string, number]>;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

function exec(
  cmd: string,
  args: string[],
  maxBuffer = 64 * 1024 * 1024,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer }, (err, stdout, stderr) => {
      const code = err ? (err as any).code ?? 1 : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });
}

// --------------------------------------------------------------------------- //
// Stat helpers
// --------------------------------------------------------------------------- //

function fmt$(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTok(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${n}`;
}

function fmtSec(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor(s.length * 0.95));
  return s[i];
}

// --------------------------------------------------------------------------- //
// SVG chart primitives
// --------------------------------------------------------------------------- //

function svgBarChart(
  values: { label: string; value: number; tooltip?: string }[],
  opts: { width?: number; height?: number; color?: string; format?: (v: number) => string } = {},
): string {
  const W = opts.width ?? 720;
  const H = opts.height ?? 160;
  const pad = { l: 8, r: 8, t: 18, b: 32 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;
  const max = Math.max(1, ...values.map((v) => v.value));
  const barW = (cw / values.length) * 0.72;
  const gap = (cw / values.length) * 0.28;
  const color = opts.color ?? "var(--accent)";
  const fmt = opts.format ?? ((v) => v.toFixed(0));
  const bars = values
    .map((v, i) => {
      const x = pad.l + i * (barW + gap) + gap / 2;
      const h = v.value > 0 ? (v.value / max) * ch : 0;
      const y = pad.t + ch - h;
      const titleText = v.tooltip ?? `${v.label}: ${fmt(v.value)}`;
      return `
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" rx="2">
          <title>${escapeHtml(titleText)}</title>
        </rect>
        <text x="${(x + barW / 2).toFixed(1)}" y="${(pad.t + ch + 14).toFixed(0)}" text-anchor="middle" class="bar-label">${escapeHtml(v.label)}</text>
        ${v.value > 0 ? `<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 4).toFixed(0)}" text-anchor="middle" class="bar-value">${escapeHtml(fmt(v.value))}</text>` : ""}`;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart bar">${bars}</svg>`;
}

function svgStackedBarChart(
  values: { label: string; segments: { kind: string; value: number; color: string }[] }[],
  opts: { width?: number; height?: number; format?: (v: number) => string } = {},
): string {
  const W = opts.width ?? 720;
  const H = opts.height ?? 180;
  const pad = { l: 8, r: 8, t: 18, b: 36 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;
  const totals = values.map((v) => v.segments.reduce((n, s) => n + s.value, 0));
  const max = Math.max(1, ...totals);
  const barW = (cw / values.length) * 0.72;
  const gap = (cw / values.length) * 0.28;
  const fmt = opts.format ?? ((v) => v.toFixed(0));
  const bars = values
    .map((v, i) => {
      const x = pad.l + i * (barW + gap) + gap / 2;
      let yCursor = pad.t + ch;
      const total = totals[i];
      const segs = v.segments
        .map((s) => {
          const h = total > 0 ? (s.value / max) * ch : 0;
          yCursor -= h;
          return `<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${s.color}"><title>${escapeHtml(`${v.label} · ${s.kind}: ${fmt(s.value)}`)}</title></rect>`;
        })
        .join("");
      return `
        ${segs}
        <text x="${(x + barW / 2).toFixed(1)}" y="${(pad.t + ch + 14).toFixed(0)}" text-anchor="middle" class="bar-label">${escapeHtml(v.label)}</text>
        ${total > 0 ? `<text x="${(x + barW / 2).toFixed(1)}" y="${(pad.t + ch - (total / max) * ch - 4).toFixed(0)}" text-anchor="middle" class="bar-value">${escapeHtml(fmt(total))}</text>` : ""}`;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart bar">${bars}</svg>`;
}

function svgHBarChart(
  values: { label: string; value: number; tooltip?: string }[],
  opts: { width?: number; rowH?: number; color?: string; format?: (v: number) => string } = {},
): string {
  const W = opts.width ?? 720;
  const rowH = opts.rowH ?? 18;
  const labelW = 220;
  const valLabelW = 70;
  const trackX = labelW;
  const trackW = W - labelW - valLabelW - 8;
  const max = Math.max(1, ...values.map((v) => v.value));
  const color = opts.color ?? "var(--accent)";
  const fmt = opts.format ?? ((v) => v.toFixed(0));
  const H = rowH * values.length + 4;
  // Truncate labels that won't fit (e.g. mcp__claude-in-chrome__browser_batch).
  // Allow ~32 chars (roughly the labelW budget at 10px font on a 720 viewBox).
  const MAX_LABEL = 32;
  const rows = values
    .map((v, i) => {
      const y = i * rowH + 2;
      const barW = (v.value / max) * trackW;
      const labelText =
        v.label.length > MAX_LABEL ? v.label.slice(0, MAX_LABEL - 1) + "…" : v.label;
      const labelTitle = v.label !== labelText ? `<title>${escapeHtml(v.label)}</title>` : "";
      return `
        <text x="${labelW - 6}" y="${(y + rowH * 0.66).toFixed(1)}" text-anchor="end" class="bar-label">${escapeHtml(labelText)}${labelTitle}</text>
        <rect x="${trackX}" y="${(y + 3).toFixed(0)}" width="${trackW}" height="${(rowH - 6).toFixed(0)}" class="hbar-track"/>
        <rect x="${trackX}" y="${(y + 3).toFixed(0)}" width="${barW.toFixed(1)}" height="${(rowH - 6).toFixed(0)}" fill="${color}" rx="2">
          <title>${escapeHtml(v.tooltip ?? `${v.label}: ${fmt(v.value)}`)}</title>
        </rect>
        <text x="${(trackX + trackW + 4).toFixed(0)}" y="${(y + rowH * 0.66).toFixed(1)}" text-anchor="start" class="bar-value">${escapeHtml(fmt(v.value))}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart hbar">${rows}</svg>`;
}

function svgHeatmap(
  // matrix[dayOfWeek 0=Sun][hour 0..23] = sessionCount
  matrix: number[][],
  opts: { width?: number } = {},
): string {
  const W = opts.width ?? 720;
  const padL = 36;
  const padT = 18;
  const padR = 8;
  const cellW = (W - padL - padR) / 24;
  const cellH = cellW * 0.85;
  const H = padT + 7 * cellH + 20;
  const max = Math.max(1, ...matrix.flat());
  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const cells: string[] = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const v = matrix[d][h] || 0;
      const intensity = v / max;
      const x = padL + h * cellW;
      const y = padT + d * cellH;
      cells.push(
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cellW.toFixed(1)}" height="${cellH.toFixed(1)}" fill="var(--accent)" fill-opacity="${(intensity * 0.9).toFixed(2)}">
           <title>${dayLabels[d]} ${String(h).padStart(2, "0")}:00 — ${v} sessions</title>
         </rect>`,
      );
    }
  }
  const hourTicks = [0, 6, 12, 18, 23]
    .map(
      (h) =>
        `<text x="${(padL + h * cellW + cellW / 2).toFixed(1)}" y="${(padT + 7 * cellH + 14).toFixed(0)}" text-anchor="middle" class="bar-label">${String(h).padStart(2, "0")}</text>`,
    )
    .join("");
  const dayTicks = dayLabels
    .map(
      (d, i) =>
        `<text x="${(padL - 4).toFixed(0)}" y="${(padT + i * cellH + cellH * 0.66).toFixed(1)}" text-anchor="end" class="bar-label">${d}</text>`,
    )
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart heatmap">${cells}${hourTicks}${dayTicks}</svg>`;
}

function svgHistogram(
  values: number[],
  bins: number[],
  binLabels: string[],
  opts: { width?: number; height?: number; color?: string } = {},
): string {
  const counts = new Array(binLabels.length).fill(0) as number[];
  for (const v of values) {
    let b = 0;
    for (let i = 0; i < bins.length; i++) {
      if (v <= bins[i]) {
        b = i;
        break;
      }
      b = bins.length; // exceeds last bin
    }
    counts[Math.min(b, counts.length - 1)]++;
  }
  return svgBarChart(
    binLabels.map((l, i) => ({ label: l, value: counts[i], tooltip: `${l}: ${counts[i]} sessions` })),
    { width: opts.width, height: opts.height, color: opts.color },
  );
}

// --------------------------------------------------------------------------- //
// Aggregations
// --------------------------------------------------------------------------- //

interface DayBucket {
  isoDate: string;
  cost: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  sessions: number;
  subagents: number;
}

function dailyBuckets(rows: SessionRow[], days: number): DayBucket[] {
  // Use the session's first_ts_epoch if present, else mtime_epoch.
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const todayStart = startOfDay(now);
  const buckets: Record<string, DayBucket> = {};
  for (let i = 0; i < days; i++) {
    const t = todayStart - i * 86400_000;
    const iso = new Date(t).toISOString().slice(0, 10);
    buckets[iso] = {
      isoDate: iso,
      cost: 0,
      tokensInput: 0,
      tokensOutput: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      sessions: 0,
      subagents: 0,
    };
  }
  for (const r of rows) {
    const ts = (r.first_ts_epoch || r.mtime_epoch) * 1000;
    if (!ts) continue;
    if (ts < todayStart - days * 86400_000) continue;
    const iso = new Date(ts).toISOString().slice(0, 10);
    const b = buckets[iso];
    if (!b) continue;
    b.cost += r.cost_usd;
    b.tokensInput += r.tokens_input;
    b.tokensOutput += r.tokens_output;
    b.tokensCacheRead += r.tokens_cache_read;
    b.tokensCacheWrite += r.tokens_cache_write;
    b.sessions += 1;
    b.subagents += r.subagents || 0;
  }
  return Object.values(buckets).sort((a, b) => a.isoDate.localeCompare(b.isoDate));
}

function projectMix(rows: SessionRow[]): { project: string; cost: number; sessions: number }[] {
  // Each session contributes to all its touched projects, weighted equally.
  const acc = new Map<string, { cost: number; sessions: number }>();
  for (const r of rows) {
    const projs = r.projects_touched.length > 0 ? r.projects_touched : [r.project || "(unknown)"];
    const share = 1 / projs.length;
    for (const p of projs) {
      const cur = acc.get(p) ?? { cost: 0, sessions: 0 };
      cur.cost += r.cost_usd * share;
      cur.sessions += 1;
      acc.set(p, cur);
    }
  }
  return Array.from(acc.entries())
    .map(([project, v]) => ({ project, ...v }))
    .sort((a, b) => b.cost - a.cost);
}

/** Richer per-project rollup for the Insights table. Cost is split across
 * touched projects (matches `projectMix`); tokens use the same split. */
interface ProjectRollup {
  project: string;
  sessions: number;
  cost: number;
  tokens: number;
  subagents: number;
  lastActiveEpoch: number; // mtime_epoch (sec) of most-recent session
  topTopic: string | null;
}
function projectRollup(rows: SessionRow[]): ProjectRollup[] {
  const acc = new Map<string, {
    sessions: number;
    cost: number;
    tokens: number;
    subagents: number;
    lastActiveEpoch: number;
    topicCounts: Map<string, number>;
  }>();
  for (const r of rows) {
    const projs = r.projects_touched.length > 0 ? r.projects_touched : [r.project || "(unknown)"];
    const share = 1 / projs.length;
    for (const p of projs) {
      const cur = acc.get(p) ?? {
        sessions: 0, cost: 0, tokens: 0, subagents: 0, lastActiveEpoch: 0,
        topicCounts: new Map<string, number>(),
      };
      cur.sessions += 1;
      cur.cost += r.cost_usd * share;
      cur.tokens += (r.tokens_total ?? 0) * share;
      cur.subagents += (r.subagents ?? 0) * share;
      if ((r.mtime_epoch ?? 0) > cur.lastActiveEpoch) cur.lastActiveEpoch = r.mtime_epoch;
      // Roll up the session's top topics (if classified) into the project bucket.
      if (r.topic_counts && r.topic_counts.length > 0) {
        for (const [topic, n] of r.topic_counts) {
          cur.topicCounts.set(topic, (cur.topicCounts.get(topic) ?? 0) + n);
        }
      }
      acc.set(p, cur);
    }
  }
  return Array.from(acc.entries())
    .map(([project, v]) => {
      let topTopic: string | null = null;
      let bestN = 0;
      for (const [t, n] of v.topicCounts) if (n > bestN) { bestN = n; topTopic = t; }
      return {
        project,
        sessions: v.sessions,
        cost: v.cost,
        tokens: Math.round(v.tokens),
        subagents: Math.round(v.subagents),
        lastActiveEpoch: v.lastActiveEpoch,
        topTopic,
      };
    })
    .sort((a, b) => b.cost - a.cost);
}

function hourDayHeatmap(rows: SessionRow[]): number[][] {
  // [dayOfWeek 0=Sun][hour 0..23]
  const m: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of rows) {
    const ts = (r.first_ts_epoch || r.mtime_epoch) * 1000;
    if (!ts) continue;
    const d = new Date(ts);
    const dow = d.getDay();
    const h = d.getHours();
    m[dow][h] += 1;
  }
  return m;
}

// --------------------------------------------------------------------------- //
// Deep metrics (top N parsed JSONLs)
// --------------------------------------------------------------------------- //

async function locateJsonl(sessionId: string): Promise<string | null> {
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  try {
    const dirs = await vscode.workspace.fs.readDirectory(vscode.Uri.file(projectsRoot));
    for (const [dirName, kind] of dirs) {
      if (kind !== vscode.FileType.Directory) continue;
      const candidate = path.join(projectsRoot, dirName, `${sessionId}.jsonl`);
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
        return candidate;
      } catch {
        // try next
      }
    }
  } catch {
    return null;
  }
  return null;
}

interface DeepMetrics {
  parsedSessions: number;
  thinkingTimeMsList: number[];
  burstCount: number; // gaps < 5s
  totalGaps: number;
  toolCounts: Record<string, number>;
}

async function computeDeepMetrics(rows: SessionRow[], maxToParse: number): Promise<DeepMetrics> {
  const out: DeepMetrics = {
    parsedSessions: 0,
    thinkingTimeMsList: [],
    burstCount: 0,
    totalGaps: 0,
    toolCounts: {},
  };
  const targets = rows.slice(0, maxToParse);
  for (const r of targets) {
    const f = await locateJsonl(r.session);
    if (!f) continue;
    try {
      const parsed: ParsedConversation = parseConversation(f);
      out.parsedSessions += 1;
      for (const gap of parsed.summary.userThinkingMsList) {
        out.thinkingTimeMsList.push(gap);
        out.totalGaps += 1;
        if (gap < 5000) out.burstCount += 1;
      }
      for (const [k, v] of Object.entries(parsed.summary.toolCountsByName)) {
        out.toolCounts[k] = (out.toolCounts[k] ?? 0) + v;
      }
    } catch {
      // ignore parse failures
    }
  }
  return out;
}

// --------------------------------------------------------------------------- //
// HTML composition
// --------------------------------------------------------------------------- //

const STYLE = `
:root {
  --bg: var(--vscode-editor-background);
  --fg: var(--vscode-editor-foreground);
  --muted: var(--vscode-descriptionForeground);
  --border: var(--vscode-panel-border);
  --accent: var(--vscode-charts-blue, var(--vscode-textLink-foreground));
  --card-bg: var(--vscode-sideBar-background);
}
body { font-family: var(--vscode-font-family); color: var(--fg); background: var(--bg); margin: 0; padding: 16px 24px; }
h1 { margin: 0 0 4px 0; font-size: 18px; }
h2 { margin: 24px 0 8px 0; font-size: 14px; }
.subtitle { color: var(--muted); font-size: 11px; margin-bottom: 16px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.kpi { background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; }
.kpi .label { font-size: 10px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.5px; }
.kpi .value { font-size: 20px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
.kpi .sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
.card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px 14px; margin-top: 8px; }
.card-title { font-size: 11px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.5px; margin-bottom: 8px; }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 900px) { .row2 { grid-template-columns: 1fr; } }
svg.chart { width: 100%; height: auto; display: block; }
/* No text-anchor here — set inline so vertical (middle) and horizontal (end) charts don't fight CSS specificity. */
svg .bar-label { fill: var(--muted); font-size: 10px; font-family: var(--vscode-font-family); }
svg .bar-value { fill: var(--fg); font-size: 9px; font-family: var(--vscode-font-family); }
svg .hbar-track { fill: var(--border); fill-opacity: 0.4; }
.legend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 8px; font-size: 11px; color: var(--muted); }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
table.top-sessions { width: 100%; border-collapse: collapse; font-size: 12px; }
table.top-sessions th { text-align: left; padding: 6px 4px; border-bottom: 1px solid var(--border); color: var(--muted); font-weight: 600; font-size: 10px; text-transform: uppercase; }
table.top-sessions td { padding: 5px 4px; border-bottom: 1px solid var(--border); }
table.top-sessions td.num { text-align: right; font-variant-numeric: tabular-nums; }
table.top-sessions tr:last-child td { border-bottom: none; }
table.project-rollup { width: 100%; border-collapse: collapse; font-size: 12px; }
table.project-rollup th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); color: var(--muted); font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
table.project-rollup td { padding: 6px 8px; border-bottom: 1px solid var(--border); }
table.project-rollup td.num { text-align: right; font-variant-numeric: tabular-nums; }
table.project-rollup tr:last-child td { border-bottom: none; }
table.project-rollup tr:hover td { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.06)); }
table.project-rollup code { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
.muted { color: var(--muted); font-style: italic; }
`;

function renderDashboard(opts: {
  rows: SessionRow[];
  deep: DeepMetrics;
  lookbackDays: number;
  showAutomated: boolean;
  parsedCount: number;
}): string {
  const { rows, deep, lookbackDays, showAutomated, parsedCount } = opts;

  // ---------- KPIs ---------- //
  const totalCost = rows.reduce((n, r) => n + r.cost_usd, 0);
  const totalTokens = rows.reduce((n, r) => n + r.tokens_total, 0);
  const totalSubagents = rows.reduce((n, r) => n + (r.subagents || 0), 0);
  const totalMessages = rows.reduce((n, r) => n + r.messages, 0);
  const sessions = rows.length;
  const avgCost = sessions > 0 ? totalCost / sessions : 0;
  const avgMessages = sessions > 0 ? totalMessages / sessions : 0;

  // ---------- Daily buckets ---------- //
  const buckets = dailyBuckets(rows, lookbackDays);
  const costSeries = buckets.map((b) => ({
    label: b.isoDate.slice(5), // MM-DD
    value: Number(b.cost.toFixed(2)),
    tooltip: `${b.isoDate}: ${fmt$(b.cost)} · ${b.sessions} sessions`,
  }));
  const tokenStack = buckets.map((b) => ({
    label: b.isoDate.slice(5),
    segments: [
      { kind: "input", value: b.tokensInput, color: "var(--vscode-charts-blue, #4c9aff)" },
      { kind: "output", value: b.tokensOutput, color: "var(--vscode-charts-orange, #ff9c3a)" },
      { kind: "cache R", value: b.tokensCacheRead, color: "var(--vscode-charts-green, #5eba7d)" },
      { kind: "cache W", value: b.tokensCacheWrite, color: "var(--vscode-charts-purple, #b283c4)" },
    ],
  }));

  // ---------- Project mix ---------- //
  const projects = projectMix(rows).slice(0, 12);
  const projectChart = svgHBarChart(
    projects.map((p) => ({
      label: p.project,
      value: Number(p.cost.toFixed(2)),
      tooltip: `${p.project}: ${fmt$(p.cost)} · ${p.sessions} sessions touched`,
    })),
    { width: 720, color: "var(--vscode-charts-blue, #4c9aff)", format: fmt$ },
  );

  // ---------- Project rollup table ---------- //
  const rollup = projectRollup(rows).slice(0, 24);
  const agoStr = (epochSec: number): string => {
    if (!epochSec) return "—";
    const diffSec = Math.max(0, Math.floor(Date.now() / 1000 - epochSec));
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
  };
  const projectTable = rollup.length === 0
    ? '<div class="subtitle">No projects to rollup yet.</div>'
    : `
    <table class="project-rollup">
      <thead>
        <tr>
          <th>Project</th>
          <th class="num">Sessions</th>
          <th class="num">Cost</th>
          <th class="num">Tokens</th>
          <th class="num">🪄</th>
          <th>Top topic</th>
          <th>Last active</th>
        </tr>
      </thead>
      <tbody>
        ${rollup.map((p) => `
        <tr>
          <td><code>${escapeHtml(p.project)}</code></td>
          <td class="num">${p.sessions.toLocaleString()}</td>
          <td class="num">${escapeHtml(fmt$(p.cost))}</td>
          <td class="num">${escapeHtml(fmtTok(p.tokens))}</td>
          <td class="num">${p.subagents > 0 ? p.subagents : ""}</td>
          <td>${p.topTopic ? escapeHtml(p.topTopic) : '<span class="muted">(unclassified)</span>'}</td>
          <td>${escapeHtml(agoStr(p.lastActiveEpoch))}</td>
        </tr>`).join("")}
      </tbody>
    </table>`;

  // ---------- Heatmap ---------- //
  const heat = hourDayHeatmap(rows);
  const heatChart = svgHeatmap(heat, { width: 720 });

  // ---------- Cost histogram ---------- //
  const histChart = svgHistogram(
    rows.map((r) => r.cost_usd),
    [0.5, 2, 10, 50, 200, 1000],
    ["<$0.50", "<$2", "<$10", "<$50", "<$200", "<$1K", "≥$1K"],
    { width: 720, color: "var(--vscode-charts-purple, #b283c4)" },
  );

  // ---------- Top sessions ---------- //
  const top = [...rows].sort((a, b) => b.cost_usd - a.cost_usd).slice(0, 10);
  const topTable = `
    <table class="top-sessions">
      <thead>
        <tr>
          <th>Title</th>
          <th class="num">$</th>
          <th class="num">msgs</th>
          <th class="num">🪄</th>
          <th class="num">tok</th>
          <th>date</th>
        </tr>
      </thead>
      <tbody>
        ${top
          .map(
            (r) => `
        <tr>
          <td>${escapeHtml((r.title || r.session.slice(0, 8)).slice(0, 70))}</td>
          <td class="num">${escapeHtml(fmt$(r.cost_usd))}</td>
          <td class="num">${r.messages.toLocaleString()}</td>
          <td class="num">${r.subagents || ""}</td>
          <td class="num">${escapeHtml(fmtTok(r.tokens_total))}</td>
          <td>${escapeHtml(r.modified)}</td>
        </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;

  // ---------- Deep metrics ---------- //
  const thinkMed = median(deep.thinkingTimeMsList) / 1000;
  const thinkP95 = p95(deep.thinkingTimeMsList) / 1000;
  const burstPct =
    deep.totalGaps > 0 ? (100 * deep.burstCount) / deep.totalGaps : 0;
  const toolSorted = Object.entries(deep.toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const toolChart =
    toolSorted.length > 0
      ? svgHBarChart(
          toolSorted.map(([name, count]) => ({
            label: name,
            value: count,
            tooltip: `${name}: ${count.toLocaleString()} calls`,
          })),
          { width: 720, color: "var(--vscode-charts-green, #5eba7d)" },
        )
      : '<div class="subtitle">Parse a few sessions to populate (lower priority).</div>';

  // ---------- HTML ---------- //
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src data:;">
<style>${STYLE}</style>
</head><body>
<h1>Claude Code · Insights</h1>
<div class="subtitle">Last ${lookbackDays} days · ${rows.length} sessions (${showAutomated ? "incl. automated" : "interactive only"}) · deep metrics from top ${parsedCount} parsed</div>

<section class="kpis">
  <div class="kpi"><div class="label">Cost</div><div class="value">${escapeHtml(fmt$(totalCost))}</div><div class="sub">avg ${escapeHtml(fmt$(avgCost))}/session</div></div>
  <div class="kpi"><div class="label">Tokens</div><div class="value">${escapeHtml(fmtTok(totalTokens))}</div><div class="sub">${rows.length} sessions</div></div>
  <div class="kpi"><div class="label">Messages</div><div class="value">${totalMessages.toLocaleString()}</div><div class="sub">avg ${avgMessages.toFixed(0)}/session</div></div>
  <div class="kpi"><div class="label">Subagents</div><div class="value">${totalSubagents.toLocaleString()}</div><div class="sub">across all sessions</div></div>
  <div class="kpi"><div class="label">Thinking time</div><div class="value">${thinkMed.toFixed(1)}s</div><div class="sub">median, p95 ${thinkP95.toFixed(0)}s</div></div>
  <div class="kpi"><div class="label">Burst rate</div><div class="value">${burstPct.toFixed(0)}%</div><div class="sub">replies in &lt;5s</div></div>
</section>

<h2>Daily cost (last ${lookbackDays} days)</h2>
<div class="card">${svgBarChart(costSeries, { color: "var(--vscode-charts-blue, #4c9aff)", format: fmt$ })}</div>

<h2>Daily tokens by type</h2>
<div class="card">
  ${svgStackedBarChart(tokenStack, { format: fmtTok })}
  <div class="legend">
    <span><span class="swatch" style="background: var(--vscode-charts-blue, #4c9aff)"></span>input</span>
    <span><span class="swatch" style="background: var(--vscode-charts-orange, #ff9c3a)"></span>output</span>
    <span><span class="swatch" style="background: var(--vscode-charts-green, #5eba7d)"></span>cache read</span>
    <span><span class="swatch" style="background: var(--vscode-charts-purple, #b283c4)"></span>cache write</span>
  </div>
</div>

<div class="row2" style="margin-top: 8px;">
  <div>
    <h2 style="margin-top:0">When you Claude (by hour × day)</h2>
    <div class="card">${heatChart}</div>
  </div>
  <div>
    <h2 style="margin-top:0">Cost distribution</h2>
    <div class="card">${histChart}</div>
  </div>
</div>

<h2>Top projects by cost</h2>
<div class="card">${projectChart}</div>

<h2>Project rollup</h2>
<div class="card">
  <div class="subtitle">Per-project totals over the last ${lookbackDays} days. Tokens and cost are split evenly when a session touched multiple projects (matches "Top projects").</div>
  ${projectTable}
</div>

<h2>Tool usage (top ${toolSorted.length})</h2>
<div class="card">
  <div class="subtitle">From the ${deep.parsedSessions} most-recent sessions parsed deeply.</div>
  ${toolChart}
</div>

<h2>Top 10 expensive sessions</h2>
<div class="card">${topTable}</div>

<h2 style="margin-top: 28px;">How you work</h2>
<div class="card">
  <p style="font-size: 12px; line-height: 1.5; margin: 0;">
    Of ${deep.totalGaps.toLocaleString()} measured turn-gaps across ${deep.parsedSessions} sessions:
    <br>
    • <b>${deep.burstCount.toLocaleString()}</b> were &lt;5s — the &ldquo;flow&rdquo; replies, where you barely paused.
    <br>
    • Median pause between Claude finishing and your reply: <b>${thinkMed.toFixed(1)}s</b>; p95 <b>${thinkP95.toFixed(0)}s</b>.
    <br>
    • Total time-in-tools across the parsed sessions: <b>${escapeHtml(
      fmtSec(Object.values(deep.toolCounts).reduce((n, v) => n + v, 0) > 0 ? thinkMed * 0 : 0),
    )}</b>
    (not measured here; see the per-conversation viewer for that breakdown).
  </p>
</div>

</body></html>`;
}

// --------------------------------------------------------------------------- //
// Entry point
// --------------------------------------------------------------------------- //

export async function openInsightsView(ctx: vscode.ExtensionContext, store?: import("./db").SessionStore | null): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("claudeSessions");
  const limit = cfg.get<number>("limit", 100);
  const showAutomated = cfg.get<boolean>("showAutomated", false);
  const cacheEnabled = cfg.get<boolean>("cacheEnabled", true);
  const scriptPath = expandHome(
    cfg.get<string>("scriptPath", "~/.claude/skills/sessions/session-center.sh"),
  );
  const lookbackDays = cfg.get<number>("insightsLookbackDays", 14);
  const deepParseMax = cfg.get<number>("insightsDeepParse", 20);

  const panel = vscode.window.createWebviewPanel(
    "claudeInsights",
    "Claude · Insights",
    vscode.ViewColumn.Active,
    { enableScripts: false, retainContextWhenHidden: true },
  );
  panel.webview.html = `<body style="padding:24px;font-family:var(--vscode-font-family);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);">Loading…</body>`;

  let allRows: SessionRow[];

  // Fast path: SQLite cache (default).
  if (cacheEnabled && store) {
    try {
      const dbRows = store.listRecent(limit, true);
      allRows = dbRows.map((r) => ({
        mtime_epoch: Math.floor(r.mtime_ns / 1e9),
        active: " ",
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
      }));
    } catch (e: any) {
      panel.webview.html = `<pre style="padding:24px;">SQLite read failed: ${escapeHtml(e?.message || String(e))}</pre>`;
      return;
    }
  } else {
    // Fallback: shell script (v0.6.x behavior).
    const { stdout, code, stderr } = await exec("bash", [scriptPath, "recent", String(limit), "json"]);
    if (code !== 0) {
      panel.webview.html = `<pre style="padding:24px;">session-center.sh failed (exit ${code})\n\n${escapeHtml(stderr)}</pre>`;
      return;
    }
    try {
      allRows = JSON.parse(stdout) as SessionRow[];
    } catch (e: any) {
      panel.webview.html = `<pre style="padding:24px;">JSON parse failed: ${escapeHtml(e?.message || String(e))}</pre>`;
      return;
    }
  }

  // Filter to interactive vs. include automated based on the same setting the
  // tree uses, so the dashboard tells the user about the work they actually drove.
  const filtered = allRows.filter((r) => showAutomated || !r.is_automated);

  // Limit to the lookback window (cost / heatmap / etc.).
  const nowSec = Math.floor(Date.now() / 1000);
  const winStart = nowSec - lookbackDays * 86400;
  const winRows = filtered.filter((r) => (r.first_ts_epoch || r.mtime_epoch) >= winStart);

  const deep = await computeDeepMetrics(winRows, deepParseMax);

  panel.webview.html = renderDashboard({
    rows: winRows,
    deep,
    lookbackDays,
    showAutomated,
    parsedCount: deep.parsedSessions,
  });
}
