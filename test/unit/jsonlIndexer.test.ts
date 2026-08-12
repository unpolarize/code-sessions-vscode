// Fixture tests for the claude transcript indexer (kp: tasks/csv-fixture-tests-for-claude-grok-git-indexers-s).
// listAllTranscripts/syncToStore run against a synthetic ~/.claude/projects-shaped
// tree under test/fixtures/claudeprojects (encoded-cwd dir / <uuid>.jsonl, nested
// subagent + workflow children) — no home-dir access. Error accounting is
// exercised with a duck-typed in-memory store, mirroring gitIndexer.test.ts.
import { describe, it, expect } from "vitest";
import * as path from "path";
import { listAllTranscripts, listAllJsonls, syncToStore, cleanCommandText } from "../../src/jsonlIndexer";
import { SessionStore, SessionRow, TurnRow } from "../../src/db";

const ROOT = path.resolve(__dirname, "../fixtures/claudeprojects");

const S_MAIN = "0199aaaa-0000-4000-8000-000000000001";
const S_AUTO = "0199aaaa-0000-4000-8000-000000000002";

/** In-memory stand-in for SessionStore: just enough surface for syncToStore. */
function fakeStore(opts: { throwOnSessionId?: string; seedKnown?: string[] } = {}) {
  const sessions = new Map<string, SessionRow>();
  const turns = new Map<string, TurnRow[]>();
  const known = new Map<string, { mtime_ns: number; size_bytes: number }>();
  for (const p of opts.seedKnown ?? []) known.set(p, { mtime_ns: 1, size_bytes: 1 });
  const store = {
    knownPaths: () => new Map(known),
    deleteByPaths: (paths: string[]) => {
      let n = 0;
      for (const p of paths) if (known.delete(p)) n += 1;
      return n;
    },
    upsertSession: (s: SessionRow) => {
      if (s.session_id === opts.throwOnSessionId) throw new Error("injected upsert failure");
      sessions.set(s.session_id, s);
      known.set(s.jsonl_path, { mtime_ns: s.mtime_ns, size_bytes: s.size_bytes });
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
  return { store: store as unknown as SessionStore, sessions, turns };
}

describe("listAllTranscripts", () => {
  it("collects sessions plus nested subagent/workflow children, skipping index/hidden/journal files", () => {
    const all = listAllTranscripts(ROOT);
    const names = all.map((t) => path.basename(t.jsonl_path)).sort();
    expect(names).toEqual([
      `${S_MAIN}.jsonl`,
      `${S_AUTO}.jsonl`,
      "agent-abc.jsonl",
      "agent-def.jsonl",
    ]);
    for (const t of all) {
      expect(t.mtime_ns).toBeGreaterThan(0);
      expect(t.size_bytes).toBeGreaterThan(0);
    }
  });

  it("classifies kind + parent linkage by path shape", () => {
    const all = listAllTranscripts(ROOT);
    const byName = (n: string) => all.find((t) => path.basename(t.jsonl_path) === n)!;

    const main = byName(`${S_MAIN}.jsonl`);
    expect(main.kind).toBe("session");
    expect(main.parentSessionId).toBeNull();
    expect(main.workflowId).toBeNull();

    const sub = byName("agent-abc.jsonl");
    expect(sub.kind).toBe("subagent");
    expect(sub.parentSessionId).toBe(S_MAIN);
    expect(sub.workflowId).toBeNull();

    const wf = byName("agent-def.jsonl");
    expect(wf.kind).toBe("workflow");
    expect(wf.parentSessionId).toBe(S_MAIN);
    expect(wf.workflowId).toBe("wf_test-1");
  });

  it("listAllJsonls keeps only top-level sessions; missing root → empty, no throw", () => {
    const flat = listAllJsonls(ROOT).map((i) => path.basename(i.jsonl_path)).sort();
    expect(flat).toEqual([`${S_MAIN}.jsonl`, `${S_AUTO}.jsonl`]);
    expect(listAllTranscripts(path.join(ROOT, "does-not-exist"))).toEqual([]);
  });
});

describe("syncToStore", () => {
  it("parses every transcript into session + turn rows with aggregates", () => {
    const { store, sessions, turns } = fakeStore();
    const stats = syncToStore(store, { projectsRoot: ROOT });

    expect(stats.total_on_disk).toBe(4);
    expect(stats.parsed).toBe(4);
    expect(stats.errors).toBe(0);
    expect(stats.removed).toBe(0);

    const main = sessions.get(S_MAIN)!;
    expect(main.source).toBe("claude");
    expect(main.project_id).toBe("demo");
    expect(main.projects_touched).toEqual(["demo"]); // from the Edit tool's file_path
    expect(main.title).toBe("Fixture demo session"); // ai-title wins over first user msg
    expect(main.first_user_msg).toBe("add a health endpoint");
    expect(main.model).toBe("claude-sonnet-4-6");
    expect(main.entrypoint).toBe("cli");
    expect(main.is_automated).toBe(false);
    expect(main.kind).toBe("session");
    // The deliberately truncated assistant line is skipped, not counted:
    // 3 user lines (incl. tool_result echo) + 2 parseable assistant lines.
    expect(main.message_count).toBe(5);
    expect(main.tool_count).toBe(1);
    expect(main.input_tokens).toBe(3000);
    expect(main.output_tokens).toBe(500);
    expect(main.cache_read_tokens).toBe(500);
    expect(main.cache_write_tokens).toBe(100);
    // Sonnet rates: (3000*3 + 500*15 + 500*0.3 + 100*3.75) / 1e6, toFixed(4)
    expect(main.cost_usd).toBe(0.017);
    expect(main.started_at).toBe(Date.parse("2026-07-20T10:00:00Z"));
    expect(main.ended_at).toBe(Date.parse("2026-07-20T10:02:30Z"));

    const mainTurns = turns.get(S_MAIN)!;
    expect(mainTurns.length).toBe(2);
    expect(mainTurns[0].user_text).toBe("add a health endpoint");
    expect(mainTurns[0].tool_names_csv).toBe("Edit");
    expect(mainTurns[0].input_tokens).toBe(1000);
    expect(mainTurns[0].output_tokens).toBe(200);
    expect(mainTurns[1].user_text).toBe("now write a test");
    expect(mainTurns[1].input_tokens).toBe(2000);
    expect(mainTurns[1].cache_read_tokens).toBe(500);
    expect(mainTurns[1].cache_write_tokens).toBe(100);

    // Non-interactive entrypoint → automated.
    const auto = sessions.get(S_AUTO)!;
    expect(auto.entrypoint).toBe("night-cron");
    expect(auto.is_automated).toBe(true);
    expect(auto.model).toBe("claude-haiku-4-5");
  });

  it("gives children synthetic distinct ids with parent/workflow linkage", () => {
    const { store, sessions } = fakeStore();
    syncToStore(store, { projectsRoot: ROOT });

    const sub = sessions.get("sub-inner-1__subagent__agent-abc")!;
    expect(sub.kind).toBe("subagent");
    expect(sub.parent_session_id).toBe(S_MAIN);
    expect(sub.workflow_id).toBeNull();
    expect(sub.is_automated).toBe(true);
    expect(sub.title.endsWith("[subagent]")).toBe(true);

    const wf = sessions.get("wf-inner-1__workflow__agent-def")!;
    expect(wf.kind).toBe("workflow");
    expect(wf.parent_session_id).toBe(S_MAIN);
    expect(wf.workflow_id).toBe("wf_test-1");
  });

  it("is incremental: second pass parses nothing; forceRecentN re-parses the newest", () => {
    const { store } = fakeStore();
    syncToStore(store, { projectsRoot: ROOT });
    const again = syncToStore(store, { projectsRoot: ROOT });
    expect(again.parsed).toBe(0);
    expect(again.unchanged).toBe(4);

    const forced = syncToStore(store, { projectsRoot: ROOT, forceRecentN: 1 });
    expect(forced.parsed).toBe(1);
    expect(forced.unchanged).toBe(3);
  });

  it("a failing transcript is counted as an error while siblings still index", () => {
    const { store, sessions } = fakeStore({ throwOnSessionId: S_AUTO });
    const stats = syncToStore(store, { projectsRoot: ROOT });
    expect(stats.errors).toBe(1);
    expect(stats.parsed).toBe(3);
    expect(sessions.has(S_MAIN)).toBe(true);
    expect(sessions.has(S_AUTO)).toBe(false);
    // path + reason captured for Output-channel diagnostics
    expect(stats.error_details).toHaveLength(1);
    expect(stats.error_details[0].path).toContain(S_AUTO);
    expect(stats.error_details[0].reason.length).toBeGreaterThan(0);
  });

  it("cached paths no longer on disk are removed", () => {
    const ghost = path.join(ROOT, "-Users-tester-projects-demo", "gone.jsonl");
    const { store } = fakeStore({ seedKnown: [ghost] });
    const stats = syncToStore(store, { projectsRoot: ROOT });
    expect(stats.removed).toBe(1);
  });
});

describe("cleanCommandText", () => {
  it("renders a slash command as name + args and strips wrapper tags", () => {
    expect(
      cleanCommandText("<command-name>/load</command-name><command-args>docs</command-args>"),
    ).toBe("/load docs");
    expect(cleanCommandText("<system-reminder>noise</system-reminder>hello")).toBe("hello");
  });
});
