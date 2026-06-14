// Incremental disk → SQLite sync.
//
// Strategy: list every ~/.claude/projects/*/<uuid>.jsonl, compare each against
// the cached (mtime_ns, size_bytes), parse and upsert only the diff, delete
// rows for files that no longer exist on disk.
//
// Parsing reuses src/conversationParser.ts (already a pure TypeScript parser
// for a single JSONL into Turn[]). We then derive the per-session aggregates
// (cost, tokens, projects_touched, etc.) from the parsed turns.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionStore, SessionRow, TurnRow } from "./db";
import { parseConversation, ParsedConversation } from "./conversationParser";

const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

// Prices in USD per 1M tokens (2026 Anthropic list). Cache read = 0.1x input,
// cache write = 1.25x input. Selected per detected model; DEFAULT is Sonnet
// because that is the Claude Code default and most sessions are Sonnet.
interface ModelRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const RATES_OPUS: ModelRates = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };
const RATES_SONNET: ModelRates = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };
const RATES_HAIKU: ModelRates = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 };

/** Pick the per-1M-token rates for a given model id. Unknown/missing → Sonnet. */
function ratesForModel(model: string | null | undefined): ModelRates {
  const m = (model ?? "").toLowerCase();
  if (m.includes("opus")) return RATES_OPUS;
  if (m.includes("sonnet")) return RATES_SONNET;
  if (m.includes("haiku")) return RATES_HAIKU;
  return RATES_SONNET; // Claude Code default
}

// Truncations for storage
const USER_TEXT_MAX = 4096;
const ASSISTANT_EXCERPT_MAX = 1024;

interface JsonlInfo {
  jsonl_path: string;
  mtime_ns: number;
  size_bytes: number;
}

/** Walk the projects root and collect (path, mtime, size) for every JSONL. */
export function listAllJsonls(): JsonlInfo[] {
  if (!fs.existsSync(PROJECTS_ROOT)) return [];
  const out: JsonlInfo[] = [];
  for (const projectDir of fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;
    const projectPath = path.join(PROJECTS_ROOT, projectDir.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      if (f.name.startsWith(".")) continue; // skip .sessions-index etc.
      if (f.name.includes("sessions-index") || f.name.includes("history")) continue;
      const p = path.join(projectPath, f.name);
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      out.push({
        jsonl_path: p,
        mtime_ns: st.mtimeMs * 1e6,
        size_bytes: st.size,
      });
    }
  }
  return out;
}

/** Decode the urlencoded-ish project dir name back to a usable label. */
function projectIdFromPath(projectPath: string): string {
  // Example: /Users/you/.claude/projects/-Users-you-projects-myrepo
  // → unpolarize
  // For ai/X: -Users-you-projects-ai-foo → ai/foo
  const base = path.basename(projectPath);
  // Strip the leading dash and replace dashes with slashes to get a path-like.
  const decoded = base.replace(/^-/, "").replace(/-/g, "/");
  // Match the same rules as session-center.sh awk:
  //   /Users/<user>/projects/ai/X/...  → ai/X
  //   /Users/<user>/projects/X/...     → X
  //   /Users/<user>/docs/...           → docs
  const parts = decoded.split("/").filter(Boolean);
  // parts[0] is 'Users', parts[1] is the username, parts[2] is the first segment
  if (parts.length >= 5 && parts[2] === "projects" && parts[3] === "ai") return `ai/${parts[4]}`;
  if (parts.length >= 4 && parts[2] === "projects") return parts[3];
  if (parts.length >= 3 && parts[2] === "docs") return "docs";
  return parts.slice(2).join("/") || base;
}

function projectsTouchedFromTurns(turns: ParsedConversation["turns"]): string[] {
  const set = new Set<string>();
  for (const t of turns) {
    for (const tc of t.toolCalls) {
      if (tc.name !== "Edit" && tc.name !== "Write") continue;
      const p: string | undefined = (tc.input as any)?.file_path;
      if (!p || typeof p !== "string") continue;
      const segs = p.split("/").filter(Boolean);
      // /Users/<user>/projects/ai/X/...
      if (segs.length >= 5 && segs[2] === "projects" && segs[3] === "ai") {
        set.add(`ai/${segs[4]}`);
        continue;
      }
      // /Users/<user>/projects/X/...
      if (segs.length >= 4 && segs[2] === "projects" && segs[3] !== "ai") {
        set.add(segs[3]);
        continue;
      }
      // /Users/<user>/docs/...
      if (segs.length >= 4 && segs[2] === "docs") {
        set.add("docs");
        continue;
      }
    }
  }
  return Array.from(set).sort();
}

