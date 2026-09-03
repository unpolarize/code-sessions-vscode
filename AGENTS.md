# AGENTS.md — Code Sessions

Instructions for AI coding agents (Claude Code, Grok, etc.) working in this repo.

## Version bumping — REQUIRED on every commit that ships code

**Every commit that touches any of `src/`, `package.json`, schema migrations, or any other file that ends up in the published `.vsix` MUST bump the version in [`package.json`](package.json) and add a matching entry to [`CHANGELOG.md`](CHANGELOG.md). No exceptions — including bug fixes, refactors, build tweaks, and dependency bumps.** The VS Code Marketplace gates installs on the version field; without a bump, `code --install-extension` silently keeps the old build even though the `.vsix` is new, and the user thinks the fix didn't ship. Doc-only changes that aren't in the package (e.g. agent-internal notes outside `README.md` / `CHANGELOG.md` / `AGENTS.md`) may skip the bump — when in doubt, bump.

The bumping rules — `MAJOR.MINOR.PATCH` (SemVer):

| Change kind | Bump | Example |
|---|---|---|
| Bug fix, internal refactor, docs, README, error-message wording, performance tweak | **PATCH** (`1.1.0 → 1.1.1`) | SQLite WASM OOM mitigation (drop `mmap_size`, cap `cache_size`); stillborn grok session filter v13 migration |
| New user-facing capability, new tree view, new command, new setting, new view-mode (insights / trajectory / agent-graph), new source / indexer | **MINOR** (`1.1.0 → 1.2.0`) | Per-day cost rollup in day-bucket header; topic classifier model upgrade |
| Breaking change: settings keys renamed, extension id changed, schema migration that older versions can't read back, drop of a public command id, removal of a tree-view kind | **MAJOR** (`1.x → 2.0.0`) | Rebrand `coder-sessions` → `code-sessions`; schema breaking change requiring a one-way migration |

**Workflow each commit:**

1. Update `"version"` in [`package.json`](package.json).
2. Prepend a `## X.Y.Z — YYYY-MM-DD` section to [`CHANGELOG.md`](CHANGELOG.md) summarising the change in 1–6 bullets. Schema migrations get explicit callouts (which `MIGRATIONS[]` index, what it does).
3. Run the build:

   ```bash
   npm run compile && npx tsc --noEmit
   ```

4. Stage `package.json`, `CHANGELOG.md`, and the code changes in the same commit.
5. **Ship (required after a landed feature):**

   ```bash
   npm run ship
   ```

   Compile + vsce package + `code --install-extension code-sessions-$version.vsix --force`.
   **Do not reload the working Code Build chat.** Verify in a **second window**. Host-trace: Output → **Code Sessions**; file `~/.sessions/.daemon/host-trace.ndjson` (`../architecture/tools/observability.md`).

6. **Browser-validate any webview UI change** (below). Vitest mini-DOM is not that pass.

**Do not publish to the Marketplace from an agent session.** Publishing is a user-initiated step; the agent's job is to bump the version, update the changelog, and produce a clean .vsix.

## Validate webviews in a browser — REQUIRED

Suite strategy: [`../architecture/tools/testing.md`](../architecture/tools/testing.md). Webviews only depend on `acquireVsCodeApi()` + `window.postMessage`. **Do not declare a Planning / conversation / insights / graph / canvas UI change done** after vitest alone (`test/unit/planningPipeline.test.ts` and friends prove parse + paint, not click/drag/layout).

A screenshot of first paint is **not** validation. Exercise the changed flow the way a user would (click, type, Shift/Ctrl-click, drag). If layout or CSS changed, check ~900px and ~560px. Hunt regressions on sibling views that share the same board renderer.

Playwright MCP or chrome-devtools MCP against a **local harness** — not `vscode-webview:` (those tools cannot drive the VS Code panel). Isolated Chrome is fine for the harness (no personal login). After ship, still confirm the real host in a **second VS Code window**.

### Planning Dashboard

Harness: [`test/webview/planning-harness.html`](test/webview/planning-harness.html) stubs `acquireVsCodeApi`, records `window.__sent`, injects a fixture snapshot, and loads [`media/planning-dashboard.js`](media/planning-dashboard.js) + [`media/planning-dashboard.css`](media/planning-dashboard.css) (same CSS the panel reads). Dashboard style edits go in that CSS file, not a TypeScript template.

```bash
cd ~/projects/unpolarize/code-sessions-vscode
python3 -m http.server 8765 --directory "$PWD"
# Playwright / chrome-devtools: open
#   http://127.0.0.1:8765/test/webview/planning-harness.html
```

Then:

1. Confirm lanes paint (no overlay stuck on “Loading planning store”). Console must be clean of script errors.
2. Click **🚀 Pipeline**. Confirm inbox / approved / implementation / done, the **route** selects, and **☑** on a lane header.
3. Drive the flow you changed. Examples: Ctrl-click two cards → drag to another lane → `window.__sent` has `pipelineMove` with `ids` and `route`. Change provider/model/effort → `setImplPrefs`.
4. Inspect `window.__sent` in the console (host messages). Inspect `window.__host.post({type:'setView', view:'board'})` to jump views without the top bar.
5. Narrow the viewport if CSS/layout changed.

