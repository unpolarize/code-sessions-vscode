// Hard-delete a session's on-disk artifacts. The SQLite row is a cache —
// deleting it without the files just makes the next indexer pass re-import
// the session. Native JSONL, Grok session dirs, and the ~/.sessions git
// mirror all have to go. Idle-guard mirrors renameSessionFile so we don't
// clobber an in-flight O_APPEND writer.

import * as fs from "fs";
import * as path from "path";
import { gitSessionsRoot } from "./gitIndexer";
import { locateStoreTurns } from "./storeTranscript";
import {
  acquireSyncLock,
  releaseSyncLock,
  runGit,
  type GitRunner,
} from "./storeSyncGit";

export const DELETE_MIN_IDLE_SECONDS = 60;

export interface DeletableSession {
  session_id: string;
  source: string;
  jsonl_path?: string | null;
  mtime_epoch?: number;
}

export type DeleteTarget = { path: string; kind: "file" | "dir" };

export interface DeleteLocators {
  locateClaudeJsonl?: (sessionId: string) => string | null | Promise<string | null>;
  locateGrokSummary?: (sessionId: string) => string | null;
  locateStoreTurns?: (sessionId: string) => { dir: string; host: string } | null;
  gitSessionsRoot?: () => string;
  git?: GitRunner;
  nowSec?: () => number;
}

export interface DeleteArtifactsResult {
  ok: boolean;
  error?: string;
  deleted: string[];
  gitCommitted?: boolean;
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isInside(abs: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function addTarget(out: DeleteTarget[], p: string, kind: "file" | "dir"): void {
  if (!p || !exists(p)) return;
  if (out.some((t) => t.path === p)) return;
  out.push({ path: p, kind });
}

export function idleGuardError(row: DeletableSession, nowSec?: number): string | null {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const mtime = row.mtime_epoch ?? 0;
  if (!mtime) return null;
  const age = Math.max(0, now - mtime);
  if (age < DELETE_MIN_IDLE_SECONDS) {
    return `Session was active ${age}s ago. Wait at least ${DELETE_MIN_IDLE_SECONDS}s after the last turn before deleting, so an in-flight write isn't lost.`;
  }
  return null;
}

export async function collectDeleteTargets(
  row: DeletableSession,
  locators: DeleteLocators = {},
): Promise<DeleteTarget[]> {
  const out: DeleteTarget[] = [];
  const jsonl = row.jsonl_path && exists(row.jsonl_path) ? row.jsonl_path : null;

  if (row.source === "git") {
    if (jsonl) addTarget(out, path.dirname(jsonl), "dir");
  } else if (row.source === "grok") {
    if (jsonl) addTarget(out, path.dirname(jsonl), "dir");
    else {
      const summary = locators.locateGrokSummary?.(row.session_id);
      if (summary && exists(summary)) addTarget(out, path.dirname(summary), "dir");
    }
  } else if (row.source === "codex") {
    if (jsonl) addTarget(out, jsonl, "file");
  } else {
    let claudePath = jsonl;
    if (!claudePath && locators.locateClaudeJsonl) {
      claudePath = (await locators.locateClaudeJsonl(row.session_id)) ?? null;
    }
    if (claudePath && exists(claudePath)) {
      addTarget(out, claudePath, "file");
      const sib = claudePath.replace(/\.jsonl$/i, "");
      if (sib !== claudePath && isDir(sib)) addTarget(out, sib, "dir");
    }
  }

  const locateTurns = locators.locateStoreTurns ?? locateStoreTurns;
  const storeRef = locateTurns(row.session_id);
  if (storeRef?.dir) addTarget(out, path.dirname(storeRef.dir), "dir");
  return out;
}

export async function deleteSessionArtifacts(
  row: DeletableSession,
  locators: DeleteLocators = {},
): Promise<DeleteArtifactsResult> {
  const idle = idleGuardError(row, locators.nowSec?.());
  if (idle) return { ok: false, error: idle, deleted: [] };

  const targets = await collectDeleteTargets(row, locators);
  const gitRoot = (locators.gitSessionsRoot ?? gitSessionsRoot)();
  const git = locators.git ?? runGit;
  const deleted: string[] = [];
  let gitCommitted = false;

  const gitTargets = gitRoot ? targets.filter((t) => isInside(t.path, gitRoot)) : [];
  const gitPaths = new Set(gitTargets.map((t) => t.path));
  const otherTargets = targets.filter((t) => !gitPaths.has(t.path));

  if (gitTargets.length > 0) {
    const gitDir = path.join(gitRoot, ".git");
    if (exists(gitDir)) {
      if (!acquireSyncLock(gitRoot)) {
        return {
          ok: false,
          error: `Could not lock ${gitRoot} for git rm (another window is syncing). Retry in a few seconds.`,
          deleted: [],
        };
      }
      try {
        const rels = gitTargets.map((t) => path.relative(gitRoot, t.path));
        for (const rel of rels) {
          await git(gitRoot, ["rm", "-r", "--ignore-unmatch", "--", rel]);
        }
        for (const t of gitTargets) {
          if (exists(t.path)) fs.rmSync(t.path, { recursive: true, force: true });
          deleted.push(t.path);
        }
        const st = await git(gitRoot, ["status", "--porcelain"]);
        if (st.stdout.trim()) {
          await git(gitRoot, ["add", "-A", "--", ...rels]);
          const commit = await git(gitRoot, [
            "commit",
            "-m",
            `code-sessions: delete session ${row.session_id.slice(0, 8)}`,
          ]);
          if (commit.code !== 0) {
            return {
              ok: false,
              error: `Deleted files but git commit failed: ${commit.stderr || commit.stdout}`,
              deleted,
              gitCommitted: false,
            };
          }
          gitCommitted = true;
        }
      } finally {
        releaseSyncLock(gitRoot);
      }
    } else {
      for (const t of gitTargets) {
        fs.rmSync(t.path, { recursive: true, force: true });
        deleted.push(t.path);
      }
    }
  }

  for (const t of otherTargets) {
    try {
      fs.rmSync(t.path, { recursive: true, force: true });
      deleted.push(t.path);
    } catch (e: any) {
      return { ok: false, error: `Failed to delete ${t.path}: ${e.message}`, deleted };
    }
  }
  return { ok: true, deleted, gitCommitted };
}
