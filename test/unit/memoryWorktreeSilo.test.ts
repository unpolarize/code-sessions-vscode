// Fixture tests for the auto-memory worktree silo doctor
// (KP ideas/csv-auto-memory-worktree-silo-doctor-detect-memo).
// #88579-shaped: main repo + `.claude/worktrees/<name>` each get a MEMORY.md.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BYTES_PER_TOKEN,
  COPY_MEMORY_SILO_MERGE_COMMAND,
  DEFAULT_BLEED_WINDOW_MS,
  MEMORY_SILO_SCHEMA,
  OPEN_MEMORY_SILO_PATHS_COMMAND,
  clusterMemorySilos,
  dashDecodeCwd,
  dashEncodeCwd,
  estimateTokensFromBytes,
  formatBytes,
  formatMergeCandidatesList,
  looksLikeWorktreeSilo,
  renderMemorySiloDoctorHtml,
  resolveGitCommonDirFs,
  scanClaudeMemorySilos,
  worktreeStem,
  type MemorySilo,
  type MemorySiloBleedSession,
} from "../../src/memoryWorktreeSilo";

const tmpDirs: string[] = [];

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function writeFile(p: string, contents: string, mtimeMs?: number): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents, "utf8");
  if (mtimeMs !== undefined) {
    const sec = mtimeMs / 1000;
    fs.utimesSync(p, sec, sec);
  }
}

function siloFixture(opts: {
  projectsRoot: string;
  encoded: string;
  body: string;
  mtimeMs?: number;
}): string {
  const memoryDir = path.join(opts.projectsRoot, opts.encoded, "memory");
  writeFile(path.join(memoryDir, "MEMORY.md"), opts.body, opts.mtimeMs);
  return memoryDir;
}

describe("helpers", () => {
  it("dash-encodes cwd the way Claude names project dirs (non-alnum → -)", () => {
    expect(dashEncodeCwd("/Users/me/repo/.claude/worktrees/feat")).toBe(
      "-Users-me-repo--claude-worktrees-feat",
    );
    expect(dashEncodeCwd("/Users/me/repo")).toBe("-Users-me-repo");
  });

  it("dash-decode is the lossy inverse (hyphens become slashes)", () => {
    expect(dashDecodeCwd("-Users-me-repo--claude-worktrees-feat")).toBe(
      "/Users/me/repo/.claude/worktrees/feat",
    );
    expect(dashDecodeCwd("-Users-me-my-app")).toBe("/Users/me/my/app");
  });

  it("worktreeStem strips Claude/git worktree suffixes", () => {
    expect(worktreeStem("-Users-me-repo--claude-worktrees-feat")).toBe("-Users-me-repo");
    expect(worktreeStem("-Users-me-repo--git-worktrees-hotfix")).toBe("-Users-me-repo");
    expect(worktreeStem("-Users-me-repo")).toBe("-Users-me-repo");
    expect(looksLikeWorktreeSilo("-Users-me-repo--claude-worktrees-feat")).toBe(true);
    expect(looksLikeWorktreeSilo("-Users-me-repo")).toBe(false);
  });

  it("estimates tokens at ~4 bytes/token and formats bytes", () => {
    expect(BYTES_PER_TOKEN).toBe(4);
    expect(estimateTokensFromBytes(8000)).toBe(2000);
    expect(estimateTokensFromBytes(0)).toBe(0);
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
  });
});

