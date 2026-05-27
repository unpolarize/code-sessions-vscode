# Changelog

## 0.14.2 — 2026-05-27

- **Fix: workspace filter was hiding everything.** The DB's `project_path` is the JSONL container directory under `~/.claude/projects/-Users-<name>-...` — not the actual source path. The filter compared that container against `/Users/<name>/docs` and matched nothing, so every session from `~/docs` got reported as "from another folder" and the view rendered empty. Added a small decoder ([`extension.ts:482-487`](src/extension.ts#L482-L487)) that reverses claude-code's `/` → `-` encoding on the directory basename and compares the decoded source path against the workspace folder. Lossy only when the real source path itself contains a literal `-`.

## 0.14.1 — 2026-05-27

Two follow-ups to v0.14.0:

- **Fix: install script was packaging a broken .vsix.** [`scripts/build-install.sh`](scripts/build-install.sh) ran `vsce package --no-dependencies`, which omitted `node_modules`. The installed extension then couldn't `require('better-sqlite3')` at runtime, so `activate()` threw and every view rendered "There is no data provider registered". The script now (a) runs `npm run rebuild-native` to match the host VS Code's Electron 39.8.8 ABI and (b) packages with full dependencies. Resulting .vsix is ~4 MB and ships the native binary at `node_modules/better-sqlite3/build/Release/better_sqlite3.node`.
- **Sessions view scopes to the current workspace.** New setting `claudeSessions.filterByCurrentWorkspace` (default `true`). When on and a workspace folder is open, the Sessions view shows only sessions whose `project_path` equals the workspace's first folder, or sits under it. Bucket totals reflect the visible subset. A header row `Filtered to <name> — N sessions from other folders hidden` clicks through to the setting. Refresh hooks: any `claudeSessions.*` change already refreshes; added `sessions.refresh()` to `onDidChangeWorkspaceFolders` so opening a different folder re-applies the filter immediately.

## 0.14.0 — 2026-05-27

Big release: project context everywhere, star sessions, daily cost budget, per-project rollup, plus a fix for the background classifier's "grinds forever" bug.

### Sessions view
- **Refresh now targets the recent N**. New setting `claudeSessions.refresh.forceRecent` (default 100) — pressing Refresh runs an incremental sync **plus** a force re-parse of the N most-recent-by-mtime JSONLs. This catches on-disk edits that don't reliably bump mtime (most notably claude-code session renames, which sometimes overwrite the JSONL in place at the same size). Set to 0 to use only the cheap incremental sync.
- **Periodic refresh + day-rollover detection.** KB / Projects views auto-refresh every 2 min. A separate 60 s timer detects when the local day flips and refreshes every date-bucketed view (sessions, KB, projects, tasks) so items move out of "Today" without user action.

### Search
- **Project chip** on every result row (`docs`, `ai/otelo`, etc.) with the full project path on hover; `searchTopics` / `searchTurns` now select `s.project_id, s.project_path`.
- **Continue in Claude** action per row (▶ button at the right edge, fades in on hover) routes through `claudeSessions.resume` so the routing matches the sidebar's inline action.

### Conversation viewer
- Header shows `📁 <project_id>` plus the full project path under the title.
- Toolbar grows a **`▶ Continue in Claude`** primary button (left-most) and a **`📁 Reveal project folder`** button. The latter calls a new `claudeSessions.revealProjectFolder` command which uses `revealFileInOS` to open Finder/Explorer at the project root.

### Star / pin sessions
- New SQLite table `session_star` (migration **v6**) with `starSession` / `unstarSession` / `starredSessionIds` methods on the store.
- Sessions provider renders a **`★ Starred — N sessions`** bucket at the very top (expanded by default) whenever anything is pinned. Each session's icon flips to `star-full` when pinned.
- New commands `claudeSessions.starSession` and `claudeSessions.unstarSession` wired into the right-click context menu. The menu toggles between empty and full star based on the `contextValue` (`session` vs `session-starred`). FK cascade drops stars when a session is deleted.

### Daily cost budget meter
- New right-side status-bar tile, reading `buildUpdate(store).costToday`. Hidden when `claudeSessions.costBudget.daily = 0` (default).
- When > 0, text reads `$X.XX / $Y (Z%)`. Turns amber via `statusBarItem.warningBackground` at 80 %, red via `statusBarItem.errorBackground` at 100 %+.
- Click opens Insights. Tooltip breaks down today's spend, budget, and used %. Re-ticks every 10 s alongside the existing live tile and on settings changes.

