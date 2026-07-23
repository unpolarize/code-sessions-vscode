// Incremental disk → SQLite sync for Codex CLI sessions.
//
// Codex stores each session as a "rollout" file at
//   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// (CODEX_HOME defaults to ~/.codex). Each file is a session_meta header line
// followed by event lines. We mirror the grokIndexer.ts contract — same
// (mtime_ns, size_bytes) cache diff, same SessionStore rows — so downstream
// consumers (classifier, KB rollups, search, sidebar) work on the merged
// corpus unchanged.
//
// Format notes (validated against codex 0.14x rollouts + fixtures):
//   - Conversation lives on `event_msg`: payload.type `user_message` /
//     `agent_message`, text at payload.message. `response_item` role=user
//     lines are synthetic (environment_context / AGENTS.md injection) and
//     role=developer lines are scaffolding — neither ever counts as a user
//     turn or a title source.
//   - Tool calls live on `response_item` payload.type `function_call` /
//     `local_shell_call` / `tool_call`.
//   - `turn_context.payload.model` carries the model (moved out of
//     session_meta in 0.14x); last non-null wins.
//   - Cumulative token usage arrives via `event_msg` payload.type
//     `token_count` at payload.info.total_token_usage; latest wins.
//   - history.jsonl and state_*.sqlite under $CODEX_HOME are NOT sessions
//     and are never touched here.
//
// Files can exceed 100MB (base_instructions alone is ~20KB per session), so
// we stream in fixed-size chunks instead of readFileSync, and tolerate a
// truncated last line while codex is live-appending — the bad line is
// skipped and the session re-indexes on the next mtime/size change.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StringDecoder } from "string_decoder";
import { SessionStore, SessionRow, TurnRow } from "./db";

export function codexSessionsRoot(): string {
  const home = process.env.CODEX_HOME && process.env.CODEX_HOME.trim().length > 0
    ? process.env.CODEX_HOME
    : path.join(os.homedir(), ".codex");
  return path.join(home, "sessions");
}

// Truncations match the claude/grok indexers so the downstream classifier
// sees comparable text lengths regardless of source.
const USER_TEXT_MAX = 4096;
const ASSISTANT_EXCERPT_MAX = 1024;

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export interface CodexSessionInfo {
  path: string;
  /** UUID from the rollout filename; session_meta.payload.id is preferred
   * when present (they match on healthy files). */
  fileUuid: string | null;
  mtime_ns: number;
  size_bytes: number;
}

/** Walk $CODEX_HOME/sessions/YYYY/MM/DD/ and collect every rollout-*.jsonl
 * with its (mtime, size). Only rollout files count — history.jsonl is a
 * different artifact and is never parsed as a session. */
export function listAllCodexSessions(root = codexSessionsRoot()): CodexSessionInfo[] {
  if (!fs.existsSync(root)) return [];
  const out: CodexSessionInfo[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (!e.name.startsWith("rollout-") || !e.name.endsWith(".jsonl")) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      const m = UUID_RE.exec(e.name);
      out.push({
        path: full,
        fileUuid: m ? m[1].toLowerCase() : null,
        mtime_ns: st.mtimeMs * 1e6,
        size_bytes: st.size,
      });
    }
  };
  walk(root, 0);
  return out;
}

/** Stream a file line-by-line synchronously in fixed-size chunks, so a
 * 100MB+ rollout never materialises as one string. A trailing line without
 * a newline is still yielded (codex may be mid-append; the JSON.parse
 * failure downstream just skips it). */
function forEachLineSync(filePath: string, onLine: (line: string) => void): void {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(1 << 16);
    // StringDecoder holds back a multi-byte UTF-8 sequence split across a
    // chunk boundary instead of emitting replacement chars mid-line.
    const decoder = new StringDecoder("utf-8");
    let carry = "";
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      carry += decoder.write(buf.subarray(0, n));
      let nl: number;
      while ((nl = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (line.trim().length > 0) onLine(line);
      }
    }
    carry += decoder.end();
    if (carry.trim().length > 0) onLine(carry);
  } finally {
    fs.closeSync(fd);
  }
}

interface CodexTurn {
  index: number;
  userText: string;
  assistantText: string;
  toolNames: string[];
  startedAt: number | null;
  endedAt: number | null;
}

