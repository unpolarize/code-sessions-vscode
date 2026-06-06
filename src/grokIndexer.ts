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
//      (e.g. `%2FUsers%2Fzhirafovod%2Fdocs`), and each session is a folder,
//      not a single file.
//   2. Two files per session: `summary.json` (metadata: title, model,
//      cwd, dates, message counts) and `chat_history.jsonl` (event stream).
//   3. Events lack per-event timestamps. We synthesise them from
//      `summary.created_at` + the line ordinal so downstream ordering still
//      works (cross-session correlation isn't claimed).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionStore, SessionRow, TurnRow } from "./db";

const GROK_SESSIONS_ROOT = path.join(os.homedir(), ".grok", "sessions");

// Truncations match the claude indexer so the downstream classifier sees
// comparable text lengths regardless of source.
const USER_TEXT_MAX = 4096;
const ASSISTANT_EXCERPT_MAX = 1024;

interface GrokSessionInfo {
  /** Session folder, e.g. `<root>/%2FUsers%2Fzhirafovod%2Fdocs/<uuid>/`. */
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
export function listAllGrokSessions(): GrokSessionInfo[] {
  if (!fs.existsSync(GROK_SESSIONS_ROOT)) return [];
  const out: GrokSessionInfo[] = [];
  let cwdDirs: fs.Dirent[];
  try {
    cwdDirs = fs.readdirSync(GROK_SESSIONS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const cwdDir of cwdDirs) {
    if (!cwdDir.isDirectory()) continue;
    const cwdPath = path.join(GROK_SESSIONS_ROOT, cwdDir.name);
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
        mtime_ns: st.mtimeMs * 1e6,
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

function tsToMs(s: string | undefined): number | null {
  if (!s) return null;
  const v = Date.parse(s);
  return Number.isFinite(v) ? v : null;
}

function extractText(content: any): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (typeof b === "string") return b;
        if (b && b.type === "text") return String(b.text ?? "");
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

/** Try to extract a file path from a frontend tool_call's arguments. Grok
 * uses `file_path` for search_replace and `filePath` for write (inconsistent
 * key naming verified across multiple sessions). Returns null if the call
 * is read-only (read_file / list_dir / grep) or if arguments are unparseable. */
function fileEditPathFromToolCall(tc: { name?: string; arguments?: string }): string | null {
  if (!tc?.name) return null;
  if (tc.name !== "search_replace" && tc.name !== "write") return null;
  if (typeof tc.arguments !== "string") return null;
  try {
    const args = JSON.parse(tc.arguments);
    const p = tc.name === "search_replace" ? args?.file_path : args?.filePath;
    return typeof p === "string" && p.length > 0 ? p : null;
  } catch {
    return null;
  }
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

interface GrokTurn {
  index: number;
  userText: string;
  assistantText: string;
  toolNames: string[];
  fileEdits: string[];
  isSubagent: boolean;
}

interface ParsedGrokSession {
  turns: GrokTurn[];
  totalTools: number;
  rawMessageCount: number;
}

/** Pure parser: grok chat_history.jsonl → conversation turns. Mirrors the
 * "turn = user message + everything until the next user message" convention
 * used by the claude conversationParser, so downstream code (classifier,
 * KB rollup) sees comparable structure. */
function parseGrokConversation(chatPath: string): ParsedGrokSession {
  let raw = "";
  try {
    raw = fs.readFileSync(chatPath, "utf-8");
  } catch {
    return { turns: [], totalTools: 0, rawMessageCount: 0 };
  }
  const lines = raw.split("\n").filter(Boolean);

  const turns: GrokTurn[] = [];
  let current: GrokTurn | null = null;
  let totalTools = 0;
  let rawMessageCount = 0;

  for (const ln of lines) {
    let obj: any;
    try {
      obj = JSON.parse(ln);
    } catch {
      continue;
    }
    const type = obj?.type;

    if (type === "user") {
      // Real user message — start a new turn.
      const userText = extractText(obj.content);
      rawMessageCount += 1;
      current = {
        index: turns.length,
        userText,
        assistantText: "",
        toolNames: [],
        fileEdits: [],
        isSubagent: false,
      };
      turns.push(current);
      continue;
    }

    if (!current) {
      // Stray events before the first user message (e.g. system prompt).
      // System prompts dominate text but don't belong to any turn; skip.
      continue;
    }

    if (type === "assistant") {
      rawMessageCount += 1;
      const text = extractText(obj.content);
      if (text) {
        current.assistantText = current.assistantText
          ? `${current.assistantText}\n\n${text}`
          : text;
      }
      const tcs: any[] = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
      for (const tc of tcs) {
        const name = typeof tc?.name === "string" ? tc.name : null;
        if (!name) continue;
        current.toolNames.push(name);
        totalTools += 1;
        // Grok has no sub-agent equivalent in v1; we deliberately leave
        // isSubagent false for every turn. spawn_subagent / use_tool would
        // surface here if a future grok release records them.
        const fp = fileEditPathFromToolCall({ name, arguments: tc.arguments });
        if (fp) current.fileEdits.push(fp);
      }
      continue;
    }

    // backend_tool_call / tool_result / system: ignored. backend tool calls
    // in observed sessions are web_search and similar — not editor-side
    // activity the user cares to surface in this view.
  }

  return { turns, totalTools, rawMessageCount };
}

/** Build the SessionRow + TurnRow pair for a single grok session, ready to
 * upsert into the shared SessionStore. */
function buildRows(
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

  // Title preference: generated_title > session_summary > first user msg.
  let firstUserMsg = "";
  if (parsed.turns.length > 0) firstUserMsg = parsed.turns[0].userText.slice(0, 4096);
  const title =
    (summary.generated_title && summary.generated_title.trim()) ||
    (summary.session_summary && summary.session_summary.trim()) ||
    firstUserMsg.slice(0, 70) ||
    sessionId.slice(0, 8);

  const projectsTouched = projectsTouchedFromGrokTurns(parsed.turns);

  // Pull grok's own telemetry sidecar. signals.json doesn't break input vs
  // output tokens (cost can't be computed), but it does record:
  //   - contextTokensUsed: closest proxy to "session size in tokens"
  //   - toolCallCount + toolsUsed: replaces our chat_history scan
  //   - modelsUsed: multi-model sessions
  //   - file-edit volume + peak RSS for the local process
  // We stash contextTokensUsed into input_tokens so the headline "tok"
  // column on the Sessions row is no longer 0 — the tooltip labels it
  // honestly as "context tokens" since it isn't really an input/output
  // split.
  const signals = readSignals(info.sessionDir);
  const contextTokens = signals?.contextTokensUsed ?? 0;
  const toolCount =
    typeof signals?.toolCallCount === "number" ? signals.toolCallCount : parsed.totalTools;

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
    input_tokens: contextTokens, // see comment above — proxy
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0,
    model: signals?.primaryModelId ?? summary.current_model_id ?? null,
    title,
    first_user_msg: firstUserMsg,
    entrypoint: summary.agent_name ?? null,
    is_automated: false,
    indexed_at: Date.now(),
    last_assistant_text_at: endedAt,
    // Whole signals blob — the tooltip / future Insights views can pick
    // out individual fields without re-reading the JSON sidecar on every
    // hover. Stored as a compact JSON string.
    extras_json: signals ? JSON.stringify(signals) : null,
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
      tool_names_csv: t.toolNames.join(","),
      tool_count: t.toolNames.length,
      has_subagent: t.isSubagent,
      // Grok's chat_history.jsonl doesn't carry per-turn token usage —
      // the column stays 0 and the day-bucket rollup just won't include
      // grok contributions (which matches the existing "Grok records no
      // token usage" caveat surfaced in the Insights subtitle).
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
  });

  return { session, turns };
}

export interface GrokSyncStats {
  total_on_disk: number;
  parsed: number;
  unchanged: number;
  removed: number;
  errors: number;
  /** Sessions deliberately skipped — `summary.session_kind === "claude_import"`
   * grok-side duplicates of authentic claude sessions, which the claude
   * indexer handles authoritatively. */
  skipped_claude_import: number;
  elapsed_ms: number;
}

/** Full sync: parse every new/changed grok session into SQLite. Returns
 * stats. Mirrors the contract of `syncToStore` in jsonlIndexer.ts so the
 * extension entrypoint can call both with the same opts shape. */
export function syncGrokToStore(
  store: SessionStore,
  opts: {
    onProgress?: (done: number, total: number) => void;
    force?: boolean;
    forceRecentN?: number;
  } = {},
): GrokSyncStats {
  const t0 = Date.now();
  const disk = listAllGrokSessions();
  // We key the cache on chat_history.jsonl path, same shape as the claude
  // cache. `knownPaths` returns rows for both sources, so we filter to the
  // ones whose path starts with the grok root to avoid cross-source
  // confusion if any UUID-shaped collisions ever happened.
  const allKnown = store.knownPaths();
  const known = new Map<string, { mtime_ns: number; size_bytes: number }>();
  for (const [p, v] of allKnown) {
    if (p.startsWith(GROK_SESSIONS_ROOT + path.sep)) known.set(p, v);
  }

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
    const cached = known.get(info.chatPath);
    if (!cached || cached.mtime_ns !== info.mtime_ns || cached.size_bytes !== info.size_bytes) {
      toParse.push(info);
    }
  }

  const diskPaths = new Set(disk.map((d) => d.chatPath));
  const removedPaths: string[] = [];
  for (const p of known.keys()) if (!diskPaths.has(p)) removedPaths.push(p);

  let parsed = 0;
  let errors = 0;
  let skipped = 0;
  for (let i = 0; i < toParse.length; i++) {
    const info = toParse[i];
    try {
      const rows = buildRows(info);
      if (!rows) {
        // null return = legitimate skip (e.g. claude_import). Distinguish
        // from a parse error so the diagnostic counter stays meaningful.
        skipped += 1;
        continue;
      }
      store.upsertSession(rows.session);
      store.deleteTurnsForSession(rows.session.session_id);
      store.upsertTurns(rows.turns);
      parsed += 1;
    } catch {
      errors += 1;
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
    skipped_claude_import: skipped,
    elapsed_ms: Date.now() - t0,
  };
}
