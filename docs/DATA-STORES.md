# Data stores & how it works

This document describes, accurately and in detail, **how the Code Sessions
extension works** and **exactly where and how it stores data**. Everything the
extension persists is a derived, disposable cache; the only network egress is to
a local Ollama daemon (and, optionally, the `claude` CLI you already run). All
file/line citations refer to files under `src/`.

---

## 1. Overview

Code Sessions is a read-only dashboard over your local coding-agent CLI history.
It **reads** three external sources that it does not own — Claude Code session
transcripts (`~/.claude/projects/*/*.jsonl`), Grok Build sessions
(`~/.grok/sessions/`), and the git history of your KB / project repos — and
**stores** a derived index of that activity in a single SQLite file inside the
extension's VS Code global-storage directory. The SQLite database is purely a
cache: deleting it loses nothing but classification/embedding work, which the
extension rebuilds on demand. **Nothing leaves the machine.** The only outbound
traffic is to a local Ollama daemon at `127.0.0.1:11434` for embeddings and
(optionally) topic classification, and to the locally-installed `claude` CLI
when you choose the `claude-p` classification backend. There are no analytics,
no telemetry, and no cloud calls in the extension itself.

---

## 2. Data flow

```
External sources (read-only, NOT owned by the extension)
┌─────────────────────────────┐  ┌──────────────────────┐  ┌─────────────────────┐
│ ~/.claude/projects/*/*.jsonl│  │ ~/.grok/sessions/     │  │ git repos            │
│ (Claude Code transcripts)   │  │  <cwd>/<uuid>/        │  │ KB repo + ~/projects │
│                             │  │  chat_history.jsonl   │  │ (git log/status)     │
│                             │  │  summary.json         │  │                      │
│                             │  │  signals.json         │  │                      │
└──────────────┬──────────────┘  └───────────┬──────────┘  └──────────┬──────────┘
               │                              │                        │
        jsonlIndexer.ts                grokIndexer.ts           gitChanges() in
        syncToStore()                  syncGrokToStore()        extension.ts (no DB;
        (incremental mtime/size diff)  (incremental diff)       results held in memory)
               │                              │                        │
               └──────────────┬───────────────┘                       │
                              ▼                                        │
                  ┌────────────────────────────┐                      │
                  │  SQLite cache (db.ts)       │                      │
                  │  sessions-cache.db (WAL)    │                      │
                  │  better-sqlite3             │                      │
                  │  session / turn /           │                      │
                  │  turn_topic / *_embedding / │                      │
                  │  session_star / migration … │                      │
                  └──────────────┬──────────────┘                      │
                                 │                                     │
            ┌────────────────────┼─────────────────────┐              │
            ▼                    ▼                     ▼              ▼
   Tree views                Webviews            Status bar      KB changes /
   (Sessions, Tasks)   (Insights, Live monitor,  (live tile,     Projects views
                        Agent graph 2D/3D,        cost budget)
                        Conversation, Trajectory,
                        Search)

        ┌──────────────────────────────────────────────────────────────┐
        │ Local-only side calls:                                         │
        │  • Ollama  http://127.0.0.1:11434  → embeddings (embedding.ts) │
        │            and topic classification (topicClassifier.ts)       │
        │  • `claude -p` CLI  → topic classification (subscription)      │
        └──────────────────────────────────────────────────────────────┘
```

The KB-changes and Projects-activity views do **not** use SQLite at all — they
shell out to `git log` / `git status` on each refresh and hold results in memory
(`gitChanges()` in `extension.ts`).

---

## 3. The SQLite cache

- **Path:** `<globalStorageUri>/sessions-cache.db`
  - Opened in `SessionStore.open(globalStorageDir)` (`db.ts:270`), where
    `globalStorageDir` is `ctx.globalStorageUri.fsPath` (`extension.ts:1667`).
  - On macOS this resolves to
    `~/Library/Application Support/Code/User/globalStorage/zhirafovod.code-sessions/sessions-cache.db`
    (the segment is the publisher.name from `package.json`). Use `Code - Insiders`
    in place of `Code` for Insiders builds.
- **Engine:** `better-sqlite3` (synchronous, native). Opened with
  `journal_mode = WAL`, `synchronous = NORMAL`, `temp_store = MEMORY`,
  `mmap_size = 268435456`, `foreign_keys = ON` (`db.ts:252-257`). WAL mode means
  the file is accompanied by `sessions-cache.db-wal` and `sessions-cache.db-shm`
  sidecars.
