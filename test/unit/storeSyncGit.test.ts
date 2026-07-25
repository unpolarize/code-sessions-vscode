// Unit tests for syncRepoOnce / rebaseInProgress with an injected GitRunner —
// zero real git. Temp dirs only supply the `.git` existence check.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { syncRepoOnce, rebaseInProgress, GitRunner } from "../../src/storeSyncGit";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-storesync-"));
  fs.mkdirSync(path.join(dir, ".git"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Scripted runner: responds by args key, records every invocation. */
function scriptedGit(
  script: Record<string, { stdout?: string; stderr?: string; code?: number }>,
): { git: GitRunner; calls: string[] } {
  const calls: string[] = [];
  const git: GitRunner = async (_dir, args) => {
    const key = args.join(" ");
    calls.push(key);
    const r = script[key] ?? {};
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0 };
  };
  return { git, calls };
}

const BASE = {
  "rev-parse --git-path rebase-merge": { stdout: ".git/rebase-merge" },
  "rev-parse --git-path rebase-apply": { stdout: ".git/rebase-apply" },
  "rev-parse --abbrev-ref HEAD": { stdout: "main" },
  remote: { stdout: "origin" },
  "fetch --quiet origin main": {},
  "pull --rebase --autostash origin main": { stdout: "Already up to date." },
};

describe("syncRepoOnce", () => {
  it("skips a directory that is not a git repo", async () => {
    fs.rmSync(path.join(dir, ".git"), { recursive: true });
    const { git, calls } = scriptedGit({});
    const r = await syncRepoOnce(dir, { push: false, git });
    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("not a git repo");
    expect(calls).toEqual([]); // never touched git
  });

  it("skips when the repo has no remote", async () => {
    const { git } = scriptedGit({ ...BASE, remote: { stdout: "" } });
    const r = await syncRepoOnce(dir, { push: false, git });
    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("no remote");
  });

  it("returns unchanged when HEAD does not move", async () => {
    const { git, calls } = scriptedGit({ ...BASE, "rev-parse HEAD": { stdout: "aaa111" } });
    const r = await syncRepoOnce(dir, { push: false, git });
    expect(r.status).toBe("unchanged");
    expect(calls).not.toContain("rebase --abort");
  });

  it("returns ok when HEAD advances", async () => {
    let head = "aaa111";
    const { git } = scriptedGit({});
    const moving: GitRunner = async (d, args) => {
      const key = args.join(" ");
      if (key === "rev-parse HEAD") {
        const out = { stdout: head, stderr: "", code: 0 };
        head = "bbb222"; // pull advances HEAD between the two rev-parse calls
        return out;
      }
      if (key in BASE) return { stdout: (BASE as any)[key].stdout ?? "", stderr: "", code: 0 };
      return git(d, args);
    };
    const r = await syncRepoOnce(dir, { push: false, git: moving });
    expect(r.status).toBe("ok");
  });

  it("aborts the rebase and reports conflict on a failed pull", async () => {
    const { git, calls } = scriptedGit({
      ...BASE,
      "rev-parse HEAD": { stdout: "aaa111" },
      "pull --rebase --autostash origin main": {
        code: 1,
        stderr: "CONFLICT (content): Merge conflict in notes.md\nerror: could not apply abc123",
      },
    });
    // after the failed pull, a rebase-merge dir exists → abort path
    fs.mkdirSync(path.join(dir, ".git", "rebase-merge"));
    const r = await syncRepoOnce(dir, { push: false, git });
    expect(r.status).toBe("conflict");
    expect(r.detail).toBe("CONFLICT (content): Merge conflict in notes.md"); // first line only
    expect(calls).toContain("rebase --abort");
  });

  it("keeps status ok but reports detail when the push fails", async () => {
    const { git } = scriptedGit({
      ...BASE,
      "rev-parse HEAD": { stdout: "aaa111" },
      "rev-list --count origin/main..HEAD": { stdout: "2" },
      "push origin main": { code: 1, stderr: "remote: permission denied\nfatal: unable to push" },
    });
    const r = await syncRepoOnce(dir, { push: true, git });
    expect(r.status).toBe("ok");
    expect(r.detail).toBe("pulled ok; push failed: remote: permission denied");
  });
});

describe("rebaseInProgress", () => {
  it("is false with no marker dirs and true when rebase-apply exists", async () => {
    const { git } = scriptedGit({
      "rev-parse --git-path rebase-merge": { stdout: ".git/rebase-merge" },
      "rev-parse --git-path rebase-apply": { stdout: ".git/rebase-apply" },
    });
    expect(await rebaseInProgress(dir, git)).toBe(false);
    fs.mkdirSync(path.join(dir, ".git", "rebase-apply"));
    expect(await rebaseInProgress(dir, git)).toBe(true);
  });
});
