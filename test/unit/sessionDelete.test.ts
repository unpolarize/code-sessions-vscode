import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  collectDeleteTargets,
  deleteSessionArtifacts,
  idleGuardError,
  DELETE_MIN_IDLE_SECONDS,
  type DeletableSession,
} from "../../src/sessionDelete";
import type { GitRunner } from "../../src/storeSyncGit";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-delete-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function scriptedGit(): { git: GitRunner; calls: string[] } {
  const calls: string[] = [];
  const git: GitRunner = async (_d, args) => {
    calls.push(args.join(" "));
    return { stdout: "", stderr: "", code: 0 };
  };
  return { git, calls };
}

describe("idleGuardError", () => {
  it("refuses a session touched inside the idle window", () => {
    const now = 1_700_000_060;
    const err = idleGuardError({ session_id: "x", source: "claude", mtime_epoch: now - 10 }, now);
    expect(err).toMatch(/active 10s ago/);
    expect(err).toContain(String(DELETE_MIN_IDLE_SECONDS));
  });

  it("allows a stale session", () => {
    const now = 1_700_000_120;
    expect(
      idleGuardError({ session_id: "x", source: "claude", mtime_epoch: now - 90 }, now),
    ).toBeNull();
  });
});

describe("collectDeleteTargets", () => {
  it("collects claude jsonl + sibling subagent dir + store mirror", async () => {
    const jsonl = path.join(dir, "abc.jsonl");
    const sib = path.join(dir, "abc");
    fs.writeFileSync(jsonl, "{}\n");
    fs.mkdirSync(path.join(sib, "agent"), { recursive: true });
    fs.writeFileSync(path.join(sib, "agent", "child.jsonl"), "{}\n");
    const storeDir = path.join(dir, "hosts", "air", "2026-08", "abc");
    fs.mkdirSync(path.join(storeDir, "turns"), { recursive: true });

    const targets = await collectDeleteTargets(
      { session_id: "abc", source: "claude", jsonl_path: jsonl },
      {
        locateStoreTurns: () => ({ dir: path.join(storeDir, "turns"), host: "air" }),
        gitSessionsRoot: () => path.join(dir, "no-git-store"),
      },
    );
    const paths = targets.map((t) => t.path).sort();
    expect(paths).toContain(jsonl);
    expect(paths).toContain(sib);
    expect(paths).toContain(storeDir);
  });

  it("collects the grok session directory from summary.json", async () => {
    const sess = path.join(dir, "g1");
    fs.mkdirSync(sess);
    const summary = path.join(sess, "summary.json");
    fs.writeFileSync(summary, "{}");
    const targets = await collectDeleteTargets(
      { session_id: "g1", source: "grok" },
      {
        locateGrokSummary: () => summary,
        locateStoreTurns: () => null,
      },
    );
    expect(targets).toEqual([{ path: sess, kind: "dir" }]);
  });

  it("collects dirname(jsonl_path) for git-source rows", async () => {
    const sess = path.join(dir, "hosts", "h", "2026-07", "sid");
    fs.mkdirSync(path.join(sess, "turns"), { recursive: true });
    const jsonl = path.join(sess, "session.json");
    fs.writeFileSync(jsonl, "{}");
    const targets = await collectDeleteTargets(
      { session_id: "sid", source: "git", jsonl_path: jsonl },
      { locateStoreTurns: () => null, gitSessionsRoot: () => dir },
    );
    expect(targets).toEqual([{ path: sess, kind: "dir" }]);
  });
});

describe("deleteSessionArtifacts", () => {
  it("refuses to delete a hot session", async () => {
    const now = 1_700_000_000;
    const r = await deleteSessionArtifacts(
      { session_id: "hot", source: "claude", mtime_epoch: now - 5 },
      { nowSec: () => now, locateStoreTurns: () => null },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/active 5s ago/);
    expect(r.deleted).toEqual([]);
  });

  it("removes native claude artifacts from a temp tree", async () => {
    const jsonl = path.join(dir, "dead.jsonl");
    const sib = path.join(dir, "dead");
    fs.writeFileSync(jsonl, "x\n");
    fs.mkdirSync(sib);
    fs.writeFileSync(path.join(sib, "child.jsonl"), "y\n");
    const now = 1_700_000_000;
    const r = await deleteSessionArtifacts(
      {
        session_id: "dead",
        source: "claude",
        jsonl_path: jsonl,
        mtime_epoch: now - 120,
      },
      {
        nowSec: () => now,
        locateStoreTurns: () => null,
        gitSessionsRoot: () => path.join(dir, "sessions-store"),
      },
    );
    expect(r.ok).toBe(true);
    expect(fs.existsSync(jsonl)).toBe(false);
    expect(fs.existsSync(sib)).toBe(false);
    expect(r.deleted.sort()).toEqual([jsonl, sib].sort());
  });

  it("git-rms + commits store dirs when the root is a git repo", async () => {
    const store = path.join(dir, "sessions");
    const sess = path.join(store, "hosts", "air", "2026-08", "sid");
    fs.mkdirSync(path.join(sess, "turns"), { recursive: true });
    fs.writeFileSync(path.join(sess, "session.json"), "{}");
    fs.mkdirSync(path.join(store, ".git"));
    const { git, calls } = scriptedGit();
    const now = 1_700_000_000;
    const row: DeletableSession = {
      session_id: "sid-0000-0000",
      source: "git",
      jsonl_path: path.join(sess, "session.json"),
      mtime_epoch: now - 120,
    };
    // Make status --porcelain report a change so we commit.
    const gitWithStatus: GitRunner = async (d, args) => {
      const key = args.join(" ");
      if (key === "status --porcelain") {
        calls.push(key);
        return { stdout: "D  hosts/air/2026-08/sid", stderr: "", code: 0 };
      }
      return git(d, args);
    };
    const r = await deleteSessionArtifacts(row, {
      nowSec: () => now,
      locateStoreTurns: () => null,
      gitSessionsRoot: () => store,
      git: gitWithStatus,
    });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(sess)).toBe(false);
    expect(calls.some((c) => c.startsWith("rm -r --ignore-unmatch"))).toBe(true);
    expect(calls.some((c) => c.startsWith("commit -m"))).toBe(true);
    expect(r.gitCommitted).toBe(true);
  });
});