### Insights dashboard
- **Project rollup table** under the existing "Top projects by cost" chart. Columns: **Project · Sessions · Cost · Tokens · 🪄 · Top topic · Last active**. Cost / tokens split evenly across touched projects (same model as the existing chart). Top topic rolls up classified topics from all sessions in the project.

### Background topic-classification daemon
- **Fix: stops grinding forever on failed sessions.** Discovery used to keep re-enqueueing failed sessions every 60 s; the same ~72 failures kept getting picked up over and over, inflating "Session 2610 of 2610" while making no real progress. Discovery now skips any session id in `failedIds` until the user explicitly clicks **Retry failed sessions** on the status-bar tile.
- **Real DB-backed overview.** New `classificationOverview()` returns four numbers in one round trip: total sessions, sessions still pending, total eligible turns, classified turns.
- **Tile + tooltip now show overall progress + ETA.** Text reads `4% · <session title> · 6/10`; tooltip shows `Sessions: 642 / 700 classified (91%)`, `Turns: 14,310 / 16,500 (87%)`, and `ETA: 24m at current rate`. When everything is done the tile reads `$(check) all 700 sessions classified` and then hides.
- **Default batch size 20 → 10.** The most common error (`N turns missing in response`) is the small Ollama model failing to echo back 20 ids in one JSON response. 10 is markedly more reliable; drop to 5 if the error persists.

## 0.13.3 — 2026-05-20

UX + docs polish.

- **Keybindings.** Five new defaults: `Cmd+Alt+C` focus the Claude Activity sidebar, `Cmd+Alt+L` open the Live monitor, `Cmd+Alt+D` open the Insights dashboard, `Cmd+Alt+G` open the agent graph, `Cmd+Alt+3` toggle 2D ↔ 3D inside the agent graph. (Ctrl+Alt+… on Windows/Linux.) The 2D/3D toggle works via a new `claudeSessions.agentGraphToggleMode` command that posts a `toggleMode` message to the currently-open graph webview; the webview now listens for `setMode` / `toggleMode` messages from the extension.
- **Refresh now actually re-syncs.** Clicking the refresh icon on the Sessions view used to only re-read the SQLite cache — it never went to disk, so a session you renamed in claude code wouldn't show its new title until the 10 s auto-sync tick caught up. `claudeSessions.refresh` now runs an incremental `syncToStore(store)` before re-rendering. Added a separate **`Refresh sessions (force full rescan)`** palette command that passes `{ force: true }` to `syncToStore`, re-parsing every JSONL regardless of mtime — slow on large catalogs but the right escape hatch when the incremental check misses a change.
- **Ollama setup docs in [README.md](README.md).** New "Ollama dependency" section explains what each model is for (`llama3.2:3b` classifier, `nomic-embed-text` embeddings), one-time install/start/pull steps for macOS + Linux, the table of overridable model settings, and how to turn auto-classification off.
- **Helper scripts.**
  - [`scripts/build-install.sh`](scripts/build-install.sh) — `npm install` → `npm run compile` → `vsce package` → `code --install-extension --force`. `--no-install` to skip the install step.
  - [`scripts/ollama-setup.sh`](scripts/ollama-setup.sh) — installs Ollama via brew/install.sh if missing, starts the daemon (brew services / systemd / detached), pulls the two models, sanity-checks `/api/tags`. Idempotent. Override models via `CLASSIFY_MODEL=…` / `EMBED_MODEL=…` env vars.

## 0.13.2 — 2026-05-20

Bug fix + controls for the background topic-classification daemon.

- **Fix: `FOREIGN KEY constraint failed`** while upserting topics ([topicClassifier.ts](src/topicClassifier.ts), [db.ts](src/db.ts)). Local models occasionally return a `turn_uuid` that isn't in the batch (hallucinated or truncated); because `upsertTopics` ran every row in one transaction, the bad row rolled back the legitimate topics alongside it. Two-layer fix:
  - The classifier filters returned topics by the batch's known `turn_uuid` set before calling `upsertTopics`; unknown ids count as `N unknown ids dropped` in the batch's partial-finish message (separate from the existing `N turns missing in response`).
  - `upsertTopics` catches per-row `FOREIGN KEY` / `UNIQUE` violations so a single bad row never aborts the rest of the transaction. Other errors still propagate.
