// Store-level pieces of semantic session search: tool-frequency aggregate
// (freq-desc, alpha tiebreak, cap) and brute-force cosine ranking over
// session_embedding rows (ordering, score floor, limit, mismatched-dim skip).
// Own temp dir; no network.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionStore, SessionRow, TurnRow } from "../../src/db";

let dir: string;
let store: SessionStore;

const SID = "11111111-1111-4111-8111-111111111111";

function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: SID,
    source: "claude",
    project_path: "/Users/tester/projects/demo",
    project_id: "demo",
    projects_touched: ["demo"],
    jsonl_path: `/Users/tester/.claude/projects/demo/${overrides.session_id ?? SID}.jsonl`,
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
    title: "fixture session",
    first_user_msg: "list the files in src",
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

function turnRow(overrides: Partial<TurnRow> = {}): TurnRow {
  return {
    turn_uuid: "turn-0001",
    session_id: SID,
    turn_index: 0,
    started_at: Date.parse("2026-07-01T10:00:00.000Z"),
    ended_at: Date.parse("2026-07-01T10:00:07.000Z"),
    duration_ms: 7000,
    user_text: "list the files in src",
    assistant_excerpt: "There are two files",
    assistant_full: null,
    tool_names_csv: "Bash",
    tool_count: 1,
    has_subagent: false,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: null,
    cost_usd: 0.01,
    ...overrides,
  };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-semantic-"));
  store = SessionStore.open(dir);
  store.upsertSession(sessionRow());
});

afterAll(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("topToolsBySession", () => {
  it("aggregates tool_names_csv freq-desc with alpha tiebreak", () => {
    store.upsertTurns([
      turnRow({ turn_uuid: "t-1", turn_index: 0, tool_names_csv: "Bash,Edit,Bash" }),
      turnRow({ turn_uuid: "t-2", turn_index: 1, tool_names_csv: "Read,Edit,Bash" }),
      turnRow({ turn_uuid: "t-3", turn_index: 2, tool_names_csv: "" }),
    ]);
    const tools = store.topToolsBySession([SID]);
    // Bash ×3, Edit ×2, Read ×1
    expect(tools.get(SID)).toEqual(["Bash", "Edit", "Read"]);
  });

  it("alpha tiebreak on equal frequency and respects the cap", () => {
    const sid2 = "22222222-2222-4222-8222-222222222222";
    store.upsertSession(sessionRow({ session_id: sid2 }));
    store.upsertTurns([
      turnRow({ turn_uuid: "t-4", session_id: sid2, turn_index: 0, tool_names_csv: "Zeta,Alpha,Midway" }),
    ]);
    expect(store.topToolsBySession([sid2])).toEqual(new Map([[sid2, ["Alpha", "Midway", "Zeta"]]]));
    expect(store.topToolsBySession([sid2], 2).get(sid2)).toEqual(["Alpha", "Midway"]);
  });

  it("returns no entry for a session without tool turns", () => {
    const sid3 = "33333333-3333-4333-8333-333333333333";
    store.upsertSession(sessionRow({ session_id: sid3 }));
    expect(store.topToolsBySession([sid3]).has(sid3)).toBe(false);
  });
});

describe("nearestSessions", () => {
  const MODEL = "ollama/nomic-embed-text@v2";

  it("ranks by cosine, applies the score floor, and skips mismatched dims", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // session_embedding has an FK to session — create the parents first.
    for (const sid of ["s-exact", "s-close", "s-floor", "s-ortho", "s-baddim", "s-othermodel"]) {
      store.upsertSession(sessionRow({ session_id: sid }));
    }
    // 4-dim space; query along [1,0,0,0].
    store.upsertEmbedding("s-exact", Float32Array.from([2, 0, 0, 0]), MODEL); // cos 1.0 (magnitude ignored)
    store.upsertEmbedding("s-close", Float32Array.from([1, 1, 0, 0]), MODEL); // cos ≈ 0.707
    store.upsertEmbedding("s-floor", Float32Array.from([1, 4, 0, 0]), MODEL); // cos ≈ 0.243 < 0.3
    store.upsertEmbedding("s-ortho", Float32Array.from([0, 1, 0, 0]), MODEL); // cos 0
    store.upsertEmbedding("s-baddim", Float32Array.from([1, 0]), MODEL); // wrong dim → skipped
    store.upsertEmbedding("s-othermodel", Float32Array.from([1, 0, 0, 0]), "ollama/other@v2");

    const ranked = store.nearestSessions(Float32Array.from([1, 0, 0, 0]), MODEL);
    expect(ranked.map((r) => r.session_id)).toEqual(["s-exact", "s-close"]);
    expect(ranked[0].score).toBeCloseTo(1.0, 5);
    expect(ranked[1].score).toBeCloseTo(Math.SQRT1_2, 5);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("skipped 1");
    warn.mockRestore();
  });

  it("honors the limit", () => {
    const ranked = store.nearestSessions(Float32Array.from([1, 0, 0, 0]), MODEL, 1);
    expect(ranked.length).toBe(1);
    expect(ranked[0].session_id).toBe("s-exact");
  });

  it("returns empty for an unknown model tag", () => {
    expect(store.nearestSessions(Float32Array.from([1, 0, 0, 0]), "ollama/none@v2")).toEqual([]);
  });
});

describe("topTopicsBySession determinism", () => {
  it("breaks frequency ties alphabetically", () => {
    store.upsertTopics([
      { turn_uuid: "t-1", topic: "Zulu", model: "m", prompt_rev: 1, batch_id: "b1" },
      { turn_uuid: "t-2", topic: "Alpha", model: "m", prompt_rev: 1, batch_id: "b1" },
    ]);
    const topics = store.topTopicsBySession([SID], 20);
    expect(topics.get(SID)!.top).toEqual(["alpha", "zulu"]);
  });
});
