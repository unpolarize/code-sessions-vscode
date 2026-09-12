// Incremental disk → SQLite sync for Grok Build CLI sessions.
//
// Strategy: walk ~/.grok/sessions/<urlencoded-cwd>/<uuid>/, compare each
// chat_history.jsonl against the cached (mtime_ns, size_bytes), parse and
// upsert only the diff. Mirrors the claude jsonlIndexer.ts contract so the
// same SessionStore + downstream consumers (classifier, KB rollups, search)
// just work on the merged corpus.
//
// Grok session layout differs from claude in three ways that we normalise
// here:
//   1. Per-cwd partitioning: cwd is URL-encoded as the parent folder name
//      (e.g. `%2FUsers%2Fyou%2Fproject`), and each session is a folder,
//      not a single file.
//   2. Two files per session: `summary.json` (metadata: title, model,
//      cwd, dates, message counts) and `chat_history.jsonl` (event stream).
//   3. Events lack per-event timestamps. We synthesise them from
//      `summary.created_at` + the line ordinal so downstream ordering still
//      works (cross-session correlation isn't claimed).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SessionStore, SessionRow, TurnRow } from "./db";
import { GrokTurn, parseGrokConversation } from "./grokConversationParser";
import {
  firstMeaningfulUserText,
  isAutomatedSession,
  isHumanContinuedSession,
  laterMeaningfulUserTexts,
  mergeAutomationExtras,
} from "./automation";
import {
  estimateGrokCostUsd,
  grokCostStampPresent,
  grokUsageFromBlob,
  type GrokCostTokenSource,
} from "./grokPricing";

export const GROK_SESSIONS_ROOT = path.join(os.homedir(), ".grok", "sessions");

/** Find `chat_history.jsonl` for a grok session id without the SQLite index.
 * Layout is `~/.grok/sessions/<urlencoded-cwd>/<uuid>/chat_history.jsonl`. */
export function locateGrokChatHistory(sessionId: string, root = GROK_SESSIONS_ROOT): string | null {
  if (!sessionId || !fs.existsSync(root)) return null;
  const direct = path.join(root, sessionId, "chat_history.jsonl");
  if (fs.existsSync(direct)) return direct;
  let cwdDirs: fs.Dirent[];
  try {
    cwdDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const cwdDir of cwdDirs) {
    if (!cwdDir.isDirectory()) continue;
    const chatPath = path.join(root, cwdDir.name, sessionId, "chat_history.jsonl");
    if (fs.existsSync(chatPath)) return chatPath;
  }
  return null;
}

function sessionInfoFromChatPath(chatPath: string): GrokSessionInfo | null {
  const sessionDir = path.dirname(chatPath);
  const summaryPath = path.join(sessionDir, "summary.json");
  if (!fs.existsSync(chatPath) || !fs.existsSync(summaryPath)) return null;
  try {
    const st = fs.statSync(chatPath);
    return {
      sessionDir,
      chatPath,
      summaryPath,
      mtime_ns: grokCacheMtimeNs(sessionDir, st),
      size_bytes: st.size,
    };
  } catch {
    return null;
  }
}

/** Cache key mtime: chat_history plus usage.json so a late token ledger
 * invalidates a row that was indexed from signals-only / $0.00. */
function grokCacheMtimeNs(sessionDir: string, chatStat: fs.Stats): number {
  let mtime = chatStat.mtimeMs * 1e6;
  try {
    const usageStat = fs.statSync(path.join(sessionDir, "usage.json"));
    mtime = Math.max(mtime, usageStat.mtimeMs * 1e6);
  } catch {
    /* no usage.json */
  }
  return mtime;
}

// Truncations match the claude indexer so the downstream classifier sees
// comparable text lengths regardless of source.
const USER_TEXT_MAX = 4096;
const ASSISTANT_EXCERPT_MAX = 1024;
// Full-text search column cap (migration v17); NULL when the excerpt holds it all.
const ASSISTANT_FULL_MAX = 64 * 1024;