- **Migration scheme:** schema versioning is via SQLite `PRAGMA user_version`.
  Migrations are a numbered array of SQL strings (`MIGRATIONS`, `db.ts:15`).
  `migrate()` (`db.ts:421`) reads the current `user_version`, applies every
  migration with index ≥ it inside a single transaction, then sets
  `user_version = MIGRATIONS.length`. There are currently **9 migrations (v1–v9)**.

### Tables

#### `session` (migration v1, extended by v5/v7/v9)
One row per indexed CLI session. Columns (`db.ts:18-43`, plus ALTERs):

| Column | Type | Purpose |
|---|---|---|
| `session_id` | TEXT PK | Session UUID (Claude session id, or Grok session id). |
| `project_path` | TEXT | Source project dir. For Claude this is the dash-encoded `~/.claude/projects/-Users-...` folder; for Grok the already-decoded cwd. |
| `project_id` | TEXT | Derived short name, e.g. `unpolarize`, `ai/otelo`, `docs`. |
| `projects_touched` | TEXT | Comma-separated derived list of projects edited in the session (stored as CSV, exposed as `string[]`). |
| `jsonl_path` | TEXT UNIQUE | Absolute path to the transcript file on disk; the join key for incremental sync. |
| `mtime_ns` | INTEGER | File mtime in nanoseconds (`mtimeMs * 1e6`). Half of the incremental-sync key. |
| `size_bytes` | INTEGER | File size; the other half of the sync key. |
| `started_at` | INTEGER | Epoch ms of first user message. |
| `ended_at` | INTEGER | Epoch ms of last activity. |
| `message_count` | INTEGER | Number of messages. |
| `tool_count` | INTEGER | Number of tool calls. |
| `subagent_count` | INTEGER | Number of subagents spawned. |
| `input_tokens` / `output_tokens` | INTEGER | Token totals. |
| `cache_read_tokens` / `cache_write_tokens` | INTEGER | Prompt-cache token totals. |
| `cost_usd` | REAL | Computed cost at list rates (see cost tables in `jsonlIndexer.ts:29-31`). |
| `model` | TEXT | Dominant/last-seen model id. |
| `title` | TEXT | Session title. |
| `first_user_msg` | TEXT | First user message (for title fallback). |
| `entrypoint` | TEXT | How the session was launched (`sdk-cli`, `routine`, interactive, …). |
| `is_automated` | INTEGER | 0/1 — automated/cron session flag. |
| `indexed_at` | INTEGER | When this row was last indexed. |
| `schema_rev` | INTEGER | Row-level schema revision (default 1). |
| `last_assistant_text_at` | INTEGER | **(v5)** Epoch ms of the most recent assistant *text* block; drives the "Nm ago" column independently of mtime. |
| `source` | TEXT NOT NULL DEFAULT `'claude'` | **(v7)** `'claude'` or `'grok'`. |
| `extras_json` | TEXT | **(v9)** Source-specific telemetry blob; Grok stores `signals.json` contents (context tokens, tool list, peak RSS, latency). NULL for Claude. |

Indexes: `idx_session_started`, `idx_session_project`, `idx_session_mtime`,
`idx_session_automated` (v1), `idx_session_source` (v7).

#### `turn` (migration v1)
One row per conversation turn (`db.ts:49-61`).

| Column | Purpose |
|---|---|
| `turn_uuid` (PK) | Turn id. |
| `session_id` | FK → `session(session_id)` ON DELETE CASCADE. |
| `turn_index` | Ordinal within the session. |
| `started_at` / `ended_at` / `duration_ms` | Timing. |
| `user_text` | Truncated to 4 KB (`USER_TEXT_MAX = 4096`). |
| `assistant_excerpt` | Truncated to 1 KB (`ASSISTANT_EXCERPT_MAX = 1024`). |
| `tool_names_csv` | e.g. `"Bash,Edit,Bash"` for quick filtering. |
| `tool_count` | Tool calls in this turn. |
| `has_subagent` | 0/1. |

Indexes: `idx_turn_session(session_id, turn_index)`, `idx_turn_started`.

#### `turn_topic` (migration v2)
Persisted topic classifications, keyed by turn (`db.ts:68-77`).

