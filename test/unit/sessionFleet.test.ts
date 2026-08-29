import { describe, it, expect } from "vitest";
import {
  classifyStatus,
  daemonRowsToFleet,
  localLiveIds,
  mergeFleetSessions,
  parseExtras,
  parseIntent,
  toFleetSession,
} from "../../src/sessionFleet";

const NOW = Date.parse("2026-08-25T18:00:00Z");

describe("classifyStatus", () => {
  it("ended sessions are never live", () => {
    expect(
      classifyStatus({ host: "air", localHost: "air", open: false, lastActivity: NOW - 1000, now: NOW }),
    ).toBe("ended");
  });
  it("recent same-host open → live-local", () => {
    expect(
      classifyStatus({
        host: "zhirafovod-air.local",
        localHost: "zhirafovod-air",
        open: true,
        lastActivity: NOW - 20_000,
        now: NOW,
      }),
    ).toBe("live-local");
  });
  it("recent other-host open → active-remote", () => {
    expect(
      classifyStatus({
        host: "air-15",
        localHost: "air",
        open: true,
        lastActivity: NOW - 20_000,
        now: NOW,
      }),
    ).toBe("active-remote");
  });
  it("stale open is not live (guards git-pull mtime false positives)", () => {
    expect(
      classifyStatus({
        host: "air-15",
        localHost: "air",
        open: true,
        lastActivity: NOW - 2 * 3600_000,
        now: NOW,
      }),
    ).toBe("open");
  });
});

describe("parseIntent / extras", () => {
  it("parses intent and extras_json", () => {
    expect(parseIntent(["intent:bugfix", "topic:x"])).toBe("bugfix");
    expect(parseExtras('{"host":"air","labels":["intent:docs"],"open":true}')).toEqual({
      host: "air",
      labels: ["intent:docs"],
      open: true,
      planning_refs: [],
    });
    expect(parseExtras("not-json").labels).toEqual([]);
  });
});

describe("localLiveIds", () => {
  it("ignores git-source mtime (pull rewrite) and uses native jsonl mtime", () => {
    const ids = localLiveIds(
      [
        { session_id: "native-live", mtime_ns: (NOW - 10_000) * 1e6, source: "claude" },
        { session_id: "git-fresh-mtime", mtime_ns: (NOW - 10_000) * 1e6, source: "git" },
        { session_id: "native-old", mtime_ns: (NOW - 10 * 60_000) * 1e6, source: "claude" },
      ],
      NOW,
    );
    expect([...ids]).toEqual(["native-live"]);
  });
});

describe("mergeFleetSessions", () => {
  it("unions git-only remote sessions with local sqlite rows", () => {
    const local = toFleetSession(
      {
        uuid: "aaaaaaaa-0000-4000-8000-000000000001",
        title: "local",
        host: "air",
        source: "claude",
        startedAt: NOW - 3600_000,
        mtime: NOW,
        lastActivity: NOW - 30_000,
        open: true,
        planningRefs: ["tasks/a"],
        labels: ["intent:feature"],
      },
      { now: NOW, localHost: "air", localLiveIds: new Set(["aaaaaaaa-0000-4000-8000-000000000001"]) },
    );
    const remote = toFleetSession(
      {
        uuid: "bbbbbbbb-0000-4000-8000-000000000002",
        title: "other laptop",
        host: "air-15",
        source: "git",
        startedAt: NOW - 7200_000,
        mtime: NOW, // git pull just rewrote this — must not become live
        lastActivity: NOW - 3 * 3600_000,
        open: true,
        planningRefs: [],
        labels: [],
      },
      { now: NOW, localHost: "air" },
    );
    const merged = mergeFleetSessions([local, remote]);
    expect(merged).toHaveLength(2);
    expect(merged.find((s) => s.uuid.startsWith("aaaa"))?.status).toBe("live-local");
    expect(merged.find((s) => s.uuid.startsWith("bbbb"))?.status).toBe("open");
  });
});

describe("daemonRowsToFleet", () => {
  it("keeps hasContent rows and drops empty creates; cwd is projectPath", () => {
    const rows = daemonRowsToFleet(
      [
        {
          id: "live-1",
          host: "air-15",
          agent: "grok",
          cwd: "/Users/me/docs",
          title: "docs work",
          hasContent: true,
          startedAt: new Date(NOW - 60_000).toISOString(),
          turnCount: 4,
        },
        {
          id: "empty-1",
          host: "air-15",
          agent: "codebuild",
          cwd: "/Users/me/other",
          hasContent: false,
          turnCount: 0,
        },
      ],
      { now: NOW, localHost: "air" },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.uuid).toBe("live-1");
    expect(rows[0]?.projectPath).toBe("/Users/me/docs");
    expect(rows[0]?.source).toBe("git");
  });
});
