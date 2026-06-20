// SQLite cache for coder-CLI session metadata (Claude Code + Grok Build).
//
// One DB at `<extensionGlobalStorageUri>/sessions-cache.db`. WAL mode.
// Migrations are numbered SQL strings, applied via PRAGMA user_version.
//
// On first activation after the v1.0 rename, the constructor probes the
// sibling `<globalStorage>/zhirafovod.claude-sessions/sessions-cache.db` and
// copies it across so existing topic-classifications survive the rebrand. See
// `SessionStore.open` for details.

import { Database } from "./sqlite";
import * as fs from "fs";
import * as path from "path";

const MIGRATIONS: string[] = [
  // v1 — session + turn tables
  `
  CREATE TABLE session (
    session_id        TEXT PRIMARY KEY,
    project_path      TEXT NOT NULL,
    project_id        TEXT,                       -- derived short name, e.g. 'unpolarize'
    projects_touched  TEXT,                       -- comma-separated derived list
    jsonl_path        TEXT NOT NULL UNIQUE,
    mtime_ns          INTEGER NOT NULL,
    size_bytes        INTEGER NOT NULL,
    started_at        INTEGER,                    -- epoch ms of first user message
    ended_at          INTEGER,                    -- epoch ms of last activity
    message_count     INTEGER NOT NULL DEFAULT 0,
    tool_count        INTEGER NOT NULL DEFAULT 0,
    subagent_count    INTEGER NOT NULL DEFAULT 0,
    input_tokens      INTEGER NOT NULL DEFAULT 0,
    output_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd          REAL NOT NULL DEFAULT 0,
    model             TEXT,
    title             TEXT,
    first_user_msg    TEXT,
    entrypoint        TEXT,
    is_automated      INTEGER NOT NULL DEFAULT 0, -- 0/1 bool
    indexed_at        INTEGER NOT NULL,
    schema_rev        INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX idx_session_started   ON session(started_at DESC);
  CREATE INDEX idx_session_project   ON session(project_id);
  CREATE INDEX idx_session_mtime     ON session(mtime_ns DESC);
  CREATE INDEX idx_session_automated ON session(is_automated);

  CREATE TABLE turn (
    turn_uuid         TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
    turn_index        INTEGER NOT NULL,
    started_at        INTEGER,
    ended_at          INTEGER,
    duration_ms       INTEGER,
    user_text         TEXT,                       -- truncated 4 KB
    assistant_excerpt TEXT,                       -- truncated 1 KB
    tool_names_csv    TEXT,                       -- "Bash,Edit,Bash,..." for quick filtering
    tool_count        INTEGER NOT NULL DEFAULT 0,
    has_subagent      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_turn_session ON turn(session_id, turn_index);
  CREATE INDEX idx_turn_started ON turn(started_at);
  `,

  // v2 — topic classification
  `
  CREATE TABLE turn_topic (
    turn_uuid     TEXT PRIMARY KEY REFERENCES turn(turn_uuid) ON DELETE CASCADE,
    topic         TEXT NOT NULL,
    topic_norm    TEXT NOT NULL,
    confidence    REAL,
    classified_at INTEGER NOT NULL,
    model         TEXT NOT NULL,
    prompt_rev    INTEGER NOT NULL,
    batch_id      TEXT
  );
  CREATE INDEX idx_turn_topic_topic ON turn_topic(topic_norm);

  CREATE TABLE classification_batch (
    batch_id      TEXT PRIMARY KEY,
    started_at    INTEGER NOT NULL,
    finished_at   INTEGER,
    turn_count    INTEGER NOT NULL,
    model         TEXT NOT NULL,
    status        TEXT NOT NULL,
    error         TEXT,
    input_tokens  INTEGER,
    output_tokens INTEGER
  );
  `,

  // v3 — session embeddings + 2D coordinates
  `
  CREATE TABLE session_embedding (
    session_id      TEXT PRIMARY KEY REFERENCES session(session_id) ON DELETE CASCADE,
    embedding       BLOB NOT NULL,
    embedding_model TEXT NOT NULL,
    embedding_dim   INTEGER NOT NULL,
    computed_at     INTEGER NOT NULL,
    umap_x          REAL,
    umap_y          REAL,
    umap_fitted_at  INTEGER
  );
  CREATE INDEX idx_emb_model ON session_embedding(embedding_model);
  `,

  // v4 — per-turn embeddings + cluster_id on session_embedding
  `
  CREATE TABLE turn_embedding (
    turn_uuid       TEXT PRIMARY KEY REFERENCES turn(turn_uuid) ON DELETE CASCADE,
    embedding       BLOB NOT NULL,
    embedding_model TEXT NOT NULL,
    embedding_dim   INTEGER NOT NULL,
    computed_at     INTEGER NOT NULL
  );
  CREATE INDEX idx_turn_emb_model ON turn_embedding(embedding_model);

  ALTER TABLE session_embedding ADD COLUMN cluster_id INTEGER;
  `,

  // v5 — last_assistant_text_at: epoch ms of the most recent assistant
  // message that contained a text block (i.e. the last time the model said
  // something to the user, as opposed to mtime which moves on every event).
  `
  ALTER TABLE session ADD COLUMN last_assistant_text_at INTEGER;
  `,

  // v6 — session_star: user pinned sessions. session_id deliberately a FK so
  // we drop the star if the session row is gone (cascade).
  `
  CREATE TABLE session_star (
    session_id  TEXT PRIMARY KEY REFERENCES session(session_id) ON DELETE CASCADE,
    starred_at  INTEGER NOT NULL
  );
  `,

  // v7 — coder source tagging. 'claude' for sessions from ~/.claude/projects,
  // 'grok' for sessions from ~/.grok/sessions. Existing rows default to claude.
  `
  ALTER TABLE session ADD COLUMN source TEXT NOT NULL DEFAULT 'claude';
  CREATE INDEX idx_session_source ON session(source);
  `,

  // v8 — one-time-migration ledger. Tracks named migrations (e.g. the
  // pre-v1.0 zhirafovod.claude-sessions import) so we can rerun a previously
  // failed merge without re-importing rows that already landed.
  `
  CREATE TABLE migration (
    name        TEXT PRIMARY KEY,
    applied_at  INTEGER NOT NULL,
    detail      TEXT
  );
  `,

  // v9 — extras blob. Source-specific telemetry that doesn't fit the
  // tabular schema (grok's signals.json with context tokens, tool list,
  // peak RSS, latency; future claude metadata) lives here as JSON. NULL
  // for sources that don't emit it. Keeping it as a generic blob avoids
  // an explosion of source-specific columns.
  `
  ALTER TABLE session ADD COLUMN extras_json TEXT;
  `,

  // v10 — session_hide: user-hidden sessions (soft-hide; the JSONL on disk
  // is untouched). Filtered out of the tree unless the showHidden setting
  // is on. Cascade-delete with the session row so a wiped cache rebuilds
  // cleanly.
  `
  CREATE TABLE session_hide (
    session_id  TEXT PRIMARY KEY REFERENCES session(session_id) ON DELETE CASCADE,
    hidden_at   INTEGER NOT NULL
  );
  `,

  // v11 — per-turn token columns. The session-level token totals on
  // `session` are lifetime sums, which made the day-bucket header
  // misleading: a session whose mtime touched "today" but whose tokens
  // were all spent yesterday would contribute its full lifetime total
  // to today's bucket sum. With per-turn tokens we can scope the day
  // total to only the turns whose ended_at falls in that day. Lifetime
  // totals remain on `session` for the session-detail tooltip. Existing
  // turn rows default to 0; the next jsonl re-parse fills them in.
  `
  ALTER TABLE turn ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE turn ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE turn ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE turn ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
  `,

  // v12 — per-turn USD cost. Per-day token totals were already correct
  // after v11, but the day-bucket header was still summing
  // `session.cost_usd` (lifetime). Computing cost in SQL would require
  // baking rate tables into a CASE/JOIN; cleaner to precompute at index
  // time using ratesForModel() and persist the result here. Existing
  // turn rows default to 0; re-parse populates them.
  `
  ALTER TABLE turn ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
  `,

  // v13 — purge stillborn grok <system-reminder> sessions. Grok writes
  // its discovered skill catalog as a single user-role
  // <system-reminder> line at session/new ACP time. When the client
  // never sends a real session/prompt (panel closed before typing,
  // backend swapped, probe-only spawn) the session file persists with
  // exactly those 2 lines. They were indexed pre-v13 and showed up as
  // tiny "<system-reminder>↵↵- refre…" rows. grokIndexer now skips
  // them at parse time; this migration drops the ones already in the
  // DB. Safe filter: grok-source, first_user_msg starts with
  // <system-reminder>, tool_count = 0, and no assistant excerpt on
  // any turn (i.e. session had no agent output).
  // See knowledge/tech/projects/code-build/grok-stillborn-sessions.md.
  `
  DELETE FROM session
  WHERE source = 'grok'
    AND tool_count = 0
    AND substr(first_user_msg, 1, 17) = '<system-reminder>'
    AND session_id NOT IN (
      SELECT DISTINCT session_id FROM turn
      WHERE assistant_excerpt IS NOT NULL AND length(trim(assistant_excerpt)) > 0
    );
  `,

  // v14 — re-classify `sdk-cli` claude sessions as interactive.
  // Pre-v14 the entrypoint heuristic only treated cli/claude-code/
  // claude-vscode/claude-jetbrains as interactive; everything else
  // (including `sdk-cli`, which is what claude records when spawned
  // with `-p`) was flagged automated and hidden behind the
  // showAutomated toggle. Code Build drives claude in `-p` mode from
  // a webview, so its sessions silently disappeared from the sidebar
  // ("CS does not show today's sessions started in CB"). The new
  // indexer treats sdk-cli as interactive going forward; this
  // migration retroactively flips existing rows so the user sees
  // their CB session history without reindexing the jsonl files
  // (the cache wouldn't re-parse them anyway — mtime hasn't moved).
  `
  UPDATE session
  SET is_automated = 0
  WHERE source = 'claude'
    AND entrypoint = 'sdk-cli'
    AND is_automated = 1;
  `,

  // v15 — same UPDATE again. v14 fired once on the 1.1.2 upgrade
  // and flipped existing sdk-cli rows. But 1.1.2 / 1.1.3 had a
  // second sdk-cli-untouched code path in jsonlIndexer.ts
  // (the "indexFromRecentTurns" fallback path, around line 263),
  // which kept marking newly-indexed sdk-cli sessions as
  // is_automated=1. Those rows accumulated between v14 firing and
  // 1.1.4 shipping. Re-running the same UPDATE catches them. The
  // canonical jsonlIndexer fix in 1.1.4 stops the bleed.
  `
  UPDATE session
  SET is_automated = 0
  WHERE source = 'claude'
    AND entrypoint = 'sdk-cli'
    AND is_automated = 1;
  `,

  // v16 — workflow / subagent transcript support.
  // Child transcripts (Agent/Task tool spawns, /workflow runs) live under
  // <parent-session-dir>/subagents/*.jsonl and /subagents/workflows/*/*.jsonl.
  // They have their own usage blocks and real costs that were previously
  // invisible to CS "cost today" and the main UI. We store them as rows
  // too so their costs participate in aggregates and so we can list them.
  // `kind` distinguishes 'session' | 'subagent' | 'workflow'.
  // `parent_session_id` links a child back to its orchestrator session.
  // `workflow_id` captures the wf_<uuid> bucket when present.
  `
  ALTER TABLE session ADD COLUMN kind TEXT NOT NULL DEFAULT 'session';
  ALTER TABLE session ADD COLUMN parent_session_id TEXT;
  ALTER TABLE session ADD COLUMN workflow_id TEXT;
  CREATE INDEX idx_session_kind ON session(kind);
  CREATE INDEX idx_session_parent ON session(parent_session_id);
  `,
];