| Column | Purpose |
|---|---|
| `turn_uuid` (PK) | FK → `turn(turn_uuid)` ON DELETE CASCADE. |
| `topic` | Human label, e.g. `opentelemetry-collector-config`. |
| `topic_norm` | Normalized slug (lowercased, hyphenated, ≤64 chars). |
| `confidence` | Optional REAL. |
| `classified_at` | Epoch ms. |
| `model` | Backend tag, e.g. `ollama/llama3.2:3b` or `claude-p/claude-haiku-4-5`. |
| `prompt_rev` | Prompt revision (`PROMPT_REV = 2` in `topicClassifier.ts:16`). |
| `batch_id` | FK-ish link to `classification_batch`. |

Index: `idx_turn_topic_topic(topic_norm)`.

#### `classification_batch` (migration v2)
Bookkeeping for each classifier invocation (`db.ts:80-90`): `batch_id` (PK),
`started_at`, `finished_at`, `turn_count`, `model`, `status`
(`pending`/`ok`/`partial`/`failed`), `error`, `input_tokens`, `output_tokens`.

#### `session_embedding` (migration v3, extended v4)
One embedding vector per session plus its 2D layout (`db.ts:95-104`, `db.ts:119`).

| Column | Purpose |
|---|---|
| `session_id` (PK) | FK → `session` ON DELETE CASCADE. |
| `embedding` | BLOB — Float32Array serialized to a Buffer. |
| `embedding_model` | e.g. `ollama/nomic-embed-text` or `fallback/hash-bow-256`. |
| `embedding_dim` | Vector length. |
| `computed_at` | Epoch ms. |
| `umap_x` / `umap_y` | **2D UMAP coordinates** for the agent-graph scatter. |
| `umap_fitted_at` | When the UMAP projection was fit. |
| `cluster_id` | **(v4)** DBSCAN/k-means cluster assignment. |

Index: `idx_emb_model(embedding_model)`.

#### `turn_embedding` (migration v4)
Per-turn embeddings used by the trajectory view (`db.ts:110-116`): `turn_uuid`
(PK, FK → `turn` CASCADE), `embedding` (BLOB), `embedding_model`,
`embedding_dim`, `computed_at`. Index: `idx_turn_emb_model`.

#### `session_star` (migration v6)
User-pinned sessions (`db.ts:132-135`): `session_id` (PK, FK → `session`
CASCADE), `starred_at`.

#### `migration` (migration v8) — the one-time-migration ledger
Tracks **named, one-shot data migrations** (distinct from the `user_version`
schema migrations) so they never re-run (`db.ts:149-153`): `name` (PK),
`applied_at`, `detail`. The only entry today is
`import_from_claude_sessions_v1`, written after the pre-v1.0 cross-extension DB
merge described below.

### Cross-extension import (pre-v1.0 rename)

On open, before indexing, `SessionStore.open` (`db.ts:289-308`) checks the
`migration` ledger for `import_from_claude_sessions_v1`. If absent and a sibling
DB exists at `<globalStorage>/zhirafovod.claude-sessions/sessions-cache.db`, it
`ATTACH`es that DB and runs `INSERT OR IGNORE` across `session`, `turn`,
`turn_topic`, `classification_batch`, `session_embedding`, `turn_embedding`, and
`session_star` inside one transaction (`mergeFromOldExtensionDb`, `db.ts:315`),
preserving existing rows. The old schema predates `source`, so the literal
`'claude'` is supplied. The merge is idempotent and gated on the ledger row, so
it runs at most once and never on every activation.

---

## 4. External data sources (read-only, not owned)

### `~/.claude/projects/*/*.jsonl` — Claude Code
`listAllJsonls()` (`jsonlIndexer.ts:53`) walks `~/.claude/projects/`, one
subfolder per dash-encoded project path, and collects every `*.jsonl` (skipping
dotfiles and `*sessions-index*` / `*history*`). Each file is parsed by
`parseConversation()` and aggregated into a `session` row + `turn` rows by
`syncToStore()` (`jsonlIndexer.ts:290`).

### `~/.grok/sessions/` — Grok Build
`grokIndexer.ts` walks `~/.grok/sessions/<url-encoded-cwd>/<uuid>/`, reading
`summary.json` (title/model/cwd/dates), `chat_history.jsonl` (event stream), and
`signals.json` (telemetry, stored verbatim into `session.extras_json`). Grok
events lack per-event timestamps, so they are synthesized from
`summary.created_at` + line ordinal. Sessions whose `session_kind` is
`claude_import` are **skipped** so the authentic Claude row stays canonical.
Enabled by `codeSessions.grok.enabled` (default true).