- **Pause / Resume.** The worker tick now bails when paused; discovery keeps running so the queue is fresh when you resume.
- **Retry failed.** Any session whose `classifySession` returned errors (or threw) is tracked in a `failedIds` set; a new control re-queues all of them in one click.
- **Status-bar tile is clickable.** Opens a Quick Pick with Pause/Resume, Retry-N-failed (only when there are failures), and Open auto-classify settings. The tile text now appends `· N failed` while running and turns into `$(warning) N classified · M failed` when idle with errors present.
- **Palette commands** added: `Auto-classify controls (pause / retry failed)`, `Auto-classify: pause / resume`, `Auto-classify: retry failed sessions`.

## 0.13.1 — 2026-05-20

Richer progress UI for the background topic-classification daemon ([src/backgroundClassifier.ts](src/backgroundClassifier.ts)):

- **Status-bar text** now reads `$(sync~spin) 4/502 · <session title> · 12/87 turns` — completed-sessions-this-run / peak-queue-this-run, the title of the session being classified, and live per-batch progress.
- **Tooltip** adds session **X of Y**, currently-classifying title with **done/total turns + %**, elapsed seconds on the current session, total turns classified this run, and the last error with how long ago it happened (surfaces silent failure modes like "Ollama not running").
- Wires `classifySession`'s existing `onProgress` callback into the status renderer so the counter ticks live as batches finish.
- Tracks `sessionsStarted` and `peakQueue` for the X/Y counter; logs the first error from each session into `lastError`.

## 0.13.0 — 2026-05-20

A larger release built on top of v0.12.0; everything below is additive.

- **Cluster meaning panel on the agent graph.** Clicking a hull or a cluster label now opens a docked panel (top-right) summarising what the cluster is about: the top topics (with mention counts), the project mix, and 5 representative session titles (closest to the centroid, clickable to open). Topic counts come from `turn_topic`; the panel shows empty-state hints when the cluster hasn't been classified yet and points at the *Classify all topics* button.
- **Click → trajectory.** Clicking a dot on the agent graph now opens the conversation **trajectory** view rather than the conversation viewer. The new search and the cluster panel still surface session titles as conversation-viewer links — pick the lens that matches how you want to look at history.
- **Tasks view.** New view in the Claude Activity sidebar with three sections:
  - **Active sub-agents** — derived from the live monitor; lists every session in flight with `subagents > 0`. Click opens the trajectory. Auto-refreshes every 30 s.
  - **Scheduled routines** — placeholder; remote `/schedule` routines live on Anthropic's side and aren't reachable from the extension. Manage them via the `/schedule` slash command in Claude Code.
  - **Crontab** — full `crontab -l` parsed into `schedule | command` rows. Clicking a row (or the pencil action) opens the crontab in a VS Code editor; saving the document installs it via `crontab <file>`. Controlled by `claudeTasks.showCrontab` (default on).
