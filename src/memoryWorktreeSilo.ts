// Auto-memory worktree silo doctor
// (KP ideas/csv-auto-memory-worktree-silo-doctor-detect-memo).
// Pure module — no vscode imports — so scan + cluster + renderer are
// fixture-testable.
//
// Claude Code keys persistent auto-memory by slugified cwd
// (`~/.claude/projects/<dash-encoded-cwd>/memory/MEMORY.md`). Each git
// worktree — including Claude's `.claude/worktrees/<name>` checkouts —
// therefore gets a **separate silo**, while operators expect repo-scoped
// memory (anthropics/claude-code#88579). Auto-memory is also injected into
// subagents that never declared `memory:` (#87613); a cheap heuristic flags
// when a silo's mtime lines up with a child session start.
//
// v1 is read-only: warn + reveal paths + copy a merge-candidates list.
// Never deletes or writes MEMORY.md. Distinct from fork-cache inheritance
// bleed (prompt cache) and any git-backed Memory MCP product.
//
// Codex analog: `~/.codex/memories/` is global (not per-cwd), so it does
// not fragment across worktrees. OpenCode analog unknown in v1.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MEMORY_SILO_SCHEMA = "code-sessions/auto-memory-worktree-silo@1";

export const COPY_MEMORY_SILO_MERGE_COMMAND = "codeSessions.copyMemorySiloMergeList";
export const OPEN_MEMORY_SILO_PATHS_COMMAND = "codeSessions.openMemorySiloPaths";

/** Child-start vs memory-dir mtime window for the optional bleed chip. */
export const DEFAULT_BLEED_WINDOW_MS = 5 * 60 * 1000;

/** ~4 bytes/token estimate used for the card's size chip. */
export const BYTES_PER_TOKEN = 4;

const WORKTREE_SUFFIX_RE = /--?(claude|git)-worktrees-.+$/i;
const WORKTREE_MARK_RE = /--?(claude|git)-worktrees-/i;

export function defaultClaudeProjectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/** Claude Code project-dir encoding: every non-alphanumeric char → `-`.
 * `/Users/me/repo/.claude/worktrees/feat` →
 * `-Users-me-repo--claude-worktrees-feat`. */
export function dashEncodeCwd(cwd: string): string {
  const abs = cwd.replace(/\\/g, "/");
  const encoded = abs.replace(/[^a-zA-Z0-9]/g, "-");
  return encoded.startsWith("-") ? encoded : `-${encoded}`;
}

/** Lossy inverse of dashEncodeCwd: `-` → `/`. Paths that themselves
 * contained hyphens cannot round-trip (see csv-claude-dash-decode-is-lossy).
 * `/.claude/` and `/.git/` survive as `--claude-` / `--git-` in the
 * encoded name; restore those well-known dotted segments so worktree
 * paths are readable on the card. */
export function dashDecodeCwd(encoded: string): string {
  const base = encoded.replace(/^-/, "");
  let decoded = "/" + base.replace(/-/g, "/");
  decoded = decoded.replace(/\/\/claude(?=\/|$)/g, "/.claude");
  decoded = decoded.replace(/\/\/git(?=\/|$)/g, "/.git");
  return decoded;
}

/** Strip a Claude/git worktree suffix from an encoded project dir so
 * main + `.claude/worktrees/foo` share a stem even when dash-decode is
 * lossy and the decoded cwd does not exist on disk. */
export function worktreeStem(encoded: string): string {
  return encoded.replace(WORKTREE_SUFFIX_RE, "");
}

export function looksLikeWorktreeSilo(encoded: string): boolean {
  return WORKTREE_MARK_RE.test(encoded);
}

export function estimateTokensFromBytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.max(1, Math.round(bytes / BYTES_PER_TOKEN));
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface MemorySilo {
  encodedCwd: string;
  decodedCwd: string;
  memoryDir: string;
  bytes: number;
  tokensEstimate: number;
  mtimeMs: number;
  gitCommonDir: string | null;
}

export interface MemorySiloCluster {
  id: string;
  grouping: "git-common-dir" | "worktree-stem";
  repoLabel: string;
  silos: MemorySilo[];
  totalBytes: number;
  totalTokensEstimate: number;
  divergingPaths: string[];
  bleed: boolean;
}

export interface MemorySiloDoctorCard {
  clusters: MemorySiloCluster[];
  scannedSilos: number;
  scannedProjectDirs: number;
}