### Git repos — KB & projects
The KB-changes and Projects-activity views run `git log --since=<N> days ago
--name-status --no-merges` plus `git status --porcelain=v1` per repo
(`gitChanges()`, `extension.ts:1079`). Results are not persisted to SQLite —
they live in memory until the next refresh.

### Incremental indexer + throttled watcher
- **`(mtime_ns, size_bytes)` diff:** `syncToStore()` loads
  `store.knownPaths()` (a map of `jsonl_path → {mtime_ns, size_bytes}`,
  `db.ts:533`) and re-parses only files that are new or whose mtime/size
  changed (`jsonlIndexer.ts:316-322`). Files gone from disk have their rows
  deleted via `deleteByPaths()` (`jsonlIndexer.ts:347`). `force` re-parses
  everything; `forceRecentN` always re-parses the N newest files (catches
  on-disk edits like renames that don't bump mtime) — wired to
  `codeSessions.refresh.forceRecent`.
- **FileSystemWatcher (1.5 s throttle):** a watcher on
  `~/.claude/projects/**/*.jsonl` (`extension.ts:2256`) coalesces
  `onDidChange`/`onDidCreate` events through a `setTimeout(..., 1500)` debounce
  (`extension.ts:2278`). On fire it runs `syncToStore` (+ `syncGrokToStore` if
  Grok is enabled) then refreshes the tree.

---

## 5. Topic classification

Topic labels are generated per turn and persisted in `turn_topic` (keyed by
`turn_uuid`). Two backends, selected by `codeSessions.classify.backend`
(default `ollama`):

- **`ollama`** — POST to `http://127.0.0.1:11434/api/chat` with `format: "json"`,
  `temperature: 0`, model `codeSessions.classify.model` (`invokeOllama`,
  `topicClassifier.ts:151`). Local, free, offline.
- **`claude-p`** — spawns the `claude` CLI headless:
  `claude -p --model <classify.model> --output-format json --max-turns 1
  --permission-mode bypassPermissions`, piping the prompt on stdin
  (`invokeClaude` + the arg list, `topicClassifier.ts:280-288`). Uses your Claude
  **subscription**, not API billing.

**Curated env (security-critical).** `invokeClaude` (`topicClassifier.ts:80`)
passes an explicitly curated environment of **only `PATH`, `HOME`, and `USER`**
(`topicClassifier.ts:90-95`). `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are
deliberately **excluded** (comment at `topicClassifier.ts:88-95`, and the file
header `topicClassifier.ts:8-9`) so the spawned `claude` falls back to
subscription auth rather than switching to metered API billing.

**Where topics land.** Results are upserted into `turn_topic`
(`store.upsertTopics`, `db.ts:613`). The model defensively filters out any
returned `id` that isn't in the current batch's `turn_uuid` set
(`topicClassifier.ts:329-330`) to avoid foreign-key violations from hallucinated
ids. `prompt_rev` (currently 2) and the backend/model tag are recorded so
re-runs are idempotent — already-classified turns under the same model are
skipped. The background daemon (`BackgroundClassifier`) walks
`sessionsWithUnclassifiedTurns()` (`db.ts:844`) when
`codeSessions.classify.autoBackground` is on; with the `claude-p` backend it
runs only if `classify.allowAutoBackgroundClaude` is explicitly enabled, so the
daemon never silently spends subscription tokens.

---

## 6. Embeddings & agent graph

The agent graph embeds each session, projects to 2D/3D with UMAP, and clusters.

- **Embedding backend** (`embedding.ts`): if `codeSessions.embedding.preferred`
  is `ollama` and a probe of `http://127.0.0.1:11434/api/tags` confirms the model
  is present (`probeOllama`, `embedding.ts:29`), it calls
  `POST /api/embeddings` with `codeSessions.embedding.ollamaModel` (default
  `nomic-embed-text`). Otherwise it uses a **deterministic hashed bag-of-words
  fallback** — a 256-dim, L2-normalized vector built from a two-hash token
  trick (`fallbackEmbed`, `embedding.ts:120`), with no external dependency. The
  stored `embedding_model` is `ollama/<model>` or `fallback/hash-bow-256`
  (`embedding.ts:160`). (A `transformersjs` option exists in settings but is not
  bundled.)
- **Persistence:** vectors go to `session_embedding.embedding` (and per-turn
  vectors to `turn_embedding`); already-embedded sessions under the same model
  are skipped on subsequent graph opens.
- **UMAP projection** (`agentGraph.ts`, via `umap-js`): the 2D fit writes
  `umap_x` / `umap_y` (and `umap_fitted_at`) through `store.setUmapCoords`
  (`db.ts:685`); a separate 3D fit feeds the 3D mode but is not persisted.
- **Clustering:** DBSCAN (`codeSessions.cluster.minPts`,
  `codeSessions.cluster.epsScale`) with a k-means fallback; results go to
  `session_embedding.cluster_id` via `store.setClusterIds` (`db.ts:719`).

---

## 7. Settings

All configuration lives under four namespaces in `package.json`
(`contributes.configuration.properties`). Defaults shown.

### `codeSessions.*`
| Key | Default | Description |
|---|---|---|
| `limit` | `100` | Max most-recent sessions to load. |
| `refresh.forceRecent` | `100` | On Refresh, force-reparse the N newest JSONLs regardless of mtime cache (catches renames). 0 = incremental only. |
| `scriptPath` | `~/.claude/skills/sessions/session-center.sh` | Fallback script when `cacheEnabled` is false (Claude only). |
| `cacheEnabled` | `true` | Use the SQLite cache. False → spawn `session-center.sh` per refresh (legacy Claude-only path). |
| `showAutomated` | `false` | Show automated/cron sessions. |
| `filterByCurrentWorkspace` | `true` | Show only sessions from the current workspace folder (or subfolder). |
| `insightsLookbackDays` | `14` | Days of activity charted in Insights. |
| `insightsDeepParse` | `20` | How many recent sessions to deep-parse for Insights metrics. |
| `grok.enabled` | `true` | Index Grok Build sessions from `~/.grok/sessions/`. |
| `resumeBackend` | `code-build` | Which extension to prefer on Resume (`code-build` vs `native`). |
| `classify.backend` | `ollama` | Topic-classification backend (`ollama` / `claude-p`). |
| `classify.model` | `llama3.2:3b` | Model id for the classification backend. |
| `classify.batchSize` | `10` | Turns classified per backend call. |
| `classify.autoOnOpen` | `true` | Classify unclassified turns when the conversation viewer opens (ollama only). |
| `classify.autoBackground` | `true` | Run classification continuously in the background. |
| `classify.allowAutoBackgroundClaude` | `false` | Allow background auto-runs even with the `claude-p` backend (opt-in). |
| `classify.claudeBin` | `""` | Override path to the `claude` CLI (claude-p only). Empty = PATH. |
| `embedding.preferred` | `ollama` | Embedding backend to try first (`ollama` / `transformersjs`). |
| `embedding.ollamaUrl` | `http://127.0.0.1:11434` | Local Ollama base URL. |
| `embedding.ollamaModel` | `nomic-embed-text` | Ollama embedding model. |
| `embedding.transformersjsModel` | `Xenova/bge-small-en-v1.5` | Transformers.js fallback model id. |
| `cluster.minPts` | `3` | DBSCAN minPts for agent-graph clustering. |
| `cluster.epsScale` | `0.04` | DBSCAN eps as a fraction of the axis range. |
| `trajectory.driftPercentile` | `90` | Cosine-distance percentile flagged as topic drift. |
| `liveStatusBar.enabled` | `true` | Show the compact live activity status-bar item. |
| `awaitingUser.notify` | `true` | Toast when a session first enters an awaiting-user state. |
| `costBudget.daily` | `0` | Daily Claude budget (USD); 0 hides the tile. |

### `codeKbChanges.*`
| Key | Default | Description |
|---|---|---|
| `repoPath` | `""` | KB git repo to list; empty = auto-detect from first workspace folder. |
| `lookbackDays` | `14` | Days of git history to load. |

### `codeProjectsActivity.*`
| Key | Default | Description |
|---|---|---|
| `repoPaths` | `["~/projects/unpolarize", "~/projects/ai/otelo"]` | Explicit repos to watch. |
| `autoDiscover` | `true` | Walk the discovery root (depth 2) for repos with recent commits. |
| `discoveryRoot` | `~/projects` | Root for auto-discovery. |
| `lookbackDays` | `14` | Days of git history per project. |

### `codeTasks.*`
| Key | Default | Description |
|---|---|---|
| `showCrontab` | `true` | Show the user's crontab as a Tasks section. |
| `subagentLookbackMin` | `5` | A session counts as "active sub-tasks running" if its JSONL changed within N minutes and has a running subagent. 0 disables. |

### One-time settings migration
`migrateSettingsToCodeNamespace` (`extension.ts:1583`) runs once per profile on
activate (`extension.ts:1657`). It is gated on the globalState flag
`settingsMigratedToCodeNamespace_v1` (`extension.ts:1587-1588`) and copies any
values the user set under the legacy `coderSessions.*` / `claudeSessions.*` (and
`coder*`/`claude*` siblings for KbChanges, ProjectsActivity, Tasks;
`OLD_PREFIXES`, `extension.ts:1590-1595`) into the matching `code*` keys. It
copies only when the new key is unset (`inspect()` guards,
`extension.ts:1623-1630`), handles both Global and Workspace targets, shows a
one-time info toast on success, and always sets the flag in `finally` so it
never repeats.

---

## 8. Inspect / reset

- **Open the DB directly:**
  ```sh
  sqlite3 "$HOME/Library/Application Support/Code/User/globalStorage/zhirafovod.code-sessions/sessions-cache.db"
  ```
  Then e.g. `.tables`, `PRAGMA user_version;`, `SELECT COUNT(*) FROM session;`.
  (Read-only inspection is safe even with VS Code open; WAL mode handles it.)
- **Drop embeddings only:** run the command **"Drop cached embeddings and
  re-embed"** (`codeSessions.reembedSessions`, `extension.ts:2163`). It deletes
  every `session_embedding` / `turn_embedding` row whose model differs from the
  current model (`deleteEmbeddingsExceptModel` / `deleteTurnEmbeddingsExceptModel`,
  `db.ts:804`/`809`); they are rebuilt next time you open the agent graph.
- **Disable the cache entirely:** set `codeSessions.cacheEnabled = false`. The
  store is never opened (`extension.ts:1663-1666`) and the Sessions view falls
  back to spawning `session-center.sh` (`SessionsProvider.load`,
  `extension.ts:597-606`). Note: agent graph, live monitor, search, and
  classification require the cache and will warn if it's off.
- **Where everything lives (delete to fully reset):** the entire global-storage
  directory
  `~/Library/Application Support/Code/User/globalStorage/zhirafovod.code-sessions/`
  — this holds `sessions-cache.db` plus its `-wal`/`-shm` sidecars and nothing
  else of consequence. Deleting it discards all cached sessions, topics, and
  embeddings; the extension re-indexes from disk on next activation (topics and
  embeddings are recomputed on demand). The source transcripts in
  `~/.claude/projects/` and `~/.grok/sessions/` are untouched.

---

## 9. Privacy & security

- **Local-only.** The extension makes no cloud calls of its own. Outbound
  traffic is limited to the local Ollama daemon (`127.0.0.1:11434`) for
  embeddings/classification and, only if you select it, the locally-installed
  `claude` CLI. Git operations are local subprocesses.
- **Curated classifier env.** When spawning `claude -p`, the child process gets
  only `PATH`/`HOME`/`USER`; `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are
  intentionally withheld so it uses subscription auth, not metered API billing
  (`topicClassifier.ts:88-95`).
- **Webview posture.** Every webview ships a `Content-Security-Policy`:
  - **Static webviews — `enableScripts: false`, `script-src 'none'`:**
    Conversation viewer (`conversationView.ts:262`, `:310`) and Insights
    (`insightsView.ts:700`, `:811`) render server-built HTML/SVG with no script
    execution.
  - **Interactive webviews — `enableScripts: true` with a nonce'd CSP:** Agent
    graph (`agentGraph.ts:429`, CSP `agentGraph.ts:567-573` —
    `default-src 'none'; script-src 'nonce-…'`), Live monitor
    (`liveMonitor.ts:191`/`:238`), Trajectory (`trajectoryView.ts:176`/`:218`),
    and Search (`searchView.ts:25`/`:67`). Each restricts `default-src 'none'`,
    allows styles/images/fonts from `webview.cspSource` only, and runs only the
    extension's own nonce-tagged script. No remote origins are whitelisted.
- **Derived & disposable.** The SQLite cache contains only data derived from
  files already on disk plus locally-computed topics/embeddings. It can be
  deleted at any time without data loss beyond recomputation.
