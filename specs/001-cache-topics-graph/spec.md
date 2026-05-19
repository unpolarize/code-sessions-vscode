# Feature Specification: SQLite cache, topic detection, agent graph

**Feature**: `001-cache-topics-graph`
**Created**: 2026-05-18
**Status**: In progress (v0.7.0 ships Phase 1 of each)
**Source**: `~/docs/knowledge/tech/agents/claude-sessions-extension-design.md`

This spec is the implementation contract for three tightly-coupled features that share one SQLite store.

## Why one spec for three features

They share storage and lifecycle:

- The **cache** is the foundation. Everything else reads from it.
- **Topic detection** needs `turn` rows present + persists topics keyed by `turn_uuid`.
- **Agent graph** needs session embeddings persisted next to session metadata.

Shipping these in three separate specs would force three migrations and three DB-connection lifecycles. One spec, one DB, one migration runner, three feature flags.

## Out-of-scope decisions made elsewhere

- Storage choice: **`better-sqlite3` + WAL** (per the research doc).
- Migration mechanism: **`PRAGMA user_version`** with numbered SQL strings in `src/db/migrations.ts`.
- Embedding model preference: **Ollama nomic-embed-text-v1.5** if present, else **Transformers.js + bge-small-en-v1.5** in-process.
- Classification model: **`claude -p --model claude-haiku-4-5`** (subscription, not API).

---

## User Scenarios

### User Story 1 — Dashboard / sidebar loads in ~200 ms instead of ~9 s (Priority: P1)

As a heavy Claude Code user with ~1500 sessions, when I open the Activity Bar or click the 📊 dashboard button, I expect data to appear effectively instantly. Today it spawns `session-center.sh`, which walks all 1500 JSONLs every time. After this feature ships, the same view should render off a SQLite cache and only re-parse the small set of JSONLs whose `(mtime, size)` advanced since the last open.

**Acceptance**:

1. **Given** I have ~1500 JSONLs on disk and the extension was active in the last hour, **when** I open the Sessions sidebar, **then** the tree populates in ≤ 500 ms (cold ≤ 2 s on first activation).
2. **Given** I send 50 new messages in a live session, **when** the file watcher fires, **then** the corresponding row in SQLite is updated and the sidebar refreshes in ≤ 1 s — without re-parsing the other 1499 sessions.
3. **Given** I add a brand-new session, **when** I refresh, **then** it appears at the top of the tree on the next refresh without manual intervention.

### User Story 2 — Each conversation turn shows its detected topic (Priority: P1)

As a user reviewing an old session in the conversation viewer, I expect each user turn to carry a short topic label (2–5 words, lowercase, dashes), and I expect a visible marker between turns where the topic changes.

**Acceptance**:

1. **Given** a session I have not opened yet, **when** I open the conversation viewer, **then** an "Analyze topics" button is visible above the turn list, and the turns show `untagged` until I click it.
2. **Given** I click "Analyze topics", **when** the classifier runs, **then** within ~20 s for a 30-turn session each turn shows a topic chip and consecutive different topics show a `↪ topic changed` divider.
3. **Given** the classifier already ran on this session yesterday, **when** I open it today, **then** the topics appear immediately from the cache (no re-classification).
4. **Given** my Claude Max plan is rate-limited, **when** the classifier hits a limit mid-batch, **then** the partially classified turns are persisted and the UI shows "Rate-limited; resume in N minutes". No double-billing on resume.

### User Story 3 — 2D map of all sessions by topic similarity (Priority: P2)

As a user, I want a "Show agent graph" command that opens a webview with a 2D scatter where each point is a session, colored by recency, positioned so semantically similar sessions cluster. I want to hover for a tooltip, click to open the conversation viewer.

**Acceptance**:

1. **Given** I have 1500 sessions and have never opened the graph, **when** I run **Claude: Show agent graph**, **then** within ~15 s a Canvas plot appears with ~1500 dots clustered by topic; theme colors match VS Code.
2. **Given** I subsequently open 10 new sessions, **when** I re-open the graph, **then** the existing layout is preserved and the new sessions land near their topic neighbors (deterministic `umap.transform()`).
3. **Given** I click a dot, **when** the click is registered, **then** the conversation viewer opens for that session.
4. **Given** Ollama is not installed, **when** the graph builds, **then** the extension falls back to Transformers.js (no user-visible failure) and reports "embedded via Transformers.js" in the status line.

### Edge cases

- A user deletes a session JSONL on disk → the corresponding `session` row is removed on next sync. (`SELECT … WHERE jsonl_path NOT IN (… disk listing …) DELETE`.)
- `claude -p` returns malformed JSONL → per-line parse with per-failure retry (binary-split the batch). Always validate `{id, topic}` shape before insert.
- A session's first user message is empty (rare, observed) → topic defaults to `untagged` and is not stored.
- The Ollama HTTP endpoint is up but the model isn't pulled → catch the 404, surface "Run: ollama pull nomic-embed-text", fall back to Transformers.js.
- The user disables the cache (`claudeSessions.cacheEnabled = false`) → all providers go back to running `session-center.sh` like in v0.6.x. Topic + graph features are disabled in this mode.

