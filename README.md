# Claude Sessions

A VS Code sidebar that gives you a central view of Claude Code activity across all projects, plus the file changes the work produced.

## Three panes

### 1. Sessions

A tree of every Claude Code session in `~/.claude/projects/`, grouped by day (Today / Yesterday / Last 7 days / Older). Each session shows:

- **AI-generated title** (or first user prompt if no title yet)
- **Projects touched** in the conversation (derived from `Edit` / `Write` tool calls, not just the session's primary cwd)
- **Subagent count** (`🪄N` prefix when `> 0` — counts `Agent` tool invocations)
- **Message count** and **cost** in USD
- **Modified time** ("Nm ago")
- **Pulse icon** for sessions modified within the last 120 seconds (active)

Click a session → spawns a terminal and runs `claude --resume <uuid>`.
Right-click → "Open transcript (JSONL)" to read the raw conversation.
Hover → full token breakdown (input / output / cache R / cache W) and the complete projects-touched list.

### 2. KB changes

A tree of file changes in your knowledge-base repo (default `~/docs`), grouped by day. Pulls both committed changes (via `git log --name-status`) and uncommitted working-tree changes (via `git status`). Each change shows status (A/M/D) and the commit subject.

Click → open the file. Right-click → "Show diff against HEAD~1" (uses VS Code's built-in `vscode.diff`).

### 3. Projects

Same as KB but for project repos. Two-level grouping: **day → project → files**.

By default it watches `~/projects/unpolarize` and `~/projects/ai/otelo`, and additionally auto-discovers any git repo under `~/projects/` (depth 2) that has commits in the lookback window. The auto-discovery picks up `openclaw`, `inference-service`, etc. without you listing them.

## Build & install

```bash
cd ~/projects/claude-sessions-vscode
npm install
npx tsc -p .
npm install -g @vscode/vsce
vsce package
code --install-extension claude-sessions-0.1.0.vsix
```

Reload VS Code, click the new Activity Bar icon ("Claude Activity"), and the three panes appear.

## Backed by

- `~/.claude/skills/sessions/session-center.sh` — the same script the `sessions` shell alias uses. The extension calls it in `json` mode. Editing pricing rates / lookback options there propagates to both.
- `git` — for KB and Projects panes. No git dependencies beyond what's in `PATH`.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `claudeSessions.limit` | `100` | Max sessions to load. |
| `claudeSessions.scriptPath` | `~/.claude/skills/sessions/session-center.sh` | Path to the helper script. |
| `claudeKbChanges.repoPath` | `~/docs` | KB repo. |
| `claudeKbChanges.lookbackDays` | `14` | Days of git history. |
| `claudeProjectsActivity.repoPaths` | `["~/projects/unpolarize", "~/projects/ai/otelo"]` | Explicit list of project repos. |
| `claudeProjectsActivity.autoDiscover` | `true` | Walk `~/projects/` depth 2 and include git repos with commits in window. |
| `claudeProjectsActivity.discoveryRoot` | `~/projects` | Root for auto-discovery. |
| `claudeProjectsActivity.lookbackDays` | `14` | Days of git history per project. |

## Why this exists

The official Claude Code VS Code extension (`anthropic.claude-code`) declares a `claude-sessions-sidebar` view container, but it's gated behind context flag `claude-vscode.sessionsListEnabled` — not user-settable. Until that ships, this extension fills the gap. It does NOT compete with Anthropic's webview chat; it complements it by adding a session-list + project-activity view that the official one doesn't yet expose.

## Roadmap

- Drill-in view per session: list of files edited in that conversation, click to open.
- Streamlit-side mirror for OTelO so the same data is queryable in Grafana / a web dashboard alongside other traces.
- Color rows by cost band (greens for cheap, reds for expensive).
- Quick-pick command (Cmd+Shift+P → "Claude: Resume session") with VS Code's `QuickPick` instead of fzf.
- Search/filter box in the sidebar.
- "Compare this session's cost to my median" badge.
- Show MCP servers used per session.

## License

Private — for personal use only. May be open-sourced later.