export interface GrokSessionInfo {
  /** Session folder, e.g. `<root>/%2FUsers%2Fyou%2Fproject/<uuid>/`. */
  sessionDir: string;
  chatPath: string;
  summaryPath: string;
  mtime_ns: number;
  size_bytes: number;
}

interface GrokSummary {
  info?: { id?: string; cwd?: string };
  session_summary?: string;
  generated_title?: string;
  created_at?: string;
  updated_at?: string;
  last_active_at?: string;
  num_messages?: number;
  num_chat_messages?: number;
  current_model_id?: string;
  head_branch?: string;
  agent_name?: string;
  /** "claude_import" identifies grok sessions that were imported from
   * `~/.claude/projects/`. These keep the original claude session UUID and
   * carry inferior fidelity (no token usage, no per-event timestamps) — we
   * skip them at indexing time so the claude-side row remains canonical and
   * its topic classifications don't get clobbered by an UPSERT collision. */
  session_kind?: string;
}

/** Telemetry sidecar grok writes per session. Not all fields appear in every
 * session (older grok versions emit fewer); everything here is optional. */
interface GrokSignals {
  turnCount?: number;
  userMessageCount?: number;
  assistantMessageCount?: number;
  toolCallCount?: number;
  toolsUsed?: string[];
  modelsUsed?: string[];
  primaryModelId?: string;
  /** Tokens currently resident in the context window — closest proxy grok
   * exposes to "input tokens used this session". Doesn't separate input /
   * output, doesn't break out cache hits. Still useful as a "how big did
   * this conversation get". */
  contextTokensUsed?: number;
  contextWindowTokens?: number;
  /** Cumulative tokens that fell off the front of the context window via
   * compaction events. Non-zero only after a /compact (rare). */
  totalTokensBeforeCompaction?: number;
  compactionCount?: number;
  /** File-edit volume from grok's own diff accounting. */
  agentLinesAdded?: number;
  agentLinesRemoved?: number;
  agentFilesTouched?: number;
  /** Latency telemetry (ms) — used by future Insights drilldowns. */
  avgTimeToFirstTokenMs?: number;
  avgResponseTimeMs?: number;
  /** Peak resident-set-size of the grok process — proxies "how much RAM
   * did the local CLI need", complementing remote-API tokens. */
  peakRssBytes?: number;
  sessionDurationSeconds?: number;
}

/** URL-decode the cwd folder name. Falls back to the raw name if decoding
 * fails (which would happen on a corrupt session dir). */
function decodeCwd(folderName: string): string {
  try {
    return decodeURIComponent(folderName);
  } catch {
    return folderName;
  }
}

function projectIdFromCwd(cwd: string): string | null {
  const segs = cwd.split("/").filter(Boolean);
  if (segs.length >= 5 && segs[2] === "projects" && segs[3] === "ai") return `ai/${segs[4]}`;
  if (segs.length >= 4 && segs[2] === "projects") return segs[3];
  if (segs.length >= 3 && segs[2] === "docs") return "docs";
  return segs.slice(2).join("/") || null;
}

/** Walk ~/.grok/sessions/* / * /  and collect (path, mtime, size) for every
 * chat_history.jsonl. Each grok session is a *directory* (uuid) under a
 * cwd-encoded parent; we key the cache by the chat_history.jsonl path so
 * mtime/size cache invalidation works exactly like the claude indexer. */
export function listAllGrokSessions(root = GROK_SESSIONS_ROOT): GrokSessionInfo[] {
  if (!fs.existsSync(root)) return [];
  const out: GrokSessionInfo[] = [];
  let cwdDirs: fs.Dirent[];
  try {
    cwdDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const cwdDir of cwdDirs) {
    if (!cwdDir.isDirectory()) continue;
    const cwdPath = path.join(root, cwdDir.name);
    let sessionDirs: fs.Dirent[];
    try {
      sessionDirs = fs.readdirSync(cwdPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of sessionDirs) {
      if (!s.isDirectory()) continue;
      const dir = path.join(cwdPath, s.name);
      const chatPath = path.join(dir, "chat_history.jsonl");
      const summaryPath = path.join(dir, "summary.json");
      // Skip incomplete sessions (missing one of the files).
      if (!fs.existsSync(chatPath) || !fs.existsSync(summaryPath)) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(chatPath);
      } catch {
        continue;
      }
      out.push({
        sessionDir: dir,
        chatPath,
        summaryPath,
        mtime_ns: grokCacheMtimeNs(dir, st),
        size_bytes: st.size,
      });
    }
  }
  return out;
}

