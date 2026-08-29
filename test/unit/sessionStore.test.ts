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
    reasoning_tokens: null,
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
    reasoning_tokens: null,
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

  it("deleteSession cascades turns, star, and hide", () => {
    const id = "88888888-8888-4888-8888-888888888888";
    store.upsertSession(sessionRow({
      session_id: id,
      jsonl_path: "/Users/tester/.claude/projects/demo/other.jsonl",
    }));
    store.upsertTurns([turnRow({ session_id: id, turn_uuid: "turn-del-1" })]);
    store.starSession(id);
    store.setHidden(id, true);
    expect(store.getById(id)).not.toBeNull();
    expect(store.turnsForSession(id).length).toBe(1);
    expect(store.starredSessionIds().has(id)).toBe(true);
    expect(store.hiddenSessionIds().has(id)).toBe(true);
    expect(store.deleteSession(id)).toBe(1);
    expect(store.getById(id)).toBeNull();
    expect(store.turnsForSession(id).length).toBe(0);
    expect(store.starredSessionIds().has(id)).toBe(false);
    expect(store.hiddenSessionIds().has(id)).toBe(false);
  });
});

describe("listRecent requireReply window", () => {
  it("does not let empty jsonl-opens occupy the limit ahead of real chats", () => {
    const now = Date.parse("2026-08-26T18:00:00.000Z");
    const day = 86_400_000;
    // 80 newest-mtime rows never got a reply (panel open).
    for (let i = 0; i < 80; i++) {
      store.upsertSession(
        sessionRow({
          session_id: `empty-${String(i).padStart(4, "0")}-0000-4000-8000-000000000000`,
          jsonl_path: `/tmp/empty-${i}.jsonl`,
          mtime_ns: (now - i * 1000) * 1e6,
          last_assistant_text_at: null,
          title: `empty ${i}`,
        }),
      );
    }
    const older = sessionRow({
      session_id: "aaaa1111-0000-4000-8000-00000000old1",
      jsonl_path: "/tmp/old-human.jsonl",
      mtime_ns: (now - 10 * day) * 1e6,
      last_assistant_text_at: now - 10 * day,
      title: "week-ago human chat",
      is_automated: false,
    });
    const today = sessionRow({
      session_id: "aaaa1111-0000-4000-8000-00000000tod1",
      jsonl_path: "/tmp/today-human.jsonl",
      mtime_ns: now * 1e6,
      last_assistant_text_at: now,
      title: "today human chat",
      is_automated: false,
    });
    store.upsertSession(older);
    store.upsertSession(today);

    const byMtime = store.listRecent(10, true);
    expect(byMtime.every((r) => r.title?.startsWith("empty") || r.title === "today human chat")).toBe(true);
    expect(byMtime.some((r) => r.title === "week-ago human chat")).toBe(false);

    const byReply = store.listRecent(10, true, { requireReply: true });
    const titles = byReply.map((r) => r.title);
    expect(titles).toContain("today human chat");
    expect(titles).toContain("week-ago human chat");
    expect(titles.some((t) => t?.startsWith("empty"))).toBe(false);
    expect(byReply[0].title).toBe("today human chat");
  });
});