function entrypointFromTurns(parsed: ParsedConversation): { entrypoint: string | null; isAutomated: boolean } {
  // The entrypoint lives on the first user line; parseConversation doesn't
  // currently surface it, so we open the raw JSONL once more and read the
  // first user line. Cheap because we already touched the file.
  try {
    const raw = fs.readFileSync(findJsonlPathById(parsed.sessionId) || "", "utf-8");
    for (const ln of raw.split("\n")) {
      if (!ln) continue;
      try {
        const obj = JSON.parse(ln);
        if (obj?.type === "user") {
          const ep: string | undefined = obj.entrypoint;
          // Interactive entrypoints — anything else is treated as
          // automation (cron-fired skills, headless scripts, etc.)
          // and hidden by default behind `showAutomated`.
          //
          // `sdk-cli` is what claude records when spawned with `-p`
          // (the headless / SDK CLI mode). Two callers use this in
          // practice:
          //   1. Code Build, which runs `claude -p --input-format
          //      stream-json` to drive the chat from a webview —
          //      a genuinely interactive UX where the user is
          //      typing turn-by-turn.
          //   2. One-shot skill invocations (`claude -p "summarise
          //      this..."`) — automation.
          // Pre-1.1.2 the bucket was lumped under "automated" so
          // Code Build sessions vanished from the sidebar. Treating
          // sdk-cli as interactive surfaces both — the one-shot
          // skill invocations are still useful breadcrumbs (you
          // can see what skills ran today) and the user can flip
          // `showAutomated = false` along a different axis if
          // they want to drop them.
          const automated = ep != null && !["cli", "claude-code", "claude-vscode", "claude-jetbrains", "sdk-cli", ""].includes(ep);
          return { entrypoint: ep ?? null, isAutomated: automated };
        }
      } catch {
        // skip
      }
    }
  } catch {
    // fall through
  }
  return { entrypoint: null, isAutomated: false };
}