function readSummary(p: string): GrokSummary | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as GrokSummary;
  } catch {
    return null;
  }
}

/** Best-effort read of `<sessionDir>/signals.json` — grok's per-session
 * telemetry sidecar. Returns null if the file is missing (older session
 * dirs, or sessions interrupted before grok wrote it). */
function readSignals(sessionDir: string): GrokSignals | null {
  const p = path.join(sessionDir, "signals.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as GrokSignals;
  } catch {
    return null;
  }
}

/** Best-effort read of `<sessionDir>/usage.json` — grok's token ledger
 * (input/output/cache, written by newer Grok Build). Missing on older dirs. */
function readUsageBlob(sessionDir: string): unknown | null {
  const p = path.join(sessionDir, "usage.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function extrasByPathFromStore(
  store: SessionStore,
  prefix: string,
): Map<string, string> {
  const fn = (store as SessionStore & { extrasByPath?: (o?: { prefix?: string }) => Map<string, string> })
    .extrasByPath;
  if (typeof fn !== "function") return new Map();
  return fn.call(store, { prefix });
}

function mergeCostExtras(
  extrasJson: string,
  stamp: { cost_estimated: boolean; cost_token_source: GrokCostTokenSource },
): string {
  let o: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(extrasJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      o = parsed as Record<string, unknown>;
    }
  } catch {
    o = {};
  }
  o.cost_estimated = stamp.cost_estimated;
  o.cost_token_source = stamp.cost_token_source;
  return JSON.stringify(o);
}

function grokNeedsParse(
  info: GrokSessionInfo,
  cached: { mtime_ns: number; size_bytes: number } | undefined,
  extrasJson: string | undefined,
  force: boolean,
): boolean {
  if (force) return true;
  if (!cached || cached.mtime_ns !== info.mtime_ns || cached.size_bytes !== info.size_bytes) {
    return true;
  }
  // One-shot catch-up: rows indexed before as-if-API cost landed stay $0.00
  // until we reparse and stamp cost_token_source.
  return !grokCostStampPresent(extrasJson);
}

function tsToMs(s: string | undefined): number | null {
  if (!s) return null;
  const v = Date.parse(s);
  return Number.isFinite(v) ? v : null;
}

/** projects_touched derivation for grok turns: collect file paths from
 * frontend file-edit tool calls and map them to project ids exactly like
 * the claude indexer does. */
function projectsTouchedFromGrokTurns(turns: GrokTurn[]): string[] {
  const set = new Set<string>();
  for (const t of turns) {
    for (const p of t.fileEdits) {
      const segs = p.split("/").filter(Boolean);
      if (segs.length >= 5 && segs[2] === "projects" && segs[3] === "ai") {
        set.add(`ai/${segs[4]}`);
        continue;
      }
      if (segs.length >= 4 && segs[2] === "projects" && segs[3] !== "ai") {
        set.add(segs[3]);
        continue;
      }
      if (segs.length >= 4 && segs[2] === "docs") {
        set.add("docs");
        continue;
      }
    }
  }
  return Array.from(set).sort();
}

/** Build the SessionRow + TurnRow pair for a single grok session, ready to
 * upsert into the shared SessionStore. */
