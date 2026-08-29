// Fixture tests for the grok session indexer (kp: tasks/csv-fixture-tests-for-claude-grok-git-indexers-s).
// listAllGrokSessions/buildGrokRows run against a synthetic ~/.grok/sessions-shaped
// tree under test/fixtures/grokstore (cwd-encoded parent / uuid dir) — no home-dir access.
import { describe, it, expect } from "vitest";
import * as path from "path";
import { listAllGrokSessions, buildGrokRows, locateGrokChatHistory } from "../../src/grokIndexer";

const ROOT = path.resolve(__dirname, "../fixtures/grokstore");

const S_VALID = "0199cccc-0000-4000-8000-000000000001";
const S_NO_SUMMARY = "0199cccc-0000-4000-8000-000000000002";
const S_STILLBORN = "0199cccc-0000-4000-8000-000000000003";
const S_CLAUDE_IMPORT = "0199cccc-0000-4000-8000-000000000004";
const S_CORRUPT_SUMMARY = "0199cccc-0000-4000-8000-000000000005";

function infoFor(uuid: string) {
  const info = listAllGrokSessions(ROOT).find((i) => i.sessionDir.endsWith(uuid));
  if (!info) throw new Error(`fixture session ${uuid} not found`);
  return info;
}

describe("listAllGrokSessions", () => {
  it("collects only session dirs that have both chat_history.jsonl and summary.json", () => {
    const all = listAllGrokSessions(ROOT);
    const ids = all.map((i) => path.basename(i.sessionDir)).sort();
    expect(ids).toEqual([S_VALID, S_STILLBORN, S_CLAUDE_IMPORT, S_CORRUPT_SUMMARY]);
    expect(ids).not.toContain(S_NO_SUMMARY);
    for (const i of all) {
      expect(i.chatPath.endsWith("chat_history.jsonl")).toBe(true);
      expect(i.mtime_ns).toBeGreaterThan(0);
    }
  });

  it("missing root → empty list, no throw", () => {
    expect(listAllGrokSessions(path.join(ROOT, "does-not-exist"))).toEqual([]);
  });
});

describe("locateGrokChatHistory", () => {
  it("finds chat_history.jsonl under a cwd-encoded parent without the sqlite index", () => {
    const p = locateGrokChatHistory(S_VALID, ROOT);
    expect(p).toBeTruthy();
    expect(p!.endsWith(`${S_VALID}/chat_history.jsonl`)).toBe(true);
    expect(locateGrokChatHistory("no-such-session", ROOT)).toBeNull();
  });
});

describe("buildGrokRows", () => {
  it("builds session + turn rows from chat/summary/signals sidecars", () => {
    const rows = buildGrokRows(infoFor(S_VALID));
    expect(rows).not.toBeNull();
    const { session, turns } = rows!;

    expect(session.session_id).toBe(S_VALID);
    expect(session.source).toBe("grok");
    expect(session.project_path).toBe("/Users/tester/projects/demo");
    expect(session.project_id).toBe("demo");
    expect(session.projects_touched).toEqual(["demo"]);
    expect(session.title).toBe("Add health endpoint"); // generated_title wins
    expect(session.model).toBe("grok-4.5"); // signals.primaryModelId
    expect(session.entrypoint).toBe("grok"); // summary.agent_name
    // signals.contextTokensUsed proxied into input_tokens; grok has no split.
    expect(session.input_tokens).toBe(4321);
    expect(session.output_tokens).toBe(0);
    expect(session.tool_count).toBe(7); // signals.toolCallCount over chat scan
    expect(session.started_at).toBe(Date.parse("2026-07-20T10:00:00Z"));
    expect(session.ended_at).toBe(Date.parse("2026-07-20T10:06:00Z")); // last_active_at wins
    expect(session.last_assistant_text_at).toBe(Date.parse("2026-07-20T10:06:00Z"));
    expect(JSON.parse(session.extras_json!)).toMatchObject({ contextTokensUsed: 4321 });

    expect(turns.length).toBe(2);
    expect(turns[0].user_text).toBe("add a health endpoint");
    expect(turns[0].tool_names_csv).toBe("read_file,search_replace");
    expect(turns[0].turn_uuid).toBe(`${S_VALID}#0`);
    expect(turns[1].user_text).toBe("now write a test for it");
    // chat_history carries no per-turn usage — columns stay 0 by contract.
    expect(turns[0].input_tokens).toBe(0);
    expect(turns[0].output_tokens).toBe(0);
  });

  it("stillborn catalog-only session → null (kept off the sidebar)", () => {
    expect(buildGrokRows(infoFor(S_STILLBORN))).toBeNull();
  });

  it("claude_import session → null (claude indexer is authoritative)", () => {
    expect(buildGrokRows(infoFor(S_CLAUDE_IMPORT))).toBeNull();
  });

  it("corrupted summary.json → null, no throw", () => {
    expect(buildGrokRows(infoFor(S_CORRUPT_SUMMARY))).toBeNull();
  });
});