- **Search panel.** New `Claude · Search` webview behind the search icon on the Sessions view title bar. A single input runs **topic** full-text search (matches `turn_topic.topic`/`topic_norm`) and **conversation** full-text search (matches `turn.user_text`/`turn.assistant_excerpt`) side-by-side as you type. Results show the session title, turn index, time-ago, a `user`/`assistant`/`both` badge, and an excerpt with the matched substring `<mark>`-highlighted. Clicking a row opens the conversation viewer.
- **Awaiting-user alerts in the live monitor.** `nowStatusFromTail` now emits a new status kind `awaiting_user` whenever the JSONL tail contains an open `AskUserQuestion` or `ExitPlanMode` `tool_use` with no matching `tool_result`. The live monitor grows an amber banner listing every awaiting session; the matching card gets an amber outline and its `now` chip animates a slow pulse. The status-bar item flips to a warning background when ≥1 session is awaiting (`$(warning) Claude · N awaiting answer`). A one-shot toast pops the first time a session enters the awaiting state — clear it with `claudeSessions.awaitingUser.notify = false` if it's noisy.
- **Sessions view: folded + leading "time since last response" + auto-refresh + Continue-in-Claude inline action.** Every session row now leads with a fixed-width "ago" column (`  5s`, ` 12m`, `  3h`, ` 14d` — padded with U+2007 figure-space so columns line up in proportional fonts). Sessions default to collapsed; active sessions no longer auto-expand. The leading time tracks **last assistant text** rather than mtime — new column `last_assistant_text_at` is populated by `conversationParser`, persisted via schema migration **v5**, and falls back to mtime for rows indexed before the migration. The whole view incrementally re-syncs (`syncToStore`) + re-renders every 10 s so the column stays close to real-time. The right-side inline action is now `▶ Continue in Claude` (`claudeSessions.resume`); *Open transcript* moved to the right-click context menu.
- **Background topic-classification daemon.** New `BackgroundClassifier` ([src/backgroundClassifier.ts](src/backgroundClassifier.ts)) runs continuously: at startup it discovers every session with unclassified turns (new DB query `sessionsWithUnclassifiedTurns`) and works through them one at a time on a 1.5 s tick. After every 10 s sessions-sync, `notifySyncCompleted()` re-runs discovery so newly-arrived turns get queued automatically; a 60 s timer is the backstop. Per-turn caching (already in `classifySession`) means re-runs on classified sessions are free. A right-side status-bar tile shows progress while working. Settings:
  - `claudeSessions.classify.autoBackground` (default `true`) — master toggle.
  - `claudeSessions.classify.allowAutoBackgroundClaude` (default `false`) — explicit opt-in for the `claude-p` backend; off by default so the daemon never quietly spends subscription tokens.

## 0.12.0 — 2026-05-20

Three additions on top of v0.11.2, focused on the agent graph:

- **Wheel-zoom + drag-pan on the 2D scatter.** Scroll on the canvas to zoom about the cursor; drag empty space to pan; double-click (or the new `reset` button) to recenter. A click vs. drag is disambiguated by a 4 px threshold, so opening a session by clicking its dot still works. New toolbar tiles `+`, `−`, `reset` mirror the same controls.
- **3D scatter mode.** New `2D`/`3D` toggle in the toolbar. The build pipeline now runs a second UMAP with `nComponents: 3` alongside the existing 2D one — the two layouts are kept on each point as independent triplets (`x/y` for 2D, `x3/y3/z3` for 3D) since separate UMAP runs are not coordinate-compatible. In 3D mode: drag orbits (yaw/pitch, pitch clamped just shy of ±π/2), the wheel dollies the camera, `reset` re-centers, and dots are painter-sorted back-to-front with a depth-cued radius. Cluster labels render at the projected 3D centroid (no force layout); convex hulls are hidden in 3D for clarity. Hover and click still work via the same screen-space picker. No new deps — hand-rolled perspective projection in ~80 LOC.
- **Classify-all-topics button on the agent graph.** New toolbar button drives `classifySession` across every point in the current graph (skipping turns that already have a topic), reports progress in a cancellable VS Code notification, and on completion rebuilds the layout so cluster labels reflect the new topics. Stops early if any batch hits a rate-limit/usage-cap error.

## 0.11.2 — 2026-05-20

Adds subagent and token-usage information to both the Live monitor and the status-bar tooltip:

- **Live monitor top bar** now carries two new tiles: **Tokens today** (sum of input + output + cache R + cache W across sessions started today, formatted as `1.2M`, `34K`, etc.) and **Subagents today**.
- **Per-session cards** now show a `🪄 N agents` pill (was previously hidden when present) and a `🔢 1.2M (in 800K · out 300K · cache 100K)` token breakdown next to the cost.
- **Status-bar tooltip** now mirrors the same data: a header line with `tokens · subagents · cost` for today, and each session row carries its own token total, in/out/cache breakdown, and subagent count alongside the cost.
- Internally, `buildUpdate()` widens its query to the 200 most-recent rows so the "today" sums catch sessions that haven't ticked their mtime in the last few minutes.

## 0.11.1 — 2026-05-20

- **Live status-bar item.** A compact always-visible indicator in the VS Code status bar (right side) reads `Claude · N active · <current tool>` while sessions are running, `Claude · idle` otherwise. Hover for a rich MarkdownString tooltip with each active session, its current status (`in tool: Bash · 4s`, `responding · 12s`, `idle`), message / tool counts, and per-session cost. Click to open the full Live monitor webview. Adaptive polling: 5 s when activity is detected, 30 s when idle. Toggle via the new `claudeSessions.liveStatusBar.enabled` setting (default `true`).