export function buildGrokRows(
  info: GrokSessionInfo,
): { session: SessionRow; turns: TurnRow[] } | null {
  const summary = readSummary(info.summaryPath);
  if (!summary) return null;

  // Skip claude_import sessions — grok copies these out of ~/.claude/projects
  // with the original claude session UUID, but without token usage or
  // per-event timestamps. Indexing them would either (a) duplicate the
  // canonical claude row at a different jsonl_path or (b) collide on the
  // session_id PK and overwrite the claude row's metadata + cascade-delete
  // its topic classifications. Both outcomes are wrong — the claude indexer
  // is authoritative for these sessions.
  if (summary.session_kind === "claude_import") return null;

  const sessionId = summary.info?.id || path.basename(info.sessionDir);
  const cwd = summary.info?.cwd || decodeCwd(path.basename(path.dirname(info.sessionDir)));
  const projectId = projectIdFromCwd(cwd);

  const startedAt = tsToMs(summary.created_at);
  // Prefer last_active_at when available — it's bumped on every chat msg,
  // unlike updated_at which can lag for several seconds. Fall back to
  // updated_at, then created_at.
  const endedAt =
    tsToMs(summary.last_active_at) ?? tsToMs(summary.updated_at) ?? startedAt;

  const parsed = parseGrokConversation(info.chatPath);

  // Skip stillborn sessions: grok writes its skill catalog as a
  // <system-reminder> user message on every `session/new` ACP call.
  // If the client never sends a real `session/prompt` (panel closed,
  // backend swapped before typing, probe-only spawn), the session
  // file persists with exactly one user line — the catalog — and no
  // assistant turns. These showed up in the sidebar as tiny
  // "<system-reminder>↵↵- refre…" rows that cluttered the day-bucket
  // view (~20 of them accumulated in 2 days on the docs project).
  // Drop them at index time; the chat_history.jsonl stays on disk in
  // case the user wants to inspect it, but it doesn't pollute the
  // sessions view. See knowledge/tech/projects/code-build/grok-stillborn-sessions.md.
  const hasAssistant = parsed.turns.some((t) => t.assistantText.trim().length > 0);
  const onlyTurn = parsed.turns.length === 1 ? parsed.turns[0] : null;
  const stillbornCatalog =
    !hasAssistant &&
    !!onlyTurn &&
    onlyTurn.userText.trimStart().startsWith("<system-reminder>");
  if (stillbornCatalog) return null;

  // Title preference: generated_title > session_summary > first user msg.
  // Grok ACP prepends <user_info> / <system-reminder> as type:user turns —
  // those are not the operator prompt. Prefer the first <user_query>.
  const userTexts = parsed.turns.map((t) => t.userText);
  const firstUserMsg = (
    firstMeaningfulUserText(userTexts) ||
    (parsed.turns.length > 0 ? parsed.turns[0].userText : "")
  ).slice(0, 4096);
  const title =
    (summary.generated_title && summary.generated_title.trim()) ||
    (summary.session_summary && summary.session_summary.trim()) ||
    firstUserMsg.slice(0, 70) ||
    sessionId.slice(0, 8);

  const projectsTouched = projectsTouchedFromGrokTurns(parsed.turns);

  // Token + as-if-API cost. Prefer usage.json (input/output/cache split).
  // Older sessions only have signals.contextTokensUsed — treat that as
  // uncached input so the row isn't $0.00. SuperGrok is a subscription;
  // we still stamp list-price dollars onto cost_usd so day totals match
  // Claude's column (one source of truth — not recomputed at display).
  const signals = readSignals(info.sessionDir);
  const usageParsed = grokUsageFromBlob(readUsageBlob(info.sessionDir));
  const contextTokens = signals?.contextTokensUsed ?? 0;
  const toolCount =
    typeof signals?.toolCallCount === "number" ? signals.toolCallCount : parsed.totalTools;

  let inputTok = 0;
  let outputTok = 0;
  let cacheReadTok = 0;
  let cacheWriteTok = 0;
  let reasoningTok: number | null = null;
  let costSource: GrokCostTokenSource = "none";
  if (usageParsed) {
    inputTok = usageParsed.usage.inputTokens;
    outputTok = usageParsed.usage.outputTokens;
    cacheReadTok = usageParsed.usage.cacheReadTokens;
    cacheWriteTok = usageParsed.usage.cacheWriteTokens;
    reasoningTok = usageParsed.reasoningTokens;
    costSource = "usage.json";
  } else if (contextTokens > 0) {
    inputTok = contextTokens;
    costSource = "signals.contextTokensUsed";
  }
  const model =
    usageParsed?.model ?? signals?.primaryModelId ?? summary.current_model_id ?? null;
  const costUsd =
    costSource === "none"
      ? 0
      : estimateGrokCostUsd(
          {
            inputTokens: inputTok,
            outputTokens: outputTok,
            cacheReadTokens: cacheReadTok,
            cacheWriteTokens: cacheWriteTok,
          },
          model,
        );

  const autoInput = {
    is_automated: false,
    entrypoint: summary.agent_name ?? null,
    title,
    first_user_msg: firstUserMsg,
    extras_json: signals ? JSON.stringify(signals) : null,
    kind: "session" as const,
    later_user_msgs: laterMeaningfulUserTexts(userTexts),
  };
  const automated = isAutomatedSession(autoInput);
  const continuedByHuman = automated && isHumanContinuedSession(autoInput);
  const extrasJson = mergeCostExtras(
    mergeAutomationExtras(signals ? JSON.stringify(signals) : null, {
      automated,
      continued_by_human: continuedByHuman,
    }),
    { cost_estimated: costSource !== "none", cost_token_source: costSource },
  );

  const session: SessionRow = {
    session_id: sessionId,
    source: "grok",
    project_path: cwd,
    project_id: projectId,
    projects_touched: projectsTouched.length > 0 ? projectsTouched : projectId ? [projectId] : [],
    jsonl_path: info.chatPath,
    mtime_ns: info.mtime_ns,
    size_bytes: info.size_bytes,
    started_at: startedAt,
    ended_at: endedAt,
    message_count: parsed.rawMessageCount,
    tool_count: toolCount,
    subagent_count: 0,
    input_tokens: inputTok,
    output_tokens: outputTok,
    cache_read_tokens: cacheReadTok,
    cache_write_tokens: cacheWriteTok,
    reasoning_tokens: reasoningTok,
    cost_usd: costUsd,
    model,
    title,
    first_user_msg: firstUserMsg,
    entrypoint: summary.agent_name ?? null,
    is_automated: automated,
    kind: 'session',
    parent_session_id: null,
    workflow_id: null,
    indexed_at: Date.now(),
    // Only stamp last_assistant_text_at when the session ACTUALLY had
    // an assistant reply. The day-bucket filter (last_response_epoch
    // > 0) relies on this to hide sessions where the agent didn't
    // emit anything — previously we naively wrote `endedAt` (the
    // summary's last_active_at), so even stillborn sessions with no
    // assistant turn looked like they had a "response" timestamp.
    last_assistant_text_at: hasAssistant ? endedAt : null,
    // Whole signals blob — the tooltip / future Insights views can pick
    // out individual fields without re-reading the JSON sidecar on every
    // hover. Stored as a compact JSON string.
    extras_json: extrasJson,
  };

  // Per-turn synthetic timestamps: spread evenly between started_at and
  // ended_at so the trajectory views can plot them in order. If we only
  // have started_at, just step by 1ms per turn.
  const startMs = startedAt ?? 0;
  const endMs = endedAt ?? startMs;
  const span = parsed.turns.length > 1 ? (endMs - startMs) / Math.max(1, parsed.turns.length - 1) : 0;

  const turns: TurnRow[] = parsed.turns.map((t, i) => {
    const turnStart = startMs ? Math.round(startMs + span * i) : null;
    const turnEnd = startMs && i < parsed.turns.length - 1
      ? Math.round(startMs + span * (i + 1))
      : endMs || null;
    return {
      turn_uuid: `${sessionId}#${i}`,
      session_id: sessionId,
      turn_index: i,
      started_at: turnStart,
      ended_at: turnEnd,
      duration_ms: turnStart && turnEnd ? Math.max(0, turnEnd - turnStart) : null,
      user_text: t.userText.slice(0, USER_TEXT_MAX),
      assistant_excerpt: t.assistantText.slice(0, ASSISTANT_EXCERPT_MAX),
      assistant_full:
        t.assistantText.length > ASSISTANT_EXCERPT_MAX ? t.assistantText.slice(0, ASSISTANT_FULL_MAX) : null,
      tool_names_csv: t.toolNames.join(","),
      tool_count: t.toolNames.length,
      has_subagent: t.isSubagent,
      // Grok chat_history.jsonl has no per-turn usage; session-level
      // cost_usd (from usage.json / contextTokensUsed) is the rollup SSOT.
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: null,
      cost_usd: 0,
      kind: 'session',
      parent_session_id: null,
      workflow_id: null,
    };
  });

  return { session, turns };
}

