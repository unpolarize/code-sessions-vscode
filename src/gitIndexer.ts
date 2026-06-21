// Incremental disk → SQLite sync for the portable git-backed session store
// written by the `code-sessions` headless agent (github.com/unpolarize/code-sessions).
//
// Layout (canonical, conflict-free):
//   ~/.sessions/hosts/<host>/<YYYY-MM>/<session-uuid>/
//       session.json        (envelope: session-store/session@1)
//       turns/NNNNNN.json    (immutable per-turn: session-store/turn@1)
//       insights/labels.json (optional: session-store/insights@1)
//
// This mirrors the claude `jsonlIndexer.ts` / `grokIndexer.ts` contract so the
// same SessionStore + downstream consumers (classifier, search, insights) work
// on the merged corpus. Two design points specific to the git source:
//
//   1. The store is CROSS-MACHINE. A session captured on THIS host is already
//      indexed from its native ~/.claude/projects JSONL (higher fidelity, has
//      `raw`). Importing it again under the same session_id would collide on the
//      PK and clobber the canonical row. So by default we import only sessions
//      whose `host` differs from this machine ("see my other laptops' work").
//   2. Canonical turns are one-message-per-record (user / assistant / tool).
//      The SQLite `turn` table models a user→assistant exchange, so we fold
//      consecutive records into exchanges exactly like the conversationParser.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SessionStore, SessionRow, TurnRow } from "./db";

const DEFAULT_GIT_ROOT = path.join(os.homedir(), ".sessions");

const USER_TEXT_MAX = 4096;
const ASSISTANT_EXCERPT_MAX = 1024;

export function gitSessionsRoot(): string {
  return process.env.CODE_SESSIONS_STORE || DEFAULT_GIT_ROOT;
}

interface GitSessionInfo {
  sessionDir: string;
  sessionJsonPath: string;
  turnsDir: string;
  host: string;
  mtime_ns: number;
  size_bytes: number;
}

interface Envelope {
  session_id: string;
  host: string;
  agent?: string;
  project_path?: string;
  model?: string;
  started_at?: string;
  ended_at?: string;
  turn_count?: number;
  tool_call_count?: number;
  totals?: { input_tokens?: number; output_tokens?: number; cost_usd?: number };
  title?: string;
  labels?: string[];
}

interface CanonicalTurn {
  turn_index: number;
  ts?: string;
  role: "user" | "assistant" | "tool" | "system";
  text?: string;
  tool_calls?: Array<{ name?: string; input?: any }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
  telemetry?: { cost_usd?: number };
}

/** Walk hosts/<host>/<month>/<uuid>/, keyed on session.json (mtime/size) so
 * cache invalidation works like the other indexers. */
export function listAllGitSessions(root = gitSessionsRoot()): GitSessionInfo[] {
  const hostsRoot = path.join(root, "hosts");
  if (!fs.existsSync(hostsRoot)) return [];
  const out: GitSessionInfo[] = [];
  for (const host of safeDirs(hostsRoot)) {
    for (const month of safeDirs(path.join(hostsRoot, host))) {
      for (const uuid of safeDirs(path.join(hostsRoot, host, month))) {
        const dir = path.join(hostsRoot, host, month, uuid);
        const sessionJsonPath = path.join(dir, "session.json");
        if (!fs.existsSync(sessionJsonPath)) continue;
        let st: fs.Stats;
        try {
          st = fs.statSync(sessionJsonPath);
        } catch {
          continue;
        }
        out.push({
          sessionDir: dir,
          sessionJsonPath,
          turnsDir: path.join(dir, "turns"),
          host,
          mtime_ns: st.mtimeMs * 1e6,
          size_bytes: st.size,
        });
      }
    }
  }
  return out;
}

function safeDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

function readTurns(turnsDir: string): CanonicalTurn[] {
  if (!fs.existsSync(turnsDir)) return [];
  let files: string[];
  try {
    files = fs.readdirSync(turnsDir).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
  } catch {
    return [];
  }
  const turns: CanonicalTurn[] = [];
  for (const f of files.sort()) {
    const t = readJson<CanonicalTurn>(path.join(turnsDir, f));
    if (t && typeof t.turn_index === "number") turns.push(t);
  }
  return turns.sort((a, b) => a.turn_index - b.turn_index);
}

function tsToMs(s: string | undefined): number | null {
  if (!s) return null;
  const v = Date.parse(s);
  return Number.isFinite(v) ? v : null;
}

function projectIdFromCwd(cwd: string): string | null {
  const segs = cwd.split("/").filter(Boolean);
  if (segs.length >= 5 && segs[2] === "projects" && segs[3] === "ai") return `ai/${segs[4]}`;
  if (segs.length >= 4 && segs[2] === "projects") return segs[3];
  if (segs.length >= 3 && segs[2] === "docs") return "docs";
  return segs.slice(2).join("/") || null;
}

