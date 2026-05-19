// SQLite cache for Claude Code session metadata.
//
// One DB at `<extensionGlobalStorageUri>/sessions-cache.db`. WAL mode.
// Migrations are numbered SQL strings, applied via PRAGMA user_version.
//
// All providers should read session metadata through this store, NOT by
// shelling out to session-center.sh on every refresh.

import Database from "better-sqlite3";
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
];

export interface SessionRow {
  session_id: string;
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
}

function rowToSession(r: any): SessionRow {
  return {
    session_id: r.session_id,
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
  };
}

export class SessionStore {
  readonly db: Database.Database;
  private constructor(private readonly dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma("mmap_size = 268435456");
    this.db.pragma("foreign_keys = ON");
  }

  static open(globalStorageDir: string): SessionStore {
    fs.mkdirSync(globalStorageDir, { recursive: true });
    const store = new SessionStore(path.join(globalStorageDir, "sessions-cache.db"));
    store.migrate();
    return store;
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

  upsertSession(s: SessionRow): void {
    this.db.prepare(`
      INSERT INTO session (
        session_id, project_path, project_id, projects_touched, jsonl_path,
        mtime_ns, size_bytes, started_at, ended_at,
        message_count, tool_count, subagent_count,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cost_usd, model, title, first_user_msg,
        entrypoint, is_automated, indexed_at
      ) VALUES (
        @session_id, @project_path, @project_id, @projects_touched, @jsonl_path,
        @mtime_ns, @size_bytes, @started_at, @ended_at,
        @message_count, @tool_count, @subagent_count,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
        @cost_usd, @model, @title, @first_user_msg,
        @entrypoint, @is_automated, @indexed_at
      )
      ON CONFLICT(session_id) DO UPDATE SET
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
        indexed_at          = excluded.indexed_at
    `).run({
      ...s,
      projects_touched: s.projects_touched.join(","),
      is_automated: s.is_automated ? 1 : 0,
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
        user_text, assistant_excerpt, tool_names_csv, tool_count, has_subagent
      ) VALUES (
        @turn_uuid, @session_id, @turn_index, @started_at, @ended_at, @duration_ms,
        @user_text, @assistant_excerpt, @tool_names_csv, @tool_count, @has_subagent
      )
      ON CONFLICT(turn_uuid) DO UPDATE SET
        turn_index        = excluded.turn_index,
        started_at        = excluded.started_at,
        ended_at          = excluded.ended_at,
        duration_ms       = excluded.duration_ms,
        user_text         = excluded.user_text,
        assistant_excerpt = excluded.assistant_excerpt,
        tool_names_csv    = excluded.tool_names_csv,
        tool_count        = excluded.tool_count,
        has_subagent      = excluded.has_subagent
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
        stmt.run({
          turn_uuid: r.turn_uuid,
          topic: r.topic,
          topic_norm: norm(r.topic),
          classified_at: now,
          model: r.model,
          prompt_rev: r.prompt_rev,
          batch_id: r.batch_id,
        });
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

  // ---- maintenance ----------------------------------------------------- //

  close(): void {
    this.db.close();
  }
}