export interface GrokIndexErrorDetail {
  path: string;
  reason: string;
}

export interface GrokSyncStats {
  total_on_disk: number;
  parsed: number;
  unchanged: number;
  removed: number;
  errors: number;
  /** Per-file parse failures — empty when errors === 0. */
  error_details: GrokIndexErrorDetail[];
  /** Sessions deliberately skipped — `summary.session_kind === "claude_import"`
   * grok-side duplicates of authentic claude sessions, which the claude
   * indexer handles authoritatively. */
  skipped_claude_import: number;
  elapsed_ms: number;
}

/** Full sync: parse every new/changed grok session into SQLite. Returns
 * stats. Mirrors the contract of `syncToStore` in jsonlIndexer.ts so the
 * extension entrypoint can call both with the same opts shape. */
export interface GrokSyncPlan {
  totalOnDisk: number;
  toParse: GrokSessionInfo[];
  removedPaths: string[];
}

/**
 * Scan + diff only (cheap stat pass, no parsing). Shared by the in-process
 * sync below and the child-process catch-up (`grokParseWorker.ts`), which
 * moves the 7–9.5 s cold parse off the extension-host thread (spec R1).
 */
export function planGrokSync(
  store: SessionStore,
  opts: { forceRecentN?: number; force?: boolean; root?: string } = {},
): GrokSyncPlan {
  const root = opts.root ?? GROK_SESSIONS_ROOT;
  const disk = listAllGrokSessions(root);
  const prefix = root + path.sep;
  const allKnown = store.knownPaths({ prefix });
  const known = new Map<string, { mtime_ns: number; size_bytes: number }>();
  for (const [p, v] of allKnown) {
    if (p.startsWith(prefix)) known.set(p, v);
  }
  const extras = extrasByPathFromStore(store, prefix);
  let forcedSet: Set<string> | null = null;
  if (opts.forceRecentN && opts.forceRecentN > 0) {
    const sorted = [...disk].sort((a, b) => b.mtime_ns - a.mtime_ns).slice(0, opts.forceRecentN);
    forcedSet = new Set(sorted.map((d) => d.chatPath));
  }
  const toParse: GrokSessionInfo[] = [];
  for (const info of disk) {
    if (opts.force || (forcedSet && forcedSet.has(info.chatPath))) {
      toParse.push(info);
      continue;
    }
    if (grokNeedsParse(info, known.get(info.chatPath), extras.get(info.chatPath), false)) {
      toParse.push(info);
    }
  }
  const diskPaths = new Set(disk.map((d) => d.chatPath));
  const removedPaths: string[] = [];
  if (disk.length > 0) {
    for (const p of known.keys()) if (!diskPaths.has(p)) removedPaths.push(p);
  }
  return { totalOnDisk: disk.length, toParse, removedPaths };
}