## Functional Requirements

### FR-1 — Single SQLite store at a stable path

System MUST open exactly one SQLite database located at `<extensionGlobalStorageUri>/sessions-cache.db`. Connection settings: `journal_mode=WAL`, `synchronous=NORMAL`, `temp_store=MEMORY`, `mmap_size=268435456`. One connection per extension host process; do not pool.

### FR-2 — Migrations are versioned and additive

System MUST use `PRAGMA user_version` to track schema. Migrations live in a numbered array in `src/db/migrations.ts`. On activate, the migrator applies any unapplied migrations inside a transaction and bumps the version. New fields added in later versions MUST be additive (`ALTER TABLE ADD COLUMN` + lazy backfill). Breaking changes require an explicit drop+re-derive path with a user-visible warning.

### FR-3 — `session` table schema (migration v1)

See [`docs/architecture.md`](../../docs/architecture.md) for the column list. Mandatory indexed columns: `session_id` (PK), `jsonl_path` (UNIQUE), `started_at` (DESC), `mtime_ns` (DESC), `project_path`.

### FR-4 — `turn` table schema (migration v1)

Per-turn rows keyed by `turn_uuid` with foreign key on `session_id`. Stores `started_at`, `duration_ms`, `user_text` (truncated 4 KB), `assistant_excerpt` (1 KB), `tool_calls_json` (compact tool-name + duration array), and token counts. Indexed on `(session_id, turn_index)`.

### FR-5 — Incremental indexer

System MUST sync disk JSONLs → SQLite using a **`(mtime_ns, size_bytes)` diff**:

1. List all `~/.claude/projects/*/*.jsonl`.
2. For each, compare against the `session` row's `mtime_ns + size_bytes`.
3. New or changed JSONLs are parsed with the existing `parseConversation()` (already in `src/conversationParser.ts`) and upserted in one transaction.
4. JSONLs that exist in DB but no longer on disk are DELETEd in the same transaction (cascades to `turn`).

The indexer MUST run:
- Once on activate, debounced 200 ms after window restore.
- Once when the JSONL `FileSystemWatcher` fires (already wired), debounced 1.5 s.
- On explicit `claudeSessions.refresh` command.

### FR-6 — Providers read from DB, not from script

`SessionsProvider`, `InsightsView`, and any future panel MUST read session metadata exclusively from `SessionStore`. `session-center.sh` becomes a fallback for users who set `claudeSessions.cacheEnabled = false`.

### FR-7 — Topic classification table (migration v2)

```sql
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

CREATE VIEW topic_change AS
SELECT t.turn_uuid, t.session_id, t.turn_index,
       tt.topic AS current_topic,
       LAG(tt.topic) OVER (PARTITION BY t.session_id ORDER BY t.turn_index) AS prev_topic,
       CASE WHEN tt.topic IS NOT NULL
                 AND LAG(tt.topic) OVER (PARTITION BY t.session_id ORDER BY t.turn_index) IS NOT NULL
                 AND tt.topic != LAG(tt.topic) OVER (PARTITION BY t.session_id ORDER BY t.turn_index)
            THEN 1 ELSE 0 END AS changed
FROM turn t
LEFT JOIN turn_topic tt ON tt.turn_uuid = t.turn_uuid;
```

### FR-8 — Topic classifier

System MUST invoke `claude -p --model claude-haiku-4-5 --output-format json --max-turns 1` to classify turns in batches of **100 turns max per call**. Input is JSON of `{turns:[{id,u,a},…]}`. Output is JSONL of `{id,topic}` lines.

- Pre-truncate `u` to 800 chars, `a` to 400 chars.
- Persist a `classification_batch` row BEFORE invoking; mark `status='ok'` after successful upsert.
- Parse output line-by-line. On a malformed line, retry the failed `id` in a sub-batch (binary-split). Drop and log if it still fails twice.
- On non-zero exit with `rate limit` in stderr: capture in batch row, set `status='failed'`, surface to UI. Backoff exponential 60 s → 30 min with jitter; persist `next_eligible_at` in a `ratelimit` table; respect on next run.
- ALWAYS reuse the user's subscription. NEVER set `ANTHROPIC_API_KEY` in the child env.

### FR-9 — On-demand classification (Phase 1)

The "Analyze topics" button in the conversation viewer classifies the open session's turns synchronously and shows progress. A future Phase 2 will add background backfill of all unclassified turns and Phase 3 will add live classification.

### FR-10 — Embedding table (migration v3)

```sql
CREATE TABLE session_embedding (
  session_id      TEXT PRIMARY KEY REFERENCES session(session_id) ON DELETE CASCADE,
  embedding       BLOB NOT NULL,      -- Float32Array, length = embedding_dim
  embedding_model TEXT NOT NULL,
  embedding_dim   INTEGER NOT NULL,
  computed_at     INTEGER NOT NULL,
  umap_x          REAL,
  umap_y          REAL,
  umap_fitted_at  INTEGER             -- when the layout was fitted
);
```

