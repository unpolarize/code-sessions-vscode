// Consumer-driven background re-embed job (semantic search PR3).
//
// Any consumer that finds missing or stale session vectors under the shared
// `ollama/<model>@<rev>` tag — agent graph open, search view Semantic toggle,
// the "Drop all + re-embed" command — kicks ONE background job. Jobs are
// single-flight: a kick while one is running returns the in-flight promise
// instead of starting a second embedding pass. Staleness is hash-based: a row
// whose stored `text_hash` differs from the freshly built embed text (topics
// classified after an early embed, new tool turns, NULL pre-v18 hash) gets
// re-embedded even though its tag is current.
//
// vscode-free so tests run fixture-only; UI callers wrap `kickReembed` in
// `vscode.window.withProgress` and feed `onProgress` / `isCancelled` through.

import { SessionStore, SessionRow } from "./db";
import { embedMany, EmbedConfig, probeOllama, EmbedManyDeps } from "./embedding";
import { buildSessionEmbedText, embedTextHash, taggedEmbeddingModel } from "./embedText";

/** Sessions embedded per embedMany batch; cancellation is checked between batches. */
const REEMBED_CHUNK = 25;

/** After a failed probe, kicks within this window fail fast without re-probing. */
export const PROBE_FAIL_COOLDOWN_MS = 60_000;

/**
 * Batch-build embed texts via the shared v2 recipe: enriched with classified
 * topics + tool mix pulled from the store in two aggregate queries.
 */
export function buildEmbedTexts(store: SessionStore, sessions: SessionRow[]): Map<string, string> {
  const out = new Map<string, string>();
  // Chunk the aggregate lookups — the IN(...) expansion hits sqlite-wasm's
  // bind-variable ceiling on multi-thousand-session corpora.
  const CHUNK = 400;
  for (let i = 0; i < sessions.length; i += CHUNK) {
    const chunk = sessions.slice(i, i + CHUNK);
    const ids = chunk.map((s) => s.session_id);
    const topics = store.topTopicsBySession(ids, 20);
    const tools = store.topToolsBySession(ids, 30);
    for (const s of chunk) {
      out.set(
        s.session_id,
        buildSessionEmbedText(s, topics.get(s.session_id)?.top ?? [], tools.get(s.session_id) ?? []),
      );
    }
  }
  return out;
}

/**
 * Sessions that need (re-)embedding under one tag: no stored row, or a stored
 * hash that no longer matches the current embed text (NULL hash counts as a
 * mismatch — the text that produced the vector is unknown).
 */
export function selectReembedTargets(
  sessions: SessionRow[],
  texts: Map<string, string>,
  hashes: Map<string, string | null>,
): SessionRow[] {
  return sessions.filter((s) => {
    if (!hashes.has(s.session_id)) return true;
    const text = texts.get(s.session_id);
    return text === undefined || hashes.get(s.session_id) !== embedTextHash(text);
  });
}

export type ReembedOutcome =
  | { ok: true; embedded: number; skipped: number; total: number; cancelled: boolean }
  | { ok: false; reason: "probe" };

export interface ReembedOpts {
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
  deps?: EmbedManyDeps & { now?: () => number };
}

let inFlight: Promise<ReembedOutcome> | null = null;
let lastProbeFailAt = -Infinity;

export function reembedInFlight(): boolean {
  return inFlight !== null;
}

/** Test seam: clear the single-flight slot and the probe-fail cooldown. */
export function resetReembedStateForTests(): void {
  inFlight = null;
  lastProbeFailAt = -Infinity;
}

/**
 * Kick the background re-embed job. Single-flight: while a job is running,
 * every kick returns the same promise (the second consumer's progress/cancel
 * hooks are ignored — the first caller owns the UI).
 */
export function kickReembed(store: SessionStore, cfg: EmbedConfig, opts: ReembedOpts = {}): Promise<ReembedOutcome> {
  if (inFlight) return inFlight;
  const p = runReembed(store, cfg, opts).finally(() => {
    if (inFlight === p) inFlight = null;
  });
  inFlight = p;
  return p;
}

async function runReembed(store: SessionStore, cfg: EmbedConfig, opts: ReembedOpts): Promise<ReembedOutcome> {
  const deps = opts.deps ?? {};
  const now = deps.now ?? Date.now;
  const probe = deps.probe ?? probeOllama;

  // The job only ever writes under the ollama tag (the shared search+graph
  // space) — with Ollama down there is nothing useful to do, so fail fast and
  // don't re-probe on every debounced search keystroke.
  if (now() - lastProbeFailAt < PROBE_FAIL_COOLDOWN_MS) return { ok: false, reason: "probe" };
  if (!(await probe(cfg))) {
    lastProbeFailAt = now();
    return { ok: false, reason: "probe" };
  }

  const tag = taggedEmbeddingModel(`ollama/${cfg.ollamaModel}`);
  const sessions = store.listRecent(100_000, false);
  const texts = buildEmbedTexts(store, sessions);
  const hashes = store.sessionEmbeddingHashes(tag);
  const targets = selectReembedTargets(sessions, texts, hashes);
  if (targets.length === 0) return { ok: true, embedded: 0, skipped: 0, total: 0, cancelled: false };

  // Already probed above — force the ollama path and stub embedMany's probe
  // so per-chunk calls don't each pay another round-trip.
  const embedCfg: EmbedConfig = { ...cfg, preferred: "ollama" };
  const chunkDeps: EmbedManyDeps = { ...deps, probe: async () => true };

  let embedded = 0;
  let skipped = 0;
  let cancelled = false;
  for (let i = 0; i < targets.length; i += REEMBED_CHUNK) {
    if (opts.isCancelled?.()) {
      cancelled = true;
      break;
    }
    const chunk = targets.slice(i, i + REEMBED_CHUNK);
    const reqs = chunk.map((s) => ({ session_id: s.session_id, text: texts.get(s.session_id)! }));
    const { results, skipped: chunkSkipped } = await embedMany(
      reqs,
      embedCfg,
      (done) => opts.onProgress?.(i + done, targets.length),
      chunkDeps,
    );
    for (const r of results) {
      store.upsertEmbedding(r.session_id, r.embedding, tag, embedTextHash(texts.get(r.session_id)!));
    }
    embedded += results.length;
    skipped += chunkSkipped.length;
  }
  return { ok: true, embedded, skipped, total: targets.length, cancelled };
}
