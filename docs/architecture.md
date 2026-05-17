# Architecture

This extension has three TreeViews + one Webview. Everything reads from local sources — no network, no auth.

```
                         ┌────────────────────────────────┐
                         │  VS Code Activity Bar           │
                         │  "Claude Activity"              │
                         └────────────────────────────────┘
                                       │
       ┌───────────────────────────────┼───────────────────────────────┐
       ▼                               ▼                               ▼
 ┌───────────────┐              ┌──────────────┐              ┌──────────────────┐
 │ SessionsTree  │              │ KbChangesTree│              │ ProjectsActivity │
 │ Provider      │              │ Provider     │              │ TreeProvider     │
 └───────────────┘              └──────────────┘              └──────────────────┘
        │                              │                              │
        ▼                              ▼                              ▼
 session-center.sh                git log on                    git log on each
 (~/.claude/skills/...)           ~/docs                        repo path +
        │                              │                       auto-discover
        ▼                              ▼                              │
 ~/.claude/projects/             ~/docs/                              ▼
 *.jsonl                                                         ~/projects/**
                                                                                                  
        │
        │ "🔍 View conversation"
        ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ Conversation Viewer (Webview)                                │
 │                                                              │
 │  parseConversation(jsonlPath)                                │
 │       │                                                      │
 │       ▼                                                      │
 │  Turn[]  →  HTML (theme-variable CSS, no scripts)            │
 └──────────────────────────────────────────────────────────────┘
```

## Source layout

```
src/
├── extension.ts             # Activation, providers, commands, watcher
├── conversationParser.ts    # JSONL → Turn[] (pure, framework-free)
└── conversationView.ts      # Webview HTML/CSS renderer
```

## Sessions data flow

1. **`SessionsProvider.load()`** spawns `bash <scriptPath> recent <limit> json`.
2. The script walks `~/.claude/projects/<encoded-project>/<uuid>.jsonl`, mtime-sorts, keeps top N.
3. For each surviving session, the script runs `jq -s` once to aggregate: title, message count, total tokens (input/output/cache R/cache W), cost, subagent count, distinct project IDs touched (derived from `Edit`/`Write` tool calls), first user timestamp.
4. The script emits a JSON array on stdout.
5. The provider parses JSON and groups by day bucket. Bucket labels carry totals (`Today — N sessions · $X · Y tok · 🪄Z`).
6. The provider renders a flat list of session items per bucket. Each session has children (metrics row, projects row, three action rows) populated lazily.

## KB / Projects data flow

For each repo path:

1. `git log --since=<N> days ago --name-status --no-merges --date=iso-strict --pretty=format:%x01%H%x09%aI%x09%s`
2. Parse the output line by line — `\x01`-prefixed lines are commit headers, subsequent lines are `A/M/D <path>` entries.
3. `git status --porcelain=v1` for uncommitted working-tree changes (prepended with commit `WORKING`).
4. Group by day bucket via `dayBucket()`.

For the Projects pane, auto-discovery additionally walks `~/projects/<depth-2>`, finds any `.git` directory, and runs `git log --since=N -n 1` to confirm the repo had a commit in the window. Repos with no recent commits are excluded.

## Day buckets

`dayBucket(Date)` returns one of `"today" | "yesterday" | "last7" | "older"` based on local time. Bucket items show their group totals in the label:

- Sessions: `Today — 4 sessions · $812 · 1.2M tok · 🪄7`
- KB: `Today — 14 files · 3 commits`
- Projects: `Today — 26 files · 8 commits`

## Conversation parser

`parseConversation(filePath)` reads the JSONL and groups lines into **Turns**. A Turn starts at a real user message and includes every assistant message and tool result that follows until the next real user message.

### JSONL line types we care about