## 0.11.0 — 2026-05-20

- **Live monitor.** New title-bar button on the Sessions view opens a real-time dashboard. Shows one card per active Claude Code session (anything whose JSONL has been modified in the last 2 minutes), with the project, elapsed time, message / tool / subagent counts, cost so far, and a "now" status line — `in tool: Bash`, `responding`, or `idle`. Re-polls every 2 s while visible, pauses when hidden. Top summary bar shows total active sessions, tools per minute across all live sessions, and cost spent today. Status is derived from a cheap 8 KB tail-read of each JSONL — no full re-parse.
- **`KB Changes` view renames itself.** The view header now reads `{basename(repoPath)} changes` — `docs changes` for the default `~/docs`, `notes changes` if you repoint it. Updates live when you change `claudeKbChanges.repoPath` without needing a window reload.
- **Changed files open with the user's default editor.** Clicking a file in *KB changes* / *Projects* now uses `vscode.open` instead of forcing the text editor, so `.md` files open in **Markdown for Humans** when that's the configured association. The `docs.master-code-workspace` workspace file now sets `workbench.editorAssociations` for `*.md` / `*.markdown` → `markdownForHumans.editor`.

Spec: [`specs/005-live-monitor-kb-rename/spec.md`](specs/005-live-monitor-kb-rename/spec.md).

## 0.10.0 — 2026-05-20

- **Auto-classify on viewer open.** Opening the conversation viewer for a session with unclassified turns kicks off topic classification in the background (only when `classify.backend = ollama`, so no Claude subscription tokens are spent without you asking). When the run completes the viewer refreshes and the chips appear. Topics persist in the SQLite cache as before, so the next open of the same session is instant. Toggle via `claudeSessions.classify.autoOnOpen` (default `true`).
- **Tooltips no longer escape the viewport.** Both the agent-graph and trajectory tooltips now flip and clamp to the canvas container so they stay readable when you hover a point near the right or bottom edge.

## 0.9.2 — 2026-05-19

Fix: "N clusters via dbscan" with 0 hulls/labels actually visible.

Root cause: clusters were being computed correctly, but the rendering loop only emitted a `ClusterLabel` (which owns both the hull *and* the topic text) when a non-empty topic existed for that cluster. Sessions that hadn't been through *Analyze topics* yet contributed no topic data, so the cluster was discovered but neither outlined nor labeled — leaving the user with all-grey dots and a misleading "0 clusters" count in the header.

Fix: always emit a `ClusterLabel` for any cluster with ≥ 3 members. When no topic data exists, the label falls back to the cluster's most common project (`docs`, `unpolarize`, `ai/otelo`) or `cluster N` if there's no project either. Hulls and color-by-cluster now render the moment DBSCAN/k-means finds structure, regardless of whether you've classified topics yet.

## 0.9.1 — 2026-05-19

Fixes "0 clusters" on small, diverse corpora:

- **k-means fallback.** When adaptive DBSCAN still can't find ≥ 2 clusters (common with ~30–50 mostly-distinct sessions — UMAP scatters them too thinly), the extension now runs **k-means++** in 2D with `k = clamp(3, round(sqrt(n/2)), 8)` so the graph always has structure to draw. Deterministic seeding, ~50 LOC, no deps.
- **`cluster.minPts` default 5 → 3.** Small corpora benefit from looser density requirements. Set higher manually if you have hundreds of sessions and want tighter clusters.
- **Header shows which algorithm ran.** "38 sessions · 4 clusters via k-means (k=4, fallback) · embedder: ollama/nomic-embed-text" — so you know whether the layout is real density structure (DBSCAN) or forced groupings (k-means).

## 0.9.0 — 2026-05-19

Agent graph readability upgrade — convex hulls, non-overlapping labels, click-to-focus. No new deps.