describe("scanClaudeMemorySilos", () => {
  it("finds MEMORY.md silos and sums bytes; skips empty memory dirs", () => {
    const root = mkTmp("mws-scan-");
    const body = "x".repeat(800);
    siloFixture({ projectsRoot: root, encoded: "-Users-me-repo", body });
    fs.mkdirSync(path.join(root, "-Users-me-empty", "memory"), { recursive: true });
    fs.writeFileSync(path.join(root, "not-a-dir"), "nope");

    const silos = scanClaudeMemorySilos(root, { resolveGitCommonDir: () => null });
    expect(silos).toHaveLength(1);
    expect(silos[0].encodedCwd).toBe("-Users-me-repo");
    expect(silos[0].decodedCwd).toBe("/Users/me/repo");
    expect(silos[0].bytes).toBe(800);
    expect(silos[0].tokensEstimate).toBe(200);
    expect(silos[0].memoryDir).toBe(path.join(root, "-Users-me-repo", "memory"));
  });

  it("returns [] when the projects root is missing", () => {
    expect(scanClaudeMemorySilos(path.join(os.tmpdir(), "mws-missing-" + Date.now()))).toEqual([]);
  });
});

describe("clusterMemorySilos", () => {
  it("clusters main + .claude/worktrees silo via worktree-stem (no git)", () => {
    const root = mkTmp("mws-stem-");
    siloFixture({
      projectsRoot: root,
      encoded: "-Users-me-repo",
      body: "main memory ".repeat(40),
    });
    siloFixture({
      projectsRoot: root,
      encoded: "-Users-me-repo--claude-worktrees-feat",
      body: "worktree memory ".repeat(20),
    });
    siloFixture({
      projectsRoot: root,
      encoded: "-Users-me-other",
      body: "unrelated",
    });

    const card = clusterMemorySilos(scanClaudeMemorySilos(root, { resolveGitCommonDir: () => null }));
    expect(card.scannedSilos).toBe(3);
    expect(card.clusters).toHaveLength(1);
    const c = card.clusters[0];
    expect(c.grouping).toBe("worktree-stem");
    expect(c.silos).toHaveLength(2);
    expect(c.silos.map((s) => s.encodedCwd).sort()).toEqual([
      "-Users-me-repo",
      "-Users-me-repo--claude-worktrees-feat",
    ]);
    expect(c.divergingPaths).toContain("/Users/me/repo");
    expect(c.divergingPaths).toContain("/Users/me/repo/.claude/worktrees/feat");
    expect(c.bleed).toBe(false);
  });

  it("clusters by git common-dir when the resolver agrees, even without a worktree suffix", () => {
    const common = "/Users/me/app/.git";
    const silos: MemorySilo[] = [
      {
        encodedCwd: "-Users-me-app",
        decodedCwd: "/Users/me/app",
        memoryDir: "/tmp/a/memory",
        bytes: 100,
        tokensEstimate: 25,
        mtimeMs: 1,
        gitCommonDir: common,
      },
      {
        encodedCwd: "-Users-me-app-wt-hotfix",
        decodedCwd: "/Users/me/app-wt-hotfix",
        memoryDir: "/tmp/b/memory",
        bytes: 40,
        tokensEstimate: 10,
        mtimeMs: 1,
        gitCommonDir: common,
      },
    ];
    const card = clusterMemorySilos(silos);
    expect(card.clusters).toHaveLength(1);
    expect(card.clusters[0].grouping).toBe("git-common-dir");
    expect(card.clusters[0].silos).toHaveLength(2);
    expect(card.clusters[0].repoLabel).toBe("app");
  });

  it("stays silent for a single silo (no fragmentation)", () => {
    const silos: MemorySilo[] = [
      {
        encodedCwd: "-Users-me-solo",
        decodedCwd: "/Users/me/solo",
        memoryDir: "/tmp/solo/memory",
        bytes: 12,
        tokensEstimate: 3,
        mtimeMs: 1,
        gitCommonDir: "/Users/me/solo/.git",
      },
    ];
    expect(clusterMemorySilos(silos).clusters).toHaveLength(0);
  });

  it("does not stem-cluster two unrelated encoded names that merely share a prefix", () => {
    const silos: MemorySilo[] = [
      {
        encodedCwd: "-Users-me-foo",
        decodedCwd: "/Users/me/foo",
        memoryDir: "/tmp/foo/memory",
        bytes: 10,
        tokensEstimate: 3,
        mtimeMs: 1,
        gitCommonDir: null,
      },
      {
        encodedCwd: "-Users-me-foo-bar",
        decodedCwd: "/Users/me/foo/bar",
        memoryDir: "/tmp/foobar/memory",
        bytes: 10,
        tokensEstimate: 3,
        mtimeMs: 1,
        gitCommonDir: null,
      },
    ];
    expect(clusterMemorySilos(silos).clusters).toHaveLength(0);
  });

  it("sets bleed when a child start lines up with silo mtime", () => {
    const t = Date.now();
    const silos: MemorySilo[] = [
      {
        encodedCwd: "-Users-me-repo",
        decodedCwd: "/Users/me/repo",
        memoryDir: "/tmp/a/memory",
        bytes: 100,
        tokensEstimate: 25,
        mtimeMs: t,
        gitCommonDir: null,
      },
      {
        encodedCwd: "-Users-me-repo--claude-worktrees-feat",
        decodedCwd: "/Users/me/repo/.claude/worktrees/feat",
        memoryDir: "/tmp/b/memory",
        bytes: 80,
        tokensEstimate: 20,
        mtimeMs: t + 1_000,
        gitCommonDir: null,
      },
    ];
    const sessions: MemorySiloBleedSession[] = [
      {
        session_id: "parent-1",
        kind: "session",
        source: "claude",
        project_path: "/Users/me/.claude/projects/-Users-me-repo",
        started_at: t - 60_000,
      },
      {
        session_id: "child-1",
        kind: "subagent",
        parent_session_id: "parent-1",
        source: "claude",
        started_at: t + 2_000,
      },
    ];
    const card = clusterMemorySilos(silos, { sessions, bleedWindowMs: DEFAULT_BLEED_WINDOW_MS });
    expect(card.clusters[0].bleed).toBe(true);
  });

  it("does not set bleed when child starts are outside the window", () => {
    const t = Date.now();
    const silos: MemorySilo[] = [
      {
        encodedCwd: "-Users-me-repo",
        decodedCwd: "/Users/me/repo",
        memoryDir: "/tmp/a/memory",
        bytes: 100,
        tokensEstimate: 25,
        mtimeMs: t,
        gitCommonDir: null,
      },
      {
        encodedCwd: "-Users-me-repo--claude-worktrees-feat",
        decodedCwd: "/Users/me/repo/.claude/worktrees/feat",
        memoryDir: "/tmp/b/memory",
        bytes: 80,
        tokensEstimate: 20,
        mtimeMs: t,
        gitCommonDir: null,
      },
    ];
    const sessions: MemorySiloBleedSession[] = [
      {
        session_id: "parent-1",
        kind: "session",
        source: "claude",
        project_path: "-Users-me-repo",
        started_at: t,
      },
      {
        session_id: "child-1",
        kind: "subagent",
        parent_session_id: "parent-1",
        source: "claude",
        started_at: t + DEFAULT_BLEED_WINDOW_MS + 60_000,
      },
    ];
    expect(clusterMemorySilos(silos, { sessions }).clusters[0].bleed).toBe(false);
  });
});

