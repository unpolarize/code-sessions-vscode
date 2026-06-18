# Feature Specification: Mixed-source buckets, manage (hide/rename), toggle, dual-resume

**Feature**: `007-mixed-buckets-manage-resume-toggle`
**Created**: 2026-06-05
**Status**: Draft — ships as v1.1.0

## Why this spec

Four small Sessions-view improvements gathered into one feature because they all touch `SessionsProvider` / `SessionItem` / the `codeSessions.resume` dispatch:

1. **Drop the source-wrapper, keep the day buckets.** Claude and Grok rows interleave inside each day bucket (`Today`, `Yesterday`, `Last 7 days`, `Older`) with a per-row source indicator so the user can scan "what happened today" without expanding two separate trees.
2. **Manage sessions — soft-hide + rename.** Hide buries dud sessions out of sight (a global toggle un-buries them); rename writes the new title to the on-disk source-of-truth so the native CLI's resume picker shows it too.
3. **Toggle keybinding.** `Cmd+Ctrl+Shift+C` (mac) / `Ctrl+Alt+Shift+C` (win/linux) — if the Code Sessions side bar is visible, close it; otherwise reveal the Code Sessions container and focus the Sessions tree.
4. **Both resume targets always visible.** The expanded session row shows `▶ Open in Code Build` AND `▶ Open in native` side-by-side so the user can pick at click-time without flipping the global `resumeBackend` setting.

## User Scenarios

### US-1 — Mixed-source day buckets (Priority: P1)

As a user with both Claude and Grok sessions today, I want them in the same `Today` bucket interleaved by time, with a visible source marker on each row.

**Acceptance**:

- Sessions root renders day buckets directly (`SourceBucketItem` is no longer emitted).
- Each `BucketItem` contains both Claude and Grok rows sorted by `mtime_epoch` desc, regardless of source.
- Each `SessionItem` carries a source marker:
  - Label prefix: `[C]` for Claude, `[G]` for Grok, placed BEFORE the fixed-width ago column so the marker lines up like the time does.
  - `iconPath` continues to express state (starred / automated / active / default).
- Day-bucket header counts and totals (`💬 cost·tokens·subagents`) sum across both sources.
- Single-source environments (only Claude installed, or only Grok) just see one-letter prefixes that are always the same — no visual cost.
- The `codeSessions.filterByCurrentWorkspace` setting continues to apply per row across both sources.
- The "N automated/cron sessions hidden" tip and the "Filtered to X" tip still render at the top of the root level (formerly per-source-bucket).

### US-2 — Soft-hide a session (Priority: P1)

As a user with a noisy SDK or test session I never want to see again, I want to hide it from the Sessions tree without deleting any data on disk.

**Acceptance**:

- Right-click any session row → `Hide session`. The row disappears from the tree on the next refresh; the JSONL on disk is untouched.
- New setting `codeSessions.showHidden` (default `false`). When `true`:
  - Hidden rows reappear in their normal bucket position with a `$(eye-closed)` icon override.
  - Right-click on a hidden row offers `Unhide session`.
- The hidden state survives DB merges, refreshes, and extension reinstalls (stored in a new `session_hide` table keyed by `session_id`).
- Hidden rows are excluded from day-bucket count/total aggregates when `showHidden=false`.
- Starred + hidden is a legitimate state; the row is hidden but the star survives.

### US-3 — Rename a session (Priority: P1)

As a user who has a more meaningful name for a session than what the auto-classifier picked, I want to rename it AND have that name show up next time I run `claude --resume` from the terminal.

**Acceptance**:

- Right-click any session row → `Rename session…`. An `InputBox` opens prefilled with the current title.
- On submit (non-empty, different from current):
  - **Claude rows:** the helper locates the JSONL via `locateSessionJsonl(sessionId)`, finds any existing `{"type":"ai-title", "aiTitle":"..."}` line, and replaces `aiTitle` with the new value. If no such line exists it is prepended at the top of the file. Writes go through `fs.writeFile(tmp, ...) + fs.renameSync(tmp, target)` so a crash mid-write doesn't corrupt the JSONL.
  - **Grok rows:** the helper resolves the session directory via `path.dirname(row.jsonl_path)`, reads `summary.json`, sets `generated_title` (and `session_summary` if present) to the new value, writes back atomically.
