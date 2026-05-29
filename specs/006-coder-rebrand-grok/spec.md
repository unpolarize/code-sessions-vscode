# Feature Specification: Coder rebrand + Grok Build session support

**Feature**: `006-coder-rebrand-grok`  
**Created**: 2026-05-28  
**Status**: Draft — ships as v1.0.0 (breaking)

## Why this spec

Two changes that travel together because they share the same surface area:

1. **Rebrand `claude-sessions` → `coder-sessions`.** The repo was renamed on GitHub to `zhirafovod/coder-sessions-vscode`. The extension's value isn't Claude-specific — it's a central sidebar for *any* coding-agent CLI's session history. Keeping `claude*` in command ids, view ids, settings keys, and the marketplace listing locks the brand to one vendor and makes it awkward to surface other tools.
2. **Add Grok Build as a second source.** The user runs both Claude Code and xAI's Grok Build CLI (companion to [phuryn/grok-build-vscode](https://github.com/phuryn/grok-build-vscode)). Today every grok session is invisible to this extension. Once the rename lands, adding a second `CoderSource` implementation against `~/.grok/sessions/` gives a unified "what coder did what work where" view.

The rebrand is a clean break for *configuration* (extension id, command ids, view ids, settings keys) — existing users reconfigure their settings once. **But** the SQLite session/topic/embedding cache migrates in-place from the old extension's global-storage directory (`<globalStorage>/zhirafovod.claude-sessions/sessions-cache.db`) to the new one (`<globalStorage>/zhirafovod.coder-sessions/sessions-cache.db`) on first activation, so the user keeps their topic-classification work and doesn't trigger a long reclassification pass.

## User Scenarios

### US-1 — Discover and list Grok Build sessions alongside Claude (Priority: P1)

As a user who runs both Claude Code and Grok Build, I want both tools' sessions to appear in the same Sessions sidebar, grouped by source, so I can scan across both without switching extensions.

**Acceptance**:

