# Changelog

## 1.49.1 — 2026-08-29

### Reload no longer blanks Code Build for 15–30 s

Host-trace: `cb.deserialize` waited **31 s** on `webview.ready` because activate's first `runIndexSync()` ran grok (6 s) + git (25 s) on the shared extension host. CSV sidebar and the chat filled at the same moment the host unblocked.

- First index after activate is **Claude-only**, yielded with `setTimeout(0)`.
- Grok/codex wait **8 s** so the restored chat can paint.
- Store git pull waits **12 s**.

## 1.49.0 — 2026-08-29

### Untested-write surface card (conversation viewer)

- Session conversation view gains an **Untested writes (N)** card under the totals — production paths the agent wrote with zero companion test-path touch in the same session, computed on demand from the transcript (Claude / Grok / Codex; nothing persisted, no schema change).
  - Injected **after first paint** (generation-token guarded; skipped if the panel was disposed or re-rendered), so opening a session adds no load latency.
  - Subtitle reads exactly "companion path touch only — not coverage"; capped at 25 rows + `+K more`; per-path honesty badges (Rust inline tests, unknown-language heuristic gap); session caveats listed (Codex shell-write miss, Claude MultiEdit/subagent, Grok subagent).
  - Three distinct empty states: no production writes / all paired / **surface unavailable** (cross-device store fallback, missing transcript) — never a fake "all paired", never an error toast.
  - Click a path → `codeSessions.openAbsoluteFile` via `command:` URI (webview scripts stay off).
- `renderWriteSurfaceCardHtml` is pure (no vscode import) and unit-tested alongside the extraction fixtures.
- Completes ideas/csv-untested-write-surface-card-paths-agent-wrot (core landed in 1.45.0 on the night-build line).

## 1.48.0 — 2026-08-29

### Rules doctor Insights card + checklist export

- **Insights dashboard** gains a workspace-scoped **Rules doctor** card (4 buckets: Candidates / Protected / Unscorable / Scored-with-hits) joined against the last N indexed multi-backend sessions for the active folder.
  - Click a section → opens the rule file at the heading (`codeSessions.openRulesDoctorSection`).
  - **Copy checklist** command URI + palette command (`codeSessions.copyRulesDoctorChecklist`) writes the hedged markdown checklist (never "delete these").
  - Setting `codeSessions.rulesDoctorSessionLimit` (default 30); turn scan capped; read-only — never writes rule files.
- `runRulesDoctor` / `renderDoctorCardHtml` land in `src/rulesDoctor.ts` (store surface stays injectable; no vscode import in the pure module).
- Slice of ideas/csv-never-referenced-rules-doctor-card-join-proj (UI + commands; core parser landed in 1.43.0).

## 1.47.0 — 2026-08-28

### Plan-assumption checklist core

- **`src/planAssumptions.ts`** (pure, no vscode/db imports) — first slice of the plan-assumption checklist card: extract plan/ask-phase assumptions as checkboxes before a build run.
  - Heuristics: `I assume` / `assuming` / `will use` / `defaulting to` / `given that` / plan bullets asserting a chosen approach; dedupe + cap 3–7.
  - `buildAssumptionChecklist` → card; `evaluateChecklistGate` blocks Start build / Promote to KP until every item is checked or dismissed, or the human supplies a skip reason.
  - `formatConstraintsMarkdown` emits a KP `## Constraints` write-back block (`code-sessions/plan-assumption-checklist@1`); `renderAssumptionCardMarkdown` for session-detail injection.
- 17 unit tests (`test/unit/planAssumptions.test.ts`). Session-detail card UI + CB/KP command wiring land in the next slice.

## 1.46.0 — 2026-08-27

### Compaction-cliff handoff core (cross-backend)

- **`src/compactionCliff.ts`** (pure, no vscode/db imports) — first slice of the compaction-cliff cross-backend handoff card: recommend a KP-cartridge switch *before* Codex/early-compact quality drop.
  - Per-backend defaults (editable overrides): **Codex** warn@1 / handoff@2 (fill 70%); **Grok** warn@1 / handoff@2 (fill 80%); **Claude** warn@2 / handoff@3 (fill 85%).
  - `evaluateCompactionCliff` → card (`ok` / `approaching` / `recommend_handoff`) with headline `"approaching cliff — handoff to <backend> with KP cartridge"`; `autoFailover` always `false` (recommendation only).
  - `countCompactionMarkers` + `signalsFromExtras` for fixture / Grok `signals.json` inputs; `renderCliffCardMarkdown` for session-detail injection.
  - `buildHandoffPack` emits `code-sessions/compaction-cliff-handoff@1` markdown (goal, acceptance, paths, last N decisions) reusable by Code Build / KP.
- 20 unit tests (`test/unit/compactionCliff.test.ts`). Session-detail card UI + one-click command wiring land in the next slice.

## 1.45.0 — 2026-08-27

### Untested-write surface core (multi-backend)

- **`src/writeSurface.ts`** (pure, no vscode/db imports) — first slice of the untested-write surface card: production paths the agent wrote with zero companion test-path touch in the same session. Computed on demand from the transcript; nothing persisted.
  - Per-backend extraction: Claude `Write`/`Edit`→writes + `Read`→reads (MultiEdit/subagent writes disclosed as caveats); Grok `write`/`search_replace`→writes + `read_file` reads (`target_file`, legacy `file_path`); Codex rollout re-read pulls `function_call.arguments` — V4A `*** Add/Update File` (+ `*** Move to` destination) and structured `operation.path` create/update; deletes ignored; shell-write miss disclosed.
  - Test-path heuristics (Jest/Vitest, pytest, Go `*_test.go` only — `testdata/` is fixtures, Rust `tests/` dir only with inline-`#[cfg(test)]` caveat note); docs/config/lockfile/generated/snapshot writes excluded.
  - Strict stem pairing: unrelated `bar.test.ts` never clears `foo.ts`; test-file writes never listed; unknown languages tagged "no test heuristic".
  - Missing transcript / store-fallback source → `status: 'unavailable'` — never a fake "all paired".
- 28 unit tests (`test/unit/writeSurface.test.ts`). Session-detail card injection + `codeSessions.openAbsoluteFile` command land in the next slice.

## 1.43.0 — 2026-08-27

### Rules doctor core — never-referenced rule sections vs multi-backend transcripts

- **`src/rulesDoctor.ts`** (pure, no vscode/db imports) — first slice of the never-referenced-rules doctor card:
  - Discovery: `CLAUDE.md` / `AGENTS.md` (any casing) / `.cursor/rules/*.{md,mdc}`, 2 MB cap.
  - Fence-safe `##`/`###` section parser; `.mdc` YAML frontmatter stripped; headingless file → one section named by filename; content-hash dedupe for CLAUDE.md↔AGENTS.md duplicates.
  - Distinctive-signal extractor (code spans ≥6 chars, path-like tokens, quoted phrases ≥3 tokens, 4–6-token prose n-grams); junk sole-matches (heading keywords, always/never/prefer, lone stack nouns) never score → `unscorable`, not a delete candidate. Short `- Never …`/`- Do not …` bullets shield the section as `protected`.
  - Bounded hit counter (distinct sessions primary, turns secondary; per-turn scan byte cap; ≤12 signals/section) — no FTS, no migration, read-only.
  - **Cross-source workspace join (Gap A):** claude sessions store `project_path` as the dash-encoded `~/.claude/projects/-Users-…` dir while codex/grok/git store the real cwd — `sessionMatchesWorkspace`/`filterWorkspaceSessions` handle both and include subagent/workflow children only when their parent matched.
  - `buildDoctorReport` buckets Candidates / Protected / Unscorable / Scored-with-hits; `exportChecklist` emits a hedged "no transcript evidence" markdown checklist (never "delete these").
- 18 unit tests (`test/unit/rulesDoctor.test.ts`). UI card in insightsView + command wiring land in the next slice.

## 1.42.0 — 2026-08-26

### Reasoning / thinking token share (Codex-first)