function fileEditPath(tc: { name?: string; input?: any }): string | null {
  if (tc.name !== "Edit" && tc.name !== "Write") return null;
  const p = tc.input?.file_path ?? tc.input?.filePath;
  return typeof p === "string" && p.length > 0 ? p : null;
}

function projectsTouchedFrom(paths: string[]): string[] {
  const set = new Set<string>();
  for (const p of paths) {
    const id = projectIdFromCwd(p);
    if (id) set.add(id);
  }
  return [...set].sort();
}

interface Exchange {
  index: number;
  userText: string;
  assistantText: string;
  toolNames: string[];
  fileEdits: string[];
  startMs: number | null;
  endMs: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
}

/** Fold one-message-per-record canonical turns into user→assistant exchanges. */
function toExchanges(turns: CanonicalTurn[]): Exchange[] {
  const out: Exchange[] = [];
  let cur: Exchange | null = null;
  const start = (userText: string, ms: number | null): Exchange => ({
    index: out.length,
    userText,
    assistantText: "",
    toolNames: [],
    fileEdits: [],
    startMs: ms,
    endMs: ms,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0,
  });

  for (const t of turns) {
    const ms = tsToMs(t.ts);
    if (t.role === "user") {
      cur = start(t.text ?? "", ms);
      out.push(cur);
      continue;
    }
    if (!cur) {
      cur = start("", ms);
      out.push(cur);
    }
    if (ms !== null) cur.endMs = ms;
    if (t.role === "assistant") {
      if (t.text) cur.assistantText = cur.assistantText ? `${cur.assistantText}\n\n${t.text}` : t.text;
      for (const tc of t.tool_calls ?? []) {
        if (tc.name) cur.toolNames.push(tc.name);
        const fp = fileEditPath(tc);
        if (fp) cur.fileEdits.push(fp);
      }
      cur.input_tokens += t.usage?.input_tokens ?? 0;
      cur.output_tokens += t.usage?.output_tokens ?? 0;
      cur.cache_read_tokens += t.usage?.cache_read_tokens ?? 0;
      cur.cache_write_tokens += t.usage?.cache_write_tokens ?? 0;
      cur.cost_usd += t.telemetry?.cost_usd ?? 0;
    }
    // role === "tool" | "system": folded silently (tool result text not surfaced)
  }
  return out;
}

/** Build the SessionRow + TurnRow[] for one git-store session. Pure: no store. */
export function buildGitRows(info: GitSessionInfo): { session: SessionRow; turns: TurnRow[] } | null {
  const env = readJson<Envelope>(info.sessionJsonPath);
  if (!env || !env.session_id) return null;

  const turns = readTurns(info.turnsDir);
  const exchanges = toExchanges(turns);

  const cwd = env.project_path ?? "";
  const projectId = cwd ? projectIdFromCwd(cwd) : null;
  const fileEdits = exchanges.flatMap((e) => e.fileEdits);
  const projectsTouched = projectsTouchedFrom(fileEdits);

  const startedAt = tsToMs(env.started_at);
  const endedAt = tsToMs(env.ended_at) ?? startedAt;
  const firstUserMsg = exchanges.find((e) => e.userText.trim().length > 0)?.userText.slice(0, 4096) ?? "";
  const title = (env.title && env.title.trim()) || firstUserMsg.slice(0, 70) || env.session_id.slice(0, 8);
  const hasAssistant = exchanges.some((e) => e.assistantText.trim().length > 0);
  const lastAssistant = [...exchanges].reverse().find((e) => e.assistantText.trim().length > 0);

  const totals = env.totals ?? {};
  const session: SessionRow = {
    session_id: env.session_id,
    source: "git",
    kind: "session",
    parent_session_id: null,
    workflow_id: null,
    project_path: cwd,
    project_id: projectId,
    projects_touched: projectsTouched.length > 0 ? projectsTouched : projectId ? [projectId] : [],
    jsonl_path: info.sessionJsonPath,
    mtime_ns: info.mtime_ns,
    size_bytes: info.size_bytes,
    started_at: startedAt,
    ended_at: endedAt,
    message_count: env.turn_count ?? turns.length,
    tool_count: env.tool_call_count ?? fileEdits.length,
    subagent_count: 0,
    input_tokens: totals.input_tokens ?? 0,
    output_tokens: totals.output_tokens ?? 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: totals.cost_usd ?? 0,
    model: env.model ?? null,
    title,
    first_user_msg: firstUserMsg,
    entrypoint: env.agent ?? null,
    is_automated: false,
    indexed_at: Date.now(),
    last_assistant_text_at: hasAssistant ? lastAssistant?.endMs ?? endedAt : null,
    extras_json: JSON.stringify({
      host: env.host,
      agent: env.agent,
      labels: env.labels ?? [],
    }),
  };

  const turnRows: TurnRow[] = exchanges.map((e) => ({
    turn_uuid: `${env.session_id}#${e.index}`,
    session_id: env.session_id,
    turn_index: e.index,
    started_at: e.startMs,
    ended_at: e.endMs,
    duration_ms: e.startMs != null && e.endMs != null ? Math.max(0, e.endMs - e.startMs) : null,
    user_text: e.userText.slice(0, USER_TEXT_MAX),
    assistant_excerpt: e.assistantText.slice(0, ASSISTANT_EXCERPT_MAX),
    tool_names_csv: e.toolNames.join(","),
    tool_count: e.toolNames.length,
    has_subagent: false,
    input_tokens: e.input_tokens,
    output_tokens: e.output_tokens,
    cache_read_tokens: e.cache_read_tokens,
    cache_write_tokens: e.cache_write_tokens,
    cost_usd: e.cost_usd,
  }));

  return { session, turns: turnRows };
}

