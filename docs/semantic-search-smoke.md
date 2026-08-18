# Semantic search — manual smoke (local Ollama required; CI does not run this)

Preconditions: Ollama running with `nomic-embed-text` pulled; open the agent
graph once (or wait for an index pass) so session vectors exist under the
`ollama/nomic-embed-text@v2` tag. Then open **Claude · Search** and turn on
the **Semantic** toggle.

For each pair below, type the paraphrase query (which deliberately shares no
keywords with the target) and confirm the expected session appears in the
**Sessions (semantic)** pane — ideally in the top 3 — while the LIKE panes
miss it. Fill in the expected-session column from your own corpus before
running; keep the queries.

| # | Paraphrase query | Expected session (title / id) | Pass |
|---|---|---|---|
| 1 | `rework the component state container` | _a refactoring session, e.g. "refactor the widget store"_ | ☐ |
| 2 | `why is the extension slow to start` | _a startup/perf debugging session_ | ☐ |
| 3 | `hook up the vector similarity lookup` | _this feature's own PR1 session (cosine `nearestSessions`)_ | ☐ |
| 4 | `automated overnight coding run went wrong` | _a night-build / orchestrator debugging session_ | ☐ |
| 5 | `publish a new release of the plugin` | _a version-bump / vsce package session_ | ☐ |

Also verify the fallbacks:

- Stop Ollama → status shows exactly `keyword (semantic unavailable)`; LIKE panes still work; no error modal.
- Fresh corpus with some sessions unembedded → status shows `semantic over K/N`.
- Toggle off → view behaves exactly as before the feature (no semantic pane, no Ollama traffic).
- Empty query → no Ollama probe/embed calls (watch the Ollama log stay quiet).
