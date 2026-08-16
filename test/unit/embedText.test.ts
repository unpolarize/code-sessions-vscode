// Shared embed-text recipe (v2): golden template string, empty-section
// omission, FIRST-USER-only truncation, and the search_document/search_query
// prefix pairing. Pure functions — no store, no network.
import { describe, it, expect } from "vitest";
import {
  buildSessionEmbedText,
  buildQueryEmbedText,
  taggedEmbeddingModel,
  RECIPE_REV,
  EMBED_TEXT_MAX_CHARS,
  SessionEmbedFields,
} from "../../src/embedText";

function fields(overrides: Partial<SessionEmbedFields> = {}): SessionEmbedFields {
  return {
    projects_touched: ["demo", "docs"],
    project_id: "demo",
    title: "fixture session",
    first_user_msg: "list the files in src",
    ...overrides,
  };
}

describe("buildSessionEmbedText", () => {
  it("produces the byte-identical golden string for a full fixture", () => {
    const text = buildSessionEmbedText(fields(), ["sqlite", "embeddings"], ["Bash", "Edit"]);
    expect(text).toBe(
      "search_document: PROJECT: demo, docs\n" +
        "TITLE: fixture session\n" +
        "TOPICS: sqlite, embeddings\n" +
        "TOOLS: Bash, Edit\n" +
        "FIRST USER: list the files in src",
    );
  });

  it("falls back to project_id when projects_touched is empty", () => {
    const text = buildSessionEmbedText(fields({ projects_touched: [] }), [], []);
    expect(text.startsWith("search_document: PROJECT: demo\n")).toBe(true);
  });

  it("omits empty sections entirely (no blank lines, no dangling labels)", () => {
    const text = buildSessionEmbedText(
      fields({ projects_touched: [], project_id: null, title: null }),
      [],
      [],
    );
    expect(text).toBe("search_document: FIRST USER: list the files in src");
    expect(text).not.toContain("PROJECT:");
    expect(text).not.toContain("TOPICS:");
  });

  it("omits the FIRST USER line when the message is empty", () => {
    const text = buildSessionEmbedText(fields({ first_user_msg: null }), ["a"], []);
    expect(text).toBe("search_document: PROJECT: demo, docs\nTITLE: fixture session\nTOPICS: a");
  });

  it("caps topics at 20 and tools at 30", () => {
    const topics = Array.from({ length: 25 }, (_, i) => `t${i}`);
    const tools = Array.from({ length: 35 }, (_, i) => `T${i}`);
    const text = buildSessionEmbedText(fields({ first_user_msg: null }), topics, tools);
    expect(text).toContain("t19");
    expect(text).not.toContain("t20,");
    expect(text).not.toMatch(/\bt20\b/);
    expect(text).toContain("T29");
    expect(text).not.toMatch(/\bT30\b/);
  });

  it("truncates ONLY the first user message to stay within the cap", () => {
    const long = "x".repeat(10_000);
    const text = buildSessionEmbedText(fields({ first_user_msg: long }), ["sqlite"], ["Bash"]);
    expect(text.length).toBe(EMBED_TEXT_MAX_CHARS);
    expect(text).toContain("TITLE: fixture session");
    expect(text).toContain("TOOLS: Bash");
    expect(text.endsWith("x")).toBe(true);
  });

  it("is deterministic for a fixed fixture", () => {
    const a = buildSessionEmbedText(fields(), ["a", "b"], ["Bash"]);
    const b = buildSessionEmbedText(fields(), ["a", "b"], ["Bash"]);
    expect(a).toBe(b);
  });
});

describe("prefixes and tag", () => {
  it("documents carry search_document:, queries search_query:", () => {
    expect(buildSessionEmbedText(fields(), [], []).startsWith("search_document: ")).toBe(true);
    expect(buildQueryEmbedText("how did I fix the indexer")).toBe(
      "search_query: how did I fix the indexer",
    );
  });

  it("taggedEmbeddingModel appends the recipe rev", () => {
    expect(taggedEmbeddingModel("ollama/nomic-embed-text")).toBe(`ollama/nomic-embed-text@${RECIPE_REV}`);
    expect(RECIPE_REV).toBe("v2");
  });
});