export type CoderSourceId = "claude" | "grok" | "git";

export interface SessionRow {
  session_id: string;
  /** Which coder CLI produced this session. Defaults to 'claude' for rows
   * migrated from pre-v1.0 DBs. */
  source: CoderSourceId;
  project_path: string;
  project_id: string | null;
  projects_touched: string[];
  jsonl_path: string;
  mtime_ns: number;
  size_bytes: number;
  started_at: number | null;
  ended_at: number | null;
  message_count: number;
  tool_count: number;
  subagent_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  model: string | null;
  title: string;
  first_user_msg: string | null;
  entrypoint: string | null;
  is_automated: boolean;
  indexed_at: number;
  /** Epoch ms of the most recent assistant text block. Falls back to
   * `ended_at` when the parser hasn't seen any text (or for rows indexed
   * before migration v5). */
  last_assistant_text_at: number | null;
  /** Source-specific telemetry blob (e.g. grok signals.json contents).
   * NULL for sources that don't emit it. See migration v9. */
  extras_json: string | null;
  /** 'session' (top-level orchestrator transcript), 'subagent' (direct
   * Agent/Task spawn under subagents/), or 'workflow' (under
   * subagents/workflows/<wf>/). New in v16. */
  kind: 'session' | 'subagent' | 'workflow';
  /** For child transcripts, the session_id of the parent that spawned it. */
  parent_session_id: string | null;
  /** When kind==='workflow', the wf_<id> bucket name. */
  workflow_id: string | null;
}

/** Per-parent aggregate of child subagent/workflow transcripts. */
export interface ChildRollup {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  child_count: number;
  workflow_count: number;
  subagent_count: number;
  /** Latest child activity (ms epoch) — used to keep parent in the right day bucket. */
  max_activity_ms: number;
}

export interface TurnRow {
  turn_uuid: string;
  session_id: string;
  turn_index: number;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  user_text: string | null;
  assistant_excerpt: string | null;
  tool_names_csv: string;
  tool_count: number;
  has_subagent: boolean;
  /** Per-turn token usage extracted from assistant.message.usage. Lets us
   * compute correct per-day token totals (a session that spans multiple
   * days no longer dumps its full lifetime total into a single day's
   * bucket). Default 0 for rows indexed before migration v11. */
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** Per-turn USD cost — precomputed at index time using the session's
   * model rate table. Lets the bucket header sum costs that were
   * actually paid that day, not the lifetime total. Default 0 for rows
   * indexed before migration v12. */
  cost_usd: number;
}

