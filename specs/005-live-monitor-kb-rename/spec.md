# Feature Specification: Live monitor + dynamic project-changes view title

**Feature**: `005-live-monitor-kb-rename`
**Created**: 2026-05-20
**Status**: In progress (ships as v0.11.0)

## Why this spec

Two small but valuable additions:

1. **Live monitor.** The Sessions tree shows session state at the last refresh — to see what's happening *right now* the user has to mentally diff against the previous read. A dedicated, auto-refreshing dashboard is the right surface for "what is Claude doing across all my windows in the last minute".
2. **Dynamic project-changes view title.** The current "KB changes" name is hardcoded but the underlying `claudeKbChanges.repoPath` points to `~/docs` for this user. Renaming the view to the basename of that path (`docs changes`) makes it self-documenting — clearer than a generic abbreviation, and adapts automatically if the user points the setting at a different repo (e.g. `~/notes` → "notes changes").

## User Scenarios

### US-1 — See active Claude sessions at a glance (Priority: P1)

As a user with one or more Claude Code sessions running across different windows/projects, I want a Live monitor that shows what each active session is currently doing — without me having to click into each one.

**Acceptance**:
- New title-bar button on the Sessions view → opens a **Live monitor** webview.
- The webview shows one card per session whose JSONL has been modified in the last 2 minutes.
- Each card displays: title, project, elapsed session time, message count, tool count, subagent count, cost so far, and a "now" status line (e.g. `in tool: Bash`, `responding`, `idle`).
- Status updates every 2 s while the webview is visible. No update when hidden.
- Empty state: "No active sessions in the last 2 minutes."

### US-2 — Title-bar status line shows running totals (Priority: P2)

The top of the Live monitor shows a small running summary: `N active · T tools/min · $X spent today`. Makes the panel useful as an ambient indicator.

**Acceptance**:
- `N` = count of cards visible.
- `T tools/min` = tools observed across all active sessions in the last 60 s.
- `$X spent today` = sum of `cost_usd` for all sessions whose `started_at` is in the current calendar day.

### US-3 — KB Changes view shows the actual project name (Priority: P2)

When the configured `claudeKbChanges.repoPath` is `~/docs`, the sidebar header says **"docs changes"** rather than the generic "KB changes". When the user repoints to `~/notes`, the title updates to **"notes changes"** without reload.

**Acceptance**:
- Initial activation: view title = `${basename(repoPath)} changes`.
- Changing the setting in VS Code Settings → title updates within the same window.
- If `repoPath` is unset/empty, fall back to the original "KB changes" string.

## Functional Requirements

### FR-1 — Live monitor module

New file `src/liveMonitor.ts` exports `openLiveMonitor(ctx, store)`:
- Creates a webview panel.
- On a `setInterval` (2 s), queries `store.listRecent(50, true)`, filters where `(now - mtime_ns / 1e6) < 120_000`, builds card data, posts `{ command: 'update', cards }` to the webview.
- Webview script re-renders cards in place (no full HTML replace) to avoid flicker.

### FR-2 — Per-session "now" status

For each active session, tail-read its JSONL (last ~8 KB) and look at the most recent event:
- If an open `tool_use` (no matching `tool_result` yet) → status = `in tool: <name>`.
- Else if assistant message in the last 30 s → status = `responding`.
- Else → status = `idle (last activity Ns ago)`.

The tail is a `fs.readSync` for the last 8 KB; cheap enough at 2 Hz across a handful of files.

### FR-3 — Top summary bar

Reuses the per-card data already computed:
- Count of cards.
- Tool count over the last 60 s = sum of tools whose timestamp ≥ now-60 s (tail-parsed).
- Cost today = `SELECT SUM(cost_usd) FROM session WHERE started_at >= floor(now to day start)`.

### FR-4 — Lifecycle

- Stops polling when `panel.onDidChangeViewState` reports `visible = false`. Resumes on `visible = true`.
- Disposes the interval on `panel.onDidDispose`.

### FR-5 — Command + button

- Command: `claudeSessions.openLiveMonitor` ("Open live monitor").
- Title-bar button on `view == claudeSessions`, group `navigation@2` (between Insights and the agent graph), icon `$(pulse)`.

### FR-6 — Dynamic KB-changes view title

- `KbChangesProvider` becomes the data source for a `vscode.TreeView` (instead of using `registerTreeDataProvider`), so the title is mutable.
- On activation and on `onDidChangeConfiguration("claudeKbChanges.repoPath")`, the title is recomputed as `${basename(expandHome(repoPath))} changes`. Falls back to `"KB changes"` if the path is empty.
- `contextualTitle` and `description` keep pointing to the basename too, for full self-documentation.

## Success Criteria

- **SC-1**: Opening the live monitor with 0 active sessions shows the empty state within 200 ms and never spins the CPU.
- **SC-2**: With one active session running, the monitor reflects new tool calls within 4 s (≤ 2 polls).
- **SC-3**: Switching `claudeKbChanges.repoPath` from `~/docs` to `~/notes` updates the view header to `"notes changes"` without window reload.

## Out of scope

- Push-based updates (would require a JSONL watcher per file + diffing). 2 s polling is good enough for a feel-real-time UX without the bookkeeping.
- Per-window distinction (we don't know which VS Code window each session belongs to).
- Recording history beyond what's already in the SQLite cache.
