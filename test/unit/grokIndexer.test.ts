// Fixture tests for the grok session indexer (kp: tasks/csv-fixture-tests-for-claude-grok-git-indexers-s).
// listAllGrokSessions/buildGrokRows run against a synthetic ~/.grok/sessions-shaped
// tree under test/fixtures/grokstore (cwd-encoded parent / uuid dir) — no home-dir access.
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { listAllGrokSessions, buildGrokRows, locateGrokChatHistory, planGrokSync, applyGrokParsed, type GrokParsedItem } from "../../src/grokIndexer";
import { handleWorkerRequest, type WorkerEvent } from "../../src/grokParseWorker";
import type { SessionStore, SessionRow, TurnRow } from "../../src/db";
import { estimateGrokCostUsd } from "../../src/grokPricing";

/** In-memory stand-in mirroring jsonlIndexer.test.ts. */
function fakeStore(seedKnown: Array<[string, { mtime_ns: number; size_bytes: number }]> = []) {
  const sessions = new Map<string, SessionRow>();
  const turns = new Map<string, TurnRow[]>();
  const known = new Map(seedKnown);
  const store = {
    knownPaths: () => new Map(known),
    deleteByPaths: (paths: string[]) => {
      let n = 0;
      for (const p of paths) if (known.delete(p)) n += 1;
      return n;
    },
    upsertSession: (s2: SessionRow) => {
      sessions.set(s2.session_id, s2);
      known.set(s2.jsonl_path, { mtime_ns: s2.mtime_ns, size_bytes: s2.size_bytes });
    },
    extrasByPath: () => {
      const m = new Map<string, string>();
      for (const s2 of sessions.values()) {
        if (s2.extras_json) m.set(s2.jsonl_path, s2.extras_json);
      }
      return m;
    },
    deleteTurnsForSession: (id: string) => turns.delete(id),
    upsertTurns: (rows: TurnRow[]) => {
      for (const r of rows) {
        const list = turns.get(r.session_id) ?? [];
        list.push(r);
        turns.set(r.session_id, list);
      }
    },
  };
  return { store: store as unknown as SessionStore, sessions, turns, known };
}

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
    // No usage.json in this fixture — contextTokensUsed is uncached input.
    expect(session.input_tokens).toBe(4321);
    expect(session.output_tokens).toBe(0);
    expect(session.cost_usd).toBe(
      estimateGrokCostUsd(
        { inputTokens: 4321, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        "grok-4.5",
      ),
    );
    expect(session.cost_usd).toBeGreaterThan(0);
    expect(session.tool_count).toBe(7); // signals.toolCallCount over chat scan
    expect(session.started_at).toBe(Date.parse("2026-07-20T10:00:00Z"));
    expect(session.ended_at).toBe(Date.parse("2026-07-20T10:06:00Z")); // last_active_at wins
    expect(session.last_assistant_text_at).toBe(Date.parse("2026-07-20T10:06:00Z"));
    expect(JSON.parse(session.extras_json!)).toMatchObject({
      contextTokensUsed: 4321,
      automated: false,
      continued_by_human: false,
      cost_estimated: true,
      cost_token_source: "signals.contextTokensUsed",
    });
    expect(session.is_automated).toBe(false);

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

  it("usage.json input/output/cache drives as-if-API cost (exclusive buckets)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csv-grok-usage-"));
    const src = infoFor(S_VALID);
    fs.copyFileSync(src.chatPath, path.join(tmp, "chat_history.jsonl"));
    fs.copyFileSync(src.summaryPath, path.join(tmp, "summary.json"));
    fs.writeFileSync(
      path.join(tmp, "usage.json"),
      JSON.stringify({
        session: {
          inputTokens: 1000,
          outputTokens: 40,
          cachedReadTokens: 200,
          cacheCreationTokens: 5,
          reasoningTokens: 12,
          primaryModelId: "grok-4.6-build",
        },
      }),
    );
    const rows = buildGrokRows({
      sessionDir: tmp,
      chatPath: path.join(tmp, "chat_history.jsonl"),
      summaryPath: path.join(tmp, "summary.json"),
      mtime_ns: 1,
      size_bytes: 1,
    });
    expect(rows).not.toBeNull();
    expect(rows!.session.input_tokens).toBe(800);
    expect(rows!.session.output_tokens).toBe(40);
    expect(rows!.session.cache_read_tokens).toBe(200);
    expect(rows!.session.cache_write_tokens).toBe(5);
    expect(rows!.session.reasoning_tokens).toBe(12);
    expect(rows!.session.model).toBe("grok-4.6-build");
    expect(rows!.session.cost_usd).toBe(
      estimateGrokCostUsd(
        { inputTokens: 800, outputTokens: 40, cacheReadTokens: 200, cacheWriteTokens: 5 },
        "grok-4.6-build",
      ),
    );
    expect(JSON.parse(rows!.session.extras_json!).cost_token_source).toBe("usage.json");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("missing tokens (no usage.json, no contextTokensUsed) → cost $0", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csv-grok-notok-"));
    const src = infoFor(S_VALID);
    fs.copyFileSync(src.chatPath, path.join(tmp, "chat_history.jsonl"));
    fs.copyFileSync(src.summaryPath, path.join(tmp, "summary.json"));
    const rows = buildGrokRows({
      sessionDir: tmp,
      chatPath: path.join(tmp, "chat_history.jsonl"),
      summaryPath: path.join(tmp, "summary.json"),
      mtime_ns: 1,
      size_bytes: 1,
    });
    expect(rows).not.toBeNull();
    expect(rows!.session.input_tokens).toBe(0);
    expect(rows!.session.cost_usd).toBe(0);
    expect(JSON.parse(rows!.session.extras_json!)).toMatchObject({
      cost_estimated: false,
      cost_token_source: "none",
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("planGrokSync + worker + applyGrokParsed (spec S4': parse off the host thread)", () => {
  it("plans new/changed files and stale removals scoped to the grok root", () => {
    const stale = path.join(ROOT, "%2FUsers%2Ftester%2Fprojects%2Fdemo", "gone", "chat_history.jsonl");
    const claudeRow = "/Users/tester/.claude/projects/-x/a.jsonl";
    const { store } = fakeStore([
      [stale, { mtime_ns: 1, size_bytes: 1 }],
      [claudeRow, { mtime_ns: 1, size_bytes: 1 }],
    ]);
    const plan = planGrokSync(store, { root: ROOT });
    expect(plan.totalOnDisk).toBe(4);
    expect(plan.toParse.length).toBe(4); // nothing cached yet
    expect(plan.removedPaths).toEqual([stale]); // never the claude row
  });

  it("worker handle() parses the plan and applyGrokParsed writes the store", () => {
    const { store, sessions, known } = fakeStore();
    const plan = planGrokSync(store, { root: ROOT });
    const events: WorkerEvent[] = [];
    handleWorkerRequest({ kind: "parse", files: plan.toParse }, (ev) => events.push(ev));
    const done = events.find((e) => e.kind === "done") as Extract<WorkerEvent, { kind: "done" }>;
    expect(done.parsed + done.errors).toBe(plan.toParse.length);
    let parsed = 0;
    let skipped = 0;
    for (const ev of events) {
      if (ev.kind !== "item") continue;
      const r = applyGrokParsed(store, ev as unknown as GrokParsedItem);
      if (r === "parsed") parsed += 1;
      else if (r === "skipped") skipped += 1;
    }
    // Valid + corrupt-summary parse into rows; stillborn + claude_import are skips.
    expect(parsed).toBeGreaterThanOrEqual(1);
    expect(skipped).toBeGreaterThanOrEqual(2);
    expect(sessions.has(S_VALID)).toBe(true);
    // Second plan over the same store: everything cached, nothing to parse.
    const plan2 = planGrokSync(store, { root: ROOT });
    expect(plan2.toParse.map((i) => i.chatPath)).not.toContain([...known.keys()][0]);
    expect(plan2.toParse.length).toBe(plan.toParse.length - parsed);
  });
});