- **Convex hulls** behind the dots. Every cluster with ≥ 3 members gets a translucent polygon in the cluster color (12 % fill, 40 % stroke). Cluster boundaries are now visible at a glance instead of "guess by color". Built with an inline monotone-chain hull (~30 LOC, zero deps).
- **Force-placed labels**. The centroid label routine now runs a small iterative repulsion pass so labels for adjacent clusters don't stack on top of each other. Each label has a 1.5 px halo in the editor background for legibility, and a 0.5 px leader line back to the centroid when the label was displaced more than 12 px.
- **Click-to-focus**. Click a hull or a label → that cluster stays full opacity, others fade to 25 %, foreign hulls drop to 4 %. Click again or click empty area to clear. Dot clicks still open the conversation viewer.

Spec: [`specs/004-cluster-hulls-labels/spec.md`](specs/004-cluster-hulls-labels/spec.md). Background research: [`knowledge/tech/visualization/cluster-rendering-options.md`](../../docs/knowledge/tech/visualization/cluster-rendering-options.md) in the docs repo.

## 0.8.1 — 2026-05-18

Fixes the "fallback/hash-bow-256 · 0 clusters" symptom on the agent graph:

- **Ollama probe timeout 250 ms → 2000 ms.** Electron's cold start on the
  first webview open often pushed the round-trip past 250 ms, so the probe
  reported "not reachable" and the embedder silently fell back to hashed-BoW.
  Two seconds is still imperceptible and easily survives a sluggish system.
- **Adaptive DBSCAN eps.** If the configured `cluster.epsScale` yields zero
  clusters, the algorithm steps eps up (×1.5 → ×2 → ×3 → ×5, capped at 0.30
  of the axis range) until at least one cluster forms. Small corpora and
  hashed-BoW embeddings now produce clusters instead of all-noise.
- **`Drop cached embeddings and re-embed` command.** Sometimes you switch
  embedding models (or pull a model after the first build) and the cached
  embeddings under the old model id stay around. The new command nukes
  every embedding row whose model id is not the current
  `ollama/<embedding.ollamaModel>`, so the next agent-graph open re-embeds
  cleanly.

## 0.8.0 — 2026-05-18

Three additions on top of v0.7.1:

- **Conversation trajectory view**. New **Show trajectory** button in the conversation viewer opens a Canvas that lays each turn out in 2-D (per-session UMAP, fit on the fly), connects them in time order, and dashes the segments where the cosine distance between consecutive turn embeddings crosses the 90th percentile — that's "topic drift". Dots are colored by their topic chip (deterministic HSL from the topic label). Hover for `#N · topic · user-excerpt`. Migration **v4** adds a `turn_embedding` table; embeddings are computed lazily and persist across opens.
- **Clusters on the agent graph**. The session-level Canvas now runs a small inline 2-D DBSCAN over the UMAP coords. Each cluster gets a stable color from a 12-tone palette; noise points fade to muted grey. Each cluster with ≥ 3 members carries a centroid label set to the most-common `topic_norm` across its members (e.g. `vscode-extension-webview · 14`). Two checkboxes in the header toggle *color-by-cluster* and *cluster labels*. New `cluster_id` column on `session_embedding` is persisted so the layout doesn't flap. Settings: `claudeSessions.cluster.minPts`, `claudeSessions.cluster.epsScale`.
- **Topics in the Sessions tree**. After analyzing topics for a session, its tree row picks up a `🏷` chip with up to 3 most-frequent topics, and the tooltip lists every topic with a turn-count.

Spec: [`specs/003-trajectory-clusters-topics/spec.md`](specs/003-trajectory-clusters-topics/spec.md).

## 0.7.1 — 2026-05-18

Follow-up to v0.7.0 — three fixes:

- **SQLite cache now actually works on install.** v0.7.0 shipped a `better-sqlite3` binary built against the system Node ABI, but VS Code 1.120 uses **Electron 39.8.8 / NODE_MODULE_VERSION 140**, so `SessionStore.open()` threw at activation and every cache-dependent feature ("Agent graph requires SQLite cache", silent 9 s shell fallback) degraded. The packaging step now runs `electron-rebuild --version 39.8.8` before producing the `.vsix`. Use `npm run package` from now on. Also: SQLite failures surface a "Show log" action on the warning toast, with the full stack in the new **Claude Sessions** output channel.
- **Local-first topic classification.** New setting `claudeSessions.classify.backend` with enum `["ollama", "claude-p"]`. Default is now `ollama` with `claude-p` available as the opt-in subscription path. The Ollama backend posts to `/api/chat` with `format: "json"` so the model returns a strict `{"topics":[{"id","topic"}]}` envelope — no JSONL parsing surprises.
- **Default model `llama3.2:3b`.** Fast (~10 s for 20 turns on Apple Silicon), small (~2 GB on disk), follows structured-output instructions reliably. Switch via `claudeSessions.classify.model` to `qwen2.5:3b`, `gemma2:2b`, or any other Ollama tag. Topics are tagged with `backend/model` (e.g. `ollama/llama3.2:3b`) in the DB so changing the model invalidates the cached rows.

