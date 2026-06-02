# Coder Sessions

A VS Code sidebar that gives you a **central command center** for coding-agent CLI activity: every session from Claude Code (`~/.claude/projects/`) **and** Grok Build (`~/.grok/sessions/`), grouped by source and by day. Tokens, cost, subagents, projects-touched, duration, topic classification, plus the file changes your work produced (knowledge base + project repos) — all in one place. Click a Claude session to resume it inside the official Claude Code extension panel. Click **🔍 View conversation** for a per-turn timeline.

> **v1.0 upgrade note.** This extension was renamed from `claude-sessions` to `coder-sessions`. On first activation it imports your existing session index + topic classifications from the old extension's global-storage dir, so you won't trigger a full reclassification. Settings keys are renamed (`claudeSessions.*` → `coderSessions.*`) and **do not** migrate — reconfigure once.

```
[Activity bar icon] Coder Activity
├─ Sessions
│   ▼ Claude Code — 1,373 sessions
│       ▼ Today — 4 sessions · $812 · 1.2M tok · 🪄7
│           ▼ Research cookie management in Claude search tools  💬1561 · $709 · ⏱26h · 12m ago
│               💬 1561 msgs · $709.20 · 398M tok · 🪄7 · ⏱26h · 12m ago
│               📁 docs, unpolarize, ai/otelo
│               🔍 View conversation       ← opens timeline webview
│               ▶ Resume in Claude         ← opens in Claude Code extension panel
│               📜 Open raw JSONL
│       ▶ Yesterday — 9 sessions · $187 · 14M tok
│       ▶ Last 7 days — 47 sessions · $1,420 · 250M tok
│       ▶ Older — 1,315 sessions
│   ▼ Grok Build — 1,424 sessions
│       ▼ Today — 18 sessions
│           ▶ Coder rebrand + Grok support · model=grok-build · 💬41 · 🛠32
│       ▶ Yesterday — 22 sessions
│       ▶ Older — 1,384 sessions
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

### Insights dashboard (webview)

Click the **📊 graph icon** in the Sessions title bar to open a per-account dashboard:

- **KPI row**: total cost, total tokens, total messages, total subagents, **median user thinking time** (gap between Claude finishing and your next reply), **burst rate** (% of replies in <5s — flow-state indicator) — across the lookback window.
- **Daily cost** bar chart.
- **Daily tokens by type** stacked bars (input / output / cache read / cache write).
- **"When you Claude"** heatmap — 7 days × 24 hours, cell intensity = session count. Reveals your real work rhythm.
- **Cost distribution histogram** — how many sessions in each $-bucket.
- **Top projects by cost** horizontal bar chart (uses `projects_touched`, not just session cwd).
- **Tool usage** horizontal bar chart — top 12 tools by call count, computed by deep-parsing the most-recent N sessions (default 20). Bash usually wins.
- **Top 10 expensive sessions** clickable table.

All charts are inline SVG. No external libraries, no scripts, no fetches. Colors come from VS Code theme variables so dark and light themes both render correctly.

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

See [`docs/architecture.md`](docs/architecture.md) and [`specs/001-cache-topics-graph/spec.md`](specs/001-cache-topics-graph/spec.md). In short:

- **SQLite cache** at `<globalStorageUri>/sessions-cache.db` (WAL mode, `better-sqlite3`). The cache is the source of truth for the Sessions tree and insights dashboard. An incremental `(mtime, size)` indexer keeps it in sync with `~/.claude/projects/*.jsonl`. Toggle off via `claudeSessions.cacheEnabled = false` to fall back to spawning `session-center.sh`.
- **Topic detection** runs `claude -p --model claude-haiku-4-5 --output-format json` on demand from the conversation viewer. Topics are persisted in `turn_topic` keyed by `turn_uuid`. The spawned `claude` env is curated (`PATH`, `HOME`, `USER` only) so `ANTHROPIC_API_KEY` from your parent shell **never** leaks in — your subscription does the work, not the API.
- **Agent graph** embeds every non-automated session into a vector (Ollama `nomic-embed-text` if reachable; otherwise a built-in hashed bag-of-words fallback), projects to 2D with `umap-js`, persists `umap_x/umap_y`, renders a Canvas scatter. Hover for tooltip, click to open the conversation viewer. See [`docs/embedding-setup.md`](docs/embedding-setup.md) for the Ollama install + `ollama pull nomic-embed-text` steps.
- The **KB / Projects** views shell out to `git log --name-status` + `git status --porcelain`. No git library, no GitHub API.
- A `vscode.FileSystemWatcher` on `~/.claude/projects/**/*.jsonl` auto-refreshes the Sessions view (1.5 s throttle), running the incremental indexer first.

## Install

The fastest path uses the bundled scripts:

```bash
git clone git@github.com:zhirafovod/claude-sessions-vscode.git
cd claude-sessions-vscode
npm install
./scripts/build-install.sh      # compile, package, install the .vsix
./scripts/ollama-setup.sh       # install Ollama if missing, start service, pull models
```

Reload VS Code → click the new **Claude Activity** icon in the Activity Bar.

The scripts are thin wrappers over standard commands; if you'd rather run them by hand:

```bash
npm install
npm run compile
npx @vscode/vsce package         # → claude-sessions-X.Y.Z.vsix
code --install-extension claude-sessions-*.vsix --force
```

For build / contribute / release flow see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Ollama dependency

The extension uses a local [Ollama](https://ollama.com) daemon for two things:

- **Topic classification** of conversation turns (the background classifier + the `Classify all topics` button on the agent graph). Default model: `llama3.2:3b` (~2 GB). Optional — if Ollama isn't running, the daemon idles and classification just doesn't happen automatically.
- **Embeddings** for the agent-graph 2D + 3D layouts. Default model: `nomic-embed-text` (~270 MB). Required if you want a real embedding-based scatter; the extension falls back to a hashed bag-of-words layout otherwise (much less informative).

Both run locally — no API tokens, no network calls beyond `127.0.0.1:11434`.

### One-time setup

```bash
# 1. Install Ollama
brew install ollama                                   # macOS
# curl -fsSL https://ollama.com/install.sh | sh       # Linux

