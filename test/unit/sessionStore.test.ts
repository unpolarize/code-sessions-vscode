// SQLite (node-sqlite3-wasm) round-trip: SessionStore open → upsert → query →
// idempotent re-upsert. Each test file gets its own temp dir; forks pool keeps
// engine instances process-isolated. No writes into the repo.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionStore, SessionRow, TurnRow } from "../../src/db";

let dir: string;
let store: SessionStore;

function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: "77777777-7777-4777-8777-777777777777",
    source: "claude",
    project_path: "/Users/tester/projects/demo",
    project_id: "demo",
    projects_touched: ["demo", "docs"],
    jsonl_path: "/Users/tester/.claude/projects/demo/session.jsonl",
    mtime_ns: 1_700_000_000_000_000,
    size_bytes: 2048,
    started_at: Date.parse("2026-07-01T10:00:00.000Z"),
    ended_at: Date.parse("2026-07-01T10:30:00.000Z"),
    message_count: 4,
    tool_count: 1,
    subagent_count: 0,
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 200,
    cache_write_tokens: 100,
    cost_usd: 0.42,
    model: "claude-fable-5",
    title: "fixture session",
    first_user_msg: "list the files in src",
    entrypoint: null,
    is_automated: false,
    indexed_at: Date.parse("2026-07-01T11:00:00.000Z"),
    last_assistant_text_at: Date.parse("2026-07-01T10:29:00.000Z"),
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
    session_id: "77777777-7777-4777-8777-777777777777",
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
    cost_usd: 0.01,
    ...overrides,
  };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-store-"));
  store = SessionStore.open(dir);
});

afterAll(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SessionStore round-trip", () => {
  it("upserts a session and reads it back by id with fields intact", () => {
    store.upsertSession(sessionRow());
    const got = store.getById("77777777-7777-4777-8777-777777777777");
    expect(got).not.toBeNull();
    expect(got!.source).toBe("claude");
    expect(got!.projects_touched).toEqual(["demo", "docs"]);
    expect(got!.is_automated).toBe(false);
    expect(got!.cost_usd).toBeCloseTo(0.42, 6);
    expect(got!.title).toBe("fixture session");
    expect(got!.kind).toBe("session");
  });

  it("re-upserting the same session is idempotent (update, not duplicate)", () => {
    store.upsertSession(sessionRow({ title: "renamed", output_tokens: 999 }));
    const got = store.getById("77777777-7777-4777-8777-777777777777");
    expect(got!.title).toBe("renamed");
    expect(got!.output_tokens).toBe(999);
    const known = store.knownPaths();
    expect(known.size).toBe(1); // still one row for the jsonl path
  });

  it("upserts turns and reads them back ordered by turn_index", () => {
    store.upsertTurns([
      turnRow({ turn_uuid: "turn-0002", turn_index: 1, user_text: "second" }),
      turnRow(),
    ]);
    const turns = store.turnsForSession("77777777-7777-4777-8777-777777777777");
    expect(turns.length).toBe(2);
    expect(turns.map((t) => t.turn_index)).toEqual([0, 1]);
    expect(turns[0].user_text).toBe("list the files in src");
    expect(turns[0].has_subagent).toBe(false);
    expect(turns[1].user_text).toBe("second");
  });

  it("re-indexing the same turns is idempotent by turn_uuid", () => {
    store.upsertTurns([turnRow({ assistant_excerpt: "updated excerpt" })]);
    const turns = store.turnsForSession("77777777-7777-4777-8777-777777777777");
    expect(turns.length).toBe(2); // no duplicate rows
    expect(turns[0].assistant_excerpt).toBe("updated excerpt");
  });

  it("deleteByPaths removes the session row", () => {
    const removed = store.deleteByPaths(["/Users/tester/.claude/projects/demo/session.jsonl"]);
    expect(removed).toBe(1);
    expect(store.getById("77777777-7777-4777-8777-777777777777")).toBeNull();
  });
});