function rowToSession(r: any): SessionRow {
  return {
    session_id: r.session_id,
    source: (r.source as CoderSourceId) || "claude",
    project_path: r.project_path,
    project_id: r.project_id,
    projects_touched: r.projects_touched ? String(r.projects_touched).split(",").filter(Boolean) : [],
    jsonl_path: r.jsonl_path,
    mtime_ns: Number(r.mtime_ns),
    size_bytes: Number(r.size_bytes),
    started_at: r.started_at,
    ended_at: r.ended_at,
    message_count: r.message_count,
    tool_count: r.tool_count,
    subagent_count: r.subagent_count,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cache_read_tokens: r.cache_read_tokens,
    cache_write_tokens: r.cache_write_tokens,
    cost_usd: r.cost_usd,
    model: r.model,
    title: r.title,
    first_user_msg: r.first_user_msg,
    entrypoint: r.entrypoint,
    is_automated: !!r.is_automated,
    indexed_at: r.indexed_at,
    last_assistant_text_at: r.last_assistant_text_at ?? null,
    extras_json: r.extras_json ?? null,
    kind: (r.kind as any) || 'session',
    parent_session_id: r.parent_session_id ?? null,
    workflow_id: r.workflow_id ?? null,
  };
}

export class SessionStore {
  readonly db: Database;
  /** Retries for transient SQLITE_BUSY / "database is locked" on open. The WASM
   * VFS uses a sibling `<db>.lock` directory; stale locks after an unclean
   * extension-host exit — or a brief multi-window race — are the usual cause. */
  private static readonly OPEN_LOCK_ATTEMPTS = 8;
  private static readonly OPEN_LOCK_BASE_MS = 75;

  private constructor(private readonly dbPath: string) {
    this.db = new Database(dbPath);
    // Wait up to 5 s when another extension host briefly holds the DB.
    this.db.pragma("busy_timeout = 5000");
    // Requesting WAL is a no-op under the WASM VFS (it has no shared-memory
    // support and silently stays on a rollback journal), but we keep the call so
    // the intent is documented and behaviour matches a native build elsewhere.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    // mmap_size was set to 256 MB for the original better-sqlite3 native
    // build, where SQLite's `xMmap` is real virtual memory mapping (cheap).
    // node-sqlite3-wasm's VFS has no xMmap and Emscripten linear memory is
    // bounded; the pragma was at best a no-op and at worst contributed to
    // SQLITE_NOMEM "out of memory" failures on read. Explicit zero so the
    // intent is unmistakable and any future WASM build keeps the bound. */
    this.db.pragma("mmap_size = 0");
    // Pin the page cache to a conservative ~4 MB (cache_size negative = KB).
    // The previous build inherited better-sqlite3's 2000-page default which
    // can balloon under temp_store=MEMORY. Bounding it here keeps the WASM
    // heap predictable across long-running indexer passes.
    this.db.pragma("cache_size = -4096");
    // temp_store: keep small temp tables in memory for speed, but the WASM
    // engine has a tighter heap than a native build — if we ever see OOM
    // during DELETE/JOIN-heavy migrations, flip this to FILE.
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma("foreign_keys = ON");
  }

