# Claude Sessions

A VS Code sidebar that gives you a **central command center** for Claude Code activity: every session across every project (with tokens, cost, subagents, projects-touched, duration), plus the file changes your work produced (knowledge base + project repos), all in one place. Click a session to resume it inside the official Claude Code extension panel. Click **🔍 View conversation** to open a per-turn timeline of the chat with every tool call, input, output, and subagent invocation.

```
[Activity bar icon] Claude Activity
├─ Sessions
│   ▼ Today — 4 sessions · $812 · 1.2M tok · 🪄7
│       ▼ Research cookie management in Claude search tools  💬1561 · $709 · ⏱26h · 12m ago
│           💬 1561 msgs · $709.20 · 398M tok · 🪄7 · ⏱26h · 12m ago
│           📁 docs, unpolarize, ai/otelo
│           🔍 View conversation       ← opens timeline webview
│           ▶ Resume in Claude         ← opens in Claude Code extension panel
│           📜 Open raw JSONL
│       ▶ Build depolarization platform...  💬804 · $211 · ⏱4h · 1d ago
│   ▶ Yesterday — 9 sessions · $187 · 14M tok
│   ▶ Last 7 days — 47 sessions · $1,420 · 250M tok
│   ▶ Older — 1,315 sessions
├─ KB changes
│   ▼ Today — 14 files · 3 commits
│       knowledge/tech/security/fetcher-exposure-unpolarize.md       [M]
│       ...
│   ▶ Yesterday — 6 files · 2 commits
├─ Projects
│   ▼ Today — 26 files · 8 commits
│       ▼ unpolarize (12)
│           backend-py/app/telemetry/header_capture.py   [M]
│           ...
│       ▼ ai/otelo (10)
│           ...
│   ▶ Yesterday — 4 files · 1 commit
```

## What it shows

### Sessions pane

A tree of every Claude Code session (read from `~/.claude/projects/*/`), grouped by day:

- **Today / Yesterday / Last 7 days / Older** buckets, each labelled with totals (session count, total cost, total tokens, total subagents).
- Each session shows on a single line:
  - Title (auto-generated; falls back to the first user prompt)
  - 💬 messages · $cost · ⏱ session-span · time-ago (`12m / 5h / 3d / 2w / 2mo`)
- Sessions modified in the last 2 minutes have a pulse icon and auto-expand.
- Expand a session to see:
  - Wider metric row (with token count + cache breakdown)
  - 📁 Projects touched (derived from `Edit`/`Write` file paths in the session, not just the working directory)
  - **🔍 View conversation** — opens the per-turn timeline webview
  - **▶ Resume in Claude** — uses `claude-vscode.primaryEditor.open(sessionId)` to open the session in the official Claude Code extension panel; falls back to a terminal `claude --resume <uuid>` if the official extension isn't installed
  - **📜 Open raw JSONL** — opens the underlying session file in a regular editor

### KB changes pane

A list of file changes in your knowledge base (default `~/docs`), grouped by day:

- Committed changes from `git log --name-status --since=<lookback>`.
- Uncommitted working-tree changes (`(uncommitted)` subject).
- Status icons: `A` added, `M` modified, `D` deleted, `R` renamed.
- Click → open the file. Right-click → "Show diff against HEAD~1" (uses VS Code's built-in `vscode.diff`).

### Projects pane

The same `git log` view, but two-level: **day → project → files**.

- Watches an explicit list (`claudeProjectsActivity.repoPaths`) by default: `~/projects/unpolarize`, `~/projects/ai/otelo`.
- **Auto-discovers** additional repos: walks `~/projects/<depth-2>` and includes any git repo with commits in the lookback window (so `openclaw`, `inference-service`, etc. show up automatically as you touch them).
- Same open/diff actions as KB.

### Conversation viewer (webview)

Click **🔍 View conversation** on any session → opens an editor tab with a full timeline:

- **Header summary**: turn count, tool count, subagent count, session span (wall-clock first → last), time in tools, time outside tools, first/last activity timestamps.
- **One card per turn**:
  - `#N · <wall-clock> · duration Xs · 3 tools (Bash×2 · Edit×1)`
  - USER prompt
  - ASSISTANT response (with its own duration)
  - **TOOLS** section (collapsed by default — click to expand the calls list)
- **One `<details>` per tool call** (collapsed by default):
  - Tool icon (🔧 standard / 🪄 subagent)
  - Name + duration
  - Started / ended timestamps
  - Input as pretty-printed JSON
  - Output (truncated at 4 KB)
- Subagent calls (`Agent` tool) get a distinct purple-ish background and show `subagent_type` + `description` inline.
- Errors get a red border + `error` pill.

The webview uses VS Code theme variables so dark and light themes both render correctly. `enableScripts=false` (static HTML — no XSS surface).

## How it works under the hood

See [`docs/architecture.md`](docs/architecture.md) for details. In short:

- The **Sessions** view shells out to `~/.claude/skills/sessions/session-center.sh recent <N> json` — the same script the `sessions` shell alias uses. One source of truth.
- The **KB / Projects** views shell out to `git log --name-status` + `git status --porcelain`. No git library, no GitHub API.
- The **Conversation viewer** parses the session JSONL in pure TypeScript and renders an HTML page using VS Code theme variables. No fetches, no scripts.
- A `vscode.FileSystemWatcher` on `~/.claude/projects/**/*.jsonl` auto-refreshes the Sessions view (1.5s throttle).

## Install

```bash
git clone git@github.com:zhirafovod/claude-sessions-vscode.git
cd claude-sessions-vscode
npm install
npx tsc -p .
npx @vscode/vsce package        # → claude-sessions-X.Y.Z.vsix
code --install-extension claude-sessions-*.vsix
```

Reload VS Code → click the new **Claude Activity** icon in the Activity Bar.

For build / contribute / release flow see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Settings

| Setting | Default | What it does |
|---|---|---|
| `claudeSessions.limit` | `100` | Maximum number of recent sessions to load. |
| `claudeSessions.scriptPath` | `~/.claude/skills/sessions/session-center.sh` | Path to the helper script. |
| `claudeKbChanges.repoPath` | `~/docs` | KB repo path. |
| `claudeKbChanges.lookbackDays` | `14` | Days of git history. |
| `claudeProjectsActivity.repoPaths` | `["~/projects/unpolarize","~/projects/ai/otelo"]` | Explicit list of project repos. |
| `claudeProjectsActivity.autoDiscover` | `true` | Walk `~/projects/` depth 2 and add any git repo with commits in window. |
| `claudeProjectsActivity.discoveryRoot` | `~/projects` | Root for auto-discovery. |
| `claudeProjectsActivity.lookbackDays` | `14` | Days of git history per project. |

## Related

- **`sessions` shell alias** — the same data, instantly, from any terminal. `bash ~/.claude/skills/sessions/session-center.sh recent 30` (or `sessions recent 30`).
- **`/sessions` Claude Code skill** — same script, invoked through the Claude Code slash-command system. Slower because the LLM is involved; use the shell alias or this extension when you want a "fully programmatic" view.
- **Design + investigation notes** (in the Sergey docs workspace): `~/docs/knowledge/tech/agents/claude-code-command-center.md`.

## Why this exists

The official Claude Code VS Code extension (`anthropic.claude-code`) declares a `claude-sessions-sidebar` view container, but it is gated behind context flag `claude-vscode.sessionsListEnabled` — **not user-settable** and not shipped yet. This extension fills the gap, adds analytics the official one will not (token / cost / subagents / projects-touched / per-turn trace), and integrates with the official one (resume opens the conversation in the Claude panel via `claude-vscode.primaryEditor.open`).

## License

Private — for personal use. Not published to the marketplace.