interface CodexUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
}

interface ParsedCodexSession {
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  startedAt: number | null;
  endedAt: number | null;
  entrypoint: string | null;
  originator: string | null;
  cliVersion: string | null;
  git: unknown;
  forkedFromId: string | null;
  usage: CodexUsage | null;
  turns: CodexTurn[];
  totalTools: number;
  rawMessageCount: number;
  badLines: number;
}

function tsToMs(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const v = Date.parse(s);
  return Number.isFinite(v) ? v : null;
}

/** Pure parser: rollout jsonl → normalized session. Defensive by design —
 * unknown/legacy line shapes are counted in badLines, never thrown. */
export function parseCodexRollout(filePath: string): ParsedCodexSession {
  const out: ParsedCodexSession = {
    sessionId: null,
    cwd: null,
    model: null,
    startedAt: null,
    endedAt: null,
    entrypoint: null,
    originator: null,
    cliVersion: null,
    git: null,
    forkedFromId: null,
    usage: null,
    turns: [],
    totalTools: 0,
    rawMessageCount: 0,
    badLines: 0,
  };

  let current: CodexTurn | null = null;

  const handle = (line: string): void => {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      out.badLines += 1; // truncated tail or legacy garbage — skip
      return;
    }
    const p = ev?.payload && typeof ev.payload === "object" ? ev.payload : null;
    const lineMs = tsToMs(ev?.timestamp);
    if (lineMs != null) {
      if (out.startedAt == null) out.startedAt = lineMs;
      out.endedAt = lineMs;
    }

    if (ev?.type === "session_meta" && p) {
      if (typeof p.id === "string") {
        const m = UUID_RE.exec(p.id);
        out.sessionId = m ? m[1].toLowerCase() : p.id;
      }
      if (typeof p.cwd === "string") out.cwd = p.cwd;
      // Older codex kept the model on session_meta.
      if (typeof p.model === "string") out.model = p.model;
      if (typeof p.source === "string") out.entrypoint = p.source;
      if (typeof p.originator === "string") out.originator = p.originator;
      if (typeof p.cli_version === "string") out.cliVersion = p.cli_version;
      if (p.git != null) out.git = p.git;
      if (typeof p.forked_from_id === "string") out.forkedFromId = p.forked_from_id;
      const metaMs = tsToMs(p.timestamp);
      if (metaMs != null && out.startedAt == null) out.startedAt = metaMs;
      return;
    }

    if (ev?.type === "turn_context" && p) {
      if (typeof p.model === "string" && p.model.length > 0) out.model = p.model; // last non-null wins
      if (typeof p.cwd === "string" && !out.cwd) out.cwd = p.cwd;
      return;
    }

    if (ev?.type === "event_msg" && p) {
      if (p.type === "user_message" && typeof p.message === "string") {
        out.rawMessageCount += 1;
        current = {
          index: out.turns.length,
          userText: p.message,
          assistantText: "",
          toolNames: [],
          startedAt: lineMs,
          endedAt: lineMs,
        };
        out.turns.push(current);
        return;
      }
      if (p.type === "agent_message" && typeof p.message === "string") {
        out.rawMessageCount += 1;
        if (!current) {
          // Assistant output before any real user turn (resumed/forked
          // sessions) — anchor it to a synthetic empty-user turn so it
          // still renders.
          current = {
            index: out.turns.length,
            userText: "",
            assistantText: "",
            toolNames: [],
            startedAt: lineMs,
            endedAt: lineMs,
          };
          out.turns.push(current);
        }
        current.assistantText = current.assistantText
          ? `${current.assistantText}\n\n${p.message}`
          : p.message;
        if (lineMs != null) current.endedAt = lineMs;
        return;
      }
      if (p.type === "token_count") {
        const u = p.info?.total_token_usage ?? p.info;
        if (u && typeof u === "object") {
          out.usage = {
            input_tokens: Number(u.input_tokens) || 0,
            output_tokens: Number(u.output_tokens) || 0,
            cache_read_tokens: Number(u.cached_input_tokens ?? u.cache_read_tokens) || 0,
          };
        }
        return;
      }
      return; // task_started / task_complete / etc — not conversation
    }

    if (ev?.type === "response_item" && p) {
      if (p.type === "function_call" || p.type === "local_shell_call" || p.type === "tool_call") {
        const name =
          typeof p.name === "string" && p.name.length > 0
            ? p.name
            : p.type === "local_shell_call"
              ? "shell"
              : "tool";
        out.totalTools += 1;
        if (current) {
          current.toolNames.push(name);
          if (lineMs != null) current.endedAt = lineMs;
        }
      }
      // message (role=user synthetic env-context / role=developer
      // scaffolding), reasoning, function_call_output: never conversation.
      return;
    }
    // Legacy flat format (no type/payload envelope) or unknown event kinds:
    // count silently unless it parsed as JSON — parsed-but-unknown is fine.
  };

  try {
    forEachLineSync(filePath, handle);
  } catch {
    // Unreadable file (perms, vanished mid-scan): surface as zero turns so
    // the caller counts it appropriately.
  }
  return out;
}