Spec: [`specs/002-model-config-llama/spec.md`](specs/002-model-config-llama/spec.md).

## 0.7.0 — 2026-05-18

Big release: SQLite cache, on-demand topic detection, and 2D agent graph.
See [`specs/001-cache-topics-graph/spec.md`](specs/001-cache-topics-graph/spec.md) for the implementation contract.

- **SQLite cache** (`<globalStorageUri>/sessions-cache.db`, WAL mode). The sidebar and insights dashboard now read every session from a local DB instead of re-spawning `session-center.sh`. Incremental `(mtime, size)` diff means a hot refresh only re-parses JSONLs that actually changed. Cold sync of 1392 sessions: ~2.5 s. Steady-state refresh: ~50 ms. `claudeSessions.cacheEnabled` (default `true`) is the master switch; set it to `false` to fall back to v0.6.x shell behavior.
- **Topic detection** in the conversation viewer. An **Analyze topics** button at the top of the viewer batches every user-turn into `claude -p --model claude-haiku-4-5 --output-format json` and persists `{turn_uuid → topic}` rows. Each turn header gets a topic chip, and `↪ topic changed` dividers appear between consecutive turns with different topics. **No `ANTHROPIC_API_KEY` is ever set in the spawned `claude` env**, so the user's subscription billing is preserved. New settings: `claudeSessions.classify.model` / `classify.batchSize` / `classify.claudeBin`.
- **2D agent graph** (📡 button on the Sessions title bar). Embeds every non-automated session into a vector (Ollama `nomic-embed-text` if reachable; otherwise a built-in deterministic hashed-bag-of-words fallback), projects with `umap-js` (`n_neighbors=30, min_dist=0.05`), persists `umap_x/umap_y`, and renders a Canvas scatter with hover tooltips and click-to-open. Recency color: green <1d, blue <7d, purple <30d, grey older. Settings: `claudeSessions.embedding.preferred` / `embedding.ollamaUrl` / `embedding.ollamaModel`.
- **New deps**: `better-sqlite3@^12.10`, `umap-js@^1.4`. Native binary load verified on macOS arm64.
- **Migrations**: schema versions 1 (session+turn), 2 (turn_topic+classification_batch), 3 (session_embedding) — applied automatically on activation.

## 0.6.1 — 2026-05-16

- **Fix horizontal-bar chart label clipping** in the insights dashboard. CSS `svg .bar-label { text-anchor: middle }` was silently overriding the inline `text-anchor="end"` on the horizontal-bar charts, causing labels like `Bash`, `docs`, `TaskCreate`, `ai/otelo-ui` to be centered on the label-region boundary and clipped by the bar fill. Removed text-anchor from CSS, set it inline on every `<text>` (middle for vertical bars, end for horizontal). Also bumped the horizontal-chart `labelW` from 140 → 220 viewBox units and truncate labels >32 chars with an ellipsis (full text in hover tooltip).
- **Filter non-project paths from `projects_touched`** in `session-center.sh`. Edits to `~/.bashrc`, `~/.bash_aliases`, `~/.claude/...`, `~/Library`, etc. no longer pollute the per-session project list as bogus single-file "projects". The new awk rules accept only `~/projects/ai/<X>/<deeper>`, `~/projects/<X>/<deeper>`, and `~/docs/<deeper>`.

## 0.6.0 — 2026-05-16

- **Insights dashboard** (`📊` button on the Sessions title bar). New webview with:
  - **KPI row**: cost, tokens, messages, subagents, median user thinking time, burst rate (% of replies in <5s) across the lookback window.
  - **Daily cost** bar chart.
  - **Daily tokens by type** stacked bar chart (input / output / cache read / cache write).
  - **When you Claude** heatmap — 7 days × 24 hours, cell intensity = session count.
  - **Cost distribution histogram** — how many sessions in each $-bucket.
  - **Top projects by cost** horizontal bar chart (using `projects_touched` per session).
  - **Tool usage** horizontal bar chart, computed from deep-parsing the top N most-recent JSONLs (default 20).
  - **Top 10 expensive sessions** table.
