// embedMany: Ollama per-item failures must skip (not substitute 256-dim
// fallback under an ollama/* model tag). filterSameDimEmbeddings keeps UMAP
// input rectangular. Store round-trip asserts skipped ids stay in
// sessionsMissingEmbedding.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  embedMany,
  filterSameDimEmbeddings,
  EmbedConfig,
  EmbedManyDeps,
} from "../../src/embedding";
import { SessionStore, SessionRow } from "../../src/db";

const CFG: EmbedConfig = {
  preferred: "ollama",
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaModel: "nomic-embed-text",
};

function vec(dim: number, fill = 1): Float32Array {
  return new Float32Array(dim).fill(fill);
}

function sessionRow(id: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: id,
    source: "claude",
    project_path: "/tmp/demo",
    project_id: "demo",
    projects_touched: ["demo"],
    jsonl_path: `/tmp/${id}.jsonl`,
    mtime_ns: 1_700_000_000_000_000,
    size_bytes: 100,
    started_at: Date.parse("2026-07-01T10:00:00.000Z"),
    ended_at: Date.parse("2026-07-01T10:30:00.000Z"),
    message_count: 2,
    tool_count: 0,
    subagent_count: 0,
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0.01,
    model: "claude-fable-5",
    title: id,
    first_user_msg: "hello",
    entrypoint: null,
    is_automated: false,
    indexed_at: Date.now(),
    last_assistant_text_at: Date.now(),
    extras_json: null,
    kind: "session",
    parent_session_id: null,
    workflow_id: null,
    ...overrides,
  };
}

describe("filterSameDimEmbeddings", () => {
  it("keeps the modal dimension and drops outliers", () => {
    const rows = [
      { id: "a", embedding: vec(768) },
      { id: "b", embedding: vec(768) },
      { id: "poison", embedding: vec(256) },
      { id: "c", embedding: vec(768) },
    ];
    const { kept, dropped, dim } = filterSameDimEmbeddings(rows);
    expect(dim).toBe(768);
    expect(kept.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
    expect(dropped.map((r) => r.id)).toEqual(["poison"]);
  });

  it("returns empty for an empty batch", () => {
    expect(filterSameDimEmbeddings([])).toEqual({ kept: [], dropped: [], dim: null });
  });
});

describe("embedMany — ollama per-item skip (no mixed-dim poison)", () => {
  it("skips a failing item after retries; all results share one dim; model stays ollama/*", async () => {
    let calls = 0;
    const deps: EmbedManyDeps = {
      probe: async () => true,
      sleep: async () => {}, // no real backoff in tests
      embedOllama: async (text) => {
        calls++;
        if (text.includes("FAIL")) throw new Error("simulated ollama hiccup");
        return vec(768, 0.5);
      },
    };

    const out = await embedMany(
      [
        { session_id: "s1", text: "ok one" },
        { session_id: "s2", text: "FAIL me" },
        { session_id: "s3", text: "ok two" },
      ],
      CFG,
      undefined,
      deps,
    );

    expect(out.model).toBe("ollama/nomic-embed-text");
    expect(out.results.map((r) => r.session_id).sort()).toEqual(["s1", "s3"]);
    expect(out.skipped).toEqual(["s2"]);
    // Every persisted vector is 768-dim — never 256 under ollama/*
    expect(out.results.every((r) => r.embedding.length === 768)).toBe(true);
    expect(out.results.some((r) => r.embedding.length === 256)).toBe(false);
    // FAIL item: 1 + OLLAMA_MAX_RETRIES (2) = 3 attempts; ok items: 1 each
    expect(calls).toBe(3 + 1 + 1);
  });

  it("uses hash-BoW only when probe fails (whole-batch fallback model id)", async () => {
    const out = await embedMany(
      [
        { session_id: "a", text: "hello world project" },
        { session_id: "b", text: "another session text" },
      ],
      CFG,
      undefined,
      { probe: async () => false },
    );
    expect(out.model).toMatch(/^fallback\/hash-bow-/);
    expect(out.skipped).toEqual([]);
    expect(out.results).toHaveLength(2);
    expect(out.results.every((r) => r.embedding.length === 256)).toBe(true);
  });

  it("seed-only failure yields empty results + skipped so caller can leave unembedded", async () => {
    const out = await embedMany(
      [{ session_id: "seed", text: "FAIL" }],
      CFG,
      undefined,
      {
        probe: async () => true,
        sleep: async () => {},
        embedOllama: async () => {
          throw new Error("dead");
        },
      },
    );
    expect(out.model).toBe("ollama/nomic-embed-text");
    expect(out.results).toEqual([]);
    expect(out.skipped).toEqual(["seed"]);
  });
});

describe("embedMany + store — failed item remains in sessionsMissingEmbedding", () => {
  let dir: string;
  let store: SessionStore;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-embed-"));
    store = SessionStore.open(dir);
  });
  afterAll(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists only successful ollama vectors; skipped id still missing; umap input rectangular", async () => {
    const ids = ["emb-ok-1", "emb-fail", "emb-ok-2"];
    for (const id of ids) store.upsertSession(sessionRow(id));

    const modelId = "ollama/nomic-embed-text";
    const deps: EmbedManyDeps = {
      probe: async () => true,
      sleep: async () => {},
      embedOllama: async (text) => {
        if (text.includes("FAIL")) throw new Error("boom");
        return vec(768);
      },
    };

    const { model, results, skipped } = await embedMany(
      ids.map((id) => ({
        session_id: id,
        text: id === "emb-fail" ? "FAIL" : "ok text",
      })),
      CFG,
      undefined,
      deps,
    );
    expect(model).toBe(modelId);
    expect(skipped).toEqual(["emb-fail"]);

    for (const r of results) store.upsertEmbedding(r.session_id, r.embedding, modelId);

    const stored = store.embeddingsByModel(modelId);
    expect(stored.map((s) => s.session_id).sort()).toEqual(["emb-ok-1", "emb-ok-2"]);
    expect(stored.every((s) => s.embedding.length === 768)).toBe(true);

    // No 256-dim vector under ollama/*
    expect(stored.some((s) => s.embedding.length === 256)).toBe(false);

    const missing = store.sessionsMissingEmbedding(modelId).map((s) => s.session_id);
    expect(missing).toContain("emb-fail");
    expect(missing).not.toContain("emb-ok-1");
    expect(missing).not.toContain("emb-ok-2");

    // UMAP-shaped: filter is a no-op when all dims match
    const { kept, dropped, dim } = filterSameDimEmbeddings(stored);
    expect(dim).toBe(768);
    expect(dropped).toHaveLength(0);
    expect(kept).toHaveLength(2);
    // Rectangular matrix for umap.fit
    const matrix = kept.map((e) => Array.from(e.embedding));
    expect(matrix.every((row) => row.length === matrix[0].length)).toBe(true);
  });
});
