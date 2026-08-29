// Fixture tests for the git-store indexer (kp: tasks/csv-fixture-tests-for-claude-grok-git-indexers-s).
// listAllGitSessions/buildGitRows run against a synthetic hosts/<host>/<month>/<uuid>/
// tree under test/fixtures/gitstore — no real transcripts, no home-dir access.
// syncGitToStore stats are exercised with a duck-typed in-memory store.
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { listAllGitSessions, buildGitRows, syncGitToStore } from "../../src/gitIndexer";
import { SessionStore, SessionRow, TurnRow } from "../../src/db";

const ROOT = path.resolve(__dirname, "../fixtures/gitstore");
const LOCAL_HOST = "local-fixture-host";

const S_CLAUDE_REMOTE = "0199bbbb-0000-4000-8000-000000000001";
const S_CORRUPT = "0199bbbb-0000-4000-8000-000000000002";
const S_CODEX_LOCAL = "0199bbbb-0000-4000-8000-000000000003";
const S_CLAUDE_LOCAL = "0199bbbb-0000-4000-8000-000000000004";

function infoFor(uuid: string) {
  const info = listAllGitSessions(ROOT).find((i) => i.sessionDir.endsWith(uuid));
  if (!info) throw new Error(`fixture session ${uuid} not found`);
  return info;
}

