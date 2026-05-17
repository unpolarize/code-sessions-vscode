# Changelog

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
