// Pure git reconciliation for one store — no vscode dependency, so it's unit
// testable against real temp repos. StoreSyncManager (vscode-aware) drives it.
//
// Conflict philosophy: recover, never wedge. `pull --rebase --autostash` (git
// re-applies the autostash on abort); a rebase already in progress — ours from
// a crash or a cron's — is aborted back to a clean HEAD before we start; a pull
// that conflicts is aborted (repo left clean) and reported, with no
// marker-resolution loop or merge agent.

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

export type RepoSyncStatus = "ok" | "unchanged" | "skipped" | "conflict" | "error";

export interface RepoSyncResult {
  status: RepoSyncStatus;
  /** Human-readable detail for logging / warnings (conflict stderr, error). */
  detail?: string;
}

export type GitRunner = (dir: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Default runner: `git` via child_process. Overridable in tests. */
export const runGit: GitRunner = (dir, args) =>
  new Promise((resolve) => {
    execFile("git", args, { cwd: dir, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: String(stdout).trim(),
        stderr: String(stderr).trim(),
        code: err ? ((err as { code?: number }).code ?? 1) : 0,
      });
    });
  });

/** True if a rebase (merge- or apply-backend) is currently in progress in `dir`. */
export async function rebaseInProgress(dir: string, git: GitRunner = runGit): Promise<boolean> {
  for (const marker of ["rebase-merge", "rebase-apply"]) {
    const r = await git(dir, ["rev-parse", "--git-path", marker]);
    if (r.code === 0 && r.stdout) {
      const p = path.isAbsolute(r.stdout) ? r.stdout : path.join(dir, r.stdout);
      if (fs.existsSync(p)) return true;
    }
  }
  return false;
}

/** Pull one repo onto its remote, recovering (not wedging) on conflict, and
 * optionally push local commits after rebasing. Returns "ok" only when HEAD
 * advanced (the caller should reload views). Never throws. */
export async function syncRepoOnce(
  dir: string,
  opts: { push: boolean; git?: GitRunner },
): Promise<RepoSyncResult> {
  const git = opts.git ?? runGit;
  try {
    if (!fs.existsSync(path.join(dir, ".git"))) return { status: "skipped", detail: "not a git repo" };

    // Recover a pre-existing wedged rebase BEFORE touching the remote.
    if (await rebaseInProgress(dir, git)) {
      await git(dir, ["rebase", "--abort"]);
    }

    const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout || "main";
    const remote = (await git(dir, ["remote"])).stdout;
    if (!remote) return { status: "skipped", detail: "no remote" };

    const before = (await git(dir, ["rev-parse", "HEAD"])).stdout;

    const fetch = await git(dir, ["fetch", "--quiet", "origin", branch]);
    if (fetch.code !== 0) return { status: "skipped", detail: `fetch failed: ${firstLine(fetch.stderr)}` };

    const pull = await git(dir, ["pull", "--rebase", "--autostash", "origin", branch]);
    if (pull.code !== 0) {
      if (await rebaseInProgress(dir, git)) await git(dir, ["rebase", "--abort"]);
      return { status: "conflict", detail: firstLine(pull.stderr || pull.stdout) };
    }

    if (opts.push) {
      const ahead = await git(dir, ["rev-list", "--count", `origin/${branch}..HEAD`]);
      if (ahead.code === 0 && Number(ahead.stdout) > 0) {
        const p = await git(dir, ["push", "origin", branch]);
        if (p.code !== 0) return { status: "ok", detail: `pulled ok; push failed: ${firstLine(p.stderr)}` };
      }
    }

    const after = (await git(dir, ["rev-parse", "HEAD"])).stdout;
    return { status: after !== before ? "ok" : "unchanged" };
  } catch (e) {
    return { status: "error", detail: String(e) };
  }
}

function firstLine(s: string): string {
  return (s || "").split("\n")[0];
}