function projectIdFromCwd(cwd: string): string | null {
  const segs = cwd.split("/").filter(Boolean);
  if (segs.length >= 5 && segs[2] === "projects" && segs[3] === "ai") return `ai/${segs[4]}`;
  if (segs.length >= 4 && segs[2] === "projects") return segs[3];
  if (segs.length >= 3 && segs[2] === "docs") return "docs";
  return segs.slice(2).join("/") || null;
}

/** Build the SessionRow + TurnRow pair for one rollout. Returns null for
 * sessions that should not surface: meta-only files (no user_message and no
 * assistant output) and files whose header never parsed. */
export function buildCodexRows(info: CodexSessionInfo): { session: SessionRow; turns: TurnRow[] } | null {
  const parsed = parseCodexRollout(info.path);

  const sessionId = parsed.sessionId ?? info.fileUuid;
  if (!sessionId) return null;

  const hasUser = parsed.turns.some((t) => t.userText.trim().length > 0);
  const hasAssistant = parsed.turns.some((t) => t.assistantText.trim().length > 0);
  // Empty/meta-only rollouts (probe spawns, aborted before first prompt):
  // skip so they don't clutter the sidebar.
  if (!hasUser && !hasAssistant) return null;

  const cwd = parsed.cwd ?? "";
  const projectId = cwd ? projectIdFromCwd(cwd) : null;

  // Title/first_user_msg from event_msg.user_message ONLY (guaranteed by the
  // parser: synthetic response_item user/developer lines never became turns).
  const firstUserTurn = parsed.turns.find((t) => t.userText.trim().length > 0);
  const firstUserMsg = firstUserTurn ? firstUserTurn.userText.slice(0, USER_TEXT_MAX) : "";
  const title = firstUserMsg.slice(0, 70) || sessionId.slice(0, 8);

  const lastAssistantTurn = [...parsed.turns].reverse().find((t) => t.assistantText.trim().length > 0);

  const isAutomated =
    parsed.originator === "exec" ||
    parsed.originator === "codex_exec" ||
    parsed.entrypoint === "exec";

  const extras: Record<string, unknown> = {};
  if (parsed.cliVersion) extras.cli_version = parsed.cliVersion;
  if (parsed.originator) extras.originator = parsed.originator;
  if (parsed.git != null) extras.git = parsed.git;
  if (parsed.forkedFromId) extras.forked_from_id = parsed.forkedFromId; // forks index independently in v1
  if (parsed.badLines > 0) extras.bad_lines = parsed.badLines;

  const session: SessionRow = {
    session_id: sessionId,
    source: "codex",
    project_path: cwd,
    project_id: projectId,
    projects_touched: projectId ? [projectId] : [],
    jsonl_path: info.path,
    mtime_ns: info.mtime_ns,
    size_bytes: info.size_bytes,
    started_at: parsed.startedAt,
    ended_at: parsed.endedAt,
    message_count: parsed.rawMessageCount,
    tool_count: parsed.totalTools,
    subagent_count: 0,
    input_tokens: parsed.usage?.input_tokens ?? 0,
    output_tokens: parsed.usage?.output_tokens ?? 0,
    cache_read_tokens: parsed.usage?.cache_read_tokens ?? 0,
    cache_write_tokens: 0,
    // Never invent cost: ChatGPT-auth codex sessions don't map to API
    // prices, and we have no codex rate table yet.
    cost_usd: 0,
    model: parsed.model,
    title,
    first_user_msg: firstUserMsg,
    entrypoint: parsed.entrypoint ?? parsed.originator ?? null,
    is_automated: isAutomated,
    kind: "session",
    parent_session_id: null,
    workflow_id: null,
    indexed_at: Date.now(),
    last_assistant_text_at: hasAssistant ? (lastAssistantTurn?.endedAt ?? parsed.endedAt) : null,
    extras_json: Object.keys(extras).length > 0 ? JSON.stringify(extras) : null,
  };

  const turns: TurnRow[] = parsed.turns.map((t, i) => ({
    turn_uuid: `${sessionId}#${i}`,
    session_id: sessionId,
    turn_index: i,
    started_at: t.startedAt,
    ended_at: t.endedAt,
    duration_ms: t.startedAt != null && t.endedAt != null ? Math.max(0, t.endedAt - t.startedAt) : null,
    user_text: t.userText.slice(0, USER_TEXT_MAX),
    assistant_excerpt: t.assistantText.slice(0, ASSISTANT_EXCERPT_MAX),
    tool_names_csv: t.toolNames.join(","),
    tool_count: t.toolNames.length,
    has_subagent: false,
    // token_count is cumulative per session, not per turn — session totals
    // carry the usage; per-turn stays 0 (mirrors the grok caveat).
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0,
  }));

  return { session, turns };
}