Do not skip this because “the unit tests passed.”

### Other CSV webviews

Same pattern if you touch them: stub `acquireVsCodeApi`, serve the HTML+JS, Playwright-click the new control, assert `__sent`. Surfaces: conversation viewer, insights, trajectory, agent graph, canvas (`src/conversationView.ts`, `insightsView.ts`, `trajectoryView.ts`, `agentGraph.ts`, `planningCanvas.ts`).

## Repo conventions

- **No `Co-Authored-By` trailers** in commit messages.
- **Don't commit unless asked** — staging is fine; commit only on a "save" command from the user.
- **Commit style** matches the existing log: `code-sessions: <short summary>` for code; `tree: …` for tree-view-specific changes; `notes: …` / `docs: …` for non-code changes.
- **Always push** after committing (part of the "save" flow).
- TypeScript strict mode is on. Run `npx tsc --noEmit` before any commit that touches `.ts`.
- Source builds via `tsc -p ./` (`npm run compile`). Package via `npm run package` (compile + `vsce package`).

## Schema migrations — IMPORTANT

Migrations live in `MIGRATIONS[]` in [`src/db.ts`](src/db.ts) and are applied in order via `PRAGMA user_version`. Each new migration **must**:

1. Append to the end of the array (never reorder).
2. Be idempotent against partial-failure replay (use `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE ADD COLUMN` with safe defaults, etc.).
3. Avoid heavy `DELETE … WHERE … IN (SELECT …)` subqueries on the WASM build — `node-sqlite3-wasm` runs on a bounded Emscripten linear-memory heap and can throw `SQLITE_NOMEM` when temp results spill. Chunk into batches or pre-materialise the subquery into a `CREATE TEMP TABLE` of session ids.
4. Carry an in-code comment explaining what the migration does **and why** — these can't be re-derived from the SQL alone after the fact.

## Architecture cheat-sheet

- **Sources**: `~/.claude/projects/<dash-encoded-cwd>/<uuid>.jsonl` and `~/.grok/sessions/<urlencoded-cwd>/<uuid>/chat_history.jsonl`. Indexers parse these into `SessionRow` / `TurnRow` shapes (`src/jsonlIndexer.ts`, `src/grokIndexer.ts`).
- **Cache**: SQLite at `<globalStorage>/<publisher>.code-sessions/sessions-cache.db` (the `<publisher>.code-sessions` segment is the extension id from `package.json`). Native `better-sqlite3` is replaced by a `node-sqlite3-wasm` shim ([`src/sqlite.ts`](src/sqlite.ts)) so the native ABI tracks VS Code's bundled Electron version.
- **Tree** (`src/extension.ts`): `SessionsProvider` builds the activity-bar tree. Day buckets aggregate per-day token + cost totals from `turn.input_tokens` / `turn.output_tokens` / `turn.cost_usd` (per-turn columns added in migrations v11 / v12).
- **Insights / trajectory views**: separate webviews (`src/insightsView.ts`, `src/trajectoryView.ts`).
- **Classifier**: topic classification runs lazily in the background (`src/backgroundClassifier.ts`) and feeds the search view.
- **Direction**: the in-extension indexers + wasm cache are slated to be replaced by queries to the CS daemon (see suite architecture below). Do not add new synchronous indexing on the extension-host thread.

## Suite architecture (private repo — read before cross-component work)

Suite-level design (CS · CSV · CB · KP), target architecture, performance tracking table, testing
strategy and the cross-project issues table live in the **private** `unpolarize/architecture` repo,
cloned next to this one at `../architecture` (symlink: [`docs/suite-architecture`](docs/suite-architecture)).
Private by design — link by path, never copy its content into this public repo.

- Before changes touching indexers, the cache, git sync, or CB/KP command contracts: read `tools/target.md` and follow `WORKFLOW.md` there.
- Bugs: claim your row in `tools/issues.md` before starting; perf work: claim the row in `tools/performance.md` and record before → after numbers.
- Repo-local internals: [`docs/architecture.md`](docs/architecture.md), on-disk formats: [`docs/DATA-STORES.md`](docs/DATA-STORES.md).

## Publishing checklist (user-driven)

When the user is ready to publish a new version to the VS Code Marketplace:

1. Confirm `package.json` `version` matches the latest entry in `CHANGELOG.md`.
2. Confirm `README.md` reflects the current feature surface.
3. Run a clean package:

   ```bash
   rm -f code-sessions-*.vsix
   npm run package
   ```

4. The user uploads the resulting `.vsix` via the Marketplace publisher page (`https://marketplace.visualstudio.com/manage/publishers/zhirafovod`). Agents do not perform this step.
5. After upload, the user verifies the listing, then tells the agent to tag the release in git (optional).