- **Schema v19** — nullable `reasoning_tokens` on `session` and `turn` (NULL = never reported; 0 = reported zero; no `DEFAULT 0`).
- **`src/reasoningTokens.ts`** — cross-backend alias map + share formula (`reasoning / output`, n/a when missing / output≤0 / reasoning>output).
- **Codex indexer** keeps `reasoning_output_tokens` from `token_count` (no longer dropped); Claude JSONL alias-reads `output_tokens_details.thinking_tokens` when present (n/a on today's transcripts); Grok/git stay NULL.
- **Conversation viewer** shows a **Reasoning share** stat (`47.4%` or `n/a`) with tooltip counts.
- Fixture + unit tests: Codex 9/19 → 47.4%; missing field stays NULL (never fake 0%).
- Slice of ideas/csv-reasoning-thinking-token-share-card-multi-ba (schema + Codex parser + share card; multi-backend list sort / Insights rollup remain).
## 1.46.4 — 2026-08-29

### Grok Build chat history loads without a full wasm index

- **View Conversation** finds `~/.grok/sessions/<cwd>/<id>/chat_history.jsonl` on disk even when the SQLite indexer has not run (1.46.3 skipped grok on the 10 s timer).
- File watcher on grok `chat_history.jsonl` indexes **only the changed files**, not all 338 sessions.

## 1.46.3 — 2026-08-29

### Stop freezing VS Code on grok index

Host-trace: `csv.index` grok was **6–7 s every cycle** (372 s of sync wasm) because the 10 s timer and Claude watcher both ran full grok/codex, and coalesce measured 5 s from **start**. Laptop stayed fine (Chrome etc.); the shared extension host did not.

- Coalesce gap is **15 s after a pass finishes**.
- Claude JSONL watcher indexes **Claude only**.
- 10 s timer refreshes trees; **does not index**. Grok/codex at most every **60 s**.
- Skip `~/.sessions` git pull when the sessions daemon is up.

## 1.46.2 — 2026-08-29

### Host-trace on store-sync, planning export, kp client, conversation view

- Spans: `csv.storeSync`, `csv.planning.export`, `csv.kp.<cmd>`, `csv.conversation`. Same NDJSON as CB/CS/KP.

## 1.46.1 — 2026-08-29

### vsce package no longer dies on suite-architecture symlink

- `.vscodeignore` excludes `docs/suite-architecture` so `npm run ship` can install.

## 1.46.0 — 2026-08-29

### Host-trace: activate + index spans

- Always-on spans on **Output → Code Sessions**: `csv.activate` (planning / store.open / trees.*) and `csv.index` (claude/grok/codex/git). `DONE …ms SLOW` when over budget.
- Same NDJSON file as Code Build: `~/.sessions/.daemon/host-trace.ndjson`. Lag `STALL` includes `task=`.
- `npm run ship` compiles, packages, and installs the VSIX. Verify in a second window.
- `.vscodeignore` excludes the `docs/suite-architecture` symlink so `vsce package` does not crash on secretlint `EISDIR`.

## 1.45.2 — 2026-08-29

### Indexer coalesces to one pass per 5 s

- JSONL watcher (1.5 s) and the 10 s timer share one gate. Live agents no longer stack overlapping wasm SQLite passes. User Refresh / full rescan still force a pass.

## 1.45.1 — 2026-08-29

### Extension-host event-loop lag on the output channel

- Samples `monitorEventLoopDelay` every 30 s onto **Code Sessions** output. p99 > 200 ms is tagged `STALL` so host freezes are visible without `sample`.

## 1.45.0 — 2026-08-29

### Fleet reads the sessions daemon (phase 1)

- On activate, CSV calls daemon `hello` + `session.list`. When the daemon is up, Fleet/Planning merge those rows (hasContent only) and **skip** `syncGitToStore` — the daemon owns the `~/.sessions` git loop.
- If the daemon is down, previous local indexers + git import still run (feature-detect fallback).
- Native Claude/Grok/Codex wasm indexers remain until the daemon index covers those sources for Search/Insights.

## 1.44.9 — 2026-08-26

### Grok Build sessions are interactive; Ask picks provider; resume doesn't walk disk

- `grok-build-plan` (and `grok` / `code-build` / `acp`) are interactive entrypoints — they were hidden as "automated" so Fleet and the Sessions tree dropped the live Grok chat.
- **Show automated** applies immediately (in-memory override) instead of blocking on a Global settings.json write.
- **Ask** (session + fleet chat) Quick-Picks provider and model like Code Build (`claude -p --model` / `grok -p --model`).
- **Open in Code Build** uses indexed `jsonl_path` and skips scanning `~/.claude/projects` for Grok ids; progress notification while Code Build activates.
- **Rename** writes Grok `summary.json` without the 60s idle guard and pushes `codeBuild.setSessionTitle` so the panel tab matches the tree.

## 1.44.8 — 2026-08-26

### Board no longer dies on `blockedSet` during first snapshot

- VS Code delivers a queued `snapshot` as soon as the webview script subscribes to `message`, which is *before* later `const`/`let` bindings ran. `renderBoard` then threw `Cannot access 'blockedSet' before initialization` (same class of TDZ for `renderError`).
- Hoist `blockedSet`, `addDays`, board-filter state, and `renderError` above the listener. Test boots the script in a mini-DOM and injects a snapshot during `addEventListener('message')` — asserts six task lanes and no overlay error.

## 1.44.7 — 2026-08-26

### Sessions tree shows conversations, not newest jsonl mtimes

- `listRecent(..., { requireReply: true })` ranks by `last_assistant_text_at` and drops panel-opens with no assistant reply. Empty/night-loop file mtimes were occupying the default 100-row window so the tree looked like “Today only.”
- Sidebar + Fleet provider both use `requireReply`. Tests: crowding empties cannot hide a week-old chat; git-store rows keep `source=git` + `extras.host` in a real SQLite store.

## 1.44.6 — 2026-08-25

### Webview fills the editor; overlay no longer spins forever

- `html,body{position:fixed;inset:0}` so `#main` gets a real height inside the VS Code iframe (100% / 100vh were collapsing to the top bar).
- Overlay is back to `#main` (not covering the tab bar). If lanes still don't exist after one retry, show Retry instead of spinning.

## 1.44.5 — 2026-08-25

### Board no longer a blank pane under the top bar

- Chrome (tabs, + New, sync pill) is static HTML; lanes live in `#main`. Every child of `#main` is `position:absolute`, so if `body` is only as tall as the top bar (`height:100vh` in an unsized iframe), `#main` is **0px** and the board/overlay paint off-screen. `html,body` now fill the webview (`height:100%`); `#main` is `flex:1 1 0%`.
- Overlay is `position:fixed` and stays up until `#board .lanes .col` exists. A host `ready` pump can no longer hide a render crash behind a white pane.

## 1.44.4 — 2026-08-25

### Dashboard script is no longer inside `document.write`

- Root cause of *Uncaught SyntaxError: Failed to execute 'write' on 'Document': Invalid or unexpected token @632*: the webview JS lived in a TypeScript template literal. `'\n'` in that template became a real newline inside a JS string (`action(s).\n` + `join('\n')`), so Chromium rejected the HTML `document.write`.
- Move the dashboard script to `media/planning-dashboard.js` and load it with `<script src>`. The HTML payload is short chrome + CSS; JS is fetched separately and cannot break `document.write`.
- Unit test `vm.Script`-parses the media file so a syntax error cannot ship.

## 1.44.3 — 2026-08-25

### Dashboard `document.write` SyntaxError @632

- A `\n` inside the SCRIPT template became a real newline in the webview JS (`join('\n')` in fleet apply results). `document.write` then failed with *Invalid or unexpected token*. Join with `<br>` instead. 1.44.3 is not enough if the window was not reloaded — the JS is now out of the HTML string entirely.

## 1.44.2 — 2026-08-25

### Export no longer sits on "waiting for kp export…" forever

- Overlay text staying on the HTML default meant the webview script never ran (or never pinged `ready`), so status never arrived. Boot script + `try/catch` around the dashboard JS now surface parse/runtime errors on the card.
- Host **pumps load status every 1s** without waiting for `ready`, and kicks export as soon as the panel opens.
- Hard watchdog kills a hung `kp` child (execFile `timeout` is not trusted in the extension host). Export budget 45s (CLI itself is ~0.4s on this store). Overlay shows the exact `node`/`cli` command.

## 1.44.1 — 2026-08-25

### Dashboard no longer sits blank while `kp export` runs

- Opening Planning painted an empty editor until export finished, and CSS hid the board chrome (`body:not([data-view=board])`) until the first snapshot. Overlay now shows **phase, elapsed time, CLI queue depth, and errors**, with Retry. Status bar: `Planning: export…`.
- `kp export` timeout raised to 180s for large stores. Failed first load is an error card, not a white void; refresh keeps the last-good board.

## 1.44.0 — 2026-08-25

### Fleet chat + denser board

- **Ask this view** — expandable chat dock on the Fleet tab, scoped to the current filter (today / live / host / hide-auto / unlinked / search). Chips: tag automated, missing tasks, link projects, summarize. The agent returns prose **and** structured actions (tag / create-task / create-idea / link). Apply one or all.
- **Hide auto** toggle (on by default) — cron / night-loop / fleet / headless sessions drop out of the board; the chat still sees `automated: true` on rows when you unhide them to tag.
- **Layout** — host columns in a responsive grid, one-line rows (time · title · badges). Actions appear on hover/select instead of six always-on buttons. Default window is **Today**.

## 1.43.0 — 2026-08-25

### Session fleet board (laptops × sessions)

- **Planning → Fleet** (command `Planning: Open session fleet` / `codeSessions.openFleet`): kanban-style board grouped by laptop, with live / today / week / unlinked / host filters. Other laptops appear from the `~/.sessions` git store after store-sync. Shortcut: **⌃⇧⌘F** (Mac) / **Ctrl+Alt+Shift+F** (Win/Linux).
- **Live status ignores git-pull mtime.** A `git pull` of `~/.sessions` rewrites file mtime and previously made idle sessions look like they started seconds ago. Live = native JSONL mtime (this machine, 2 min) or envelope/turn content timestamps (15 min, other hosts). Git-store file mtime is never used.
- **Explain / Ask / Apply labels / → idea / → task** on each card. Explain runs `claude -p` (subscription CLI) to derive intent/topic/tags (cs-label-session JSON); Apply writes `kp session-label`. Capture creates a linked KP idea or task.
- Cards still Open / Resume / Link to a planning item.

## 1.42.0 — 2026-08-25

### Filter automated sessions + hard-delete

- **Broader automation predicate** (`src/automation.ts`): hides not only the DB `is_automated` flag but night-loop / cron / fleet prompt signatures, extra entrypoints (`routine`, `headless`, …), git-store `extras.labels`, and subagent/workflow children. Code Build `sdk-cli` sessions stay visible unless the first prompt matches a suite-automation pattern. Settings: `codeSessions.automation.titlePatterns` / `extraEntrypoints` / `labels`.
- **Easy toggle**: title-bar watch/eye icon, Filter picker Automation section, and a clickable “N automated/cron sessions hidden” tree tip. Still defaults to hidden (`codeSessions.showAutomated: false`).
- **Delete session…** context-menu command: modal confirm, 60s idle guard (same as rename), removes native JSONL (and sibling subagent dir) / Grok session dir / Codex rollout / `~/.sessions` git dir (`git rm` + commit under the StoreSync lock so the next pull doesn't restore it), then `DELETE FROM session` (cascades turns, embeddings, star, hide).
- Insights dashboard and agent graph use the same predicate so night jobs don't inflate KPIs or the scatter.

## 1.41.0 — 2026-08-24

### Codex sessions render in the conversation viewer

- **Viewer routes codex rollouts to a codex parser** — `parserKindForSource` gains a `codex` kind (row source, or a `~/.codex/sessions/` path when the row is unavailable) and the viewer dispatches to the new `parseCodexRolloutAsParsed` adapter. Previously codex sessions went through the claude parser and rendered blank turn bodies.
- **`parseCodexRolloutAsParsed`** (`src/codexIndexer.ts`): ParsedCodexSession → ParsedConversation. Tool calls come through as name-only entries (rollouts record tool names, not arguments/results); meta-only rollouts yield the viewer's zero-turn empty state; a missing file throws an explicit `rollout missing: <path>`.
- **jsonl_path-first transcript locator** — Open/search/view commands now prefer the indexed `jsonl_path` (when it still exists on disk) over walking `~/.claude/projects` by UUID, which could never find codex (`~/.codex/sessions/**/rollout-*.jsonl`) or grok transcripts. Stale rows fall back to the walk, so claude behavior is unchanged.
- Slice of tasks/csv-make-codex-a-first-class-source-sourcemeta-h (viewer + locator surfaces; sourceMeta consolidation, deep-metrics dispatch, and codex-binary resume preflight remain).

## 1.40.0 — 2026-08-18

### Background re-embed job + hash-based staleness (semantic search PR3)

- **New `src/reembedJob.ts`** — consumer-driven background re-embed job under the shared `ollama/<model>@v2` tag: single-flight (concurrent kicks join the in-flight run), cancellable between 25-session chunks, 60 s probe-fail cooldown so debounced searches don't re-probe per keystroke. `buildEmbedTexts` moved here from the agent graph (both consumers share it).
- **Hash-based stale detection** (schema v18: `session_embedding.text_hash`): every upsert stores an FNV-1a hash of the exact embed text. Rows whose stored hash no longer matches the freshly built text — topics classified *after* an early embed, new tool turns, pre-v18 NULL hashes — are re-embedded on the next graph open or job kick, even though the `@v2` tag is unchanged.
- **Semantic search kicks the job**: a query answered over a partial corpus (`semantic over K/N`) or none at all fires the background job with a cancellable notification, then hints to rerun the search.
- **"Re-embed sessions" command gains a force path**: *Drop stale* (old behavior — other-tag rows only) or *Drop all + re-embed*, which clears current-tag session+turn rows too (previously impossible without a recipe-rev bump) and rebuilds immediately.
- Old-DB rebuild copy for `session_embedding` now uses an explicit column list (`SELECT *` would have broken on the new column, same class of bug as the v11 turn-table incident).
- Fully done: tasks/csv-semantic-session-search-embed-the-query-cosi (PR1 1.37.0, PR2 1.39.0, PR3 here).

## 1.39.0 — 2026-08-18

### Semantic session search in the search view (PR2)

- **"Semantic" toggle** in Claude · Search (default off, persisted in webview state, 300 ms debounce when on): probes Ollama, embeds the query as `search_query: <q>`, and cosine-ranks persisted `@v2` session vectors into a **Sessions (semantic)** pane (score to 2 dp, project chip, open/resume). LIKE topics/turns panes are unchanged and stay as secondary results.
- **Exact fallback statuses**: probe fail / no vectors / embed error → LIKE only with `keyword (semantic unavailable)`; partially embedded corpus → `semantic over K/N` (new `SessionStore.sessionEmbeddingCoverage`).
- Toggle off (or an empty query) produces the byte-identical pre-change payload and never touches Ollama — asserted by tests, incl. a paraphrase fixture where semantic finds the target and LIKE does not (`test/unit/semanticSearch.test.ts`).
- `docs/semantic-search-smoke.md` — 5-query manual smoke template for local-Ollama verification.
- Remaining slice (PR3): consumer-driven background re-embed job (kp: tasks/csv-semantic-session-search-embed-the-query-cosi).

## 1.38.1 — 2026-08-17

### Store sync: multi-window lock, corrupt-rebase recovery, merge when far ahead

- **Per-repo lock** (`.git/csv-sync.lock`) so N VS Code windows (one per project) no longer run `git pull --rebase` on `~/docs` / `~/.sessions` at the same time. Stale lock (>2 min) is stolen.
- **Corrupt rebase-merge** (dir exists, `head-name` missing) is deleted instead of `rebase --abort`, which cannot succeed in that state. Same wedge as the work-laptop `~/.sessions` / `~/docs` incidents.
- **Merge, don't rebase**, when the clone is more than 50 commits ahead of origin. Replaying thousands of unpushed session commits is what leaves the corrupt marker dir.

## 1.37.0 — 2026-08-16

### Semantic search groundwork: shared v2 embed recipe + cosine ranking (PR1)

- **New `src/embedText.ts`** — the single embed-text recipe for session vectors: `search_document: PROJECT/TITLE/TOPICS/TOOLS/FIRST USER` (empty sections omitted; ≤4096 chars with only FIRST USER truncated), `buildQueryEmbedText` (`search_query:` pairing), and `taggedEmbeddingModel` → `ollama/<model>@v2`. Bump `RECIPE_REV` whenever the text changes — the tag mismatch is what drives re-embeds.
- **Agent graph embeds the enriched text** (was PROJECT+TITLE+FIRST USER only) and persists under the `@v2` tag; classified topics (≤20, freq-desc) and tool mix (≤30, freq-desc/alpha) now shape the vector space. Next graph open re-embeds under the new tag.
- **`SessionStore.nearestSessions(query, model, limit=50, minScore=0.3)`** — brute-force in-process cosine over `session_embedding` (L2-normalize both sides, dot); mismatched-dimension rows are skipped + logged, never length-truncated. **`topToolsBySession`** aggregates `turn.tool_names_csv`; `topTopicsBySession` gains an alpha tiebreak for determinism.
- **"Drop cached embeddings" pins the full `@v2` tag** for session rows (previously it would have deleted fresh tagged rows and kept stale untagged ones); turn embeddings keep the untagged id they're stored under.
- Search-view Semantic toggle + Ollama query path land in the next slice (kp: tasks/csv-semantic-session-search-embed-the-query-cosi).



### Finished toasts no longer fire mid-session

- "Session finished" now waits until the session *leaves the live-monitor board* (transcript no longer being written) and stays off it for `notifications.finishedSeconds` (default raised **90 → 300**). Idle-while-still-on-the-board (thinking, long scripts, gaps between turns) does not toast.
- `now` chip treats thinking + any event in the last 90s as `responding` (was 30s of assistant text only).

## 1.35.2 — 2026-08-11

### Fixture tests for git + grok indexers

- New vitest suites `test/unit/gitIndexer.test.ts` / `test/unit/grokIndexer.test.ts` run the git-store and grok indexers over synthetic fixture trees (`test/fixtures/gitstore`, `test/fixtures/grokstore`) — corrupted `session.json`/`summary.json` and truncated turn files are tolerated without dropping sibling sessions; local-host skip vs codex-rollout import and `syncGitToStore` error accounting are pinned down.
- `grokIndexer`: `listAllGrokSessions` gains an injectable root (default unchanged, callers unaffected); `buildRows` exported as `buildGrokRows` for testability. No behavior change.

PATCH.

## 1.35.1 — 2026-08-11

### Search: match-window snippet + multi-token highlight

- **`searchTurns` returns a `snippet`** — ~180-char window centered on the earliest query-token hit, taken from `COALESCE(assistant_full, assistant_excerpt)` on the matched side. Deep assistant hits (term past the 1 KB excerpt) now render a snippet that actually contains the matched term instead of the head of the excerpt.
- **Search webview** prefers the server `snippet` and highlights **each query token** (not only a contiguous phrase), so multi-word queries like "async runKp" mark both words in topics and conversation rows.
- DB-level test extended for deep-hit snippet content, multi-word windows, and the pure `SessionStore.matchSnippet` helper.

PATCH.

## 1.35.0 — 2026-08-11

### Search: multi-word queries + full assistant text

- **Tokenized matching.** `searchTurns` / `searchTopics` split the query on whitespace and AND the per-token LIKEs, so "async runKp" now matches a turn containing both words non-contiguously (previously the whole query was one literal `%…%` substring). For `matched` attribution, all tokens must land on the same side (user or assistant). Empty/whitespace queries still return nothing.
- **Schema migration v17** (`MIGRATIONS[16]`): adds `turn.assistant_full TEXT`. Only the first 1 KB of assistant answers was indexed (`assistant_excerpt`), so terms deeper in long answers were unsearchable. Indexers now store the full assistant text (capped at 64 KB) when it exceeds the excerpt — NULL otherwise, so short answers aren't stored twice. Search reads `COALESCE(assistant_full, assistant_excerpt)`. Pre-v17 rows stay NULL (excerpt-only) until their source file changes and re-parses.
- All four indexers (claude jsonl, codex, grok, git) populate the new column; new DB-level test `test/wasm-search-tokenize.test.js` covers AND semantics, deep-text matches past char 2000, excerpt fallback, and reopen/migration idempotency.

## 1.34.0 — 2026-08-09

### Planning: KP-store watcher — external captures show up without a manual refresh

- **FileSystemWatcher on the planning store root** (`**/*.md`): a `kp capture` in a terminal, a `/planning-*` skill run by a local Claude session, or a git pull of the store now refreshes Today/Inbox/Projects and an open dashboard automatically.
- **`ReloadGate` (new `src/reloadGate.ts`)** — the watcher is a dirty bit, not a direct re-export trigger: rapid fs events collapse into one trailing debounced reload (new setting `codeSessions.planning.reloadDebounceMs`, default 800ms, clamped 100–10000), which then goes through `PlanningModel.reload()`'s existing coalescer (≤2 exports for any burst).
- **Self-write suppression.** Events caused by our own kp CLI mutations are muted while the mutation is in flight plus a 500ms grace after — the explicit post-mutation reload each call site already does stays the single repaint; no feedback loop, no double exports.
- **storeRoot rebind.** Changing `codeSessions.planning.storeRoot` re-creates the watcher on the new root; watcher, gate, and pending timers are disposed with the extension.
- Manual escape hatch unchanged: `Planning: Refresh` still forces a reload.

MINOR.

## 1.33.0 — 2026-08-09

### Planning: async kp CLI — the extension host no longer freezes on every planning action

- **`KpClient` (new `src/kpClient.ts`)** — one serialized promise-chain queue over async `execFile` replaces all 44 `spawnSync` kp CLI calls in `planning.ts` / `planningDashboard.ts`. Mutations run in submit order and never interleave; the extension-host thread stays responsive while exports run. Stdin piping for `kp edit --body -` is preserved (explicit write+end, UTF-8), a 60s timeout SIGKILLs a hung child so it can't wedge the queue, and dispose (deactivate/reload-window) kills any in-flight child and refuses new work.
- **Coalesced reload.** `PlanningModel.reload()` is async with a dirty-bit: N rapid reload requests while an export is in flight collapse to one trailing export (≤2 total). A generation counter makes a slow export result unable to overwrite a newer snapshot.
- **Keep last-good snapshot.** A failed or unparsable `kp export` now logs and keeps the previous snapshot instead of blanking the Today/Inbox/Projects trees (previous behavior nulled it).
- `DashboardDeps.runKp`/`reload` are now async (dashboard message handlers await mutation → reload → repaint in order).
- Not yet in this slice (tracked in kp `tasks/csv-async-runkp…`): KP-store FileSystemWatcher with debounce setting + self-write suppression.

MINOR.

## 1.32.1 — 2026-08-07

### Embeddings: never poison the agent graph with mixed-dimension vectors

- **Per-item Ollama failures** in an `ollama/*` batch are retried (short exponential backoff, max 2) then **skipped** — the session stays unembedded so the next pass retries. Previously a failed item was replaced with the 256-dim hash-BoW fallback under the same `ollama/<model>` id, which made `umap.fit` see a jagged matrix and NaN geometry for the whole graph.
- **Defensive dim filter** before UMAP in the agent graph and trajectory views: drop non-modal-dimension rows (legacy poison) and warn; layout only runs on a rectangular matrix.
- Hash-BoW fallback still used only when the whole batch falls back (`preferred` not ollama, or probe fails) under `fallback/hash-bow-256`.

PATCH.

## 1.32.0 — 2026-07-25

### Sessions tree: folder + host scope filters with a QuickPick switcher

- **Host filter (new, default on).** `codeSessions.filterByCurrentHost` shows only sessions that ran on this machine. Native transcripts are always local; git-store imports carry their origin host in `extras_json.host` (matched case-insensitively, ignoring `.local`/`.lan` suffixes). Other laptops' sessions are hidden by default.
- **Filter switcher.** New `codeSessions.chooseFilter` command — funnel icon in the Sessions title bar, also bound to the "Filtered to …" banner row. One QuickPick lists **folders** (current workspace / all / every distinct session cwd with counts) and **hosts** (this host / all / every other host with counts). Picking an entry overrides that axis for this window only (persisted in `workspaceState`); the settings defaults (`filterByCurrentWorkspace`, `filterByCurrentHost`) stay untouched.
- **Banner** now reflects both axes (`Filtered to docs · host foo — N sessions hidden`), always renders while a non-default override is active (so there's a way back), and opens the switcher instead of Settings.

MINOR.

## 1.31.0 — 2026-07-19

### Claude statusline parity: context-window gauge + burn rate

- **Per-session context-window gauge.** Each active session now estimates tokens currently in context from the latest assistant `message.usage` block (input + cache read + cache creation) in a wider 64 KB JSONL tail. Context limits per model: `[1m]` models → 1M, grok → 256K, Claude/unknown → 200K.
  - Live status-bar tooltip: per-session `ctx NN%` (bold + `$(warning)` at ≥ 80%).
  - Status-bar label: appends `· $(warning) ctx NN%` (highest active session) when any session is ≥ 80%.
  - Live Monitor cards: slim context bar with green/yellow/red thresholds at 50% / 80% plus `NN% · used/limit` tokens.
- **Burn rate ($/hr).** New `UpdatePayload.burnRateUsdPerHour` = cost today ÷ hours since today's first session activity (shown only after 30 min of activity). Surfaced in the cost-budget tile (text + tooltip), the live status-bar tooltip summary, and the Live Monitor summary bar.
- Status parsing, notifications, adaptive polling, and config gates are unchanged; the status parser still sees its original 8 KB tail window.

MINOR.

## 1.30.1 — 2026-07-16

### Auto ideas: show session + agent/model provenance

- Autogenerated idea cards (Inbox + Auto view) surface **agent · model** badges and a **source session** chip when `linked_sessions` / frontmatter provenance is present.
- Pairs with night-orchestrator enrichment (`--session`, `--agent`, `--model` on `kp create`).

## 1.30.0 — 2026-07-16

## 1.29.1 — 2026-07-16

### KP dashboard: Sessions (and other views) visible when pane is minimized

- Top bar **always wraps** and prioritizes the view tab strip (`Board / Inbox / … / Sessions`) so tabs no longer disappear off the right edge in a narrow editor group.
- Board-only chrome (`groupBy` / `sortBy` / `＋ lane` / lane segment) is **hidden on non-board views**, reclaiming space for Sessions / Projects / Auto.
- Main content area uses `min-height: 0` + proper overflow so session lists scroll instead of being clipped when the panel height is short.

PATCH.

## 1.26.0 — 2026-07-15

### Autonomous builder visibility

- New **🤖 Auto** view surfaces the overnight ideate→spec→implement orchestration (from `planning/autonomous/plan.json`): **planned sessions + times** (this window's ideate/implement, next window), **projected window usage** (with a meter), **implementation reports** (click to open), and the **autogenerated ideas** created during ideation. Inbox cards created by the autonomous ideation now carry a **🤖 auto** badge.
- Bundles knowledge-planning **0.4.0**: `kp create --tags/--source` and an `autonomous` field in `kp export`.

MINOR.

## 1.25.0 — 2026-07-14

### Inbox triage + Stale filter (dogfooding: keep the capture pile under control)

- **Inbox view** — a dedicated triage queue of freshly-captured items (tasks `inbox`, ideas `capture`, thoughts `new`), newest-captured first with source/context. Per-item quick actions: Open, convert thought→idea/task, idea→task, Defer/Park. A **📥 N** pill in the top bar jumps to it.
- **Stale filter** — a **🕸 Stale** toggle in the board filter bar shows open items untouched for 21+ days.
- Bundles knowledge-planning **0.3.0**: `kp inbox`, `kp stale`, and near-duplicate ingest dedup (re-captured phone-dump bullets link to the existing item instead of minting a duplicate — grok-4.5-reviewed heuristic), plus `triage`/`stale` fields in `kp export`.

MINOR.

## 1.24.0 — 2026-07-14

### Overdue tasks

- **See past-due, not-completed tasks** — a red **⚠ N overdue** pill in the top bar (when any exist) and an **⚠ Overdue** toggle in the board filter bar show only tasks whose due date is before today and aren't done/outdated. Click the pill to jump to the filtered board. Cards already flag overdue due-dates in red.
- Bundles knowledge-planning **0.2.1**, which adds a `kp overdue [--date D]` CLI command and an `overdue` field in `kp export`.

MINOR.

## 1.23.0 — 2026-07-13

### Readable board on narrow panes + richer session viewer

- **Responsive board** — when the pane is narrow (side bar open / small window), the kanban lanes now stack full-width and stay readable instead of being crushed into a horizontal scroll of tiny columns. Project/Sessions cards no longer overflow narrow panes.
- **Session conversation viewer** — opening a session from the dashboard now shows **Cost, total Tokens (in/out/cache breakdown on hover), and Model** alongside turns/tools/span, matching the sidebar's stats. The primary action is relabeled **▶ Continue in Code Build** and now passes the session's source + project path so it actually resumes *that* session in Code Build (previously it could open a blank chat).

PATCH/MINOR.

## 1.22.0 — 2026-07-13

- Planning mode now runs the **published npm `@unpolarize/knowledge-planning`** (bundled into the extension as `dist/cli.js`, versioned with the .vsix) instead of a local source checkout. Falls back to a resolvable install, then a dev checkout. `KP_ROOT` defaults to the KB planning store so the generic package default doesn't misroute.

## 1.21.0 — 2026-07-13

- Opening a session from the planning dashboard (Sessions view, drawer "Linked sessions", Projects-view session rows) now shows the **conversation** ("insides") by default via `codeSessions.viewConversation`, instead of the trajectory graph. A separate **Trajectory** button per session opens the graph when you want it.

## 1.20.2 — 2026-07-13

- Fix Sessions view Today/Yesterday/Last-week filtering: read the actual `store.listRecent` fields (`session_id`, `mtime_ns`, `started_at`, `message_count`) and bucket by **last activity** (mtime), matching the Code Sessions sidebar — previously it mis-read epoch fields and bucketed by first-timestamp, so recent sessions showed as older / empty.

## 1.20.1 — 2026-07-13

- Sessions view now sources from the Code Sessions SQLite index (recent + rich) so Today/Yesterday/Last-week actually populate; falls back to the ~/.sessions git store when the cache is off. Linked-planning badges resolve from the snapshot's `linked_sessions` (works for any session source).

## 1.20.0 — 2026-07-13

### Sessions view + create defaults

- **Sessions view** — a new top-level view listing Code Sessions from the `~/.sessions` git store, filtered by **Today / Yesterday / Last week / All**, with a search box (title/project/agent). Each session shows when it ran, project, agent, turn count, and any linked planning items. Click (or Open) to view the transcript; Resume ▸ opens it in Code Build; "Link to task" searches/selects a planning item and links it (`kp link-session`); "→ planning" jumps to a linked item.
- **New items default to actionable** — the drawer create editor now defaults tasks to **today** status and pre-fills **Due = today** (still editable / pre-dated from a calendar day).

MINOR.

## 1.19.0 — 2026-07-13

### Drawer-based create + resolution editor, Social column, Code Build fix

- **"＋ New" opens a full editor in the side drawer** (type, title, status, category, lane, project, due, priority, body) instead of the one-line top-bar input; clicking a calendar day opens it pre-dated. Creates via `kp create` + follow-ups, then opens the new item.
- **Resolution note on closing moves is now a multi-line modal** (Save note & move / Move, no note / Cancel move; ⌘↵ saves, Esc cancels) instead of the cramped one-line input.
- **✨ Social view** — a dedicated column of ideas/tasks/thoughts flagged to polish into a social-media post. Flag from the drawer ("Mark for social") or drag a card onto the drop zone; "Polish in Code Build" drafts a post (2 variants) from the item. Flag is stored in the `lane` field (`social`).
- **Fix: "Run in Code Build" reliably launches** — Code Build activates lazily, so its command wasn't registered until first use; the dashboard now activates the extension by id first (pairs with code-build-vscode 0.9.9, which also activates `onCommand`).

MINOR.

## 1.18.0 — 2026-07-12

### Store-sync status + activity-driven polling

- **Sync status everywhere** — a new status-bar item (`☁ 2m ago`) and a header pill on the Planning Dashboard show when the git stores were last synced, the current state (syncing / ok / conflict / offline), and which repos changed; click either to sync now.
- **Activity-driven cadence** — while you're active on the Planning Dashboard (focus, clicks, keys, scroll), the store poll switches to an aggressive interval (`codeSessions.sync.activeIntervalSeconds`, default 20s) for a bounded window (`codeSessions.sync.activeWindowMinutes`, default 3m after your last interaction), then falls back to the normal `intervalMinutes`. Opening/focusing the board pulls immediately.
- Pairs with knowledge-planning 1b25ae7: the kp serve web dashboard pulls the KB repo on open and while active, with the same header sync pill.

MINOR.

## 1.17.0 — 2026-07-12

### Sorting, project-centric view, session ↔ planning navigation

- **Sort cards within lanes** — new ↕ selector next to group-by: priority (default), due, updated (newest first), title, project, domain, type. Persisted.
- **Group lanes by project** — the ▦ group-by selector gains project; dragging a card between project lanes reassigns it via `kp set-project`.
- **Projects view** — new top-level view: one card per KP project with open items (status-ordered, click → drawer, double-click card → expand all), closed counts, and the sessions linked to the project or its items (click → open the chat).
- **Session → Planning** — right-click a session in the Code Sessions view → "Open in Planning": jumps to the planning item(s) linked to that session (via `linked_sessions` / envelope `planning_refs`, now projected into the snapshot); if several, pick; if none, offers to link the session to an item and opens it. The reverse direction (drawer "Linked sessions" → open chat) already existed.

MINOR — pairs with knowledge-planning 2dd2e80 (linked_sessions in the projection).

## 1.16.0 — 2026-07-12

### Resolution notes on closing moves

- Moving an item to **done / deferred / outdated / parked / archived** — by lane drag, card-on-card drop, or the drawer status selector — now prompts for a resolution note. Enter with text saves it into the item's body as `## Resolution (<status> — <date>)` (via `kp set-status --note`); empty Enter moves without a note; **Esc cancels the move**.
- Pairs with knowledge-planning 9381acf: the kp serve web board/drawer prompts the same way, and the CLI gained `kp set-status <id> <status> --note "…"`.

MINOR.

## 1.15.1 — 2026-07-12

### Project labels on planning items

- Detail drawer gains a **Project** selector (KP projects from the snapshot). Writes via `kp set-project` (aliases CS/CSV/CB/KP, or `-` to clear).
- Cards already show `· <project-slug>` when `project` is set on the object.

PATCH — pairs with knowledge-planning `set-project` / `derive-projects` / `label-sessions`.

## 1.15.0 — 2026-07-12

### On-demand sync button + planning/session keybindings

- **⟳ Sync** button on the Planning Dashboard top bar (+ command "Planning: Run Sync Script…"): runs a script from the KB's `scripts/sync/` folder (configurable via `codeSessions.planning.syncDir`). One QuickPick entry per executable `*.sh`; `sync.sh` — the standard name — sorts first and runs directly when it's the only script. Output lands in the Planning output channel; the snapshot reloads after.
- **Keybindings (mac)**: `⌘⌃⇧S` toggle the Code Sessions sidebar (rebound from ⌘⌃⇧C, which Code Build now uses for new chat) · `⌘⌃⇧P` toggle planning mode — opens the Planning sidebar + board together, closes both on second press · `⌘⌃⇧B` show the planning board. Windows/Linux: same on ctrl+alt+shift.
- Pairs with knowledge-planning 5498f86: kp serve web top bar renders a run button per sync script over the same convention (`/api/sync-scripts`, `/api/sync`).

MINOR.

## 1.14.0 — 2026-07-12

### Category editing, thought→task, sidebar Thoughts

- **Category (domain) is a real editor** — the drawer's Domain field is now labeled Category and offers a datalist of existing domains (from domain objects + values in use); pick one or type a new one. Board group-by-domain drag already moves items between categories.
- **Thought → task** — thoughts gain a second convert action (drawer + →☑ hover) alongside → idea.
- **Sidebar**: the Planning Inbox tree gains a Thoughts group; "＋ New" quick-pick offers thought.
- Pairs with knowledge-planning 85ba13b: kp serve web dashboard got the same Thoughts lane set, provenance drawer with category editor and convert buttons, double-click-to-expand Topics panels, and a Day view that no longer lists parked/archived bulk-triage as "worked on".

MINOR.

## 1.13.0 — 2026-07-12

### Thoughts view — gdoc prose lands on the board, convertible to ideas

- New **Thoughts** lane set on the Planning board (`new / kept / converted / archived`) showing the `thought` objects the v2 gdoc ingest extracts from prose/reflections in the Google-Doc mirror (knowledge-planning: `kp ingest-thoughts`).
- Thought cards show provenance — the date-header/section context (◔) and surfaced-on date; the drawer adds context/surfaced badges and a clickable ↗ source link (opens the gdoc).
- **Convert → idea**: hover action (→💡) on thought cards + drawer action; runs `kp recategorize --to-type idea` and opens the new idea in the drawer.
- Type-grouped board now includes a thought lane.

MINOR — pairs with knowledge-planning `thought` type + provenance columns.

## 1.12.0 — 2026-07-12

### Planning board: due-date fix, drawer autosave + priority, column maximize, drag-to-sort

- **Due date fix** — Chromium fires `change` per keystroke in the year segment (typing "2" yields a valid `0002-…` date), which got saved mid-typing. Commits are now debounced (700ms) and years < 1970 refused; clicking the field opens the native calendar picker (`showPicker()`).
- **Clone opens the editor** — no more top-bar title prompt: the copy is created as "<title> (copy)" and opens straight in the detail drawer where the title (and everything else) is editable in place.
- **Column maximize** — double-click a column header/empty area to expand that lane full-width as a compact single-line list; double-click again or press Esc to restore.
- **Drag-to-sort priorities** — lanes now sort p0→p3 (unset last); dropping a card onto another card adopts that card's priority (`kp set-priority`); dropping across lanes also moves status.
- **Drawer: autosave + Esc + priority** — the body textarea autosaves (800ms debounce + on blur; Save button removed, "saved ✓" indicator); Escape closes the drawer (flushing pending autosave); new Priority selector (p0–p3 / none) next to Due.

MINOR — new board/drawer capabilities + a data-corrupting due-date bug fix.

## 1.11.0 — 2026-07-12

### Planning board: clone, done-lane age window, drawer due date

- **Clone a task/idea/plan** — new ⧉ hover action on board cards and a "Clone" action in the detail drawer. Prompts for the copy's title (default "<title> (copy)"), copies status/domain/priority/due plus body and lane via `kp create` + `kp edit`. A clone of a closed item (done/outdated) restarts at the type's default open status (task→inbox, idea→capture, plan→plan).
- **Done lane age window** — the done column header gains a selector (**yesterday / week / month / all**, default week) that hides done items whose `updated` is older than the window; the header count shows "+N older" for what's hidden. Persisted in webview state.
- **Due date in the drawer** — the detail drawer gains a Due date field (native date input) wired to `kp set-due`; clearing the input unsets the date.

MINOR — new user-facing board/drawer capabilities.

## 1.10.0 — 2026-07-12

### Board date filter — "tasks worked on / due on a day"

- The Board gains a filter bar: pick a field (**worked on (updated)** or **due**) and a date, and the board narrows to cards whose that-field falls on that day. "today" jumps to now; "clear" removes it; a count shows how many matched.
- Setting **worked on = today** answers "what did I touch today"; **due = a day** answers "what's due then" without leaving the board.
- Board relaid out as a filter row + horizontally-scrolling lanes. Reads `updated`/`due` straight from the `kp export` snapshot; no new data feed.

(The `kp serve` web dashboard's Day view also now splits "Worked on (updated)" / "Created" / "Due" — shipped in knowledge-planning.) MINOR — UI only.

# Changelog

## 1.9.0 — 2026-07-12

### Board search (⌘F), guided create, create-on-calendar-day

- **⌘F / Ctrl-F** reveals a search box that filters the board to cards matching the term (across all lanes); Esc clears. Re-applies after each render.
- **"＋ New"** (was "＋ Capture", a bare string prompt) opens a guided create: pick type (task/idea/plan) → title, running `kp create`. Matches the dashboard's QuickPick/InputBox editing idiom.
- **Click a calendar day** (empty area of a month cell or week column) → create a task pre-dated to that day (`createOnDay` → `kp create --due`). The day number still drills into that day's list.

Needs `@unpolarize/knowledge-planning` with the `kp create` command (shipped together). MINOR — new UI + two host messages, no schema change.

# Changelog

## 1.8.0 — 2026-07-12

### Calendar: real month / week / work-week grids (was a flat list)

The Planning Dashboard's Calendar showed only a flat date-grouped list. It now has proper grid modes, matching the standalone `kp serve` dashboard:

- **Mode selector** (Month · Week · Work week · List) appears when Calendar is active.
- **Month**: a 6×7 grid (Monday-first), each day cell showing its due tasks (priority-prefixed, overdue in red), out-of-month days dimmed, today outlined; click a cell → that day's List.
- **Week / Work week**: 7- or 5-day columns of due items; click a column header → that day's List; prev/next/Today navigation.
- **List**: the previous flat view (from/to + All-dated / +Overdue), still available and used for the single-day drill-down.
- **Drag a task to another date**: due items are draggable onto any month cell / week column → new `setDue` host message runs `kp set-due`. Reads due/priority straight from the `kp export` snapshot (no new data feed); all views reload after a change.

MINOR (`1.7.0 → 1.8.0`) — new calendar UI + one host message. No schema/protocol change.

# Changelog

## 1.7.0 — 2026-07-11

### Viewer-owned background git sync (KB / Sessions / Planning)

The viewer now keeps the shared git stores fresh itself, so it always shows up-to-date cross-machine data — and only while it's open (no always-on daemon or cron; every timer/watcher is a disposable, so closing the viewer stops all sync).

- **What it syncs:** the KB repo `~/docs` (which contains the Planning store under `planning/`) and the Sessions store `~/.sessions`. Planning is covered by the `~/docs` pull; extra repos can be added via `codeSessions.sync.extraRepos`.
- **When:** on activation (1.5s after the window settles), on a periodic poll (`codeSessions.sync.intervalMinutes`, default 5), and on **turn completion** — a new `~/.sessions/hosts/**` watcher fires when the CS capture daemon commits a finished turn/session, debounced 4s. After any pull that advances HEAD, the affected views reload (sessions re-index, KB/Projects git-log, Planning snapshot).
- **Conflict handling — recover, never wedge:** uses `pull --rebase --autostash`; if a rebase is already in progress (ours from a crash, or a cron's), it's aborted back to a clean HEAD before syncing. A pull that conflicts is aborted (repo left clean) and surfaced as a one-time warning — no marker-resolution loop, no merge agent. Overlapping triggers coalesce (one serialized pass; a request mid-run schedules exactly one more).
- **Push:** after rebasing, this machine's local commits are pushed (`codeSessions.sync.push`, default on) so its own sessions/planning changes flow out too; turn off for pull-only.
- New command **"Code Sessions: Sync stores now"** for a manual pull. New settings under `codeSessions.sync.*`. New module `src/storeSync.ts` (raw `child_process`; ported from the CS library's `GitStore.sync()` pattern).

MINOR (`1.6.3 → 1.7.0`) — new user-facing sync behavior + new settings/command. No schema/protocol change.

# Changelog

## 1.6.3 — 2026-06-27

### Docs: generic, accurate defaults

- **Corrected stale documented defaults** to match the shipped config: `codeProjectsActivity.repoPaths`
  (`[]`, auto-discovery) and `codeKbChanges.repoPath` (`""`, auto-detect) in README + DATA-STORES.
- **Genericized the global-storage path** in docs to `<publisher>.code-sessions` (the extension id from
  `package.json`); the inspect command now derives it instead of hardcoding it.
- Removed personal references and example project names from the README/docs; broadened the
  "Why this exists" section to reflect cross-agent (Claude + Grok) coverage. No functional changes.

## 1.6.2 — 2026-06-27

### Inline-editable item detail + Research opens Code Build

- **Item drawer:** name (title), domain, lane, and notes/details are now **edited
  inline** in the board's detail drawer (saved via `kp edit`, drawer refreshes).
- **Research KB / Ideate / Decompose / Draft-spec** no longer open a throwaway editor
  file — they open **Code Build** with the prepopulated prompt copied to the clipboard
  (review & send in the composer).

## 1.6.1 — 2026-06-27

### Side-panel items open in the board

Clicking a task/idea/plan in the planning side panel now opens the **Planning Dashboard
board** and focuses that item's detail drawer (instead of opening the markdown file). The
markdown is still one click away via the drawer's "Open file" action.

## 1.6.0 — 2026-06-27

### Planning Workbench

Full CRUD + agent workflow for the planning board, side panel, and item view:

- **Board:** per-card **Edit / Recategorize / Delete**; configurable **swimlanes** via a
  group-by selector (status / domain / type / **custom lane**) + "＋ lane"; drag a card to
  any lane to set that field (status/domain/lane) or recategorize the type.
- **Item view:** **Research KB** (runs the `planning-research` skill), **Edit**,
  **Recategorize**, **Move → task**, **Delete**. Ideate / Decompose / Draft-spec / Research
  now open a **prepopulated, editable prompt** you review before it runs in **Code Build**
  (the duplicate terminal "Execute" is gone). **Open in Code Build** can attach the item's
  linked knowledge as `@`-references. **Link session** is now a searchable picker over the
  session store (with preview), and **linked sessions are clickable to jump into the chat**.
- **Side panel:** fixed empty **Today** (now reads live task status), added **Tasks / Ideas /
  Plans** groups.
- **Graph:** more node spacing + label halos for legibility.
- Backed by new `kp` commands: `edit`, `recategorize`, `delete`, `research` (+ a `lane` field).

## 1.5.10 — 2026-06-24

### Fix: live-monitor false "finished" alerts

A session was reported "finished" the moment it went from active to idle for a
single poll tick — so long tool calls, model thinking, or the gap between turns in
an agent loop fired a false "Session … finished" popup while it was still running.
Now debounced: "finished" fires only after a session is continuously inactive for
`codeSessions.notifications.finishedSeconds` (default 90s), and re-activation
cancels the pending alert.

## 1.2.6 — 2026-06-18

### Fix: "database is locked" on activate (stale WASM VFS lock)

Reported on the work laptop after upgrading: `SessionStore.open()` threw
`SQLite3Error: database is locked` at the first `PRAGMA journal_mode`, so
`activate()` never registered tree providers.

Root cause: `node-sqlite3-wasm` uses a sibling `sessions-cache.db.lock`
directory for exclusive access. An unclean extension-host shutdown (reload,
crash, force-quit) can leave a stale lock behind. A brief multi-window race
(two VS Code windows activating CS at once) produces the same symptom.

- Clear stale `<db>.lock` before every open attempt (was only done for the
  legacy import ATTACH path).
- Retry open with exponential backoff (8 attempts, up to ~9.5 s total).
- Set `busy_timeout = 5000` on connect.
- Lock-class failures surface a hint to close other windows / reload.

## 1.2.5 — 2026-06-18

### Fix: broken 1.2.4 install (extension failed to activate)

The 1.2.4 `.vsix` was accidentally packaged **without** `node_modules`
(~234 KB instead of ~980 KB). At runtime `require('node-sqlite3-wasm')`
threw during module load, so `activate()` never ran — every sidebar view
showed *"There is no data provider registered"* and commands like
`codeSessions.refresh` / `codeSessions.toggleActivityView` were not found.

- Rebuilt with `scripts/build-install.sh` (packages **with** dependencies).
- Added a post-package guard in `build-install.sh` that fails if
  `node_modules/node-sqlite3-wasm` is missing from the `.vsix`.

## 1.2.4 — 2026-06-18

### Workflow/subagent cost attribution

- Recursive discovery of child transcripts under `subagents/` and
  `subagents/workflows/`.
- Child costs roll up into parent session rows (`🔀$X.XX` suffix).
- **Workflow runs** section in Tasks view.
- DB migration v16 (`kind`, `parent_session_id`, `workflow_id`).

*(Note: the initial 1.2.4 `.vsix` build was broken — use 1.2.5.)*

## 1.2.3 — 2026-06-13

### Auto-recover from "database disk image is malformed"

Reported in the wild after 1.2.2 shipped:

```
code-sessions: SQLite cache failed to open: database disk image is
malformed. The Sessions tree will be empty until this is resolved —
see the log for stack and try the Refresh command after fixing.
```

SQLite reported genuine on-disk corruption (`SQLITE_CORRUPT` /
`SQLITE_NOTADB`). Pre-1.2.3 the user had to manually delete the
cache file from `~/Library/Application Support/Code/User/
globalStorage/zhirafovod.code-sessions/sessions-cache.db` before
the extension would work again — a non-obvious recovery for a
cache that's fully rebuildable from upstream `~/.claude/projects`
and `~/.grok/sessions`.

Fix: `SessionStore.open()` now catches the corruption-class error
classes (`SQLITE_CORRUPT` / `SQLITE_NOTADB` / "database disk image
is malformed" / "file is not a database"), quarantines the bad
file to `sessions-cache.db.corrupt-<ISO-timestamp>` (alongside
`-wal` / `-shm` / `-journal` sidecars in case the corruption
originated there), and recreates the cache fresh. The indexer
repopulates on its normal sync pass; the user sees a one-shot
info toast naming the backup file with a "Show log" action for
forensics.

If rename across volumes fails (rare; FUSE / mounted-volume
setups), falls back to copy + unlink. If even that fails, the
error re-fires unchanged — no silent data loss.

Per AGENTS.md: 1.2.2 → 1.2.3 (PATCH — bug fix, no new surface).

## 1.2.2 — 2026-06-13

### Fix: shell-script fallback removed (was breaking every fresh install)

Reported on a fresh laptop install (different macOS user `sesergee`):

```
Error: session-center.sh exit 127: bash: /Users/sesergee/.claude/skills/
sessions/session-center.sh: No such file or directory
```

Root cause: `SessionsProvider.load()` and `openInsightsView()` had a legacy v0.6.x fallback path that, when `cacheEnabled = false` OR `SessionStore.open()` threw at activate time, would spawn `~/.claude/skills/sessions/session-center.sh` — the developer's personal pre-v1 tool that **doesn't exist on any other user's machine**. Exit 127 (command not found) every time.

Fix: removed the shell-script fallback entirely. Both views now show a clear actionable empty-state when the SQLite cache is unavailable:
- Sessions tree: *"Code Sessions: SQLite cache unavailable. Re-enable with `codeSessions.cacheEnabled = true` (default) and reload the window. If it was on, the cache failed to open — check Output → 'Code Sessions' for details."*
- Insights view: *"Insights need the SQLite cache. Enable `codeSessions.cacheEnabled = true` (default) and reload the window."*

`codeSessions.scriptPath` setting marked `deprecationMessage` so future configs that reference it surface a clear migration note. The setting still loads (no schema breaking change) but the value is ignored.

The activate-time SQLite open-failure warning toast was reworded to drop the now-untrue "Falling back to shell-script mode" promise.

Per AGENTS.md: 1.2.1 → 1.2.2 (PATCH — bug fix, no new surface).

## 1.2.1 — 2026-06-13

### Fix: no more annoying tab-splits when opening views from the sidebar

Every webview-panel creation site (`Resume session`, `Open Insights`, `View conversation`, `Agent graph`, `Search`, `Trajectory`, `Live monitor`, `Memory atlas`) used `vscode.ViewColumn.Active`. That's unreliable when the user invokes the command from the sidebar tree — `vscode.window.activeTextEditor` is undefined while focus sits in the sidebar, so `ViewColumn.Active` falls through to "create a new split column". Result: every click opened a fresh editor group beside the user's carefully-arranged editors. Reported in notes.md as "very annoying."

Fix: new `src/editorColumn.ts` exports `preferredEditorColumn()` that first asks `vscode.window.tabGroups.activeTabGroup` (always defined, returns the focused editor group regardless of where keyboard focus is), then falls back to the active editor's column, then `ViewColumn.One`. Reuses the existing editor area instead of splitting.

Applied to all 7 panel-creation sites in CS: liveMonitor.ts, conversationView.ts, agentGraph.ts, searchView.ts, insightsView.ts, trajectoryView.ts, extension.ts.

## 1.2.0 — 2026-06-13

### Memory inventory — new sidebar tab + insights tile + live-monitor row

User-driven feature from notes.md: surface "how many memories the agent has" everywhere CS already shows session/cost/token telemetry, and give the user a clickable inventory of every memory source on the machine.

- **New `codeMemory` tree view** in the activity-bar container (`Memory` next to Sessions / KB / Projects / Tasks). Renders a totals header (`N entries · M files · provider:count …`) plus one collapsible group per scope (Workspace / Project / User). Each leaf row is a memory source file with its entry count, click-to-open command, and tooltip carrying the absolute path + provider + scope. Refresh button in the title bar; auto-refresh every 60s.
- **Memory KPI tile in the Insights dashboard** alongside Cost / Tokens / Messages / Subagents / Thinking time / Burst rate. Shows total entries + source-file count for the current workspace.
- **Memory row in the AI Agent live monitor** — fifth tile next to Active sessions / Tools/min / Tokens today / Subagents today / Cost today. Refreshed on every poll tick so CLAUDE.md edits show up live.
- **`UpdatePayload`** in liveMonitor.ts extended with `memoryEntries: number` + `memoryFiles: number`.
- **Memory source discovery** (`src/memoryView.ts` — 230 LOC): scans CLAUDE.md / CLAUDE.local.md / AGENTS.md / MEMORY.md at workspace root + `.claude/CLAUDE.md` + `.claude/{rules,commands}/` + `~/.claude/{CLAUDE.md,MEMORY.md}` + `~/.claude/projects/<encoded-cwd>/memory/MEMORY.md` + `~/.codex/AGENTS.md` + `~/.codex/memories/*` + `~/.grok/AGENTS.md`. Entry count = H2 sections (markdown) or file count (codex memories dir). Fenced-code-aware so `## ` inside a triple-backtick fence doesn't count.
- New commands: `codeMemory.refresh`, `codeMemory.openFile`.

Per-session memory usage attribution (e.g. "session X read N memory entries") is NOT in this release — that needs the memory-map work in `@unpolarize/agent-memory-core` to land first. v1.2.0 ships the inventory + global counters; per-session attribution follows.

## 1.1.4 — 2026-06-13

- **Fix: Code Build sessions STILL invisible after 1.1.2** — the `sdk-cli` allow-list landed in one of two indexing code paths in `jsonlIndexer.ts` but not the other. The miss path is the in-loop `isAutomated` heuristic around the per-turn JSONL scan (~line 263); it kept flagging new CB-spawned sessions as `is_automated=1` even though the canonical `entrypointFromTurns()` helper had been fixed. Net effect: 1.1.2/1.1.3 users saw existing CB sessions surface (thanks to migration v14's one-shot UPDATE) but every NEW CB session re-vanished into the automated bucket. Both heuristics now share the same allow-list (cli / claude-code / claude-vscode / claude-jetbrains / **sdk-cli** / ""). New **migration v15** re-runs the same UPDATE to catch the rows that were re-mis-marked between v14 and 1.1.4.

## 1.1.3 — 2026-06-13

- **Fix: rebrand migration crashed on first activation with "table turn has 16 columns but 11 values were supplied".** The old (`zhirafovod.claude-sessions`) `turn` table is the v1 schema (11 columns); the new `code-sessions` `turn` table has 16 after migrations v11/v12 appended the per-turn `input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_write_tokens` / `cost_usd` columns. The merge step did `INSERT OR IGNORE INTO turn SELECT * FROM old.turn` — fine pre-v11, broken since. The whole transaction rolled back, the migration ledger never recorded success, and the extension fell back to shell-script mode for the rest of the session. Now uses an explicit column list (the 11 v1 columns); the five new columns default to 0 and get backfilled on the next jsonl re-parse.

## 1.1.2 — 2026-06-13

- **Fix: Code Build sessions invisible in the sidebar.** Code Build spawns `claude -p ...` (the SDK CLI mode), which records `entrypoint=sdk-cli` on the first user line of the jsonl. The pre-v14 heuristic in `jsonlIndexer.entrypointFromTurns` only treated `cli` / `claude-code` / `claude-vscode` / `claude-jetbrains` as interactive — `sdk-cli` slipped into the "automated" bucket and got hidden by `showAutomated = false`. CB sessions silently disappeared from the today/yesterday/older buckets. Allow-list now includes `sdk-cli` for both fresh indexing and a retroactive **migration v14** that flips `is_automated = 0` on already-indexed claude rows with `entrypoint = sdk-cli`. One-shot skill invocations (`claude -p "summarise..."`) also become visible — they're useful breadcrumbs of what skills ran.
- **Pre-publish hygiene.** Default for `codeProjectsActivity.repoPaths` changed from a hardcoded personal path list (`["~/projects/unpolarize", "~/projects/ai/otelo"]`) to `[]` — auto-discovery handles the typical case and the explicit list was leaking the publisher's directory layout into every install. Genericised one comment in `src/jsonlIndexer.ts` that had a literal local username in its path-encoding example.
- `AGENTS.md` (new) — strict version-bump-and-changelog policy on every commit that ships code, plus a publish checklist for the marketplace.

## 1.1.1 — 2026-06-13

Stability + correctness fixes; first Marketplace-publish-ready build of the 1.1.x line.

- **Fix: SQLite "out of memory" on read.** node-sqlite3-wasm runs on a bounded Emscripten linear-memory heap; the legacy `mmap_size = 256 MB` pragma inherited from the native better-sqlite3 build was at best a no-op (WASM VFS has no xMmap) and at worst tickled SQLITE_NOMEM under temp-store pressure. Now: `mmap_size = 0`, explicit `cache_size = -4096` (4 MB cap), `temp_store = MEMORY` kept (will flip to FILE if OOM recurs during migrations). Error path also gained SQLite `code` / `errno` surfacing + a stack-trace console log so future occurrences point at the offending query.
- **Filter stillborn grok `<system-reminder>` sessions.** Grok writes its discovered skill catalog as a single user-role line on every ACP `session/new`; when the client never sends a real `session/prompt` (panel closed early, backend swapped, probe-only spawn), the session file persists with just those 2 lines. ~20 such rows had accumulated in 2 days. `grokIndexer.buildRows` now returns null for them (with `deleteByPaths` to clean stale DB rows), and `last_assistant_text_at` is only stamped when the session actually had an assistant reply so `last_response_epoch > 0` filtering works.
- **Migration v13** — one-time `DELETE FROM session WHERE source='grok' AND tool_count=0 AND substr(first_user_msg,1,17)='<system-reminder>' AND session_id NOT IN (turns-with-assistant)`. Safe filter — won't touch sessions that happened to start with a system-reminder but had real assistant responses. Drops the pre-existing 20-or-so stillborn rows that can't auto-re-parse (their `mtime_ns` is stable).
- **Better `SessionsProvider.load` error reporting.** Catch block now includes the SQLite error class + message + stack trace logged to console (View → Output → Window) so any future read failure pinpoints the failing query.

## 1.0.0 — 2026-05-28

Rebrand to **Coder Sessions** + first-class Grok Build support.

### Breaking — rebrand from `claude-sessions` to `coder-sessions`
- Extension id, publisher product name, activity-bar container, every command id (`claudeSessions.*` → `coderSessions.*`), every view id (`claudeSessions`, `claudeKbChanges`, `claudeProjectsActivity`, `claudeTasks` → `coderSessions`, `coderKbChanges`, `coderProjectsActivity`, `coderTasks`), and every settings key all renamed. Old settings values do **not** carry over — reconfigure once.
- Repo moved to [zhirafovod/coder-sessions-vscode](https://github.com/zhirafovod/coder-sessions-vscode). Marketplace listing is a new entry; the old `zhirafovod.claude-sessions` is frozen.

### DB migration on first activation (no reclassification needed)
- On first run, the extension `ATTACH`es the sibling `<globalStorage>/zhirafovod.claude-sessions/sessions-cache.db` and merges every table (`session`, `turn`, `turn_topic`, `classification_batch`, `session_embedding`, `turn_embedding`, `session_star`) into its own DB via `INSERT OR IGNORE`. Migration v7 adds a `source TEXT NOT NULL DEFAULT 'claude'` column; v8 adds a `migration` ledger table that records the import so it doesn't re-run on every activation.
- **Self-heal for the v1.0 pre-release bug:** if grok's `session_kind: "claude_import"` rows had been indexed into the new DB and overwritten the authentic claude rows, the merge `DELETE`s those grok-attributed sessions first (cascading their turns/topics) and restores the authoritative claude data from the old DB.
- A one-shot info toast reports the import count: *"Imported N sessions and M topic classifications from your previous Claude Sessions install."*
- Old global-storage dir is left untouched. VS Code globalState keys (classifier paused / failed lists) reset to defaults — they're cheap to recover and VS Code doesn't expose another extension's globalState.

### Grok Build sessions
- New source: walks `~/.grok/sessions/<urlencoded-cwd>/<uuid>/` and indexes each session's `summary.json` + `chat_history.jsonl` into the shared SQLite cache with `source='grok'`.
- **Skips `session_kind: "claude_import"` sessions** — grok-side duplicates of authentic claude sessions, which keep the original claude UUID but carry inferior fidelity (no token usage, no per-event timestamps). Indexing them would collide on the `session_id` PK with the canonical claude row, overwriting metadata and cascade-deleting topic classifications. The claude indexer is authoritative for these sessions.
- Sessions tree groups by source at the root: two nodes — **Claude Code** and **Grok Build** — each expanding to the existing day-bucket structure. Single-source environments collapse back to the flat layout so users on one CLI don't see a redundant wrapper.
- Grok tool_calls parsed from the assistant entries: `read_file`, `search_replace`, `write`, `run_terminal_command`, MCP tools, etc. all count toward the session's `tool_count`. File-edit paths from `search_replace.file_path` and `write.filePath` populate `projects_touched`.
- Classifier and search work source-agnostically against the merged corpus.
- New setting `coderSessions.grok.enabled` (default `true`) toggles grok discovery.

### Out of scope for v1.0 (deferred)
- Token usage / cost columns for grok (no per-turn token counts in `chat_history.jsonl`).
- Agent graph / Tasks for grok (no sub-agent spawn/end events).
- "Continue in Grok" resume action (no external `--resume` CLI flag).

See [specs/006-coder-rebrand-grok/spec.md](specs/006-coder-rebrand-grok/spec.md) for the full design.

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