/** In-memory stand-in for SessionStore: just enough surface for syncGitToStore. */
function fakeStore(opts: { throwOnSessionId?: string } = {}) {
  const sessions = new Map<string, SessionRow>();
  const turns = new Map<string, TurnRow[]>();
  const known = new Map<string, { mtime_ns: number; size_bytes: number }>();
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

describe("listAllGitSessions", () => {
  it("walks hosts/<host>/<month>/<uuid> and keys on session.json", () => {
    const all = listAllGitSessions(ROOT);
    expect(all.map((i) => path.basename(i.sessionDir)).sort()).toEqual([
      S_CLAUDE_REMOTE,
      S_CORRUPT,
      S_CODEX_LOCAL,
      S_CLAUDE_LOCAL,
    ]);
    for (const i of all) {
      expect(i.mtime_ns).toBeGreaterThan(0);
      expect(i.size_bytes).toBeGreaterThan(0);
    }
    expect(infoFor(S_CLAUDE_REMOTE).host).toBe("mac-remote");
  });

  it("missing root → empty list, no throw", () => {
    expect(listAllGitSessions(path.join(ROOT, "does-not-exist"))).toEqual([]);
  });
});

describe("buildGitRows", () => {
  it("folds canonical turns into exchanges with tokens, tools, and file edits", () => {
    const rows = buildGitRows(infoFor(S_CLAUDE_REMOTE));
    expect(rows).not.toBeNull();
    const { session, turns } = rows!;

    expect(session.session_id).toBe(S_CLAUDE_REMOTE);
    expect(session.source).toBe("git");
    expect(session.project_id).toBe("demo");
    expect(session.projects_touched).toEqual(["demo", "docs"]);
    expect(session.title).toBe("Fix the flaky retry test");
    expect(session.message_count).toBe(4); // envelope turn_count wins
    expect(session.tool_count).toBe(3); // envelope tool_call_count wins
    expect(session.input_tokens).toBe(1200);
    expect(session.output_tokens).toBe(300);
    expect(session.cost_usd).toBe(0.05);
    expect(session.model).toBe("claude-sonnet-4-6");
    expect(session.entrypoint).toBe("claude");
    expect(session.started_at).toBe(Date.parse("2026-07-21T09:00:00Z"));
    expect(session.ended_at).toBe(Date.parse("2026-07-21T09:10:00Z"));
    expect(JSON.parse(session.extras_json!)).toMatchObject({ host: "mac-remote", labels: ["night"] });

    // Two user→assistant exchanges. The corrupted 000005.json and the
    // 000006.json.tmp half-write are both skipped without dropping the rest.
    expect(turns.length).toBe(2);
    const [t0, t1] = turns;
    expect(t0.user_text).toBe("fix the flaky retry test");
    expect(t0.assistant_excerpt).toBe("Looking at the retry helper now.");
    expect(t0.tool_names_csv).toBe("Edit,Bash");
    expect(t0.tool_count).toBe(2);
    expect(t0.input_tokens).toBe(1000);
    expect(t0.output_tokens).toBe(200);
    expect(t0.cache_read_tokens).toBe(50);
    expect(t0.cache_write_tokens).toBe(25);
    expect(t0.cost_usd).toBe(0.03);
    expect(t0.duration_ms).toBe(60_000);
    expect(t0.turn_uuid).toBe(`${S_CLAUDE_REMOTE}#0`);

    expect(t1.user_text).toBe("now update the docs");
    expect(t1.tool_names_csv).toBe("Write");
    expect(t1.cost_usd).toBe(0.02);
  });

  it("codex-rollout session parses like any other envelope", () => {
    const rows = buildGitRows(infoFor(S_CODEX_LOCAL));
    expect(rows).not.toBeNull();
    expect(rows!.session.entrypoint).toBe("codex");
    expect(rows!.session.model).toBe("gpt-5.2-codex");
    expect(rows!.turns.length).toBe(1);
    expect(rows!.turns[0].assistant_excerpt).toBe("The job fails in the lint step.");
  });

  it("corrupted session.json → null, no throw", () => {
    expect(buildGitRows(infoFor(S_CORRUPT))).toBeNull();
  });
});

describe("syncGitToStore", () => {
  it("imports remote + non-native local sessions, skips native local, tolerates corrupt", () => {
    const { store, sessions } = fakeStore();
    const stats = syncGitToStore(store, { root: ROOT, localHost: LOCAL_HOST });
    expect(stats.total_on_disk).toBe(4);
    // claude-jsonl on this host is the native indexer's job.
    expect(stats.skipped_local_host).toBe(1);
    // codex-rollout on this host is still imported.
    expect(stats.parsed).toBe(2);
    expect(stats.errors).toBe(0);
    expect(stats.unchanged).toBe(0);
    expect([...sessions.keys()].sort()).toEqual([S_CLAUDE_REMOTE, S_CODEX_LOCAL]);
  });

  it("second run over an unchanged tree parses nothing but re-visits the corrupt session", () => {
    const { store } = fakeStore();
    syncGitToStore(store, { root: ROOT, localHost: LOCAL_HOST });
    const again = syncGitToStore(store, { root: ROOT, localHost: LOCAL_HOST });
    expect(again.parsed).toBe(0); // corrupt session builds to null → delete, not parse
    expect(again.errors).toBe(0);
    expect(again.unchanged).toBe(2);
  });

  it("a store failure on one session is counted as an error, siblings still index", () => {
    const { store, sessions } = fakeStore({ throwOnSessionId: S_CODEX_LOCAL });
    const stats = syncGitToStore(store, { root: ROOT, localHost: LOCAL_HOST });
    expect(stats.errors).toBe(1);
    expect(stats.parsed).toBe(1);
    expect([...sessions.keys()]).toEqual([S_CLAUDE_REMOTE]);
  });

  it("includeLocalHost imports the native local session too", () => {
    const { store } = fakeStore();
    const stats = syncGitToStore(store, { root: ROOT, localHost: LOCAL_HOST, includeLocalHost: true });
    expect(stats.skipped_local_host).toBe(0);
    expect(stats.parsed).toBe(3);
  });

  it("real SessionStore keeps source=git and extras.host (the tree host filter)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-git-"));
    const real = SessionStore.open(dir);
    try {
      const stats = syncGitToStore(real, { root: ROOT, localHost: LOCAL_HOST });
      expect(stats.errors).toBe(0);
      expect(stats.parsed).toBe(2);
      const remote = real.getById(S_CLAUDE_REMOTE);
      expect(remote).not.toBeNull();
      expect(remote!.source).toBe("git");
      expect(JSON.parse(remote!.extras_json || "{}").host).toBe("mac-remote");
      expect(remote!.last_assistant_text_at).toBeGreaterThan(0);
      const recent = real.listRecent(10, true, { requireReply: true });
      expect(recent.some((s) => s.session_id === S_CLAUDE_REMOTE)).toBe(true);
    } finally {
      real.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
