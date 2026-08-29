// Search-view semantic path: probe → search_query-prefixed embed →
// cosine-ranked session rows, with the exact fallback / coverage status
// strings; toggle off must reproduce the pre-change LIKE payload and an
// empty query must touch neither probe nor embed. All network mocked at the
// module seam; own temp dir.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionStore, SessionRow } from "../../src/db";
import { EmbedConfig } from "../../src/embedding";
import { semanticSessionSearch, buildSearchResults, KEYWORD_FALLBACK_STATUS } from "../../src/semanticSearch";

const MODEL_TAG = "ollama/nomic-embed-text@v2";
const CFG: EmbedConfig = { preferred: "ollama", ollamaUrl: "http://127.0.0.1:1", ollamaModel: "nomic-embed-text" };

const TARGET = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER = "bbbbbbbb-2222-4222-8222-222222222222";

function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: TARGET,
    source: "claude",
    project_path: "/Users/tester/projects/demo",
    project_id: "demo",
    projects_touched: ["demo"],
    jsonl_path: `/Users/tester/.claude/projects/demo/${overrides.session_id ?? TARGET}.jsonl`,
    mtime_ns: 1_700_000_000_000_000,
    size_bytes: 2048,
    started_at: Date.parse("2026-07-01T10:00:00.000Z"),
    ended_at: Date.parse("2026-07-01T10:30:00.000Z"),
    message_count: 4,
    tool_count: 1,
    subagent_count: 0,
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: null,
    cost_usd: 0.1,
    model: "claude-fable-5",
    title: "refactor the widget store",
    first_user_msg: "refactor the widget store",
    entrypoint: null,
    is_automated: false,
    indexed_at: Date.parse("2026-07-01T11:00:00.000Z"),
    last_assistant_text_at: null,
    extras_json: null,
    kind: "session",
    parent_session_id: null,
    workflow_id: null,
    ...overrides,
  };
}

let dir: string;
let store: SessionStore;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-semsearch-"));
  store = SessionStore.open(dir);
  store.upsertSession(sessionRow());
  store.upsertSession(sessionRow({ session_id: OTHER, title: "unrelated ops chore", first_user_msg: "rotate the logs" }));
  // 4-dim space: TARGET along [1,0,0,0], OTHER orthogonal.
  store.upsertEmbedding(TARGET, Float32Array.from([1, 0, 0, 0]), MODEL_TAG);
  store.upsertEmbedding(OTHER, Float32Array.from([0, 1, 0, 0]), MODEL_TAG);
});

afterAll(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const okDeps = () => ({
  probe: vi.fn(async () => true),
  embedQuery: vi.fn(async () => Float32Array.from([0.9, 0.1, 0, 0])),
});

describe("semanticSessionSearch", () => {
  it("paraphrase query: semantic finds the target session, LIKE does not", async () => {
    // No LIKE field of either session contains these tokens.
    const q = "rework component state container";
    expect(store.searchTopics(q, 200)).toEqual([]);
    expect(store.searchTurns(q, 200)).toEqual([]);

    const deps = okDeps();
    const res = await semanticSessionSearch(q, store, CFG, deps);
    expect(res.available).toBe(true);
    if (!res.available) return;
    expect(res.rows[0]).toMatchObject({ session_id: TARGET, title: "refactor the widget store", project_id: "demo" });
    expect(res.rows[0].score).toBeGreaterThan(0.9);
    // OTHER is orthogonal-ish → below the 0.3 floor.
    expect(res.rows.map((r) => r.session_id)).toEqual([TARGET]);
  });

  it("embeds the query with the search_query prefix", async () => {
    const deps = okDeps();
    await semanticSessionSearch("widget refactor", store, CFG, deps);
    expect(deps.embedQuery).toHaveBeenCalledWith("search_query: widget refactor", CFG);
  });

  it("reports partial coverage as 'semantic over K/N'", async () => {
    const res = await semanticSessionSearch("widget", store, CFG, okDeps());
    // 2 vectors, 3 non-automated sessions once the extra parent lands below —
    // here the corpus is exactly covered, so first assert full coverage…
    expect(res.available && res.status).toBe("semantic");
    // …then add an unembedded session and expect the K/N string.
    store.upsertSession(sessionRow({ session_id: "cccccccc-3333-4333-8333-333333333333", title: "no vector yet" }));
    const partial = await semanticSessionSearch("widget", store, CFG, okDeps());
    expect(partial.available && partial.status).toBe("semantic over 2/3");
  });

  it("probe failure falls back with the exact keyword status", async () => {
    const deps = { probe: vi.fn(async () => false), embedQuery: vi.fn() };
    const res = await semanticSessionSearch("widget", store, CFG, deps);
    expect(res).toEqual({ available: false, reason: "probe", status: KEYWORD_FALLBACK_STATUS });
    expect(res.status).toBe("keyword (semantic unavailable)");
    expect(deps.embedQuery).not.toHaveBeenCalled();
  });

  it("embed error falls back without throwing", async () => {
    const deps = { probe: vi.fn(async () => true), embedQuery: vi.fn(async () => { throw new Error("boom"); }) };
    const res = await semanticSessionSearch("widget", store, CFG, deps);
    expect(res).toEqual({ available: false, reason: "embed-error", status: KEYWORD_FALLBACK_STATUS });
  });

  it("no vectors under the tag falls back before probing", async () => {
    const deps = okDeps();
    const res = await semanticSessionSearch("widget", store, { ...CFG, ollamaModel: "other-model" }, deps);
    expect(res).toEqual({ available: false, reason: "no-vectors", status: KEYWORD_FALLBACK_STATUS });
    expect(deps.probe).not.toHaveBeenCalled();
  });
});

describe("buildSearchResults", () => {
  it("toggle off ≡ pre-change LIKE payload: same keys, no probe, no embed", async () => {
    const deps = okDeps();
    const payload = await buildSearchResults("widget", false, store, CFG, deps);
    expect(payload).toEqual({
      command: "results",
      q: "widget",
      topics: store.searchTopics("widget", 200),
      conversations: store.searchTurns("widget", 200),
    });
    expect(Object.keys(payload).sort()).toEqual(["command", "conversations", "q", "topics"]);
    expect(deps.probe).not.toHaveBeenCalled();
    expect(deps.embedQuery).not.toHaveBeenCalled();
  });

  it("empty query calls neither probe nor embed even with semantic on", async () => {
    const deps = okDeps();
    const payload = await buildSearchResults("   ", true, store, CFG, deps);
    expect(payload).toEqual({ command: "results", q: "   ", topics: [], conversations: [] });
    expect(deps.probe).not.toHaveBeenCalled();
    expect(deps.embedQuery).not.toHaveBeenCalled();
  });

  it("trims the query before embedding", async () => {
    const deps = okDeps();
    await buildSearchResults("  widget refactor  ", true, store, CFG, deps);
    expect(deps.embedQuery).toHaveBeenCalledWith("search_query: widget refactor", CFG);
  });

  it("semantic on attaches the semantic result alongside the LIKE panes", async () => {
    const payload = await buildSearchResults("rework component state container", true, store, CFG, okDeps());
    expect(payload.semantic?.available).toBe(true);
    expect(payload.topics).toEqual([]);
    expect(payload.conversations).toEqual([]);
  });
});