/** Minimal session-row shape for the optional subagent-bleed chip. */
export interface MemorySiloBleedSession {
  session_id?: string | null;
  parent_session_id?: string | null;
  kind?: string | null;
  source?: string | null;
  project_path?: string | null;
  /** Epoch ms of first activity (SessionStore.started_at). */
  started_at?: number | null;
}

export interface ScanMemorySiloOptions {
  /** Override git-common-dir lookup (tests inject; default is a `.git` walk). */
  resolveGitCommonDir?: (cwd: string) => string | null;
}

export interface ClusterMemorySiloOptions {
  sessions?: MemorySiloBleedSession[];
  bleedWindowMs?: number;
}

// --------------------------------------------------------------------------- //
// Filesystem scan
// --------------------------------------------------------------------------- //

function dirBytesAndMtime(dir: string): { bytes: number; mtimeMs: number; files: number } {
  let bytes = 0;
  let mtimeMs = 0;
  let files = 0;
  const walk = (cur: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      try {
        if (e.isDirectory()) {
          walk(p);
        } else if (e.isFile()) {
          const st = fs.statSync(p);
          bytes += st.size;
          files += 1;
          if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
        }
      } catch {
        /* skip unreadable entries */
      }
    }
  };
  walk(dir);
  if (mtimeMs === 0) {
    try {
      mtimeMs = fs.statSync(dir).mtimeMs;
    } catch {
      /* keep 0 */
    }
  }
  return { bytes, mtimeMs, files };
}

/**
 * Walk up from `cwd` looking for a `.git` dir/file and resolve the
 * repository common dir (handles linked worktrees via `commondir` /
 * `gitdir:`). Returns null when `cwd` does not exist — dash-decode is
 * lossy, so this is best-effort.
 */