  /** node-sqlite3-wasm's VFS has no shared-memory (xShm) support, so it cannot
   * open a database whose file header is marked WAL (`unable to open database
   * file`). Databases created by the previous better-sqlite3 build are in WAL
   * mode. This rewrites the header's write/read format version bytes (offsets
   * 18 and 19) from 2 (WAL) back to 1 (rollback journal) so the WASM engine can
   * open the file with all data intact. Idempotent and best-effort.
   *
   * Safe when the WAL has been checkpointed — the normal case after a clean
   * shutdown, where the main file holds all committed data. Any uncheckpointed
   * `-wal` frames are dropped, which is acceptable here: this DB is a cache the
   * indexer rebuilds from the source JSONLs. */
  /** node-sqlite3-wasm's VFS locks files via a sibling `<file>.lock` directory
   * and can leave a stale one behind after an unclean close. Safe to remove when
   * no live holder exists — paired with open() retries for the multi-window race. */
  private static clearWasmVfsLock(dbPath: string): void {
    try {
      fs.rmSync(dbPath + ".lock", { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  private static isLockError(e: unknown): boolean {
    const msg = String((e as any)?.message ?? e);
    return /database is locked|SQLITE_BUSY/i.test(msg);
  }

  private static isCorruptError(e: unknown): boolean {
    const msg = String((e as any)?.message ?? e);
    return /database disk image is malformed|file is not a database|file is encrypted or is not a database|database is corrupt|unable to open database file|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(msg);
  }

  /** Short synchronous wait — `open()` runs during sync activate(). */
  private static sleepSync(ms: number): void {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      /* spin */
    }
  }

  private static tryCreateAndMigrate(dbPath: string): SessionStore {
    const store = new SessionStore(dbPath);
    store.migrate();
    return store;
  }

  private static quarantineCorruptDb(dbPath: string, reason: string): string {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${dbPath}.corrupt-${ts}`;
    try {
      fs.renameSync(dbPath, backupPath);
    } catch {
      try {
        fs.copyFileSync(dbPath, backupPath);
        fs.unlinkSync(dbPath);
      } catch {
        /* throw will re-fire on next attempt */
      }
    }
    for (const sfx of ["-wal", "-shm", "-journal", ".lock"]) {
      const side = dbPath + sfx;
      if (fs.existsSync(side)) {
        try {
          fs.renameSync(side, backupPath + sfx);
        } catch {
          try {
            fs.unlinkSync(side);
          } catch {
            /* ignore */
          }
        }
      }
    }
    SessionStore.lastRecoveredCorruption = { backupPath, reason };
    return backupPath;
  }

  private static coerceRollbackJournal(dbPath: string): void {
    try {
      if (!fs.existsSync(dbPath)) return;
      const fd = fs.openSync(dbPath, "r+");
      let isWal = false;
      try {
        const hdr = Buffer.alloc(2);
        // bytes 18 = file-format write version, 19 = read version; 1=rollback, 2=WAL
        fs.readSync(fd, hdr, 0, 2, 18);
        if (hdr[0] === 2 || hdr[1] === 2) {
          isWal = true;
          fs.writeSync(fd, Buffer.from([1, 1]), 0, 2, 18);
        }
      } finally {
        fs.closeSync(fd);
      }
      if (isWal) {
        // Sidecars only matter in WAL mode; once the header says rollback they
        // are ignored, so remove them to avoid confusion on the next open.
        for (const ext of ["-wal", "-shm"]) {
          try {
            fs.rmSync(dbPath + ext, { force: true });
          } catch {
            /* best-effort */
          }
        }
      }
    } catch {
      // If anything goes wrong, fall through — the subsequent open() will
      // surface the real error rather than masking it here.
    }
  }

  /** Result of the one-shot cross-extension DB import. Reported to the
   * caller so it can show a toast / log line on first activation after the
   * v1.0 rename — and on any later activation that finally completes the
   * merge if the user e.g. reinstalls or restores the old DB. */
  static migrationReport: {
    migrated: boolean;
    sessions: number;
    classifiedTurns: number;
  } | null = null;

  /** True when the most recent `open()` had to quarantine a corrupt DB
   * file and start fresh. Surfaced via a one-shot info toast in the
   * activate handler so the user knows what happened + sees the
   * backup path for forensics. Cleared on the next clean open. */
  static lastRecoveredCorruption: { backupPath: string; reason: string } | null = null;

  static open(globalStorageDir: string): SessionStore {
    fs.mkdirSync(globalStorageDir, { recursive: true });
    const dbPath = path.join(globalStorageDir, "sessions-cache.db");

    // Open (or create) our own DB and run schema migrations. If the
    // file on disk is corrupt (SQLITE_CORRUPT / "database disk image
    // is malformed"), the constructor or migrate() call throws.
    // Auto-recover: quarantine the bad file + its sidecars, then
    // recreate from scratch. The cache is rebuildable from the
    // upstream jsonls in ~/.claude/projects + ~/.grok/sessions, so
    // a wipe is cheap (the next sync pass repopulates) — far better
    // than leaving the user with a permanently broken sidebar.
    //
    // Quarantine path includes a timestamp so multiple corruption
    // events don't clobber each other. Sidecars (-wal, -shm,
    // .agent-memory.json, .agent-memory-audit.jsonl) move alongside
    // the main file in case the corruption originated there.
    SessionStore.lastRecoveredCorruption = null;
    let store: SessionStore | undefined;

    for (let attempt = 1; attempt <= SessionStore.OPEN_LOCK_ATTEMPTS; attempt++) {
      SessionStore.clearWasmVfsLock(dbPath);
      SessionStore.coerceRollbackJournal(dbPath);
      try {
        store = SessionStore.tryCreateAndMigrate(dbPath);
        break;
      } catch (e: any) {
        if (SessionStore.isLockError(e) && attempt < SessionStore.OPEN_LOCK_ATTEMPTS) {
          SessionStore.sleepSync(
            SessionStore.OPEN_LOCK_BASE_MS * Math.pow(2, attempt - 1),
          );
          continue;
        }
        if (SessionStore.isCorruptError(e) && fs.existsSync(dbPath)) {
          SessionStore.quarantineCorruptDb(dbPath, String(e?.message ?? e));
          SessionStore.clearWasmVfsLock(dbPath);
          store = SessionStore.tryCreateAndMigrate(dbPath);
          break;
        }
        throw e;
      }
    }
    if (!store) {
      throw new Error("SQLite cache failed to open after lock retries");
    }

    // One-shot import from the pre-v1.0 sibling extension directory. Unlike
    // earlier versions that just copied the file when the new DB didn't
    // exist (and silently no-op'd otherwise), this is an attached-DB MERGE
    // gated on a `migration` ledger row. That means:
    //   - works on a fresh install (no existing rows → copies everything)
    //   - works on a half-populated NEW DB (e.g. test runs that pre-seeded
    //     it before VS Code first activated): missing rows still backfill,
    //     existing rows are kept (INSERT OR IGNORE)
    //   - won't re-import on every activation thanks to the ledger row
    const IMPORT_NAME = "import_from_claude_sessions_v1";
    const alreadyImported = (store.db
      .prepare("SELECT 1 FROM migration WHERE name = ?")
      .get(IMPORT_NAME) as any) != null;

    if (!alreadyImported) {
      const oldDir = path.join(path.dirname(globalStorageDir), "zhirafovod.claude-sessions");
      const oldDb = path.join(oldDir, "sessions-cache.db");
      if (fs.existsSync(oldDb)) {
        const merged = store.mergeFromOldExtensionDb(oldDb);
        store.db
          .prepare("INSERT OR IGNORE INTO migration (name, applied_at, detail) VALUES (?, ?, ?)")
          .run(IMPORT_NAME, Date.now(), JSON.stringify(merged));
        SessionStore.migrationReport = {
          migrated: true,
          sessions: merged.sessionsAfter,
          classifiedTurns: merged.topicsAfter,
        };
      }
    }
    return store;
  }

  /** Merge rows from the pre-v1.0 sibling DB into this one. Idempotent via
   * INSERT OR IGNORE on each table's primary key. Returns before/after row
   * counts for diagnostics. */
  private mergeFromOldExtensionDb(oldDbPath: string): {
    sessionsBefore: number; sessionsAfter: number;
    turnsBefore: number; turnsAfter: number;
    topicsBefore: number; topicsAfter: number;
  } {
    const sessionsBefore = (this.db.prepare("SELECT COUNT(*) AS n FROM session").get() as any).n;
    const turnsBefore = (this.db.prepare("SELECT COUNT(*) AS n FROM turn").get() as any).n;
    const topicsBefore = (this.db.prepare("SELECT COUNT(*) AS n FROM turn_topic").get() as any).n;

    // node-sqlite3-wasm's VFS locks files via a sibling `<file>.lock` directory
    // and can leave a stale one behind after an unclean close. A single
    // connection tolerates its own stale lock, but ATTACH treats a locked file
    // as "database is locked" and aborts the merge. Old DBs written by the
    // pre-WASM (better-sqlite3) extension never have one, so this is a no-op in
    // the common case — it just guards against a lock left by a prior WASM run.
    SessionStore.clearWasmVfsLock(oldDbPath);
    // The old DB is also a better-sqlite3 (WAL-mode) file; ATTACH would fail to
    // open it under the WASM VFS unless we convert it to a rollback journal too.
    SessionStore.coerceRollbackJournal(oldDbPath);

    // ATTACH the old DB as `old.*` then INSERT OR IGNORE across every table
    // we want to preserve. The old schema is v6 and predates the `source`
    // column on `session` — supply 'claude' as the literal default. Wrap in
    // a single transaction so a failure mid-merge rolls back cleanly.
    this.db.exec(`ATTACH DATABASE '${oldDbPath.replace(/'/g, "''")}' AS old`);
    try {
      const tx = this.db.transaction(() => {
        // Repair pass for users whose NEW DB was populated by a buggy earlier
        // pre-release: grok's `session_kind: "claude_import"` sessions had
        // been indexed and their UPSERTs overwrote authentic claude rows on
        // the session_id PK, then `deleteTurnsForSession` cascade-deleted
        // the turn_topic rows. Detect that state and demote those grok rows
        // before the OLD merge so the authentic claude data wins.
        //
        // FK constraints: this cascade-deletes the offending session's turns
        // and topics. That's exactly what we want — the grok-attributed
        // turns/topics are inferior copies; OLD's authoritative versions are
        // restored by the INSERT OR IGNORE statements below.
        this.db.exec(`
          DELETE FROM session
          WHERE source = 'grok'
            AND session_id IN (SELECT session_id FROM old.session)
        `);

        // session: explicit column list so the new `source` column is
        // populated even though it doesn't exist in the old schema.
        // v16 columns (kind/parent/workflow) get defaults in the target table.
        this.db.exec(`
          INSERT OR IGNORE INTO session (
            session_id, source, project_path, project_id, projects_touched,
            jsonl_path, mtime_ns, size_bytes, started_at, ended_at,
            message_count, tool_count, subagent_count,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            cost_usd, model, title, first_user_msg,
            entrypoint, is_automated, indexed_at, last_assistant_text_at
          )
          SELECT
            session_id, 'claude', project_path, project_id, projects_touched,
            jsonl_path, mtime_ns, size_bytes, started_at, ended_at,
            message_count, tool_count, subagent_count,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            cost_usd, model, title, first_user_msg,
            entrypoint, is_automated, indexed_at,
            ${this.oldHasColumn("session", "last_assistant_text_at") ? "last_assistant_text_at" : "NULL"}
          FROM old.session
        `);

        // Explicit column list — `SELECT *` blew up on the rebrand
        // migration because the old (`zhirafovod.claude-sessions`)
        // turn table is the v1 schema with 11 columns, and the new
        // schema has 16 after migrations v11 (per-turn token columns)
        // and v12 (per-turn cost_usd) appended. The new five columns
        // default to 0 in the table definition; they get backfilled
        // on the next jsonl re-parse. Symptom pre-fix:
        //   SQLite cache failed to open: table turn has 16 columns
        //   but 11 values were supplied. Falling back to shell-script
        //   mode.
        // Keep this list aligned with the v1 turn schema (above) so
        // future column additions don't reopen the bug.
        this.db.exec(`
          INSERT OR IGNORE INTO turn (
            turn_uuid, session_id, turn_index, started_at, ended_at,
            duration_ms, user_text, assistant_excerpt, tool_names_csv,
            tool_count, has_subagent
          )
          SELECT
            turn_uuid, session_id, turn_index, started_at, ended_at,
            duration_ms, user_text, assistant_excerpt, tool_names_csv,
            tool_count, has_subagent
          FROM old.turn
        `);
        this.db.exec(`INSERT OR IGNORE INTO turn_topic SELECT * FROM old.turn_topic`);
        this.db.exec(`INSERT OR IGNORE INTO classification_batch SELECT * FROM old.classification_batch`);

        // session_embedding gained `cluster_id` at v4; old DBs through v3
        // lack that column.
        if (this.oldHasColumn("session_embedding", "cluster_id")) {
          this.db.exec(`INSERT OR IGNORE INTO session_embedding SELECT * FROM old.session_embedding`);
        } else if (this.oldHasTable("session_embedding")) {
          this.db.exec(`
            INSERT OR IGNORE INTO session_embedding
              (session_id, embedding, embedding_model, embedding_dim, computed_at, umap_x, umap_y, umap_fitted_at)
            SELECT session_id, embedding, embedding_model, embedding_dim, computed_at, umap_x, umap_y, umap_fitted_at
            FROM old.session_embedding
          `);
        }
        if (this.oldHasTable("turn_embedding")) {
          this.db.exec(`INSERT OR IGNORE INTO turn_embedding SELECT * FROM old.turn_embedding`);
        }
        if (this.oldHasTable("session_star")) {
          this.db.exec(`INSERT OR IGNORE INTO session_star SELECT * FROM old.session_star`);
        }
      });
      tx();
    } finally {
      this.db.exec("DETACH DATABASE old");
    }

    const sessionsAfter = (this.db.prepare("SELECT COUNT(*) AS n FROM session").get() as any).n;
    const turnsAfter = (this.db.prepare("SELECT COUNT(*) AS n FROM turn").get() as any).n;
    const topicsAfter = (this.db.prepare("SELECT COUNT(*) AS n FROM turn_topic").get() as any).n;
    return { sessionsBefore, sessionsAfter, turnsBefore, turnsAfter, topicsBefore, topicsAfter };
  }

  /** Helper used by the merge: does an attached `old` DB have this table? */
  private oldHasTable(tableName: string): boolean {
    const r = this.db
      .prepare("SELECT 1 FROM old.sqlite_master WHERE type='table' AND name=?")
      .get(tableName);
    return r != null;
  }

  /** Helper used by the merge: does an attached `old` DB have this column?
   * Required because PRAGMA table_info doesn't accept the schema prefix as
   * a parameter, so we have to parse the schema name into the SQL. */
  private oldHasColumn(tableName: string, columnName: string): boolean {
    if (!this.oldHasTable(tableName)) return false;
    const rows = this.db.prepare(`PRAGMA old.table_info(${tableName})`).all() as any[];
    return rows.some((r) => r.name === columnName);
  }

  migrate(): void {
    const current = (this.db.pragma("user_version", { simple: true }) as number) || 0;
    if (current >= MIGRATIONS.length) return;
    const apply = this.db.transaction((from: number) => {
      for (let v = from; v < MIGRATIONS.length; v++) {
        this.db.exec(MIGRATIONS[v]);
      }
      this.db.pragma(`user_version = ${MIGRATIONS.length}`);
    });
    apply(current);
  }

  // ---- session queries -------------------------------------------------- //

  count(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM session").get() as any).n as number;
  }

  getByJsonlPath(p: string): SessionRow | null {
    const r = this.db.prepare("SELECT * FROM session WHERE jsonl_path = ?").get(p);
    return r ? rowToSession(r) : null;
  }

  getById(id: string): SessionRow | null {
    const r = this.db.prepare("SELECT * FROM session WHERE session_id = ?").get(id);
    return r ? rowToSession(r) : null;
  }

  listRecent(limit: number, includeAutomated: boolean): SessionRow[] {
    const sql = `
      SELECT * FROM session
      WHERE ($includeAuto OR is_automated = 0)
      ORDER BY mtime_ns DESC
      LIMIT $limit
    `;
    return (this.db.prepare(sql).all({ limit, includeAuto: includeAutomated ? 1 : 0 }) as any[]).map(rowToSession);
  }

  listSinceEpoch(epochSec: number, includeAutomated: boolean): SessionRow[] {
    const sql = `
      SELECT * FROM session
      WHERE ended_at >= $epochMs
        AND ($includeAuto OR is_automated = 0)
      ORDER BY mtime_ns DESC
    `;
    return (this.db.prepare(sql).all({ epochMs: epochSec * 1000, includeAuto: includeAutomated ? 1 : 0 }) as any[]).map(
      rowToSession,
    );
  }

  /** Aggregate billable child transcripts (subagent + workflow) per parent
   * session. Used to roll child spend into the parent row in the Sessions
   * tree without listing children as separate sessions. */
  childRollupByParent(): Map<string, ChildRollup> {
    const sql = `
      SELECT
        parent_session_id,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COUNT(*) AS child_count,
        COALESCE(SUM(CASE WHEN kind = 'workflow' THEN 1 ELSE 0 END), 0) AS workflow_count,
        COALESCE(SUM(CASE WHEN kind = 'subagent' THEN 1 ELSE 0 END), 0) AS subagent_count,
        MAX(COALESCE(last_assistant_text_at, ended_at, CAST(mtime_ns / 1000000 AS INTEGER))) AS max_activity_ms
      FROM session
      WHERE kind IN ('subagent', 'workflow')
        AND parent_session_id IS NOT NULL
      GROUP BY parent_session_id
    `;
    const out = new Map<string, ChildRollup>();
    for (const r of this.db.prepare(sql).all() as any[]) {
      if (!r.parent_session_id) continue;
      out.set(r.parent_session_id, {
        cost_usd: Number(r.cost_usd ?? 0),
        input_tokens: Number(r.input_tokens ?? 0),
        output_tokens: Number(r.output_tokens ?? 0),
        cache_read_tokens: Number(r.cache_read_tokens ?? 0),
        cache_write_tokens: Number(r.cache_write_tokens ?? 0),
        child_count: Number(r.child_count ?? 0),
        workflow_count: Number(r.workflow_count ?? 0),
        subagent_count: Number(r.subagent_count ?? 0),
        max_activity_ms: Number(r.max_activity_ms ?? 0),
      });
    }
    return out;
  }

  /** Return session_ids of child transcripts whose parent is in `parentIds`. */
  childSessionIdsForParents(parentIds: string[]): string[] {
    if (parentIds.length === 0) return [];
    const placeholders = parentIds.map(() => "?").join(",");
    const sql = `
      SELECT session_id FROM session
      WHERE parent_session_id IN (${placeholders})
        AND kind IN ('subagent', 'workflow')
    `;
    return (this.db.prepare(sql).all(...parentIds) as any[]).map((r) => String(r.session_id));
  }

  upsertSession(s: SessionRow): void {
    this.db.prepare(`
      INSERT INTO session (
        session_id, source, project_path, project_id, projects_touched, jsonl_path,
        mtime_ns, size_bytes, started_at, ended_at,
        message_count, tool_count, subagent_count,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cost_usd, model, title, first_user_msg,
        entrypoint, is_automated, indexed_at, last_assistant_text_at,
        extras_json, kind, parent_session_id, workflow_id
      ) VALUES (
        @session_id, @source, @project_path, @project_id, @projects_touched, @jsonl_path,
        @mtime_ns, @size_bytes, @started_at, @ended_at,
        @message_count, @tool_count, @subagent_count,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
        @cost_usd, @model, @title, @first_user_msg,
        @entrypoint, @is_automated, @indexed_at, @last_assistant_text_at,
        @extras_json, @kind, @parent_session_id, @workflow_id
      )
      ON CONFLICT(session_id) DO UPDATE SET
        source              = excluded.source,
        project_path        = excluded.project_path,
        project_id          = excluded.project_id,
        projects_touched    = excluded.projects_touched,
        jsonl_path          = excluded.jsonl_path,
        mtime_ns            = excluded.mtime_ns,
        size_bytes          = excluded.size_bytes,
        started_at          = excluded.started_at,
        ended_at            = excluded.ended_at,
        message_count       = excluded.message_count,
        tool_count          = excluded.tool_count,
        subagent_count      = excluded.subagent_count,
        input_tokens        = excluded.input_tokens,
        output_tokens       = excluded.output_tokens,
        cache_read_tokens   = excluded.cache_read_tokens,
        cache_write_tokens  = excluded.cache_write_tokens,
        cost_usd            = excluded.cost_usd,
        model               = excluded.model,
        title               = excluded.title,
        first_user_msg      = excluded.first_user_msg,
        entrypoint          = excluded.entrypoint,
        is_automated        = excluded.is_automated,
        indexed_at          = excluded.indexed_at,
        last_assistant_text_at = excluded.last_assistant_text_at,
        extras_json         = excluded.extras_json,
        kind                = excluded.kind,
        parent_session_id   = excluded.parent_session_id,
        workflow_id         = excluded.workflow_id
    `).run({
      ...s,
      projects_touched: s.projects_touched.join(","),
      is_automated: s.is_automated ? 1 : 0,
      last_assistant_text_at: s.last_assistant_text_at ?? null,
      extras_json: s.extras_json ?? null,
      kind: s.kind || 'session',
      parent_session_id: s.parent_session_id ?? null,
      workflow_id: s.workflow_id ?? null,
    });
  }

  deleteByPaths(paths: string[]): number {
    if (paths.length === 0) return 0;
    const placeholders = paths.map(() => "?").join(",");
    const info = this.db.prepare(`DELETE FROM session WHERE jsonl_path IN (${placeholders})`).run(...paths);
    return info.changes;
  }

  /** Map of all jsonl_path → (mtime_ns, size_bytes). Used by the indexer to compute the diff. */
  knownPaths(): Map<string, { mtime_ns: number; size_bytes: number }> {
    const m = new Map<string, { mtime_ns: number; size_bytes: number }>();
    for (const r of this.db.prepare("SELECT jsonl_path, mtime_ns, size_bytes FROM session").all() as any[]) {
      m.set(r.jsonl_path, { mtime_ns: Number(r.mtime_ns), size_bytes: Number(r.size_bytes) });
    }
    return m;
  }

  // ---- turn queries ----------------------------------------------------- //

  upsertTurns(turns: TurnRow[]): void {
    if (turns.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO turn (
        turn_uuid, session_id, turn_index, started_at, ended_at, duration_ms,
        user_text, assistant_excerpt, tool_names_csv, tool_count, has_subagent,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
      ) VALUES (
        @turn_uuid, @session_id, @turn_index, @started_at, @ended_at, @duration_ms,
        @user_text, @assistant_excerpt, @tool_names_csv, @tool_count, @has_subagent,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens, @cost_usd
      )
      ON CONFLICT(turn_uuid) DO UPDATE SET
        turn_index         = excluded.turn_index,
        started_at         = excluded.started_at,
        ended_at           = excluded.ended_at,
        duration_ms        = excluded.duration_ms,
        user_text          = excluded.user_text,
        assistant_excerpt  = excluded.assistant_excerpt,
        tool_names_csv     = excluded.tool_names_csv,
        tool_count         = excluded.tool_count,
        has_subagent       = excluded.has_subagent,
        input_tokens       = excluded.input_tokens,
        output_tokens      = excluded.output_tokens,
        cache_read_tokens  = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        cost_usd           = excluded.cost_usd
    `);
    const insertMany = this.db.transaction((rows: TurnRow[]) => {
      for (const r of rows) {
        stmt.run({ ...r, has_subagent: r.has_subagent ? 1 : 0 });
      }
    });
    insertMany(turns);
  }

  deleteTurnsForSession(sessionId: string): void {
    this.db.prepare("DELETE FROM turn WHERE session_id = ?").run(sessionId);
  }

  turnsForSession(sessionId: string): TurnRow[] {
    const rows = this.db
      .prepare("SELECT * FROM turn WHERE session_id = ? ORDER BY turn_index")
      .all(sessionId) as any[];
    return rows.map((r) => ({
      ...r,
      has_subagent: !!r.has_subagent,
    }));
  }

  // ---- topic queries (Phase 1B) ---------------------------------------- //

  topicsForSession(sessionId: string): Map<string, { topic: string; topic_norm: string }> {
    const rows = this.db
      .prepare(`
        SELECT tt.turn_uuid, tt.topic, tt.topic_norm
        FROM turn t
        JOIN turn_topic tt ON tt.turn_uuid = t.turn_uuid
        WHERE t.session_id = ?
      `)
      .all(sessionId) as any[];
    return new Map(rows.map((r) => [r.turn_uuid, { topic: r.topic, topic_norm: r.topic_norm }]));
  }

  countTurnsWithoutTopic(sessionId: string): number {
    return (
      this.db
        .prepare(`
          SELECT count(*) AS n
          FROM turn t
          LEFT JOIN turn_topic tt ON tt.turn_uuid = t.turn_uuid
          WHERE t.session_id = ? AND tt.turn_uuid IS NULL AND COALESCE(t.user_text, '') != ''
        `)
        .get(sessionId) as any
    ).n;
  }

  upsertTopics(rows: Array<{ turn_uuid: string; topic: string; model: string; prompt_rev: number; batch_id: string }>): void {
    if (rows.length === 0) return;
    const norm = (s: string) =>
      s.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 64);
    const stmt = this.db.prepare(`
      INSERT INTO turn_topic (turn_uuid, topic, topic_norm, classified_at, model, prompt_rev, batch_id)
      VALUES (@turn_uuid, @topic, @topic_norm, @classified_at, @model, @prompt_rev, @batch_id)
      ON CONFLICT(turn_uuid) DO UPDATE SET
        topic = excluded.topic,
        topic_norm = excluded.topic_norm,
        classified_at = excluded.classified_at,
        model = excluded.model,
        prompt_rev = excluded.prompt_rev,
        batch_id = excluded.batch_id
    `);
    const now = Date.now();
    const insertMany = this.db.transaction((items: typeof rows) => {
      for (const r of items) {
        try {
          stmt.run({
            turn_uuid: r.turn_uuid,
            topic: r.topic,
            topic_norm: norm(r.topic),
            classified_at: now,
            model: r.model,
            prompt_rev: r.prompt_rev,
            batch_id: r.batch_id,
          });
        } catch (e: any) {
          // Most common case here is a FOREIGN KEY violation when the model
          // returned a turn_uuid that isn't in the `turn` table (hallucinated
          // or truncated). Caller already filters known ids; this is the
          // belt-and-suspenders so one bad row never rolls back the rest.
          if (!/FOREIGN KEY|UNIQUE/i.test(String(e?.message ?? ""))) {
            // Anything else is unexpected — re-throw to surface it.
            throw e;
          }
        }
      }
    });
    insertMany(rows);
  }

  createBatch(batchId: string, turnCount: number, model: string): void {
    this.db.prepare(`
      INSERT INTO classification_batch (batch_id, started_at, turn_count, model, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(batchId, Date.now(), turnCount, model);
  }

  finishBatch(batchId: string, status: "ok" | "partial" | "failed", error?: string, inputTokens?: number, outputTokens?: number): void {
    this.db.prepare(`
      UPDATE classification_batch
      SET finished_at = ?, status = ?, error = ?, input_tokens = ?, output_tokens = ?
      WHERE batch_id = ?
    `).run(Date.now(), status, error || null, inputTokens ?? null, outputTokens ?? null, batchId);
  }

  // ---- embedding queries (Phase 1C) ------------------------------------ //

  upsertEmbedding(sessionId: string, embedding: Float32Array, model: string): void {
    this.db.prepare(`
      INSERT INTO session_embedding (session_id, embedding, embedding_model, embedding_dim, computed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        embedding = excluded.embedding,
        embedding_model = excluded.embedding_model,
        embedding_dim = excluded.embedding_dim,
        computed_at = excluded.computed_at
    `).run(sessionId, Buffer.from(embedding.buffer), model, embedding.length, Date.now());
  }

  setUmapCoords(rows: Array<{ session_id: string; x: number; y: number }>, fittedAt: number): void {
    const stmt = this.db.prepare(`
      UPDATE session_embedding SET umap_x = ?, umap_y = ?, umap_fitted_at = ? WHERE session_id = ?
    `);
    const tx = this.db.transaction((items: typeof rows) => {
      for (const r of items) stmt.run(r.x, r.y, fittedAt, r.session_id);
    });
    tx(rows);
  }

  embeddingsByModel(model: string): Array<{ session_id: string; embedding: Float32Array; umap_x: number | null; umap_y: number | null }> {
    return (this.db
      .prepare("SELECT session_id, embedding, umap_x, umap_y FROM session_embedding WHERE embedding_model = ?")
      .all(model) as any[]).map((r) => ({
      session_id: r.session_id,
      embedding: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
      umap_x: r.umap_x,
      umap_y: r.umap_y,
    }));
  }

  /** Pull every embedding back + cluster_id for the given model. */
  embeddingsWithClustersByModel(model: string): Array<{ session_id: string; embedding: Float32Array; umap_x: number | null; umap_y: number | null; cluster_id: number | null }> {
    return (this.db
      .prepare("SELECT session_id, embedding, umap_x, umap_y, cluster_id FROM session_embedding WHERE embedding_model = ?")
      .all(model) as any[]).map((r) => ({
      session_id: r.session_id,
      embedding: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
      umap_x: r.umap_x,
      umap_y: r.umap_y,
      cluster_id: r.cluster_id,
    }));
  }

  setClusterIds(rows: Array<{ session_id: string; cluster_id: number }>): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare("UPDATE session_embedding SET cluster_id = ? WHERE session_id = ?");
    const tx = this.db.transaction((items: typeof rows) => {
      for (const r of items) stmt.run(r.cluster_id, r.session_id);
    });
    tx(rows);
  }

  // ---- turn-embedding queries (Phase 1D) -------------------------------- //

  turnEmbeddingsForSession(sessionId: string, model: string): Map<string, Float32Array> {
    const rows = this.db
      .prepare(`
        SELECT te.turn_uuid, te.embedding
        FROM turn t
        JOIN turn_embedding te ON te.turn_uuid = t.turn_uuid AND te.embedding_model = ?
        WHERE t.session_id = ?
      `)
      .all(model, sessionId) as any[];
    return new Map(
      rows.map((r) => [
        r.turn_uuid,
        new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
      ]),
    );
  }

  upsertTurnEmbeddings(rows: Array<{ turn_uuid: string; embedding: Float32Array; model: string }>): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO turn_embedding (turn_uuid, embedding, embedding_model, embedding_dim, computed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(turn_uuid) DO UPDATE SET
        embedding = excluded.embedding,
        embedding_model = excluded.embedding_model,
        embedding_dim = excluded.embedding_dim,
        computed_at = excluded.computed_at
    `);
    const now = Date.now();
    const tx = this.db.transaction((items: typeof rows) => {
      for (const r of items) {
        stmt.run(r.turn_uuid, Buffer.from(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength), r.model, r.embedding.length, now);
      }
    });
    tx(rows);
  }

  // ---- topic aggregates per session (Phase 1D) -------------------------- //

  topTopicsBySession(sessionIds: string[], limit = 3): Map<string, { top: string[]; counts: Map<string, number> }> {
    const out = new Map<string, { top: string[]; counts: Map<string, number> }>();
    if (sessionIds.length === 0) return out;
    const placeholders = sessionIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`
        SELECT t.session_id AS sid, tt.topic_norm AS topic, COUNT(*) AS n
        FROM turn t
        JOIN turn_topic tt ON tt.turn_uuid = t.turn_uuid
        WHERE t.session_id IN (${placeholders})
        GROUP BY t.session_id, tt.topic_norm
        ORDER BY t.session_id, n DESC
      `)
      .all(...sessionIds) as any[];
    for (const r of rows) {
      const entry = out.get(r.sid) ?? { top: [], counts: new Map<string, number>() };
      entry.counts.set(r.topic, Number(r.n));
      if (entry.top.length < limit) entry.top.push(r.topic);
      out.set(r.sid, entry);
    }
    return out;
  }

  sessionsMissingEmbedding(model: string): SessionRow[] {
    const rows = this.db
      .prepare(`
        SELECT s.* FROM session s
        LEFT JOIN session_embedding e ON e.session_id = s.session_id AND e.embedding_model = ?
        WHERE e.session_id IS NULL AND s.is_automated = 0
      `)
      .all(model) as any[];
    return rows.map(rowToSession);
  }

  /** Delete every session_embedding row whose model id is not `keepModel`. */
  deleteEmbeddingsExceptModel(keepModel: string): number {
    return this.db.prepare("DELETE FROM session_embedding WHERE embedding_model != ?").run(keepModel).changes;
  }

  /** Delete every turn_embedding row whose model id is not `keepModel`. */
  deleteTurnEmbeddingsExceptModel(keepModel: string): number {
    return this.db.prepare("DELETE FROM turn_embedding WHERE embedding_model != ?").run(keepModel).changes;
  }

  /** Cheap aggregate counts for the background-classifier overview. All in
   * a single round trip via SQLite's expression-list trick. */
  classificationOverview(): {
    totalSessions: number;
    sessionsWithPending: number;
    totalEligibleTurns: number;
    classifiedTurns: number;
  } {
    const r = this.db
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM session) AS totalSessions,
          (SELECT COUNT(DISTINCT t.session_id)
             FROM turn t
             LEFT JOIN turn_topic tt ON tt.turn_uuid = t.turn_uuid
             WHERE tt.turn_uuid IS NULL AND COALESCE(t.user_text,'') != '') AS sessionsWithPending,
          (SELECT COUNT(*) FROM turn WHERE COALESCE(user_text,'') != '') AS totalEligibleTurns,
          (SELECT COUNT(*) FROM turn_topic) AS classifiedTurns
      `)
      .get() as any;
    return {
      totalSessions: Number(r?.totalSessions ?? 0),
      sessionsWithPending: Number(r?.sessionsWithPending ?? 0),
      totalEligibleTurns: Number(r?.totalEligibleTurns ?? 0),
      classifiedTurns: Number(r?.classifiedTurns ?? 0),
    };
  }

  /** Returns sessions that still have ≥1 turn with non-empty `user_text` but
   * no `turn_topic` row. Used by the background classifier daemon to schedule
   * incremental classification work. Sorted newest-first. */
  sessionsWithUnclassifiedTurns(limit = 200): string[] {
    const rows = this.db
      .prepare(`
        SELECT s.session_id
        FROM session s
        WHERE EXISTS (
          SELECT 1
          FROM turn t
          LEFT JOIN turn_topic tt ON tt.turn_uuid = t.turn_uuid
          WHERE t.session_id = s.session_id
            AND tt.turn_uuid IS NULL
            AND COALESCE(t.user_text, '') != ''
        )
        ORDER BY s.mtime_ns DESC
        LIMIT ?
      `)
      .all(limit) as any[];
    return rows.map((r) => r.session_id);
  }

  // ---- search ----------------------------------------------------------- //

  /** LIKE-based search over `turn_topic`. Returns one row per (session, topic_norm)
   * with the count of matching turns. */
  searchTopics(
    query: string,
    limit = 200,
  ): Array<{
    session_id: string;
    title: string | null;
    project_id: string | null;
    project_path: string | null;
    topic: string;
    topic_norm: string;
    count: number;
    last_ts: number | null;
  }> {
    const q = String(query || "").trim();
    if (q.length === 0) return [];
    const like = "%" + q.toLowerCase() + "%";
    const rows = this.db
      .prepare(`
        SELECT s.session_id, s.title, s.project_id, s.project_path, tt.topic_norm,
               MIN(tt.topic) AS topic,
               COUNT(*) AS c,
               MAX(t.ended_at) AS last_ts
        FROM turn_topic tt
        JOIN turn t ON t.turn_uuid = tt.turn_uuid
        JOIN session s ON s.session_id = t.session_id
        WHERE LOWER(tt.topic) LIKE ? OR LOWER(tt.topic_norm) LIKE ?
        GROUP BY s.session_id, tt.topic_norm
        ORDER BY last_ts DESC NULLS LAST, c DESC
        LIMIT ?
      `)
      .all(like, like, limit) as any[];
    return rows.map((r) => ({
      session_id: r.session_id,
      title: r.title,
      project_id: r.project_id ?? null,
      project_path: r.project_path ?? null,
      topic: r.topic,
      topic_norm: r.topic_norm,
      count: r.c,
      last_ts: r.last_ts ?? null,
    }));
  }

  /** LIKE-based search over `turn.user_text` and `turn.assistant_excerpt`. Returns
   * matching turns with enough context to render an excerpt. */
  searchTurns(
    query: string,
    limit = 200,
  ): Array<{
    session_id: string;
    title: string | null;
    project_id: string | null;
    project_path: string | null;
    turn_uuid: string;
    turn_index: number;
    ts: number | null;
    user_text: string | null;
    assistant_excerpt: string | null;
    matched: "user" | "assistant" | "both";
  }> {
    const q = String(query || "").trim();
    if (q.length === 0) return [];
    const like = "%" + q.toLowerCase() + "%";
    const rows = this.db
      .prepare(`
        SELECT t.session_id, s.title, s.project_id, s.project_path,
               t.turn_uuid, t.turn_index, t.ended_at AS ts,
               t.user_text, t.assistant_excerpt,
               (LOWER(COALESCE(t.user_text,'')) LIKE ?) AS um,
               (LOWER(COALESCE(t.assistant_excerpt,'')) LIKE ?) AS am
        FROM turn t
        JOIN session s ON s.session_id = t.session_id
        WHERE LOWER(COALESCE(t.user_text,'')) LIKE ?
           OR LOWER(COALESCE(t.assistant_excerpt,'')) LIKE ?
        ORDER BY t.ended_at DESC NULLS LAST
        LIMIT ?
      `)
      .all(like, like, like, like, limit) as any[];
    return rows.map((r) => ({
      session_id: r.session_id,
      title: r.title,
      project_id: r.project_id ?? null,
      project_path: r.project_path ?? null,
      turn_uuid: r.turn_uuid,
      turn_index: r.turn_index,
      ts: r.ts ?? null,
      user_text: r.user_text,
      assistant_excerpt: r.assistant_excerpt,
      matched: r.um && r.am ? "both" : r.um ? "user" : "assistant",
    }));
  }

  // ---- starred sessions ------------------------------------------------- //

  starSession(sessionId: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO session_star (session_id, starred_at) VALUES (?, ?)")
      .run(sessionId, Date.now());
  }

  unstarSession(sessionId: string): void {
    this.db.prepare("DELETE FROM session_star WHERE session_id = ?").run(sessionId);
  }

  /** Set of starred session ids; cheap to read on every tree refresh. */
  starredSessionIds(): Set<string> {
    const rows = this.db.prepare("SELECT session_id FROM session_star").all() as any[];
    return new Set(rows.map((r) => r.session_id));
  }

  // ---- hidden sessions ------------------------------------------------- //

  setHidden(sessionId: string, hidden: boolean): void {
    if (hidden) {
      this.db
        .prepare("INSERT OR REPLACE INTO session_hide (session_id, hidden_at) VALUES (?, ?)")
        .run(sessionId, Date.now());
    } else {
      this.db.prepare("DELETE FROM session_hide WHERE session_id = ?").run(sessionId);
    }
  }

  /** Set of hidden session ids; read on every tree refresh. */
  hiddenSessionIds(): Set<string> {
    const rows = this.db.prepare("SELECT session_id FROM session_hide").all() as any[];
    return new Set(rows.map((r) => r.session_id));
  }

  /** Overwrite the cached session.title for an id. Called after a rename
   * rewrites the source-of-truth file (Claude `aiTitle` line / Grok
   * `summary.json.generated_title`) so the tree shows the new label
   * immediately, without waiting for the next indexer pass to re-parse the
   * file. The next indexer pass will re-derive the same value, so this is
   * just a latency optimisation, not a divergence. */
  updateSessionTitle(sessionId: string, title: string): void {
    this.db
      .prepare("UPDATE session SET title = ? WHERE session_id = ?")
      .run(title, sessionId);
  }

  // ---- maintenance ----------------------------------------------------- //

  close(): void {
    this.db.close();
  }
}
