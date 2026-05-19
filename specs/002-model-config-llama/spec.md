# Feature Specification: Configurable classification backend, llama3.2 default, fix native deps

**Feature**: `002-model-config-llama`
**Created**: 2026-05-18
**Status**: In progress (ships as v0.7.1)
**Source**: User feedback on v0.7.0 — "setup llama3.2, use as default" + warning "Agent Graph requires SQLite cache" on fresh install.

## Why one spec for three things

They form one user-visible promise: **the extension works out of the box, without a Claude subscription cost per turn, on a fresh VS Code install.** All three are in service of that:

- **Llama default** removes the per-turn cost.
- **Configurable backend** lets users opt back into `claude -p` Haiku or any other Ollama model.
- **Native-deps fix** unblocks the SQLite cache that the agent graph + topic display both depend on.

## Problem statement

On a fresh install of v0.7.0 (VS Code 1.120, Electron 39.8.8, Node ABI 127):

1. `better-sqlite3@12.10` shipped in the `.vsix` was built against the system Node ABI (likely 115), not Electron 39's ABI 127. `SessionStore.open()` throws, the catch sets `store = null`, and every cache-dependent feature degrades silently:
   - The Sessions tree falls back to spawning `session-center.sh` on every refresh (~9 s).
   - The agent graph and topic classifier refuse to start: "Agent graph requires SQLite cache".
2. Topic classification defaults to `claude -p --model claude-haiku-4-5`, which burns subscription minutes for every analysis. The user wants local-first.
3. There is no UI for picking which model does which job — backend choice is implicit in `embedding.preferred` for graphs but absent for classification.

## User Scenarios

### US-1 — First-run cache works (Priority: P0)

As a fresh installer of the .vsix, when I reload VS Code, the SQLite cache opens, the cold sync runs, the agent graph and topic classifier are immediately usable. I never see "Agent Graph requires SQLite cache".

**Acceptance**:
- Installing `claude-sessions-0.7.1.vsix` and reloading: no warning notifications. The Sessions tree populates in ≤ 2 s cold, ≤ 500 ms warm.
- The 📡 agent-graph button works on first click without raising a warning.

### US-2 — Local classification by default (Priority: P0)

As a default user, when I click "Analyze topics" in the conversation viewer, the extension calls a local Ollama model (`llama3.2:3b`) — no Claude subscription minutes spent.

**Acceptance**:
- A clean install with Ollama running and `llama3.2:3b` pulled classifies a 30-turn session in ≤ 60 s, with no `claude -p` invocations (verified by absence of `claude` processes in `ps`).
- If Ollama is unreachable, the UI shows "Ollama not reachable; configure `claudeSessions.classify.backend` to switch to `claude-p`."

### US-3 — Backend choice exposed (Priority: P1)

As a user, I can pick the classification backend (`ollama` or `claude-p`) and the embedding backend (`ollama` or `fallback`) in VS Code settings.

**Acceptance**:
- `claudeSessions.classify.backend` setting exists with enum `["ollama","claude-p"]`, default `"ollama"`.
- Changing it takes effect on the next "Analyze topics" click without window reload.
- Editing `claudeSessions.classify.model` to e.g. `qwen2.5:3b` and re-running classify uses that model.

## Functional Requirements

### FR-1 — Rebuild native modules for VS Code's Electron at package time

System MUST run `@electron/rebuild` against VS Code's Electron version (currently 39.8.8) before producing the `.vsix`. The packaging script in `package.json` runs:

```
electron-rebuild --version 39.8.8 --module-dir . --types prod
```

The rebuilt `node_modules/better-sqlite3/build/Release/better_sqlite3.node` is what ships in the `.vsix`. Add a script `prepackage` that runs the rebuild step automatically before `vsce package`.

### FR-2 — Diagnostic on cache failure

Replace the silent fallback in `extension.ts::activate` with a one-line action button: if `SessionStore.open()` throws, surface "SQLite cache failed: $msg — open log" with an `openOutput` button that reveals the extension log. Catch the error and write the full stack to the log channel so users can self-diagnose.

### FR-3 — Topic classifier supports two backends via dispatch

Refactor `src/topicClassifier.ts` so the public `classifySession()` reads `claudeSessions.classify.backend` and dispatches to one of two implementations:

- `claudeBackend` (existing) — `claude -p` with curated env, preserves subscription. Uses `classify.model` as model id.
- `ollamaBackend` (new) — HTTP `POST /api/chat` against `embedding.ollamaUrl` with `format: "json"` and a structured system prompt that asks for `{"topics":[{"id":"<uuid>","topic":"<label>"}]}`. Parses JSON, validates shape.

Both backends must:
- Honor the same `batchSize` setting.
- Persist results via `store.upsertTopics(...)` with `model` set to e.g. `ollama/llama3.2:3b` or `claude-p/claude-haiku-4-5` so re-runs with the same model+prompt-rev are skipped.
- Surface rate-limit / connection errors via the returned `ClassifyResult.errors[]`.

### FR-4 — Default to local Ollama llama3.2

Set in `package.json`:
- `claudeSessions.classify.backend` default = `"ollama"`
- `claudeSessions.classify.model` default = `"llama3.2:3b"`

These are also exposed in `claudeSessions.embedding.ollamaUrl`. The Ollama URL is reused — one daemon for both embeddings and classification.

### FR-5 — Settings UI (read-only declarative)

The existing VS Code Settings UI provides the picker for free once the enum values are declared. No bespoke UI is required. Settings:

| Setting | Type | Default | Notes |
|---|---|---|---|
| `claudeSessions.classify.backend` | `"ollama" \| "claude-p"` | `"ollama"` | Where topic classification runs |
| `claudeSessions.classify.model` | string | `"llama3.2:3b"` | Model id passed to the chosen backend |
| `claudeSessions.classify.batchSize` | number | `20` | Turns per call |
| `claudeSessions.classify.claudeBin` | string | `""` | Override `claude` CLI path |
| `claudeSessions.embedding.preferred` | `"ollama" \| "fallback"` | `"ollama"` | Vector source for the agent graph |
| `claudeSessions.embedding.ollamaUrl` | string | `"http://127.0.0.1:11434"` | Daemon URL (shared) |
| `claudeSessions.embedding.ollamaModel` | string | `"nomic-embed-text"` | Embedding model id |

### FR-6 — Ollama health probe at activation

On `activate`, asynchronously probe the configured Ollama URL and log a single line: "Ollama: reachable / models: [list]" or "Ollama: not reachable — will fall back". Surfaces in the Output panel under "Claude Sessions", no popup.

## Success Criteria

- **SC-1**: A clean install of `claude-sessions-0.7.1.vsix` on this user's machine produces zero warning popups on activation.
- **SC-2**: First click of "Analyze topics" on a 30-turn session completes in ≤ 60 s using `llama3.2:3b`.
- **SC-3**: First click of 📡 agent graph completes in ≤ 90 s end-to-end using `nomic-embed-text`.
- **SC-4**: Switching `classify.backend` to `claude-p` in settings and re-clicking "Analyze topics" uses Haiku without window reload.
- **SC-5**: A fresh `npm install && npm run package` rebuilds the native module against the local VS Code's Electron version automatically.

## Out of scope

- Transformers.js fallback for embeddings — still parked.
- A separate "model picker" webview — declarative settings are enough.
- Auto-pulling `llama3.2:3b` from inside the extension — surface install instructions in the README instead.