### FR-11 — Embedding pipeline

System MUST:

1. At activation, probe Ollama (`GET http://localhost:11434/api/tags`) with a 200 ms timeout.
2. If reachable AND `nomic-embed-text` is in the model list → use Ollama (`POST /api/embeddings`).
3. Else lazy-load Transformers.js with `Xenova/bge-small-en-v1.5`, model cached under the extension's global storage.
4. Embedding input per session: `"PROJECT: {project}\nFIRST USER: {first_user_msg_truncated_4096}\nTOOLS: {distinct_tool_names_joined}"`.
5. Persist BLOB + model id + dim.
6. Skip sessions where an embedding already exists for the same `embedding_model`. Re-compute when the model changes.

### FR-12 — 2D layout via UMAP

System MUST use `umap-js` with `n_neighbors=30, min_dist=0.05, metric='cosine'`. Fit on the first build (or when "Refit layout" is invoked); persist `umap_x`/`umap_y` per session and the fitted state to `<globalStorageUri>/umap-state.json`. Subsequent new sessions use `transform()` for deterministic placement.

### FR-13 — Graph webview

The "Claude: Show agent graph" command opens a webview with `enableScripts: true` and the following CSP (use a generated nonce):

```
default-src 'none';
style-src ${webview.cspSource} 'unsafe-inline';
script-src 'nonce-${nonce}';
img-src ${webview.cspSource} data:;
font-src ${webview.cspSource};
```

The webview script renders 1500 dots on a Canvas, supports hover (show tooltip with title + cost), and posts `{command:'open', id}` on click. The extension host validates `id` against the DB and opens the conversation viewer.

### FR-14 — Settings

| Setting | Default | Effect |
|---|---|---|
| `claudeSessions.cacheEnabled` | `true` | Master switch. `false` → behave like v0.6.x. |
| `claudeSessions.classify.model` | `claude-haiku-4-5` | Model passed to `claude -p`. |
| `claudeSessions.classify.batchSize` | `100` | Turns per `claude -p` call. |
| `claudeSessions.classify.maxConcurrent` | `1` | Concurrent `claude -p` invocations (keep at 1 to respect rate limits). |
| `claudeSessions.embedding.preferred` | `auto` | `auto` / `ollama` / `transformersjs`. |
| `claudeSessions.embedding.ollamaUrl` | `http://localhost:11434` | Where to probe. |
| `claudeSessions.embedding.ollamaModel` | `nomic-embed-text` | Ollama model name. |
| `claudeSessions.embedding.transformersjsModel` | `Xenova/bge-small-en-v1.5` | Fallback model. |

## Success Criteria

- **SC-1**: Sidebar opens in ≤ 500 ms on warm cache (measured via `performance.now()` between `activate` and first `getChildren` resolution).
- **SC-2**: Insights dashboard opens in ≤ 1 s on warm cache (was ~9 s).
- **SC-3**: Classifying a 30-turn session via "Analyze topics" completes in ≤ 30 s and produces non-empty `turn_topic` rows for every turn.
- **SC-4**: Agent graph renders 1500 dots in ≤ 2 s after the embedding pass (which itself takes ≤ 60 s for cold build via Ollama, ≤ 5 min via Transformers.js).
- **SC-5**: Toggling `claudeSessions.cacheEnabled = false` restores v0.6.x behavior with no errors and no orphaned DB files.

## Assumptions

- VS Code 1.95+ ships Node 20+; `better-sqlite3` prebuilt binaries cover macOS arm64 / x64 / Linux x64 — i.e. the user's hardware. (Windows is not a supported target for this private extension.)
- `claude` CLI is on `PATH` (the user already has it).
- The user's Max plan has enough headroom that classifying ~30 turns on demand is not a problem; the rate-limit handling is defensive.
- Ollama is OPTIONAL; the extension must work without it.

## Phasing

| Phase | Ships in | What |
|---|---|---|
| Phase 1A — cache foundation | **v0.7.0** | SQLite + migrations + indexer + providers reading from DB |
| Phase 1B — topic classification on-demand | **v0.7.0** | Conversation viewer "Analyze topics" button |
| Phase 1C — agent graph (scaffold) | **v0.7.0** | Embedding probe + table; UMAP fit + Canvas scatter; click→open. Initial Transformers.js download happens lazily. |
| Phase 2 — background topic backfill | v0.8.0 | Drain `turn` rows missing in `turn_topic` at one batch / 10 min during work hours |
| Phase 3 — live classification | v0.8.0 | File watcher classifies new turns within 30 s |
| Phase 4 — quota dashboard | v0.8.0 | Chart subscription burn from `classification_batch` token totals |

This document is the contract for v0.7.0. Future phases will be new specs.
