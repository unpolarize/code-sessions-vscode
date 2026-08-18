// Host side of the search view's Semantic toggle: probe Ollama, embed the
// query with the paired `search_query:` prefix, cosine-rank persisted
// session vectors under the shared `ollama/<model>@<rev>` tag.
//
// Everything network-shaped is injectable so tests run fixture-only. The
// fallback status strings are load-bearing — the webview shows them verbatim
// and tests assert them byte-for-byte.

import { SessionStore } from "./db";
import { EmbedConfig, probeOllama, embedOllamaOne } from "./embedding";
import { buildQueryEmbedText, taggedEmbeddingModel, SEMANTIC_SCORE_FLOOR } from "./embedText";

export const KEYWORD_FALLBACK_STATUS = "keyword (semantic unavailable)";

export interface SemanticSessionHit {
  session_id: string;
  title: string | null;
  project_id: string | null;
  score: number;
}

export type SemanticSearchResult =
  | { available: true; rows: SemanticSessionHit[]; status: string }
  | { available: false; reason: "probe" | "no-vectors" | "embed-error"; status: typeof KEYWORD_FALLBACK_STATUS };

/** Injectable seams for unit tests (default = real HTTP). */
export interface SemanticSearchDeps {
  probe?: (cfg: EmbedConfig) => Promise<boolean>;
  embedQuery?: (text: string, cfg: EmbedConfig) => Promise<Float32Array>;
}

export async function semanticSessionSearch(
  query: string,
  store: SessionStore,
  cfg: EmbedConfig,
  deps: SemanticSearchDeps = {},
): Promise<SemanticSearchResult> {
  const probe = deps.probe ?? probeOllama;
  const embedQuery = deps.embedQuery ?? embedOllamaOne;
  const tag = taggedEmbeddingModel(`ollama/${cfg.ollamaModel}`);

  const coverage = store.sessionEmbeddingCoverage(tag);
  if (coverage.embedded === 0) {
    return { available: false, reason: "no-vectors", status: KEYWORD_FALLBACK_STATUS };
  }
  if (!(await probe(cfg))) {
    return { available: false, reason: "probe", status: KEYWORD_FALLBACK_STATUS };
  }

  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await embedQuery(buildQueryEmbedText(query), cfg);
  } catch {
    return { available: false, reason: "embed-error", status: KEYWORD_FALLBACK_STATUS };
  }

  const ranked = store.nearestSessions(queryEmbedding, tag, 50, SEMANTIC_SCORE_FLOOR);
  const rows: SemanticSessionHit[] = ranked.map((r) => {
    const s = store.getById(r.session_id);
    return {
      session_id: r.session_id,
      title: s?.title ?? null,
      project_id: s?.project_id ?? null,
      score: r.score,
    };
  });
  const status =
    coverage.embedded < coverage.total ? `semantic over ${coverage.embedded}/${coverage.total}` : "semantic";
  return { available: true, rows, status };
}

/**
 * Full results payload for one search-view query. With `semantic` off (or an
 * empty query) the shape is byte-identical to the pre-toggle LIKE payload —
 * no extra keys, no probe, no embed.
 */
export async function buildSearchResults(
  q: string,
  semantic: boolean,
  store: SessionStore,
  cfg: EmbedConfig,
  deps: SemanticSearchDeps = {},
): Promise<{ command: "results"; q: string; topics: unknown[]; conversations: unknown[]; semantic?: SemanticSearchResult }> {
  const hasQuery = q.trim().length > 0;
  const topics = hasQuery ? store.searchTopics(q, 200) : [];
  const conversations = hasQuery ? store.searchTurns(q, 200) : [];
  const payload: Awaited<ReturnType<typeof buildSearchResults>> = { command: "results", q, topics, conversations };
  if (semantic && hasQuery) {
    payload.semantic = await semanticSessionSearch(q.trim(), store, cfg, deps);
  }
  return payload;
}