/** One parsed result from `buildGrokRows` (in-process or from the worker). */
export interface GrokParsedItem {
  chatPath: string;
  rows: { session: SessionRow; turns: TurnRow[] } | null;
  error?: string;
}

/** Apply one parsed item to the store. Mirrors the inline loop below. */
export function applyGrokParsed(
  store: SessionStore,
  item: GrokParsedItem,
): "parsed" | "skipped" | "error" {
  if (item.error) return "error";
  if (!item.rows) {
    // claude_import duplicate or stillborn session — clean any stale row.
    store.deleteByPaths([item.chatPath]);
    return "skipped";
  }
  store.upsertSession(item.rows.session);
  store.deleteTurnsForSession(item.rows.session.session_id);
  store.upsertTurns(item.rows.turns);
  return "parsed";
}

export function syncGrokToStore(
  store: SessionStore,
  opts: {
    onProgress?: (done: number, total: number) => void;
    force?: boolean;
    forceRecentN?: number;
    /** Index only these chat_history.jsonl paths (watcher). Does not scan the rest. */
    onlyPaths?: string[];
  } = {},
): GrokSyncStats {
  const t0 = Date.now();
  const disk =
    opts.onlyPaths && opts.onlyPaths.length > 0
      ? opts.onlyPaths.map(sessionInfoFromChatPath).filter((x): x is GrokSessionInfo => x != null)
      : listAllGrokSessions();
  // We key the cache on chat_history.jsonl path, same shape as the claude
  // cache. `knownPaths` returns rows for both sources, so we filter to the
  // ones whose path starts with the grok root to avoid cross-source
  // confusion if any UUID-shaped collisions ever happened.
  const prefix = GROK_SESSIONS_ROOT + path.sep;
  const allKnown = store.knownPaths({ prefix });
  const known = new Map<string, { mtime_ns: number; size_bytes: number }>();
  for (const [p, v] of allKnown) {
    if (p.startsWith(prefix)) known.set(p, v);
  }
  const extras = extrasByPathFromStore(store, prefix);

  let forcedSet: Set<string> | null = null;
  if (opts.forceRecentN && opts.forceRecentN > 0) {
    const sorted = [...disk].sort((a, b) => b.mtime_ns - a.mtime_ns).slice(0, opts.forceRecentN);
    forcedSet = new Set(sorted.map((d) => d.chatPath));
  }

  const toParse: GrokSessionInfo[] = [];
  for (const info of disk) {
    if (opts.force || (forcedSet && forcedSet.has(info.chatPath))) {
      toParse.push(info);
      continue;
    }
    if (grokNeedsParse(info, known.get(info.chatPath), extras.get(info.chatPath), false)) {
      toParse.push(info);
    }
  }

  const diskPaths = new Set(disk.map((d) => d.chatPath));
  const removedPaths: string[] = [];
  if (!opts.onlyPaths?.length) {
    for (const p of known.keys()) if (!diskPaths.has(p)) removedPaths.push(p);
  }

  let parsed = 0;
  let errors = 0;
  const error_details: GrokIndexErrorDetail[] = [];
  let skipped = 0;
  for (let i = 0; i < toParse.length; i++) {
    const info = toParse[i];
    try {
      const rows = buildGrokRows(info);
      if (!rows) {
        // null return = legitimate skip (claude_import duplicate OR
        // stillborn <system-reminder>-only session). Also delete any
        // pre-existing DB row by chatPath so a session that was
        // previously indexed (before this filter) but then identified
        // as stillborn on re-parse gets cleaned out of the sidebar.
        skipped += 1;
        store.deleteByPaths([info.chatPath]);
        continue;
      }
      store.upsertSession(rows.session);
      store.deleteTurnsForSession(rows.session.session_id);
      store.upsertTurns(rows.turns);
      parsed += 1;
    } catch (e: unknown) {
      errors += 1;
      error_details.push({
        path: info.chatPath,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
    if (opts.onProgress) opts.onProgress(i + 1, toParse.length);
  }

  const removed = store.deleteByPaths(removedPaths);

  return {
    total_on_disk: disk.length,
    parsed,
    unchanged: disk.length - toParse.length,
    removed,
    errors,
    error_details,
    skipped_claude_import: skipped,
    elapsed_ms: Date.now() - t0,
  };
}