| `type` | What we extract |
|---|---|
| `user` (string or non-tool_result array content) | Starts a new Turn. Captures `timestamp` (parsed to ms), `message.content` text. |
| `user` (array content with `[0].type == "tool_result"`) | Attaches the result to the current Turn by `tool_use_id` matching. Captures `timestamp` and updates the ToolCall's `endMs` / `durationMs`. |
| `assistant` | Appended to the current Turn. Each `content[]` block is either a `text` (accumulated into `assistantText`) or a `tool_use` (becomes a `ToolCall`). |
| `ai-title` | Sets the conversation title. |

### Tool call attachment

When an assistant emits a `tool_use` with id `X`, we push a `ToolCall` into the current Turn and register it in a `pendingTools` map keyed by `X`. When we later see a `tool_result` with `tool_use_id == X`, we look it up, attach `resultText` + `resultIsError`, and compute `durationMs = endMs - startMs`.

### Subagents

A `tool_use` is treated as a subagent invocation when `name === "Agent"` (or `"Task"` for older sessions). We additionally capture `input.subagent_type` and `input.description` for inline display.

### Aggregates (per conversation)

```ts
ConversationSummary {
  totalTurns,
  totalTools,
  totalSubagents,
  totalAssistantTextChars,
  totalTurnDurationMs,   // sum of (turn end − user msg time) per turn
  totalToolDurationMs,   // sum of tool call durations
}
```

`Outside tools` time on the viewer header = `(endMs - startMs) - totalToolDurationMs`. Rough proxy for time spent waiting on model output rather than tool execution.

## Webview rendering

`conversationView.ts` produces a single static HTML string via template literals. Key choices:

- `enableScripts: false` — no JavaScript runs in the webview. Interactivity is pure HTML `<details>` toggling. No XSS surface, no postMessage protocol.
- `retainContextWhenHidden: true` — switching tabs and back doesn't re-render.
- All colors come from `var(--vscode-*)` so dark/light themes work without per-theme CSS.
- Tool input/output are folded by default; click to expand.
- The TOOLS section per turn is also a `<details>` — collapsed by default so you can scan turns by user/assistant prose without the noise.

The HTML is regenerated on every `openConversationViewer` call (no diffing). For a 1500-turn session this is ~1MB of HTML and renders in well under a second.

## Resume integration with the official Claude Code extension

The official `anthropic.claude-code` extension exposes (undocumented) commands that accept a session UUID as the first argument:

- `claude-vscode.primaryEditor.open(sessionId, prompt?, viewColumn?)`
- `claude-vscode.editor.open(sessionId, prompt?, viewColumn?)`

Both invoke `createPanel(sessionId, prompt, viewColumn)` internally, which opens the Claude panel in the user's preferred location (primary editor / side panel / new window).

`claudeSessions.resume` tries `primaryEditor.open` first, then `editor.open`, then falls back to spawning a terminal and running `claude --resume <uuid>` if the extension isn't installed.

## File watcher

Activate-time we register:

```ts
vscode.workspace.createFileSystemWatcher(
  new vscode.RelativePattern(
    vscode.Uri.file(path.join(os.homedir(), ".claude", "projects")),
    "**/*.jsonl",
  ),
);
```

On change / create we queue a debounced refresh of the Sessions provider (1.5 s). KB and Projects panes have no watcher — they refresh on demand (the title-bar refresh button) or when VS Code reactivates the view.

## Performance

- `session-center.sh` walks all ~1300 sessions in ~9 s by pre-filtering on mtime and only invoking `jq` on the top N (default 100).
- The parser reads one JSONL synchronously (`fs.readFileSync`) and processes line by line. A 1500-turn session (~5 MB) takes well under a second.
- HTML render is a single template-literal pass.

## Testing approach (future)

There aren't formal tests yet. The natural seams:

- `parseConversation()` is pure — feed it any JSONL fixture and assert on `Turn[]`.
- `gitChanges(repoPath, days)` is pure — feed it a fixture repo (git init + N commits) and assert.
- `formatRelative` / `formatDurationSec` / `formatTokens` are obvious unit-test targets.
- TreeView providers can be exercised via VS Code's extension-test runner. Not currently wired.
