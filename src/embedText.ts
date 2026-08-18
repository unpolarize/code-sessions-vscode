// Shared embedding-text recipe for session vectors (agent graph + semantic
// search use ONE vector space under ONE tag: `<model>@<RECIPE_REV>`).
//
// Documents are prefixed `search_document:`, queries `search_query:` (the
// nomic-embed family expects these; Ollama injects nothing itself). Bump
// RECIPE_REV whenever the produced text changes for the same session — the
// tag mismatch is what triggers re-embedding.

export const RECIPE_REV = "v2";

/** Hard cap on the embed text; only FIRST USER is ever truncated. */
export const EMBED_TEXT_MAX_CHARS = 4096;

/** Minimum cosine score for a session to appear in semantic search results. */
export const SEMANTIC_SCORE_FLOOR = 0.3;

/** Compose the persisted embedding_model tag, e.g. `ollama/nomic-embed-text@v2`. */
export function taggedEmbeddingModel(model: string): string {
  return `${model}@${RECIPE_REV}`;
}

export interface SessionEmbedFields {
  projects_touched: string[];
  project_id: string | null;
  title: string | null;
  first_user_msg: string | null;
}

/**
 * Deterministic embed text. Sections with an empty value are omitted
 * entirely; caps are topics ≤20, tools ≤30 (inputs arrive pre-ordered
 * freq-desc with alpha tiebreak from the store aggregates).
 */
export function buildSessionEmbedText(s: SessionEmbedFields, topics: string[], tools: string[]): string {
  const sections: string[] = [];
  const project = s.projects_touched.join(", ") || s.project_id || "";
  if (project) sections.push(`PROJECT: ${project}`);
  if (s.title) sections.push(`TITLE: ${s.title}`);
  if (topics.length > 0) sections.push(`TOPICS: ${topics.slice(0, 20).join(", ")}`);
  if (tools.length > 0) sections.push(`TOOLS: ${tools.slice(0, 30).join(", ")}`);
  const head = "search_document: " + sections.join("\n");
  const first = s.first_user_msg ?? "";
  if (!first) return head;
  const prefix = (sections.length > 0 ? head + "\n" : head) + "FIRST USER: ";
  const room = EMBED_TEXT_MAX_CHARS - prefix.length;
  if (room <= 0) return head;
  return prefix + first.slice(0, room);
}

/** Queries get the paired prefix so they land in the same vector space. */
export function buildQueryEmbedText(query: string): string {
  return `search_query: ${query}`;
}

/**
 * Deterministic FNV-1a hash of the embed text, persisted next to the vector.
 * A stored hash that no longer matches the freshly built text marks the row
 * stale (e.g. embedded before topic classification filled TOPICS) even though
 * the recipe rev — and therefore the tag — is unchanged.
 */
export function embedTextHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