- All charts are inline SVG with VS Code theme variables — no scripts in the webview, no external assets, no CSP issues.
- New settings: `claudeSessions.insightsLookbackDays` (default 14), `claudeSessions.insightsDeepParse` (default 20).
- Parser extended: `ConversationSummary` now carries `userThinkingMsList[]` (per-turn user-thinking gaps, ms) and `toolCountsByName` (tool name → call count) for deep dashboard metrics.

## 0.5.0 — 2026-05-16

- **Automated/cron sessions hidden by default.** Detected via JSONL `entrypoint` field: `sdk-cli` / `sdk` / `routine` / `headless` etc. are automated; `cli` / `claude-vscode` / `claude-jetbrains` / empty are interactive. Setting `claudeSessions.showAutomated` (default `false`) toggles. When hidden, a single info row at the bottom of the tree reports the hidden count.
- When shown, automated sessions get a `watch` icon to distinguish them from interactive work.
- Bucket totals reflect only the displayed (interactive) sessions so "Today — N sessions · $X · Y tok" stays meaningful.
- session-center.sh: new `entrypoint` + `is_automated` fields in JSON output.
- Settings changes now auto-refresh the tree (no need to click the refresh button after toggling `showAutomated`, `lookbackDays`, etc.).

## 0.4.0 — 2026-05-16

- **Sessions row**: description always shows `💬messages · $cost · ⏱duration · time-ago`. The time-ago format auto-scales (`<1s`, `Nm`, `Nh`, `Nd`, `Nw`, `Nmo`) instead of always-in-minutes. Session duration (`⏱`) is the wall-clock span from first user message to last activity.
- **Conversation viewer**: tool input AND output are now both folded by default. The whole TOOLS section per turn is also collapsible — click to expand the calls list. Keeps the per-turn prose scannable without trace noise.
- **session-center.sh**: emits `first_ts_epoch` (epoch seconds of first user message) in JSON mode so duration is computable in the tree without re-parsing JSONL.
- **Docs**: expanded README; new `docs/architecture.md`; new `CHANGELOG.md`; new `CONTRIBUTING.md`.

## 0.3.0 — 2026-05-16

- New **🔍 View conversation** child on each session row. Opens a webview tab with a per-turn timeline: turn duration, tool count, each tool's input/output, subagent metadata. See README and `docs/architecture.md` for the full spec.
- New `src/conversationParser.ts` (pure JSONL → Turn[] parser).
- New `src/conversationView.ts` (webview HTML/CSS renderer using VS Code theme variables; `enableScripts: false`).
- `locateSessionJsonl()` helper factored out of `openTranscript` and reused for the viewer.

## 0.2.0 — 2026-05-16

- **Resume opens in the official Claude Code extension panel** (not a terminal). Discovered the undocumented `claude-vscode.primaryEditor.open(sessionId, ...)` command. Falls back to `claude --resume <uuid>` in a terminal if `anthropic.claude-code` isn't installed.
- **Sessions row redesign**: title is the headline, metrics live on collapsible children. Active sessions auto-expand; older ones stay collapsed.
- **Bucket totals**: day-group nodes show aggregate session count, total cost, total tokens, total subagents (sessions) or file count + commit count (KB/Projects).
- Helper: `formatTokens()` for compact K/M/B display.

## 0.1.0 — 2026-05-16

- Initial three-pane sidebar.
  - **Sessions**: date-grouped tree of all Claude Code sessions across projects. AI-generated title, projects touched, subagent count, message count, cost, modified-time.
  - **KB changes**: `~/docs` git log + working-tree changes, grouped by day. Open file / show diff.
  - **Projects**: configurable list + auto-discovery of `~/projects/<depth-2>` git repos with commits in the lookback window. Two-level: day → project → files.
- File-watcher auto-refresh of Sessions when JSONL files change.
- Built against the existing `session-center.sh` script (JSON mode) and plain `git` CLI — no additional runtime deps.

## 0.0.1 — 2026-05-16

- Initial scaffold. Single-pane sessions list with click-to-resume in a terminal.