export interface CodexSyncStats {
  total_on_disk: number;
  parsed: number;
  unchanged: number;
  removed: number;
  errors: number;
  /** Meta-only / empty rollouts deliberately not surfaced. */
  skipped_empty: number;
  elapsed_ms: number;
}

/** Full sync: parse every new/changed codex rollout into SQLite. Mirrors the
 * syncGrokToStore contract so the extension entrypoint can call all three
 * indexers with the same opts shape. */
export function syncCodexToStore(
  store: SessionStore,
  opts: {
    onProgress?: (done: number, total: number) => void;
    force?: boolean;
    forceRecentN?: number;
    /** Test hook: override the sessions root. */
    root?: string;
  } = {},
): CodexSyncStats {
  const t0 = Date.now();
  const root = opts.root ?? codexSessionsRoot();
  const disk = listAllCodexSessions(root);

  // knownPaths returns rows for every source; filter to files under the
  // codex root so claude/grok rows can't collide with the diff.
  const allKnown = store.knownPaths();
  const known = new Map<string, { mtime_ns: number; size_bytes: number }>();
  for (const [p, v] of allKnown) {
    if (p.startsWith(root + path.sep)) known.set(p, v);
  }

  let forcedSet: Set<string> | null = null;
  if (opts.forceRecentN && opts.forceRecentN > 0) {
    const sorted = [...disk].sort((a, b) => b.mtime_ns - a.mtime_ns).slice(0, opts.forceRecentN);
    forcedSet = new Set(sorted.map((d) => d.path));
  }

  const toParse: CodexSessionInfo[] = [];
  for (const info of disk) {
    if (opts.force || (forcedSet && forcedSet.has(info.path))) {
      toParse.push(info);
      continue;
    }
    const cached = known.get(info.path);
    if (!cached || cached.mtime_ns !== info.mtime_ns || cached.size_bytes !== info.size_bytes) {
      toParse.push(info);
    }
  }

  const diskPaths = new Set(disk.map((d) => d.path));
  const removedPaths: string[] = [];
  for (const p of known.keys()) if (!diskPaths.has(p)) removedPaths.push(p);

  let parsed = 0;
  let errors = 0;
  let skipped = 0;
  for (let i = 0; i < toParse.length; i++) {
    const info = toParse[i];
    try {
      const rows = buildCodexRows(info);
      if (!rows) {
        // Meta-only skip. Also clean out any pre-existing row for this path
        // (e.g. previously indexed before this filter existed).
        skipped += 1;
        store.deleteByPaths([info.path]);
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
    skipped_empty: skipped,
    elapsed_ms: Date.now() - t0,
  };
}