describe("resolveGitCommonDirFs", () => {
  it("resolves a linked worktree via gitdir + commondir", () => {
    const repo = mkTmp("mws-git-");
    const gitDir = path.join(repo, ".git");
    fs.mkdirSync(path.join(gitDir, "worktrees", "feat"), { recursive: true });
    writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFile(path.join(gitDir, "worktrees", "feat", "commondir"), "../..\n");
    const wt = path.join(repo, ".claude", "worktrees", "feat");
    writeFile(path.join(wt, ".git"), `gitdir: ${path.join(gitDir, "worktrees", "feat")}\n`);

    expect(resolveGitCommonDirFs(repo)).toBe(gitDir);
    expect(resolveGitCommonDirFs(wt)).toBe(gitDir);
  });
});

describe("renderMemorySiloDoctorHtml", () => {
  it("renders a ≥2-silo fixture card with schema, sizes, and action command URIs", () => {
    const root = mkTmp("mws-html-");
    siloFixture({
      projectsRoot: root,
      encoded: "-Users-me-repo",
      body: "alpha ".repeat(50),
    });
    siloFixture({
      projectsRoot: root,
      encoded: "-Users-me-repo--claude-worktrees-feat",
      body: "beta ".repeat(30),
    });
    const card = clusterMemorySilos(scanClaudeMemorySilos(root, { resolveGitCommonDir: () => null }));
    expect(card.clusters[0].silos).toHaveLength(2);
    const html = renderMemorySiloDoctorHtml(card);
    expect(html).toContain(MEMORY_SILO_SCHEMA);
    expect(html).toContain("Auto-memory worktree silos");
    expect(html).toContain("2 silos");
    expect(html).toContain("worktree");
    expect(html).toContain("/Users/me/repo");
    expect(html).toContain("/Users/me/repo/.claude/worktrees/feat");
    expect(html).toContain(`command:${COPY_MEMORY_SILO_MERGE_COMMAND}?`);
    expect(html).toContain(`command:${OPEN_MEMORY_SILO_PATHS_COMMAND}?`);
    expect(html).toContain("Copy merge candidates");
    expect(html).toContain("Open silo paths");
    expect(html).toContain("never deletes");
    expect(html).toContain("dash-encoded-cwd");
    expect(html).toContain("~/.codex/memories/");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("bleed?");
  });

  it("renders empty string when there is no fragmentation", () => {
    expect(renderMemorySiloDoctorHtml(clusterMemorySilos([]))).toBe("");
  });

  it("surfaces the bleed chip when the heuristic fires", () => {
    const t = 1_700_000_000_000;
    const silos: MemorySilo[] = [
      {
        encodedCwd: "-Users-me-repo",
        decodedCwd: "/Users/me/repo",
        memoryDir: "/tmp/a/memory",
        bytes: 100,
        tokensEstimate: 25,
        mtimeMs: t,
        gitCommonDir: null,
      },
      {
        encodedCwd: "-Users-me-repo--claude-worktrees-feat",
        decodedCwd: "/Users/me/repo/.claude/worktrees/feat",
        memoryDir: "/tmp/b/memory",
        bytes: 80,
        tokensEstimate: 20,
        mtimeMs: t,
        gitCommonDir: null,
      },
    ];
    const sessions: MemorySiloBleedSession[] = [
      {
        session_id: "p",
        kind: "session",
        source: "claude",
        project_path: "-Users-me-repo",
        started_at: t,
      },
      {
        session_id: "c",
        kind: "subagent",
        parent_session_id: "p",
        started_at: t + 1000,
      },
    ];
    const html = renderMemorySiloDoctorHtml(clusterMemorySilos(silos, { sessions }));
    expect(html).toContain("bleed?");
  });
});

describe("formatMergeCandidatesList", () => {
  it("lists decoded cwds and memory dirs and says do not delete", () => {
    const silos: MemorySilo[] = [
      {
        encodedCwd: "-Users-me-repo",
        decodedCwd: "/Users/me/repo",
        memoryDir: "/tmp/a/memory",
        bytes: 100,
        tokensEstimate: 25,
        mtimeMs: 1,
        gitCommonDir: null,
      },
      {
        encodedCwd: "-Users-me-repo--claude-worktrees-feat",
        decodedCwd: "/Users/me/repo/.claude/worktrees/feat",
        memoryDir: "/tmp/b/memory",
        bytes: 80,
        tokensEstimate: 20,
        mtimeMs: 1,
        gitCommonDir: null,
      },
    ];
    const md = formatMergeCandidatesList(clusterMemorySilos(silos));
    expect(md).toContain("do not delete");
    expect(md).toContain("/Users/me/repo");
    expect(md).toContain("/tmp/a/memory");
    expect(md).toContain("/tmp/b/memory");
    expect(md).toContain("2 silos");
  });
});
