# Code Sessions

A VS Code sidebar that gives you a **central command center** for coding-agent CLI activity: every session from Claude Code (`~/.claude/projects/`) **and** Grok Build (`~/.grok/sessions/`), grouped by source and by day. Tokens, cost, subagents, projects-touched, duration, topic classification, plus the file changes your work produced (knowledge base + project repos) — all in one place. Click a Claude session to resume it inside the official Claude Code extension panel. Click **🔍 View conversation** for a per-turn timeline.

> **Upgrade note.** The extension id is now `code-sessions` (previously `claude-sessions`, then `coder-sessions`). On first activation it imports your existing session index + topic classifications from the prior global-storage dir (so you won't trigger a full reclassification), and a one-time shim migrates any settings you customized under the old `claudeSessions.*` / `coderSessions.*` keys into the current `codeSessions.*` namespace — your data and config carry over automatically.

```
[Activity bar icon] Code Sessions
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

- Watches an explicit list (`codeProjectsActivity.repoPaths`) by default: `~/projects/unpolarize`, `~/projects/ai/otelo`.
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

## How it works & what it stores

Code Sessions is a **read-only dashboard** over your local coding-agent CLI history. It reads three external sources it does not own and indexes them into a local cache — nothing leaves your machine.

**What it reads (sources of truth, never modified):**
- `~/.claude/projects/*/*.jsonl` — Claude Code session transcripts
- `~/.grok/sessions/<cwd>/<uuid>/` — Grok Build sessions (`chat_history.jsonl`, `summary.json`, `signals.json`)
- Git history of your KB and `~/projects/*` repos (via `git log` / `git status`, held in memory — not cached)

**What it stores (a derived, disposable index):**
A single SQLite database (`better-sqlite3`, WAL mode) at:

```
<globalStorage>/sessions-cache.db
# macOS: ~/Library/Application Support/Code/User/globalStorage/zhirafovod.code-sessions/sessions-cache.db
```

It holds tables for sessions, turns, topic classifications, embeddings + 2D layout coordinates, starred sessions, and a migration ledger. The schema is versioned via `PRAGMA user_version`. **This DB is purely a cache** — delete the `zhirafovod.code-sessions` global-storage folder and the extension rebuilds it from disk on next launch (topics and embeddings are recomputed on demand). An incremental indexer only re-parses transcripts whose `(mtime, size)` changed, triggered by a 1.5 s-throttled file watcher.

**Local-only compute:**
- **Embeddings** for the agent graph use a local Ollama daemon (`127.0.0.1:11434`, `nomic-embed-text`), falling back to a built-in hashed bag-of-words vector when Ollama isn't running.
- **Topic classification** uses local Ollama by default, or optionally `claude -p` (your Claude subscription). When spawning `claude`, the extension passes a curated env (`PATH`/`HOME`/`USER` only) and deliberately withholds `ANTHROPIC_API_KEY` so it never switches to metered API billing.

There are no analytics, no telemetry, and no cloud calls from the extension itself. Webviews run under a strict Content-Security-Policy (static views execute no scripts; interactive views use nonce-gated scripts and whitelist no remote origins).

To inspect or reset the cache, and for the full table-by-table schema, see **[docs/DATA-STORES.md](docs/DATA-STORES.md)**. Deeper internals live in [`docs/architecture.md`](docs/architecture.md) and [`docs/embedding-setup.md`](docs/embedding-setup.md).

## Install

The fastest path uses the bundled scripts:

```bash
git clone git@github.com:unpolarize/code-sessions-vscode.git
cd code-sessions-vscode
npm install
./scripts/build-install.sh      # compile, package, install the .vsix
./scripts/ollama-setup.sh       # install Ollama if missing, start service, pull models
```

Reload VS Code → click the new **Code Sessions** icon in the Activity Bar.

The scripts are thin wrappers over standard commands; if you'd rather run them by hand:

```bash
npm install
npm run compile
npx @vscode/vsce package         # → code-sessions-X.Y.Z.vsix
code --install-extension code-sessions-*.vsix --force
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
| `codeSessions.classify.model` | `llama3.2:3b` | Classifier model passed to Ollama. Try `qwen2.5:3b`, `gemma2:2b`, or `llama3.1:8b` for sharper labels. |
| `codeSessions.embedding.ollamaModel` | `nomic-embed-text` | Embedding model. `mxbai-embed-large` is higher-quality but slower. |
| `codeSessions.embedding.ollamaUrl` | `http://127.0.0.1:11434` | Override if Ollama runs on another host/port. |

After changing the embedding model, run **`Claude: Drop cached embeddings and re-embed`** from the palette so the agent graph rebuilds from scratch.

### Turning auto-classification off

If you don't want the daemon running:

- `codeSessions.classify.autoBackground` → `false` — disables the background daemon.
- `codeSessions.classify.autoOnOpen` → `false` — disables the on-open auto-classify when you view a conversation.

Manual classification still works via the **Classify all topics** button on the agent graph or **Analyze conversation topics** in the command palette.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `codeSessions.limit` | `100` | Maximum number of recent sessions to load. |
| `codeSessions.cacheEnabled` | `true` | Read from SQLite. Set `false` to fall back to spawning `session-center.sh` (v0.6.x). |
| `codeSessions.scriptPath` | `~/.claude/skills/sessions/session-center.sh` | Path to the helper script (used only when cache is disabled). |
| `codeSessions.classify.model` | `claude-haiku-4-5` | Model for topic classification (`claude -p`, your subscription). |
| `codeSessions.classify.batchSize` | `20` | Turns per `claude -p` call. |
| `codeSessions.classify.claudeBin` | _empty_ | Override path to the `claude` CLI. Empty = `PATH`. |
| `codeSessions.embedding.preferred` | `ollama` | Preferred embedding backend (`ollama` or `transformersjs`). Falls back to a hashed bag-of-words if neither is available. |
| `codeSessions.embedding.ollamaUrl` | `http://127.0.0.1:11434` | Ollama base URL. |
| `codeSessions.embedding.ollamaModel` | `nomic-embed-text` | Ollama model name. |
| `codeKbChanges.repoPath` | `~/docs` | KB repo path. |
| `codeKbChanges.lookbackDays` | `14` | Days of git history. |
| `codeProjectsActivity.repoPaths` | `["~/projects/unpolarize","~/projects/ai/otelo"]` | Explicit list of project repos. |
| `codeProjectsActivity.autoDiscover` | `true` | Walk `~/projects/` depth 2 and add any git repo with commits in window. |
| `codeProjectsActivity.discoveryRoot` | `~/projects` | Root for auto-discovery. |
| `codeProjectsActivity.lookbackDays` | `14` | Days of git history per project. |

## Related

- **`sessions` shell alias** — the same data, instantly, from any terminal. `bash ~/.claude/skills/sessions/session-center.sh recent 30` (or `sessions recent 30`).
- **`/sessions` Claude Code skill** — same script, invoked through the Claude Code slash-command system. Slower because the LLM is involved; use the shell alias or this extension when you want a "fully programmatic" view.
- **Design + investigation notes** (in the Sergey docs workspace): `~/docs/knowledge/tech/agents/claude-code-command-center.md`.

## Why this exists

The official Claude Code VS Code extension (`anthropic.claude-code`) declares a `claude-sessions-sidebar` view container, but it is gated behind context flag `claude-vscode.sessionsListEnabled` — **not user-settable** and not shipped yet. This extension fills the gap, adds analytics the official one will not (token / cost / subagents / projects-touched / per-turn trace), and integrates with the official one (resume opens the conversation in the Claude panel via `claude-vscode.primaryEditor.open`).

## License

MIT — see [`LICENSE`](LICENSE).
