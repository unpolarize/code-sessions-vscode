# Embedding setup for the agent graph

The **agent graph** (📡 button on the Sessions title bar) needs a vector per
session so it can lay them out by similarity. The extension picks one of two
backends at runtime:

| Backend | When it's used | Quality | Setup |
|---|---|---|---|
| **Ollama** `nomic-embed-text` | When `127.0.0.1:11434/api/tags` is reachable in ≤ 250 ms **and** the model is pulled | Semantic clusters by actual topic | One-time install + `ollama pull` |
| **Hashed bag-of-words** (built-in) | Anything else — Ollama not installed, daemon down, model not pulled, network error | Coarse — clusters by literal keyword overlap (project name, tool names, user-prompt vocabulary) | None |

The fallback is **deterministic** and ships in the extension, so the graph
**always works** even without Ollama. Install Ollama only if you want the
clustering to reflect real meaning rather than literal word overlap.

## Recommended: Ollama + nomic-embed-text

`nomic-embed-text-v1.5` is an 8K-context, 768-dim embedding model. It's fast
(~5 ms per session on Apple Silicon), small (~270 MB), and runs entirely
locally — no data ever leaves your machine.

### Install Ollama

**macOS**:

```bash
brew install ollama
brew services start ollama          # background daemon
# or run it in the foreground:
# ollama serve
```

**Linux**:

```bash
curl -fsSL https://ollama.com/install.sh | sh
systemctl --user enable --now ollama
```

### Pull the embedding model

```bash
ollama pull nomic-embed-text
```

That's ~270 MB downloaded once.

### Verify

```bash
curl -s http://127.0.0.1:11434/api/tags | grep nomic-embed-text
# should print one line containing "nomic-embed-text:latest"

curl -s http://127.0.0.1:11434/api/embeddings \
  -d '{"model":"nomic-embed-text","prompt":"hello world"}' \
  | head -c 200
# should print JSON starting with {"embedding":[0.0123, …
```

### Use it in the extension

Open the Command Palette → `Claude: Show 2D agent graph`. The status line in
the webview header will show `embedder: ollama/nomic-embed-text`. For ~1500
sessions a full cold build takes 30–60 s end-to-end; subsequent opens only
embed new sessions, then re-fit the UMAP layout (~1–2 s).

## Configuration

All three settings live under `claudeSessions.embedding.*`:

| Setting | Default | Notes |
|---|---|---|
| `embedding.preferred` | `ollama` | Set to `fallback` to force the built-in BoW vector even when Ollama is reachable (useful for testing) |
| `embedding.ollamaUrl` | `http://127.0.0.1:11434` | Change if you run Ollama on a different port or on a remote host |
| `embedding.ollamaModel` | `nomic-embed-text` | Any Ollama embedding-capable model works. `bge-m3`, `mxbai-embed-large`, and `all-minilm` are all valid alternatives |

The persisted embeddings are tagged with the model id (e.g.
`ollama/nomic-embed-text` or `fallback/hash-bow-256`). If you switch models,
the extension re-embeds every session under the new id on the next open of
the graph — old embeddings stay in the DB but are unused.

## Troubleshooting

**Probe says Ollama isn't reachable, but `ollama list` works.**
The probe expects the daemon at `embedding.ollamaUrl` (default `127.0.0.1:11434`).
If you use a Unix socket or a non-default port, set `claudeSessions.embedding.ollamaUrl`.

**"Model not pulled" — graph silently falls back.**
The probe checks `/api/tags` for a model whose name starts with
`embedding.ollamaModel`. Run `ollama pull nomic-embed-text` (or whatever model
you set), then reload the VS Code window.

**Graph hangs at "Embedding N sessions".**
Each embedding call has a 30 s timeout. If many time out, Ollama is busy
serving a chat model. Stop other Ollama workloads or reduce session count by
toggling `claudeSessions.showAutomated = false` (default).

**`ANTHROPIC_API_KEY` and Ollama.**
None — they're unrelated. Ollama runs entirely locally over HTTP. The
extension also never forwards `ANTHROPIC_API_KEY` to spawned `claude`
processes (used by topic classification) so subscription billing is
preserved.

## Why no Transformers.js?

Transformers.js (in-process embedding via WASM) is listed as a future fallback
in [`specs/001-cache-topics-graph/spec.md`](../specs/001-cache-topics-graph/spec.md)
(FR-11). It was deliberately skipped in v0.7.0 because:

- It adds ~80 MB to the extension on first run (model download to global
  storage).
- WASM inference of `bge-small-en-v1.5` on 1500 sessions takes 2–5 minutes
  vs ~30 s for Ollama.
- The hashed-BoW fallback already gives a usable layout for users who don't
  want Ollama; Transformers.js would only be a middle tier between those two.

If demand appears, it can be added behind `embedding.preferred = "transformersjs"`
without a schema change.