- After the file write, the extension re-indexes the affected session (or its source's force-recent path) so the cache picks up the new title; the tree refreshes.
- On submit empty, the rename is canceled (no-op). No "clear title" semantics — the only way to revert is to enter the original text.
- If the source file is missing, read-only, or malformed, an error toast surfaces and the cache is untouched.
- The native CLI sees the new title on its next `--resume` pick (Claude's resume reads `aiTitle`; Grok Build's session list reads `summary.json`).

### US-4 — Toggle keybinding (Priority: P2)

As a user who wants quick access to the Sessions side bar, I want a keyboard shortcut that hides it when visible and reveals + focuses it when not.

**Acceptance**:

- New command `codeSessions.toggleActivityView` bound to `cmd+ctrl+shift+c` (mac) and `ctrl+alt+shift+c` (win/linux). The existing `codeSessions.focusActivityView` binding (`cmd+alt+c` / `ctrl+alt+c`) stays unchanged.
- Behavior:
  - If the Sessions `TreeView.visible` is `true` → run `workbench.action.closeSidebar`.
  - Else → run `workbench.view.extension.code-activity` to reveal the container, then focus the Sessions tree.
- Requires converting `vscode.window.registerTreeDataProvider("codeSessions", ...)` to `vscode.window.createTreeView("codeSessions", {treeDataProvider})` so the toggle can read `.visible`. The other three view providers (KB changes / projects activity / tasks) stay on the cheap registration API — none need toggle behavior.

### US-5 — Both resume targets always visible (Priority: P1)

As a user, when I expand a session row I want to pick at click-time between "Open in Code Build" and "Open in native (Claude/Grok)" without first changing the `resumeBackend` setting.

**Acceptance**:

- `SessionItem.metricsChildren()` always emits both resume children, in this order:
  1. `▶ Open in Code Build` → new command `codeSessions.resumeInCodeBuild(row)`.
  2. `▶ Resume in native Claude` (when `row.source === "claude"`) or `▶ Open in native Grok` (when `row.source === "grok"`) → new command `codeSessions.resumeInNative(row)`.
- Each command hard-codes its target and bypasses the `codeSessions.resumeBackend` setting.
- The existing `codeSessions.resume` command (still bound to the inline tree-item action and the keyboard shortcut) continues to dispatch via `resumeBackend` — it delegates to `resumeInCodeBuild` or `resumeInNative` based on the setting.
- Fallback chain inside each target stays as today:
  - `resumeInCodeBuild`: tries `codeBuild.openExternalSession`, falls back to `codeBuild.newConversation`, finally falls back to the native target if `code-build` is not installed.
  - `resumeInNative`: tries `claude-vscode.primaryEditor.open` (Claude) or `grok.open` (Grok), falls back to a terminal CLI spawn.
- When `code-build` is not installed, the `Open in Code Build` child shows but its handler surfaces a toast `code-build not installed — falling back to native` and proceeds with the native path.

## DB schema migration

- Migration **v10** — `session_hide` table:
  ```sql
  CREATE TABLE session_hide (
    session_id TEXT PRIMARY KEY REFERENCES session(session_id) ON DELETE CASCADE,
    hidden_at  INTEGER NOT NULL
  );
  ```
- New `SessionStore` methods:
  - `setHidden(sessionId: string, hidden: boolean): void`
  - `hiddenSessionIds(): Set<string>`

## Commands (new)

| Command id | Title | Trigger |
|---|---|---|
| `codeSessions.hideSession` | Hide session | Right-click on non-hidden session |
| `codeSessions.unhideSession` | Unhide session | Right-click on hidden session (visible only when `showHidden=true`) |
| `codeSessions.renameSession` | Rename session… | Right-click on any session |
| `codeSessions.toggleActivityView` | Toggle Code Sessions sidebar | Keybinding `cmd+ctrl+shift+c` / `ctrl+alt+shift+c` |
| `codeSessions.resumeInCodeBuild` | Open in Code Build | Child of expanded session |
| `codeSessions.resumeInNative` | Open in native CLI | Child of expanded session |

## Settings (new)

| Key | Type | Default | Description |
|---|---|---|---|
| `codeSessions.showHidden` | boolean | `false` | Reveal hidden sessions in the tree with a closed-eye icon. |

## Context values

To drive right-click visibility, new viewItem strings:

- `session-hidden`, `sessionAutomated-hidden`, `session-starred-hidden`, `sessionAutomated-starred-hidden`.

Menu predicate for `hideSession`: `view == codeSessions && (viewItem == session || viewItem == sessionAutomated || viewItem == session-starred || viewItem == sessionAutomated-starred)`.

Menu predicate for `unhideSession`: `view == codeSessions && (viewItem == session-hidden || viewItem == sessionAutomated-hidden || viewItem == session-starred-hidden || viewItem == sessionAutomated-starred-hidden)`.

Menu predicate for `renameSession`: all eight session viewItems above.

## Out of scope

- No hard-delete (the JSONL is the source of truth; the cache can always be rebuilt).
- No batch hide / batch rename UI in this rev.
- No multi-select.
- No keybinding for hide / rename / resume-in-X.
- No undo for rename (the cache will pick up whatever's on disk; user re-runs Rename to revert).

## Risks and notes

- **JSONL write safety.** Rename mutates user data outside the extension's storage. Implementation MUST use atomic temp-file + rename; MUST NOT touch the file if a session has been touched in the last 2 seconds (live session is writing — surface a "session is active, try again" warning); MUST keep the original file unmodified on parse error.
- **Title source-of-truth.** Confirmed by reading `src/conversationParser.ts:121` — Claude title comes from `{"type":"ai-title", "aiTitle":"..."}`. Confirmed for Grok by reading `src/grokIndexer.ts:373-375` — `generated_title` is the highest-priority source.
- **Hidden + filtered interactions.** `filterByCurrentWorkspace`, `showAutomated`, and `showHidden` are independent — all three apply via `filterVisible`.