export interface GitSyncStats {
  total_on_disk: number;
  parsed: number;
  unchanged: number;
  removed: number;
  errors: number;
  /** Sessions skipped because their host matches this machine (already indexed
   * from native JSONL — see header note #1). */
  skipped_local_host: number;
  elapsed_ms: number;
}

/** Agents CSV already indexes natively (from their own JSONL). Own-host sessions
 * of these are skipped from the git store to avoid duplicates; everything else
 * (codex, codebuild, …) is imported even on this host so CSV shows it from CS. */
const NATIVELY_INDEXED = new Set(["claude-code", "claude", "grok"]);

function isLocalDuplicate(info: GitSessionInfo, localHost: string): boolean {
  if (info.host !== localHost) return false;
  const agent = readJson<Envelope>(info.sessionJsonPath)?.agent ?? "";
  return NATIVELY_INDEXED.has(agent);
}

/** Full sync: import every new/changed git-store session into SQLite. Mirrors
 * the `syncToStore` / `syncGrokToStore` contract. */
export function syncGitToStore(
  store: SessionStore,
  opts: {
    onProgress?: (done: number, total: number) => void;
    force?: boolean;
    forceRecentN?: number;
    /** import sessions captured on THIS host too (default false — see note #1) */
    includeLocalHost?: boolean;
    localHost?: string;
    root?: string;
  } = {},
): GitSyncStats {
  const t0 = Date.now();
  const root = opts.root ?? gitSessionsRoot();
  const localHost = opts.localHost ?? os.hostname();
  const disk = listAllGitSessions(root);

  const allKnown = store.knownPaths();
  const rootPrefix = path.join(root, "hosts") + path.sep;
  const known = new Map<string, { mtime_ns: number; size_bytes: number }>();
  for (const [p, v] of allKnown) if (p.startsWith(rootPrefix)) known.set(p, v);

  let forcedSet: Set<string> | null = null;
  if (opts.forceRecentN && opts.forceRecentN > 0) {
    const sorted = [...disk].sort((a, b) => b.mtime_ns - a.mtime_ns).slice(0, opts.forceRecentN);
    forcedSet = new Set(sorted.map((d) => d.sessionJsonPath));
  }

  let skippedLocal = 0;
  const toParse: GitSessionInfo[] = [];
  for (const info of disk) {
    if (!opts.includeLocalHost && isLocalDuplicate(info, localHost)) {
      skippedLocal += 1;
      continue;
    }
    if (opts.force || (forcedSet && forcedSet.has(info.sessionJsonPath))) {
      toParse.push(info);
      continue;
    }
    const cached = known.get(info.sessionJsonPath);
    if (!cached || cached.mtime_ns !== info.mtime_ns || cached.size_bytes !== info.size_bytes) {
      toParse.push(info);
    }
  }

  // Only consider non-local sessions for removal detection.
  const diskPaths = new Set(
    disk.filter((d) => opts.includeLocalHost || !isLocalDuplicate(d, localHost)).map((d) => d.sessionJsonPath),
  );
  const removedPaths: string[] = [];
  for (const p of known.keys()) if (!diskPaths.has(p)) removedPaths.push(p);

  let parsed = 0;
  let errors = 0;
  for (let i = 0; i < toParse.length; i++) {
    const info = toParse[i];
    try {
      const rows = buildGitRows(info);
      if (!rows) {
        store.deleteByPaths([info.sessionJsonPath]);
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
    unchanged: disk.length - toParse.length - skippedLocal,
    removed,
    errors,
    skipped_local_host: skippedLocal,
    elapsed_ms: Date.now() - t0,
  };
}