# 2. Start the daemon (foreground)
ollama serve                                          # or: brew services start ollama

# 3. Pull the models the extension uses
ollama pull llama3.2:3b
ollama pull nomic-embed-text

# 4. Sanity check
curl -s http://127.0.0.1:11434/api/tags | jq '.models[].name'
```

Or just run `./scripts/ollama-setup.sh` — it does all four steps and is safe to re-run (it skips what's already done).

### Choosing different models

The defaults are tuned for small machines. If you have headroom, edit settings:

| Setting | Default | Description |
|---|---|---|
| `claudeSessions.classify.model` | `llama3.2:3b` | Classifier model passed to Ollama. Try `qwen2.5:3b`, `gemma2:2b`, or `llama3.1:8b` for sharper labels. |
| `claudeSessions.embedding.ollamaModel` | `nomic-embed-text` | Embedding model. `mxbai-embed-large` is higher-quality but slower. |
| `claudeSessions.embedding.ollamaUrl` | `http://127.0.0.1:11434` | Override if Ollama runs on another host/port. |

After changing the embedding model, run **`Claude: Drop cached embeddings and re-embed`** from the palette so the agent graph rebuilds from scratch.

### Turning auto-classification off

If you don't want the daemon running:

- `claudeSessions.classify.autoBackground` → `false` — disables the background daemon.
- `claudeSessions.classify.autoOnOpen` → `false` — disables the on-open auto-classify when you view a conversation.

Manual classification still works via the **Classify all topics** button on the agent graph or **Analyze conversation topics** in the command palette.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `claudeSessions.limit` | `100` | Maximum number of recent sessions to load. |
| `claudeSessions.cacheEnabled` | `true` | Read from SQLite. Set `false` to fall back to spawning `session-center.sh` (v0.6.x). |
| `claudeSessions.scriptPath` | `~/.claude/skills/sessions/session-center.sh` | Path to the helper script (used only when cache is disabled). |
| `claudeSessions.classify.model` | `claude-haiku-4-5` | Model for topic classification (`claude -p`, your subscription). |
| `claudeSessions.classify.batchSize` | `20` | Turns per `claude -p` call. |
| `claudeSessions.classify.claudeBin` | _empty_ | Override path to the `claude` CLI. Empty = `PATH`. |
| `claudeSessions.embedding.preferred` | `ollama` | Preferred embedding backend (`ollama` or `transformersjs`). Falls back to a hashed bag-of-words if neither is available. |
| `claudeSessions.embedding.ollamaUrl` | `http://127.0.0.1:11434` | Ollama base URL. |
| `claudeSessions.embedding.ollamaModel` | `nomic-embed-text` | Ollama model name. |
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

MIT — see [`LICENSE`](LICENSE).