- The Sessions tree has two top-level nodes: **Claude Code** and **Grok Build**.
- A source node is hidden when its data directory (`~/.claude/projects/` or `~/.grok/sessions/`) doesn't exist on the machine.
- Each source node expands to per-project subtrees, then per-session leaves (same layout as today's claude-only tree).
- A grok session leaf shows: title (from `summary.json.generated_title || session_summary || session id`), model id (`current_model_id`), message count (`num_messages`), and updated-at relative time.
- A claude session leaf retains all current columns (tokens, cost, subagents, topic).
- Clicking a grok session leaf opens its `chat_history.jsonl` in an editor; clicking a claude session leaf behaves as today.

### US-2 — Topic classifier runs on both sources (Priority: P1)

As a user, I want the background topic classifier to discover topics in grok sessions too, so the topic columns and topic overview panel make sense across both tools.

**Acceptance**:

- The background classifier discovers unclassified grok sessions on the same schedule it discovers claude ones.
- Grok session text input to the classifier is the concatenation of `user_message` and `assistant_message` events from `chat_history.jsonl` (system prompts skipped — they dominate text but carry no per-session signal).
- The classifier's output column shape stays identical (one topic + confidence per session).
- The status bar daemon tile shows the same `Live · classifying N / paused / N failed` shape regardless of source mix.

### US-3 — Live monitor surfaces the active grok session (Priority: P2)

As a user who just typed something into Grok Build, I want the Live monitor to show that grok session as active alongside any active claude session.

**Acceptance**:

- Live monitor card shows: source badge (CC / GR), session title, project basename, elapsed since first message, message count, and a status line.
- Grok status line can show `in tool: search_replace` / `in tool: read_file` / etc. — driven by the most recent `assistant.tool_calls[].name` in `chat_history.jsonl`. If the last event was a plain assistant message it shows `responding`; if a user message it shows `user typed`.
- "Active" detection threshold (mtime < 2 min) is the same per source.
- Cost / tools-per-min running totals at the top of the panel are claude-only and labelled as such ("Claude · N active · T tools/min · $X today"). Grok lacks token-usage telemetry in `chat_history.jsonl`, so it gets a second line "Grok · N active · T tools/min" (no cost).

### US-4 — Search hits both sources (Priority: P2)

As a user, I want to search transcripts and have grok hits appear in the same result list as claude hits.

**Acceptance**:

- The full-text search panel queries both sources' user/assistant message text.
- Each result row is source-tagged (CC / GR) so the user can see at a glance which tool produced it.
- Filtering by source is available (chip toggles `CC` / `GR`).

### US-5 — KB-changes and Projects-activity include grok contributions (Priority: P2)

As a user, I want file-write activity from grok sessions to roll up into the per-day KB-changes and per-project Projects-activity views, so a "what changed today" question doesn't silently miss work done in grok.

**Acceptance**:

- KB-changes view aggregates file edits from grok sessions in the configured KB repo (`coderSessions.repoPath`), same as it does for claude. Source badge on each row identifies origin.
- Projects-activity view does the same for non-KB workspaces.
- File-edit detection for grok parses `chat_history.jsonl` for `assistant.tool_calls[].name in {"search_replace","write"}` and extracts the path from `arguments` (note: `search_replace` uses `file_path`, `write` uses `filePath` — both must be handled).
- `read_file` is NOT counted as a change (read-only).

### US-6 — Source-agnostic UI degrades gracefully where data is missing (Priority: P3)

As a user opening Agent graph or Tasks against a grok session, I want a clear empty state rather than a crash or misleading blanks.

**Acceptance**:

- Agent graph opened on a grok session: empty state reads "Agent graph requires sub-agent telemetry; Grok Build sessions don't record sub-agent spawn/end events."
- Tasks view: source filter chip `CC` is pre-selected by default; if user toggles to `GR`, view shows "Tasks (sub-agents / scheduled routines) is Claude-specific."

### US-7 — Rebrand: settings reconfigured, DB migrates (Priority: P1)

As an existing user upgrading past v0.14.x, I expect to install the new VSIX once, see the activity bar icon under a new name, reconfigure my settings keys once (one-time effort), and keep all my existing session index + topic classifications so I don't trigger a long reclassification pass.

**Acceptance**:

- VSIX name `coder-sessions-1.0.0.vsix` builds and installs.
- Activity bar entry: "Coder Activity" with the same chat-discussion icon.
- View IDs: `coderSessions`, `coderKbChanges`, `coderProjectsActivity`, `coderTasks`.
- Command palette: every command's `category` is "Coder Sessions"; every command id is `coderSessions.*`.
- Settings: every key under `claudeSessions.*` becomes `coderSessions.*`. Old setting values do **not** migrate — the user reconfigures `coderSessions.repoPath`, `coderSessions.modelEndpoint`, etc. once. README documents the rename and the one-time reconfigure step.
- **DB migrates** at extension activation. The DB lives inside `vscode.ExtensionContext.globalStorageUri` (`.../globalStorage/<publisher>.<name>/sessions-cache.db`):
  - If `<globalStorage>/zhirafovod.coder-sessions/sessions-cache.db` already exists → no-op (idempotent).
  - Else if a sibling `<globalStorage>/zhirafovod.claude-sessions/sessions-cache.db` exists → `fs.copyFile` to the new path, run schema migration v7 (`ALTER TABLE session ADD COLUMN source TEXT NOT NULL DEFAULT 'claude'`). Topic, embedding, star, batch tables come along untouched.
  - Else (fresh install) → create empty DB at the new path with full schema (including new `source` column).
  - The sibling-dir probe uses `path.join(path.dirname(globalStorageDir), "zhirafovod.claude-sessions")` so it works on Code, Code-Insiders, Cursor, VSCodium — anywhere globalStorage groups extension dirs together.
  - Old DB is left in place untouched.
  - On migration, log to extension output channel and show a one-shot info toast: *"Imported N sessions and M topic classifications from your previous Claude Sessions install."*
- VS Code globalState keys for classifier (`claudeSessions.classifier.paused` / `.failedIds`) **do not migrate** — VS Code doesn't expose another extension's globalState. The classifier starts in its default "not paused, no failures" state on first run. This is acceptable: it's small state that recovers naturally as the daemon scans existing classified sessions and skips them.
- README and CHANGELOG explain the rebrand + DB migration. CHANGELOG v1.0.0 entry lists "renamed all ids / settings, added Grok Build source, migrated DB and classifier state to new path."
- Old `claude-sessions-*.vsix` artifacts removed from the repo. Going forward only `coder-sessions-*.vsix` is committed (or none — preferable to keep the repo small).

## Out of scope (v1.0.0)

These were considered and explicitly deferred. The brainstorming spike that fed this spec verified the underlying constraints; revisit only if those constraints change.

- **Agent graph for grok.** Grok records frontend tool calls but no sub-agent spawn/end events; the existing graph view depends on the latter for lane layout.
- **Tasks (sub-agents / scheduled routines) for grok.** Grok has no equivalent telemetry; `todo_write` is a per-session local list, not the cross-session sub-agent dispatch concept this view surfaces.
- **Token usage / cost for grok.** `chat_history.jsonl` carries no per-turn token counts. Cost columns and the daily-cost rollup stay claude-only.
- **"Continue in Grok" resume action.** The `grok` CLI has session history (the grok-build-vscode extension uses it), but no documented external `--resume <id>` flag. Until that exists or we can call into the grok-build-vscode extension's command palette, the grok session row shows "Open transcript" only.
- **Multi-source classifier model differences.** Same model and prompt run against both sources' message text. If grok-specific clustering proves valuable later it becomes its own spec.

## Architecture

### Source adapter at the boundary

Today's `src/jsonlIndexer.ts` knows the Claude JSONL shape. We extract that into a `CoderSource` interface that abstracts only the format-divergent parts: filesystem layout, parsing, and live-tail. Everything past the adapter — DB schema, classifier, full-text index, status bar, views — runs on a normalised event stream.

```ts
// src/coderSessions/types.ts
export type CoderSourceId = 'claude' | 'grok';

export interface CoderSession {
  source: CoderSourceId;
  id: string;               // uuid (claude: filename stem; grok: folder name)
  cwd: string;              // decoded absolute path
  startedAt: number;        // ms epoch
  updatedAt: number;
  modelId?: string;
  title?: string;           // grok: generated_title; claude: derived from first user msg
  numMessages: number;
  rawPath: string;          // for opening transcript
}

export type CoderEvent =
  | { kind: 'user_message';      text: string; ts: number }
  | { kind: 'assistant_message'; text: string; ts: number; modelId?: string }
  | { kind: 'tool_use';          tool: string; ts: number }                 // claude + grok
  | { kind: 'file_edit';         path: string; ts: number }                 // claude + grok
  | { kind: 'subagent_start';    name: string; ts: number }                 // claude only
  | { kind: 'subagent_end';      name: string; ts: number }                 // claude only
  | { kind: 'token_usage';       input: number; output: number; ts: number }; // claude only

export interface CoderSource {
  readonly id: CoderSourceId;
  readonly displayName: string;            // "Claude Code" / "Grok Build"
  isAvailable(): Promise<boolean>;
  listSessions(): AsyncIterable<CoderSession>;
  readEvents(s: CoderSession): AsyncIterable<CoderEvent>;
  watchLive(s: CoderSession, signal: AbortSignal): AsyncIterable<CoderEvent>;
  resumeCommand(s: CoderSession): { command: string; args: string[] } | null;
}
```

Downstream consumers only depend on `CoderSession` and `CoderEvent`. The kinds that grok cannot emit (`tool_use`, `file_edit`, `subagent_*`, `token_usage`) become natural empty states for the views that depend on them — no special-casing in view code.

### Directory layout

```
src/
  coderSessions/
    types.ts            // interface + event union (above)
    registry.ts         // enumerates available sources at activation; hot-reloads on dir creation
    claudeSource.ts     // ports current src/jsonlIndexer.ts logic verbatim, behaviour-preserving
    grokSource.ts       // new
  extension.ts          // command/view ids renamed; instantiates registry; passes sources into views
  db.ts                 // DB at ~/.coder-sessions/sessions.sqlite (migrated from ~/.claude-sessions/ on first run); adds `source TEXT NOT NULL`
  backgroundClassifier.ts // consumes registry, source-agnostic
  liveMonitor.ts        // accepts registry, renders per-source cards
  searchView.ts         // indexes from registry
  insightsView.ts       // claude-only in v1 (depends on token_usage); shows empty state for grok
  agentGraph.ts         // claude-only in v1 (depends on subagent_start/end); shows empty state for grok
  trajectoryView.ts     // claude-only in v1 (initial scope); grok-capable in a future iteration
  conversationView.ts   // source-aware: renders tool_use rows for both; subagent lanes for claude only
```

### Claude source

`claudeSource.ts` is a behaviour-preserving extraction of `jsonlIndexer.ts` + the relevant parts of `conversationParser.ts`. No format changes. `resumeCommand` returns `{ command: 'claude', args: ['--resume', s.id, '--cwd', s.cwd] }`.

### Grok source

- `listSessions()`: scans `~/.grok/sessions/<urlencoded-cwd>/*/summary.json`. URL-decodes the parent folder name to get `cwd`. Pulls `id`, `created_at`, `updated_at` (falls back to `last_active_at`), `current_model_id`, `generated_title || session_summary`, `num_chat_messages`. `rawPath` = the session folder. (Note: grok partitions by cwd; claude partitions by cwd flattened-with-dashes. The two implementations differ only at the directory layer.)
- `readEvents()`: streams `chat_history.jsonl` line by line. Maps:
  - `{type:"user", content:[{type:"text",text}]}` → `user_message`
  - `{type:"assistant", content:string, model_id, tool_calls?}` →
    - `assistant_message` if `content` non-empty
    - one `tool_use` event per entry in `tool_calls[]` (`tool = tc.name`)
    - one `file_edit` event for each `tool_calls[]` entry whose `name` is `search_replace` (path = `JSON.parse(arguments).file_path`) or `write` (path = `JSON.parse(arguments).filePath`)
    - `read_file` / `list_dir` / `grep` produce a `tool_use` but no `file_edit` (reads only)
  - `{type:"system"}` → ignored (system prompt; dominates text but carries no per-session signal)
  - `{type:"backend_tool_call"}` (e.g. `web_search`) → ignored in v1; surface only frontend tool calls which are the editor-side activity the user cares about
  - `{type:"tool_result"}` → ignored in v1 (no consumer needs the body; if we later want "Bash output" lanes we add it then)
- `arguments` parsing: the field is a JSON-encoded string. Wrap `JSON.parse` in try/catch; on parse failure emit the `tool_use` but skip the `file_edit`.
- Timestamps: `chat_history.jsonl` events don't carry per-event timestamps (verified across multiple sessions — keys are `content,model_fingerprint,model_id,reasoning,tool_calls,type` only). Use `summary.json.created_at` as session base; line ordinal index (1, 2, 3, ...) gives monotonic ts within the session. Useful for ordering, not for cross-session correlation. If a per-event ts field appears in a later grok release, switch to it.
- `watchLive()`: tails `chat_history.jsonl` via `fs.watch` debounced to 500ms; re-reads from last-known byte offset.
- `resumeCommand()`: returns `null` in v1 (no external resume CLI).

### Registry

`registry.ts` instantiates both sources, calls `isAvailable()` on each, exposes a `getActiveSources(): CoderSource[]` and a per-id lookup. Views iterate `getActiveSources()` to populate.

### DB schema and migration

Single-table change to `sessions`: add `source TEXT NOT NULL DEFAULT 'claude'`. New column also: `raw_path TEXT NOT NULL` (replaces any path field that today implicitly assumed claude layout — backfilled from existing path-like columns during migration).

**Migration flow** on first activation (`db.ts:openDatabase()`):

1. If `~/.coder-sessions/sessions.sqlite` exists → open it. Done.
2. Else if `~/.claude-sessions/sessions.sqlite` exists:
   - `mkdir -p ~/.coder-sessions`
   - `fs.copyFile(~/.claude-sessions/sessions.sqlite, ~/.coder-sessions/sessions.sqlite)`
   - Open the new copy.
   - Run idempotent `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (SQLite doesn't actually support `IF NOT EXISTS` on ADD COLUMN — use a `PRAGMA table_info(sessions)` probe and add the column only if missing).
   - For each existing session row, default `source='claude'` (the new column default handles new inserts; existing rows are backfilled by the column default automatically since we used `DEFAULT 'claude'`).
   - Count migrated rows (`SELECT COUNT(*) FROM sessions`) and topic-classified rows (`SELECT COUNT(*) FROM sessions WHERE topic IS NOT NULL`) for the toast.
3. Else (fresh install) → `mkdir -p ~/.coder-sessions`, create empty DB with new schema.
4. Migrate VS Code global-state classifier keys (`claudeSessions.classifier.paused` / `claudeSessions.classifier.failedIds`) → `coderSessions.classifier.*` if the new keys are unset and the old keys are set. Read old, write new, `update(old, undefined)` to clear. One-shot.

Migration is a one-time event guarded by the existence of the new DB file. No version flag needed.

### Rename mechanics

- `package.json`:
  - `name`: `claude-sessions` → `coder-sessions`
  - `displayName`: `Claude Sessions` → `Coder Sessions`
  - `description`: rewrite, name both Claude Code and Grok Build
  - `repository.url`: `claude-sessions-vscode.git` → `coder-sessions-vscode.git`
  - `activationEvents`: `onView:claudeSessions` → `onView:coderSessions`, etc.
  - `viewsContainers.activitybar[0].id`: `claude-activity` → `coder-activity`; title: `Claude Activity` → `Coder Activity`
  - `views['coder-activity']`: view ids `claudeSessions` → `coderSessions`, etc. `contextualTitle`s rewritten to drop "Claude" where they meant the tool generically (e.g. "Claude Sub-agents" stays — it's literally claude-specific — but "Per-project file changes" needs no rename).
  - `contributes.commands[*].command`: every `claudeSessions.*` → `coderSessions.*`. Categories `Claude` → `Coder`.
  - `contributes.configuration.properties`: every `claudeSessions.*` key → `coderSessions.*`.
- `src/`: project-wide rename of identifiers:
  - `claudeSessions.*` command/view id strings → `coderSessions.*`
  - VS Code context keys (`when` clauses) renamed accordingly
  - Internal variable names like `claudeSession` → `coderSession` *only* where the variable holds a generic session (i.e. one from either source); names that genuinely refer to Claude-specifics (e.g. inside `claudeSource.ts`) keep `claude` in the name as documentation.
- `scripts/install.sh`: paths to vsix file renamed.
- `README.md`, `CHANGELOG.md`: rewrite intro paragraph; CHANGELOG gets a v1.0.0 entry capturing the breaking change and grok support.
- Delete `claude-sessions-*.vsix` artifacts from the repo.
- `package.json` version bumps to `1.0.0`.

### Grok-build-vscode dependency

This extension does **not** depend on `grok-build-vscode` being installed. It only reads `~/.grok/sessions/`, which the `grok` CLI populates whether or not the editor extension is installed. README should mention this so users understand the two extensions are independent — but complementary.

## Data flow

```
~/.claude/projects/...jsonl     ~/.grok/sessions/.../chat_history.jsonl
       │                                 │
       ▼                                 ▼
ClaudeSource.listSessions()      GrokSource.listSessions()
ClaudeSource.readEvents()        GrokSource.readEvents()
       │                                 │
       └──────────► CoderSource ◄────────┘
                       │
                       ▼
                  registry.getActiveSources()
                       │
        ┌──────────────┼──────────────┬──────────────┐
        ▼              ▼              ▼              ▼
  Sessions tree   Classifier    Live monitor    Search index
  (grouped by   (DB upsert     (per-source     (FTS over text
   source node)  with source    cards)          events; source
                 column)                         column for filter)
```

## Error handling

- `~/.claude` or `~/.grok` missing: `isAvailable()` returns `false`; source absent from registry; corresponding top-level node hidden.
- `summary.json` malformed: log to extension output channel, skip session, continue.
- `chat_history.jsonl` line malformed: skip line, continue (existing claude parser already does this).
- DB at `~/.coder-sessions/sessions.sqlite` missing/corrupt on first run: create fresh.
- A source throwing in `listSessions()` must not crash discovery of the other.

## Testing

- **Fixtures** (committed to `test/fixtures/`):
  - `claude/projects/-fixture-cwd/aaaa-aaaa.jsonl` — 5-line claude jsonl covering user/assistant/tool_use/file_edit/subagent
  - `grok/sessions/%2Ffixture%2Fcwd/bbbb-bbbb/summary.json` + `chat_history.jsonl` — 5-line grok jsonl covering user/assistant/system/backend_tool_call/tool_result
- **Unit**:
  - `claudeSource.readEvents` against fixture produces expected `CoderEvent[]`
  - `grokSource.readEvents` produces `user_message`, `assistant_message`, `tool_use` per `tool_calls[]` entry, and `file_edit` for `search_replace` / `write` (with correct path extracted from JSON-encoded arguments)
  - `grokSource.readEvents` skips `system`, `backend_tool_call`, `tool_result`
  - `grokSource.readEvents` tolerates malformed `arguments` JSON (still emits `tool_use`, skips `file_edit`)
  - `grokSource.listSessions` URL-decodes the cwd folder back to `/fixture/cwd`
  - Registry hides a source when its data dir is absent
- **Smoke (manual)**:
  - Build VSIX, install in fresh window
  - Confirm both source nodes appear, with sessions discovered from the live `~/.claude` and `~/.grok` dirs
  - Trigger a classifier run; confirm topics appear on grok sessions
  - Open KB-changes view; confirm grok file-edit rows appear with GR badge alongside CC rows
  - Open agent-graph against a grok session; confirm empty-state copy
  - Open a grok session leaf; confirm `chat_history.jsonl` opens
  - Trigger Live monitor with an in-flight grok session and confirm `in tool: <name>` reflects the most recent `tool_calls[]` entry

## Success criteria

- All v0.14.2 functionality works against claude sessions after the rename (behaviour-preserving extraction of `jsonlIndexer.ts`).
- Grok sessions visible in Sessions tree, clbuilassified, searchable, and surfaced in the Live monitor.
- No leftover `claudeSessions.*` strings outside `specs/` (historic specs keep their original names) and `claudeSource.ts` (where `claude` is meaningful).
- README and CHANGELOG explain the rename + grok addition.
- VSIX builds clean and activates without errors in a fresh VS Code window with no prior `~/.coder-sessions/` state.