export function resolveGitCommonDirFs(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 24; i++) {
    const gitPath = path.join(dir, ".git");
    try {
      const st = fs.lstatSync(gitPath);
      if (st.isDirectory()) {
        const cdFile = path.join(gitPath, "commondir");
        if (fs.existsSync(cdFile)) {
          const rel = fs.readFileSync(cdFile, "utf8").trim();
          if (rel) return path.resolve(gitPath, rel);
        }
        return gitPath;
      }
      if (st.isFile()) {
        const text = fs.readFileSync(gitPath, "utf8");
        const m = /^gitdir:\s*(.+)\s*$/m.exec(text);
        if (!m) return null;
        const gitdir = path.resolve(dir, m[1].trim());
        const cdFile = path.join(gitdir, "commondir");
        if (fs.existsSync(cdFile)) {
          const rel = fs.readFileSync(cdFile, "utf8").trim();
          if (rel) return path.resolve(gitdir, rel);
        }
        // `<repo>/.git/worktrees/<name>` → `<repo>/.git`
        const marker = `${path.sep}worktrees${path.sep}`;
        const idx = gitdir.lastIndexOf(marker);
        if (idx > 0) return gitdir.slice(0, idx);
        return gitdir;
      }
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Scan `~/.claude/projects/<encoded-cwd>/memory` (or an injected fixture root). */
export function scanClaudeMemorySilos(
  projectsRoot: string = defaultClaudeProjectsRoot(),
  opts: ScanMemorySiloOptions = {},
): MemorySilo[] {
  const resolveGit = opts.resolveGitCommonDir ?? resolveGitCommonDirFs;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const silos: MemorySilo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const memoryDir = path.join(projectsRoot, e.name, "memory");
    let memStat: fs.Stats;
    try {
      memStat = fs.statSync(memoryDir);
      if (!memStat.isDirectory()) continue;
    } catch {
      continue;
    }
    const { bytes, mtimeMs, files } = dirBytesAndMtime(memoryDir);
    if (files === 0) continue;
    const decodedCwd = dashDecodeCwd(e.name);
    let gitCommonDir: string | null = null;
    try {
      gitCommonDir = resolveGit(decodedCwd);
    } catch {
      gitCommonDir = null;
    }
    silos.push({
      encodedCwd: e.name,
      decodedCwd,
      memoryDir,
      bytes,
      tokensEstimate: estimateTokensFromBytes(bytes),
      mtimeMs,
      gitCommonDir,
    });
  }
  silos.sort((a, b) => b.bytes - a.bytes);
  return silos;
}

// --------------------------------------------------------------------------- //
// Cluster
// --------------------------------------------------------------------------- //

function repoLabelFromCluster(silos: MemorySilo[], grouping: MemorySiloCluster["grouping"], id: string): string {
  if (grouping === "git-common-dir") {
    const parent = path.basename(path.dirname(id));
    if (parent && parent !== ".git") return parent;
  }
  const stem = worktreeStem(silos[0]?.encodedCwd ?? id);
  const decoded = dashDecodeCwd(stem);
  const base = decoded.split("/").filter(Boolean).pop();
  return base || stem;
}

function clusterBleed(
  silos: MemorySilo[],
  sessions: MemorySiloBleedSession[] | undefined,
  windowMs: number,
): boolean {
  if (!sessions || sessions.length === 0) return false;
  const encoded = new Set(silos.map((s) => s.encodedCwd));
  const parents = new Set<string>();
  for (const s of sessions) {
    const kind = s.kind ?? "session";
    if (kind === "subagent" || kind === "workflow") continue;
    if ((s.source || "claude") !== "claude") continue;
    const enc = s.project_path ? path.basename(s.project_path) : "";
    if (enc && encoded.has(enc) && s.session_id) parents.add(s.session_id);
  }
  if (parents.size === 0) return false;
  const childStarts: number[] = [];
  for (const s of sessions) {
    const kind = s.kind ?? "session";
    if (kind !== "subagent" && kind !== "workflow") continue;
    if (!s.parent_session_id || !parents.has(s.parent_session_id)) continue;
    const t = s.started_at ?? 0;
    if (t > 0) childStarts.push(t);
  }
  if (childStarts.length === 0) return false;
  for (const silo of silos) {
    if (silo.mtimeMs <= 0) continue;
    for (const t of childStarts) {
      if (Math.abs(silo.mtimeMs - t) <= windowMs) return true;
    }
  }
  return false;
}

function toCluster(
  id: string,
  grouping: MemorySiloCluster["grouping"],
  members: MemorySilo[],
  sessions: MemorySiloBleedSession[] | undefined,
  windowMs: number,
): MemorySiloCluster {
  const sorted = [...members].sort((a, b) => b.bytes - a.bytes);
  const totalBytes = sorted.reduce((n, s) => n + s.bytes, 0);
  return {
    id,
    grouping,
    repoLabel: repoLabelFromCluster(sorted, grouping, id),
    silos: sorted,
    totalBytes,
    totalTokensEstimate: estimateTokensFromBytes(totalBytes),
    divergingPaths: sorted.map((s) => s.decodedCwd),
    bleed: clusterBleed(sorted, sessions, windowMs),
  };
}

/**
 * Group silos that belong to the same repo. Prefer git common-dir when
 * the decoded cwd exists; fall back to `--claude-worktrees-` /
 * `--git-worktrees-` stems so hyphenated paths still cluster.
 * Only clusters with ≥2 silos are returned (the card is silent otherwise).
 */
export function clusterMemorySilos(
  silos: MemorySilo[],
  opts: ClusterMemorySiloOptions = {},
): MemorySiloDoctorCard {
  const windowMs = opts.bleedWindowMs ?? DEFAULT_BLEED_WINDOW_MS;
  const used = new Set<string>();
  const clusters: MemorySiloCluster[] = [];

  const byGit = new Map<string, MemorySilo[]>();
  for (const s of silos) {
    if (!s.gitCommonDir) continue;
    const key = path.resolve(s.gitCommonDir);
    const list = byGit.get(key);
    if (list) list.push(s);
    else byGit.set(key, [s]);
  }
  for (const [dir, members] of byGit) {
    if (members.length < 2) continue;
    for (const m of members) used.add(m.encodedCwd);
    clusters.push(toCluster(dir, "git-common-dir", members, opts.sessions, windowMs));
  }

  const unused = silos.filter((s) => !used.has(s.encodedCwd));
  const byStem = new Map<string, MemorySilo[]>();
  for (const s of unused) {
    const stem = worktreeStem(s.encodedCwd);
    const list = byStem.get(stem);
    if (list) list.push(s);
    else byStem.set(stem, [s]);
  }
  for (const [stem, members] of byStem) {
    if (members.length < 2) continue;
    if (!members.some((m) => looksLikeWorktreeSilo(m.encodedCwd))) continue;
    for (const m of members) used.add(m.encodedCwd);
    clusters.push(toCluster(stem, "worktree-stem", members, opts.sessions, windowMs));
  }

  clusters.sort((a, b) => b.totalBytes - a.totalBytes || b.silos.length - a.silos.length);
  return {
    clusters,
    scannedSilos: silos.length,
    scannedProjectDirs: silos.length,
  };
}

export function formatMergeCandidatesList(card: MemorySiloDoctorCard): string {
  const lines: string[] = [
    "# Auto-memory silos — merge candidates (read-only; do not delete)",
    "",
    "Claude Code keys MEMORY.md by slugified cwd, so each worktree is a separate silo.",
    "Copy this list, then merge by hand. This doctor never wipes memory.",
    "",
  ];
  for (const c of card.clusters) {
    lines.push(
      `## ${c.repoLabel} (${c.silos.length} silos, ${formatBytes(c.totalBytes)}, ~${c.totalTokensEstimate} tokens, via ${c.grouping})`,
    );
    for (const s of c.silos) {
      lines.push(
        `- ${s.decodedCwd}  (${formatBytes(s.bytes)}, ~${s.tokensEstimate} tok, ${s.memoryDir})`,
      );
    }
    lines.push("");
  }
  if (card.clusters.length === 0) {
    lines.push("(no fragmented repos — fewer than 2 silos share a git common-dir or worktree stem)");
    lines.push("");
  }
  return lines.join("\n");
}

// --------------------------------------------------------------------------- //
// HTML
// --------------------------------------------------------------------------- //

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function commandHref(command: string, args: unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

export interface MemorySiloRenderOpts {
  copyCommand?: string;
  openCommand?: string;
}

/** Insights section ("" when no repo has ≥2 silos). */
export function renderMemorySiloDoctorHtml(
  card: MemorySiloDoctorCard,
  opts: MemorySiloRenderOpts = {},
): string {
  if (card.clusters.length === 0) return "";
  const copyCmd = opts.copyCommand ?? COPY_MEMORY_SILO_MERGE_COMMAND;
  const openCmd = opts.openCommand ?? OPEN_MEMORY_SILO_PATHS_COMMAND;
  const mergeText = formatMergeCandidatesList(card);
  const allPaths = card.clusters.flatMap((c) => c.silos.map((s) => s.memoryDir));
  const copyHref = commandHref(copyCmd, [mergeText]);
  const openAllHref = commandHref(openCmd, allPaths);
  const anyBleed = card.clusters.some((c) => c.bleed);
  const siloCount = card.clusters.reduce((n, c) => n + c.silos.length, 0);
  const repoCount = card.clusters.length;

  const blocks = card.clusters
    .map((c) => {
      const bleedChip = c.bleed
        ? `<span class="mws-chip mws-bleed" title="A child session started within 5 minutes of this silo's MEMORY.md mtime — auto-memory may have been injected into a subagent that never declared memory: (#87613)">bleed?</span>`
        : "";
      const rows = c.silos
        .map((s) => {
          const openHref = commandHref(openCmd, [s.memoryDir]);
          const worktree = looksLikeWorktreeSilo(s.encodedCwd);
          return `<tr>
        <td class="mws-path"><a class="mws-link" href="${esc(openHref)}" title="${esc(s.memoryDir)}">${esc(s.decodedCwd)}</a>${
            worktree ? ` <span class="mws-tag">worktree</span>` : ""
          }</td>
        <td class="num">${esc(formatBytes(s.bytes))}</td>
        <td class="num">~${esc(String(s.tokensEstimate))}</td>
      </tr>`;
        })
        .join("");
      return `<div class="mws-cluster">
    <div class="mws-cluster-head"><span class="mws-repo">${esc(c.repoLabel)}</span>
      <span class="mws-chip" title="Grouped by ${esc(c.grouping)}">${c.silos.length} silos</span>
      ${bleedChip}
      <span class="mws-muted">${esc(formatBytes(c.totalBytes))} · ~${esc(String(c.totalTokensEstimate))} tok · ${esc(c.grouping)}</span>
    </div>
    <table class="mws-table"><tr><th>cwd (decoded)</th><th>size</th><th>tokens</th></tr>${rows}</table>
  </div>`;
    })
    .join("");

  return `<section class="mws-card" data-schema="${esc(MEMORY_SILO_SCHEMA)}">
  <div class="mws-head"><span class="mws-title">Auto-memory worktree silos</span>
    <span class="mws-chip" title="Claude keys MEMORY.md by slugified cwd, so each worktree is a separate silo (#88579)">${siloCount} silos / ${repoCount} repo${repoCount === 1 ? "" : "s"}</span>
    ${anyBleed ? `<span class="mws-chip mws-bleed" title="At least one silo's mtime lines up with a child session start">bleed?</span>` : ""}
    <span class="mws-actions">
      <a class="mws-action" href="${esc(copyHref)}">Copy merge candidates</a>
      <a class="mws-action" href="${esc(openAllHref)}">Open silo paths</a>
    </span>
  </div>
  <div class="mws-sub">Claude Code stores auto-memory at <code>~/.claude/projects/&lt;dash-encoded-cwd&gt;/memory/MEMORY.md</code>. Each worktree cwd becomes its own silo while you probably wanted repo-scoped memory (#88579). ${siloCount} silo${siloCount === 1 ? "" : "s"} across ${repoCount} repo${repoCount === 1 ? "" : "s"} below · ${card.scannedSilos} memory dir${card.scannedSilos === 1 ? "" : "s"} scanned.</div>
  ${blocks}
  <div class="mws-help">Grouping prefers a <code>.git</code> common-dir walk when the decoded cwd exists; otherwise a <code>--claude-worktrees-</code> / <code>--git-worktrees-</code> stem on the encoded name. Dash-decode is lossy when the real path contains hyphens. Token sizes are ~bytes/4. Codex <code>~/.codex/memories/</code> is global (not per-cwd) so it does not fragment; OpenCode analog unknown in v1.</div>
  <div class="mws-disclaimer">Read-only doctor — lists paths and copies a merge-candidates checklist; never deletes or writes MEMORY.md. Distinct from fork-cache inheritance bleed (prompt cache). Confirm before any merge; auto-wipe is a separate flow.</div>
</section>`;
}

/** CSS for Insights — keep in sync with `.mws-*` markup above. */
export const MEMORY_SILO_CARD_CSS = `
.mws-card { background: var(--card-bg, var(--vscode-editorWidget-background, #1e1e1e)); border: 1px solid var(--border, var(--vscode-panel-border, #333)); border-radius: 6px; padding: 12px 14px; margin-top: 8px; }
.mws-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; flex-wrap: wrap; }
.mws-title { font-size: 11px; text-transform: uppercase; color: var(--muted, var(--vscode-descriptionForeground, #999)); letter-spacing: 0.5px; font-weight: 600; }
.mws-chip { display: inline-block; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; color: var(--vscode-inputValidation-warningForeground, #e8a838); border: 1px solid var(--vscode-inputValidation-warningForeground, #e8a838); border-radius: 8px; padding: 1px 7px; vertical-align: middle; }
.mws-chip.mws-bleed { color: var(--vscode-inputValidation-errorForeground, #f88); border-color: var(--vscode-inputValidation-errorForeground, #f88); }
.mws-actions { margin-left: auto; display: flex; gap: 12px; }
.mws-action { font-size: 11px; color: var(--accent, var(--vscode-textLink-foreground, #4af)); text-decoration: none; font-weight: 500; }
.mws-action:hover { text-decoration: underline; }
.mws-sub { font-size: 12px; color: var(--muted, var(--vscode-descriptionForeground, #999)); line-height: 1.45; margin-bottom: 8px; }
.mws-sub code { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
.mws-cluster { margin-top: 10px; }
.mws-cluster-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
.mws-repo { font-size: 12px; font-weight: 600; }
.mws-muted { font-size: 11px; color: var(--muted, var(--vscode-descriptionForeground, #999)); }
.mws-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 2px; }
.mws-table th, .mws-table td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--border, var(--vscode-panel-border, #333)); }
.mws-table th { color: var(--muted, var(--vscode-descriptionForeground, #999)); font-weight: 500; font-size: 10px; text-transform: uppercase; }
.mws-table td.num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.mws-table th:nth-child(n+2) { text-align: right; }
.mws-path { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; word-break: break-all; }
.mws-link { color: var(--accent, var(--vscode-textLink-foreground, #4af)); text-decoration: none; }
.mws-link:hover { text-decoration: underline; }
.mws-tag { font-size: 9px; text-transform: uppercase; letter-spacing: 0.3px; color: var(--muted, var(--vscode-descriptionForeground, #999)); border: 1px solid var(--border, var(--vscode-panel-border, #333)); border-radius: 6px; padding: 0 5px; }
.mws-help { font-size: 11px; color: var(--muted, var(--vscode-descriptionForeground, #999)); margin-top: 8px; line-height: 1.45; }
.mws-help code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; }
.mws-disclaimer { font-size: 11px; color: var(--muted, var(--vscode-descriptionForeground, #999)); margin-top: 8px; line-height: 1.45; border-top: 1px solid var(--border, var(--vscode-panel-border, #333)); padding-top: 8px; }
`;