function findJsonlPathById(sessionId: string): string | null {
  if (!sessionId) return null;
  for (const projectDir of fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;
    const candidate = path.join(PROJECTS_ROOT, projectDir.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function aggregateFromParsed(parsed: ParsedConversation, info: JsonlInfo, projectPath: string): { session: SessionRow; turns: TurnRow[] } {
  // Token + cost aggregation: walk the JSONL once more so we can attribute
  // each assistant.message.usage block to its enclosing turn. Per-turn
  // tokens land in `turn.input_tokens`/etc. (migration v11) and drive the
  // accurate per-day rollup in the Sessions tree. We also keep the
  // session-level totals as a sanity sum.
  let inputTok = 0,
    outputTok = 0,
    cacheReadTok = 0,
    cacheWriteTok = 0;
  let firstUserMsg = "";
  let entrypoint: string | null = null;
  let isAutomated = false;
  let rawMessageCount = 0; // every user/assistant line, matches session-center.sh
  let sessionModel: string | null = null; // last non-empty model id seen
  // Per-turn token accumulator. Same turn-boundary rule as
  // conversationParser: a real user message (not a tool_result echo)
  // starts a new turn; everything that follows until the next real user
  // message belongs to it. Index aligned to parsed.turns[] order.
  const tokensByTurn: Array<{ input: number; output: number; cacheR: number; cacheW: number }> = [];
  let currentTurnIdx = -1;
  const isToolResultLine = (obj: any): boolean =>
    obj?.type === "user" &&
    Array.isArray(obj?.message?.content) &&
    obj.message.content[0]?.type === "tool_result";
  try {
    const raw = fs.readFileSync(info.jsonl_path, "utf-8");
    for (const ln of raw.split("\n")) {
      if (!ln) continue;
      let obj: any;
      try {
        obj = JSON.parse(ln);
      } catch {
        continue;
      }
      if (obj?.type === "user" || obj?.type === "assistant") rawMessageCount += 1;
      // Real user message → new turn. tool_result echoes don't move the
      // turn boundary (they're agent-internal continuations of the same
      // turn). Match conversationParser's logic so indices line up.
      if (obj?.type === "user" && !isToolResultLine(obj)) {
        currentTurnIdx += 1;
        tokensByTurn[currentTurnIdx] = { input: 0, output: 0, cacheR: 0, cacheW: 0 };
      }
      if (obj?.type === "assistant") {
        const u = obj?.message?.usage ?? {};
        const inT = u.input_tokens || 0;
        const outT = u.output_tokens || 0;
        const crT = u.cache_read_input_tokens || 0;
        const cwT = u.cache_creation_input_tokens || 0;
        inputTok += inT;
        outputTok += outT;
        cacheReadTok += crT;
        cacheWriteTok += cwT;
        if (currentTurnIdx >= 0) {
          // Defensive: assistant before any user (shouldn't happen, but
          // older transcripts could have orphan assistant lines).
          const slot = tokensByTurn[currentTurnIdx];
          if (slot) {
            slot.input += inT;
            slot.output += outT;
            slot.cacheR += crT;
            slot.cacheW += cwT;
          }
        }
        // Model id lives on assistant lines as obj.message.model
        // (e.g. "claude-sonnet-4-6-..." / "claude-opus-4-...").
        const m = obj?.message?.model;
        if (typeof m === "string" && m) sessionModel = m;
      } else if (obj?.type === "user" && !firstUserMsg) {
        const content = obj?.message?.content;
        if (typeof content === "string") firstUserMsg = content;
        else if (Array.isArray(content) && content[0]?.type === "text") firstUserMsg = String(content[0].text || "");
        if (obj.entrypoint != null) {
          entrypoint = obj.entrypoint;
          // Allow-list must match the canonical one in
          // entrypointFromTurns(): `sdk-cli` is interactive (Code
          // Build drives claude with `-p`). Without sdk-cli here,
          // CB-spawned sessions still got is_automated=1 even after
          // the 1.1.2 fix, because THIS second indexing path was
          // missed in that change.
          isAutomated = !["cli", "claude-code", "claude-vscode", "claude-jetbrains", "sdk-cli", ""].includes(obj.entrypoint);
        }
      }
    }
  } catch {
    // ignore
  }
  const totalTok = inputTok + outputTok + cacheReadTok + cacheWriteTok;
  const r = ratesForModel(sessionModel);
  const cost =
    (inputTok * r.input +
      outputTok * r.output +
      cacheReadTok * r.cacheRead +
      cacheWriteTok * r.cacheWrite) /
    1_000_000;

  const totalToolCalls = parsed.summary.totalTools;
  const totalSubagents = parsed.summary.totalSubagents;
  const messageCount = rawMessageCount; // same shape as session-center.sh

  const projectsTouched = projectsTouchedFromTurns(parsed.turns);
  const projectId = projectIdFromPath(projectPath);

  const session: SessionRow = {
    session_id: parsed.sessionId || path.basename(info.jsonl_path, ".jsonl"),
    source: "claude",
    project_path: projectPath,
    project_id: projectId,
    projects_touched: projectsTouched.length > 0 ? projectsTouched : projectId ? [projectId] : [],
    jsonl_path: info.jsonl_path,
    mtime_ns: info.mtime_ns,
    size_bytes: info.size_bytes,
    started_at: parsed.startMs,
    ended_at: parsed.endMs,
    message_count: messageCount,
    tool_count: totalToolCalls,
    subagent_count: totalSubagents,
    input_tokens: inputTok,
    output_tokens: outputTok,
    cache_read_tokens: cacheReadTok,
    cache_write_tokens: cacheWriteTok,
    cost_usd: Number(cost.toFixed(4)),
    model: sessionModel,
    title: parsed.title || firstUserMsg.slice(0, 70),
    first_user_msg: firstUserMsg.slice(0, 4096),
    entrypoint,
    is_automated: isAutomated,
    indexed_at: Date.now(),
    last_assistant_text_at: parsed.lastAssistantTextMs,
    // Claude-side extras are still tabular fields; no JSON blob needed yet.
    extras_json: null,
  };

  const turns: TurnRow[] = parsed.turns.map((t, i) => {
    const tok = tokensByTurn[i] ?? { input: 0, output: 0, cacheR: 0, cacheW: 0 };
    // Per-turn cost — precomputed at index time using the session's
    // model rate table (same rates as the session-level cost above).
    // Lets the day-bucket header sum the costs actually paid that day
    // rather than the lifetime total.
    const turnCost =
      (tok.input * r.input +
        tok.output * r.output +
        tok.cacheR * r.cacheRead +
        tok.cacheW * r.cacheWrite) /
      1_000_000;
    return {
      turn_uuid: `${session.session_id}#${i}`, // stable per session+index
      session_id: session.session_id,
      turn_index: i,
      started_at: t.userTimestampMs || null,
      ended_at: t.turnEndMs,
      duration_ms: t.userTimestampMs && t.turnEndMs ? Math.max(0, t.turnEndMs - t.userTimestampMs) : null,
      user_text: t.userText.slice(0, USER_TEXT_MAX),
      assistant_excerpt: t.assistantText.slice(0, ASSISTANT_EXCERPT_MAX),
      tool_names_csv: t.toolCalls.map((tc) => tc.name).join(","),
      tool_count: t.toolCalls.length,
      has_subagent: t.toolCalls.some((tc) => tc.isSubagent),
      input_tokens: tok.input,
      output_tokens: tok.output,
      cache_read_tokens: tok.cacheR,
      cache_write_tokens: tok.cacheW,
      cost_usd: Number(turnCost.toFixed(6)),
    };
  });

  return { session, turns };
}

export interface SyncStats {
  total_on_disk: number;
  parsed: number;
  unchanged: number;
  removed: number;
  errors: number;
  elapsed_ms: number;
}

/** Full sync: parse every new/changed JSONL into SQLite. Returns stats. */
export function syncToStore(
  store: SessionStore,
  opts: {
    onProgress?: (done: number, total: number) => void;
    /** Re-parse every JSONL on disk regardless of mtime/size cache. */
    force?: boolean;
    /** Re-parse the N most-recent-by-mtime JSONLs regardless of cache, while
     * still incrementally checking the rest. Cheap way to catch on-disk edits
     * that don't reliably bump mtime (e.g. session renames in claude code). */
    forceRecentN?: number;
  } = {},
): SyncStats {
  const t0 = Date.now();
  const disk = listAllJsonls();
  const known = store.knownPaths();

  // Build the "forced" set: top-N most-recent JSONLs if forceRecentN is set.
  let forcedSet: Set<string> | null = null;
  if (opts.forceRecentN && opts.forceRecentN > 0) {
    const sorted = [...disk].sort((a, b) => b.mtime_ns - a.mtime_ns).slice(0, opts.forceRecentN);
    forcedSet = new Set(sorted.map((d) => d.jsonl_path));
  }

  // Diff: which files are new or changed? `force` re-parses everything;
  // `forceRecentN` re-parses just the N newest entries plus the usual delta.
  const toParse: JsonlInfo[] = [];
  for (const info of disk) {
    if (opts.force || (forcedSet && forcedSet.has(info.jsonl_path))) { toParse.push(info); continue; }
    const cached = known.get(info.jsonl_path);
    if (!cached || cached.mtime_ns !== info.mtime_ns || cached.size_bytes !== info.size_bytes) {
      toParse.push(info);
    }
  }

  // Which paths are gone?
  const diskPaths = new Set(disk.map((d) => d.jsonl_path));
  const removedPaths: string[] = [];
  for (const p of known.keys()) if (!diskPaths.has(p)) removedPaths.push(p);

  let parsed = 0;
  let errors = 0;
  for (let i = 0; i < toParse.length; i++) {
    const info = toParse[i];
    const projectPath = path.dirname(info.jsonl_path);
    try {
      const conv = parseConversation(info.jsonl_path);
      const { session, turns } = aggregateFromParsed(conv, info, projectPath);
      store.upsertSession(session);
      store.deleteTurnsForSession(session.session_id);
      store.upsertTurns(turns);
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
    elapsed_ms: Date.now() - t0,
  };
}
