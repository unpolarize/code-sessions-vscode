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
5. Optionally package the .vsix locally for sanity install:

   ```bash
   npm run package
   code --install-extension code-sessions-X.Y.Z.vsix --force
   ```

   The user reloads their VS Code window to pick up the new build.

**Do not publish to the Marketplace from an agent session.** Publishing is a user-initiated step; the agent's job is to bump the version, update the changelog, and produce a clean .vsix.

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
- **Cache**: SQLite at `<globalStorage>/zhirafovod.code-sessions/sessions-cache.db`. Native `better-sqlite3` is replaced by a `node-sqlite3-wasm` shim ([`src/sqlite.ts`](src/sqlite.ts)) so the native ABI tracks VS Code's bundled Electron version.
- **Tree** (`src/extension.ts`): `SessionsProvider` builds the activity-bar tree. Day buckets aggregate per-day token + cost totals from `turn.input_tokens` / `turn.output_tokens` / `turn.cost_usd` (per-turn columns added in migrations v11 / v12).
- **Insights / trajectory views**: separate webviews (`src/insightsView.ts`, `src/trajectoryView.ts`).
- **Classifier**: topic classification runs lazily in the background (`src/backgroundClassifier.ts`) and feeds the search view.

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
