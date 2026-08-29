// Untested-write surface: per-session list of production file paths the agent
// wrote with zero companion test-path touch (write OR read) in the same
// session. Heuristic-only — companion-path presence, not coverage, not
// execution, not assertion strength. Computed on demand from the transcript;
// nothing is persisted (the store keeps tool *names* only, never per-call
// arguments — see db.ts v1–v18).
//
// Backend sources:
//   claude — conversationParser ToolCall.input: Write/Edit → writes, Read →
//            reads. Known miss (caveat, unsolved): MultiEdit and writes made
//            inside Agent/Task subagent transcripts.
//   grok   — write/search_replace → writes (same key quirks as
//            fileEditPathFromToolCall); read_file → reads. Real sessions use
//            `target_file` for read_file, older/fixture sessions `file_path`;
//            both accepted.
//   codex  — the viewer adapter keeps tool names only, but rollout files DO
//            carry function_call.arguments. Re-read the rollout here and
//            extract V4A patch headers (*** Add/Update File, *** Move to) and
//            structured apply_patch operations. Shell writes (touch, cat >,
//            heredocs) are a known miss — disclosed, never claimed complete.
//   git/store fallback — no tool arguments exist; status 'unavailable',
//            never a fake "all paired".

import * as fs from "fs";
import * as path from "path";
import { parseConversation } from "./conversationParser";
import { parseGrokConversation } from "./grokConversationParser";

export type WriteSurfaceStatus = "ok" | "partial" | "unavailable";

export interface UntestedWrite {
  path: string;
  /** Per-path honesty note: Rust inline-test blindness, unknown-language
   * heuristic gap. Null when the standard heuristics fully apply. */
  note: string | null;
}

export interface WriteSurface {
  /** Production writes (normalized, deduped; test paths and excluded classes
   * removed). */
  writes: string[];
  /** Every read path seen, deduped (test + production alike). */
  reads: string[];
  untestedWrites: UntestedWrite[];
  status: WriteSurfaceStatus;
  /** Session-level honesty notes (known extraction misses, fallback reasons). */
  caveats: string[];
}

/** Minimal structural slice of a SessionRow — pass the full row or a stub. */
export interface WriteSurfaceSessionInput {
  source?: string | null;
  jsonl_path?: string | null;
}

// ---------------------------------------------------------------------------
// Path classification

const JS_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const TEST_DIR_SEGMENTS = new Set(["__tests__", "tests", "test"]);

function segmentsOf(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}

function extOf(p: string): string {
  return path.extname(p).toLowerCase();
}

function underTestDir(p: string): boolean {
  return segmentsOf(p).slice(0, -1).some((s) => TEST_DIR_SEGMENTS.has(s));
}

/** Is this path itself a test (or test-adjacent) file? Suffix/prefix patterns
 * and known directories only — never a bare `test` substring (contest.ts,
 * testimonial.tsx). `testdata/` is Go fixtures, not tests. */
export function isTestPath(p: string): boolean {
  const segs = segmentsOf(p);
  if (segs.slice(0, -1).some((s) => s === "testdata")) return false;
  const base = path.basename(p);
  const ext = extOf(p);
  if (ext === ".go") return /_test\.go$/.test(base);
  if (ext === ".py") {
    if (/^test_.*\.py$/.test(base) || /_test\.py$/.test(base)) return true;
    if (base === "conftest.py") return true;
    return underTestDir(p);
  }
  if (ext === ".rs") return underTestDir(p);
  if (JS_EXTS.has(ext)) {
    if (segs.slice(0, -1).some((s) => s === "__tests__")) return true;
    if (/\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs)$/.test(base)) return true;
    return underTestDir(p);
  }
  return underTestDir(p);
}

const DOC_EXTS = new Set([".md", ".mdx", ".markdown", ".rst", ".txt"]);
const CONFIG_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "cargo.toml",
  "cargo.lock",
  "go.mod",
  "go.sum",
  ".gitignore",
  ".npmrc",
  ".editorconfig",
]);
const GENERATED_DIR_SEGMENTS = new Set(["dist", "build", "out", ".next", "node_modules", "target"]);
const FIXTURE_DIR_SEGMENTS = new Set(["__snapshots__", "testdata", "fixtures"]);

/** Should this write be excluded from the production-write set entirely?
 * Docs, config/lockfiles, generated output, snapshots/fixtures. */
export function isExcludedWrite(p: string): boolean {
  const base = path.basename(p);
  const baseLower = base.toLowerCase();
  const ext = extOf(p);
  const dirSegs = segmentsOf(p).slice(0, -1);
  if (DOC_EXTS.has(ext)) return true;
  if (/^(readme|changelog|license)/i.test(base)) return true;
  if (dirSegs.some((s) => s === "docs")) return true;
  if (CONFIG_BASENAMES.has(baseLower)) return true;
  if (/^tsconfig.*\.json$/.test(baseLower)) return true;
  if (ext === ".lock" || baseLower.endsWith(".lock")) return true;
  if (ext === ".yaml" || ext === ".yml") return true;
  if (dirSegs.some((s) => GENERATED_DIR_SEGMENTS.has(s))) return true;
  if (/\.generated\./.test(base) || /_pb2\.py$/.test(base) || /\.pb\.go$/.test(base)) return true;
  if (baseLower.endsWith(".d.ts")) return true;
  if (dirSegs.some((s) => FIXTURE_DIR_SEGMENTS.has(s))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Pairing

/** Basename stem: extension gone, test affixes stripped.
 * foo.test.ts → foo · test_foo.py → foo · foo_test.go → foo · foo.rs → foo */
function strippedStem(p: string): string {
  let base = path.basename(p);
  const ext = path.extname(base);
  if (ext) base = base.slice(0, -ext.length);
  base = base.replace(/\.(test|spec)$/, "");
  base = base.replace(/^test_/, "");
  base = base.replace(/_test$/, "");
  return base;
}

/** Directory context for pairing: dirname segments minus test-dir segments
 * (__tests__/tests/test) and the src/lib layer, so co-located, __tests__
 * sibling, and src|lib↔tests mirror all collapse to the same context. */
function pairContext(p: string): string {
  return segmentsOf(p)
    .slice(0, -1)
    .filter((s) => !TEST_DIR_SEGMENTS.has(s) && s !== "src" && s !== "lib")
    .join("/");
}

/** Does touched path T companion-pair with production write W? Strict: T must
 * itself be a test path, share W's stem after affix stripping, AND live in
 * the same directory context (co-located, __tests__/tests sibling, or
 * src|lib↔tests mirror). An unrelated bar.test.ts never clears foo.ts, and a
 * same-stem test in a different monorepo package never clears it either. The
 * lenient "any test in the same package" rule is deliberately not
 * implemented. */
export function pairsWith(write: string, touch: string): boolean {
  if (!isTestPath(touch)) return false;
  if (strippedStem(touch) !== strippedStem(write)) return false;
  return pairContext(touch) === pairContext(write);
}

const KNOWN_HEURISTIC_EXTS = new Set([...JS_EXTS, ".py", ".go", ".rs"]);

const RUST_NOTE = "Rust: inline #[cfg(test)] tests are invisible to path heuristics";
const UNKNOWN_LANG_NOTE = "no test-path heuristic for this file type";

// ---------------------------------------------------------------------------
// Pure core

export interface SessionTouches {
  writes: string[];
  reads: string[];
}

function normalize(p: string): string {
  return path.normalize(p.trim());
}

function dedupe(paths: string[]): string[] {
  return [...new Set(paths.map(normalize).filter((p) => p.length > 0 && p !== "."))];
}

/** Pure core: touches → surface. Backend extractors feed this; unit fixtures
 * exercise it directly. */
export function computeFromTouches(
  touches: SessionTouches,
  opts?: { status?: WriteSurfaceStatus; caveats?: string[] },
): WriteSurface {
  const allWrites = dedupe(touches.writes);
  const reads = dedupe(touches.reads);
  const prodWrites = allWrites.filter((w) => !isTestPath(w) && !isExcludedWrite(w));
  const allTouches = [...allWrites, ...reads];

  const untestedWrites: UntestedWrite[] = [];
  for (const w of prodWrites) {
    const paired = allTouches.some((t) => t !== w && pairsWith(w, t));
    if (paired) continue;
    const ext = extOf(w);
    let note: string | null = null;
    if (ext === ".rs") note = RUST_NOTE;
    else if (!KNOWN_HEURISTIC_EXTS.has(ext)) note = UNKNOWN_LANG_NOTE;
    untestedWrites.push({ path: w, note });
  }

  return {
    writes: prodWrites,
    reads,
    untestedWrites,
    status: opts?.status ?? "ok",
    caveats: opts?.caveats ?? [],
  };
}

function unavailable(reason: string): WriteSurface {
  return { writes: [], reads: [], untestedWrites: [], status: "unavailable", caveats: [reason] };
}

// ---------------------------------------------------------------------------
// Backend extractors

const CLAUDE_SUBAGENT_CAVEAT = "subagent (Agent/Task) file writes are not tracked";
const CLAUDE_MULTIEDIT_CAVEAT = "MultiEdit writes are not tracked";

export function extractClaudeTouches(jsonlPath: string): { touches: SessionTouches; caveats: string[] } {
  const parsed = parseConversation(jsonlPath);
  const writes: string[] = [];
  const reads: string[] = [];
  const caveats = new Set<string>();
  for (const turn of parsed.turns) {
    for (const tc of turn.toolCalls) {
      const fp = typeof tc.input?.file_path === "string" ? tc.input.file_path : null;
      if ((tc.name === "Write" || tc.name === "Edit") && fp) writes.push(fp);
      else if (tc.name === "Read" && fp) reads.push(fp);
      else if (tc.name === "MultiEdit") caveats.add(CLAUDE_MULTIEDIT_CAVEAT);
      else if (tc.isSubagent) caveats.add(CLAUDE_SUBAGENT_CAVEAT);
    }
  }
  return { touches: { writes, reads }, caveats: [...caveats] };
}

const GROK_SUBAGENT_CAVEAT = "grok subagent (spawn_subagent) file writes are not tracked";

export function extractGrokTouches(jsonlPath: string): { touches: SessionTouches; caveats: string[] } {
  const parsed = parseGrokConversation(jsonlPath);
  const writes: string[] = [];
  const reads: string[] = [];
  const caveats = new Set<string>();
  for (const turn of parsed.turns) {
    for (const tc of turn.toolCalls) {
      if (tc.name === "spawn_subagent") caveats.add(GROK_SUBAGENT_CAVEAT);
      if (typeof tc.arguments !== "string") continue;
      let args: any;
      try {
        args = JSON.parse(tc.arguments);
      } catch {
        continue;
      }
      if (tc.name === "search_replace" || tc.name === "write") {
        const p = tc.name === "search_replace" ? args?.file_path : (args?.filePath ?? args?.file_path);
        if (typeof p === "string" && p) writes.push(p);
      } else if (tc.name === "read_file") {
        const p = args?.target_file ?? args?.file_path;
        if (typeof p === "string" && p) reads.push(p);
      }
    }
  }
  return { touches: { writes, reads }, caveats: [...caveats] };
}

const CODEX_SHELL_CAVEAT = "Codex shell writes (touch, cat >, heredocs) are not detected";

/** V4A patch envelope → write paths. Add/Update are writes; a `*** Move to:`
 * destination is the write for the preceding Update; deletes ignored. */
export function writePathsFromV4A(patchText: string): string[] {
  const writes: string[] = [];
  let pendingIdx = -1;
  for (const rawLine of patchText.split("\n")) {
    const line = rawLine.trimEnd();
    const m = /^\*\*\* (Add|Update|Delete) File:\s*(.+)$/.exec(line);
    if (m) {
      const p = m[2].trim().replace(/^["']|["']$/g, "");
      if (m[1] === "Delete") {
        pendingIdx = -1;
        continue;
      }
      writes.push(p);
      pendingIdx = writes.length - 1;
      continue;
    }
    const mv = /^\*\*\* Move to:\s*(.+)$/.exec(line);
    if (mv && pendingIdx >= 0) {
      writes[pendingIdx] = mv[1].trim().replace(/^["']|["']$/g, "");
      pendingIdx = -1;
    }
  }
  return writes;
}

const CODEX_READ_TOOLS = new Set(["read_file", "view", "open_file"]);

export function extractCodexTouches(rolloutPath: string): { touches: SessionTouches; caveats: string[] } {
  const raw = fs.readFileSync(rolloutPath, "utf-8");
  const writes: string[] = [];
  const reads: string[] = [];
  for (const ln of raw.split("\n")) {
    if (!ln.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(ln);
    } catch {
      continue;
    }
    const ev = obj?.type ? obj : obj?.item ? obj.item : null;
    const p = ev?.payload ?? null;
    if (!p || typeof p !== "object") continue;
    const ptype = p.type;
    if (
      ptype !== "function_call" &&
      ptype !== "custom_tool_call" &&
      ptype !== "local_shell_call" &&
      ptype !== "tool_call"
    )
      continue;

    const name = typeof p.name === "string" ? p.name : "";
    const argsRaw =
      typeof p.arguments === "string" ? p.arguments : typeof p.input === "string" ? p.input : "";

    let args: any = null;
    if (argsRaw) {
      try {
        args = JSON.parse(argsRaw);
      } catch {
        args = null;
      }
    }

    // Structured apply_patch: operation.{type,path}
    const op = args?.operation ?? p.operation;
    if (op && typeof op === "object" && typeof op.path === "string") {
      if (op.type === "create_file" || op.type === "update_file") writes.push(op.path);
      continue;
    }

    // V4A patch text — direct input, arguments.input/patch, or shell
    // command array ["apply_patch", "<patch>"] / bash -lc heredoc.
    let patchText: string | null = null;
    if (argsRaw.includes("*** Begin Patch")) {
      if (typeof args?.input === "string") patchText = args.input;
      else if (typeof args?.patch === "string") patchText = args.patch;
      else if (Array.isArray(args?.command)) patchText = args.command.join("\n");
      else patchText = argsRaw;
    }
    if (patchText) {
      writes.push(...writePathsFromV4A(patchText));
      continue;
    }

    if (CODEX_READ_TOOLS.has(name)) {
      const rp = args?.file_path ?? args?.target_file ?? args?.path;
      if (typeof rp === "string" && rp) reads.push(rp);
    }
  }
  return { touches: { writes, reads }, caveats: [CODEX_SHELL_CAVEAT] };
}

// ---------------------------------------------------------------------------
// Entry point

/** One session → write surface, on demand. No DB reads or writes; the row's
 * source + jsonl_path decide the transcript parser. Missing/unparseable
 * transcript or a store fallback (no tool arguments exist) → 'unavailable',
 * never a fake "all paired". */
export function computeWriteSurface(row: WriteSurfaceSessionInput): WriteSurface {
  const source = row.source ?? null;
  const jsonlPath = row.jsonl_path ?? null;
  if (!source) return unavailable("session source unknown — surface unavailable");
  if (!jsonlPath) return unavailable("transcript path unknown — surface unavailable");
  if (!fs.existsSync(jsonlPath)) return unavailable("transcript missing on this device — surface unavailable");
  if (source !== "claude" && source !== "grok" && source !== "codex") {
    return unavailable("store-fallback session has no tool arguments — surface unavailable");
  }
  try {
    const extracted =
      source === "claude"
        ? extractClaudeTouches(jsonlPath)
        : source === "grok"
          ? extractGrokTouches(jsonlPath)
          : extractCodexTouches(jsonlPath);
    const status: WriteSurfaceStatus = extracted.caveats.length > 0 ? "partial" : "ok";
    return computeFromTouches(extracted.touches, { status, caveats: extracted.caveats });
  } catch {
    return unavailable("transcript unreadable — surface unavailable");
  }
}

// ---------------------------------------------------------------------------
// Card HTML (pure — no vscode import; the conversation webview injects it)

/** Command the conversation viewer registers for click-to-open. The webview
 * has `enableScripts: false`, so links are `command:` URIs, never JS. */
export const OPEN_ABSOLUTE_FILE_COMMAND = "codeSessions.openAbsoluteFile";
/** Exact wording required by the KP item — the metric is companion-path
 * presence, never coverage. */
export const WRITE_SURFACE_SUBTITLE = "companion path touch only — not coverage";
export const WRITE_SURFACE_CAP = 25;

export interface WriteSurfaceCardOpts {
  /** Emit `command:` URIs for each path (default true). Off for plain HTML. */
  commandUris?: boolean;
  /** Max paths listed before the `+K more` overflow row (default 25). */
  cap?: number;
}

function escapeCardHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render the `Untested writes (N)` card. Three distinct empty copies (no
 * writes / all paired / unavailable) so an empty list is never read as
 * "safe" when the surface simply could not be computed. */
export function renderWriteSurfaceCardHtml(surface: WriteSurface, opts?: WriteSurfaceCardOpts): string {
  const commandUris = opts?.commandUris !== false;
  const cap = Math.max(1, opts?.cap ?? WRITE_SURFACE_CAP);
  const n = surface.untestedWrites.length;
  const subtitle = `<div class="ws-sub">${escapeCardHtml(WRITE_SURFACE_SUBTITLE)}</div>`;
  const caveats =
    surface.caveats.length > 0
      ? `<ul class="ws-caveats">${surface.caveats.map((c) => `<li>${escapeCardHtml(c)}</li>`).join("")}</ul>`
      : "";

  if (surface.status === "unavailable") {
    return `<section class="ws-card ws-unavailable">
  <div class="ws-head"><span class="ws-title">Untested writes</span><span class="ws-count">surface unavailable</span></div>
  ${subtitle}
  ${caveats}
</section>`;
  }

  let body: string;
  if (n === 0) {
    const empty =
      surface.writes.length === 0
        ? "No production writes detected in this transcript (heuristic)."
        : `No untested writes detected (heuristic) — ${surface.writes.length} production write${surface.writes.length === 1 ? "" : "s"}, each with a companion test-path touch.`;
    body = `<div class="ws-empty">${escapeCardHtml(empty)}</div>`;
  } else {
    const shown = surface.untestedWrites.slice(0, cap);
    const rows = shown
      .map((w) => {
        const label = escapeCardHtml(w.path);
        const link = commandUris
          ? `<a class="ws-path" href="command:${OPEN_ABSOLUTE_FILE_COMMAND}?${encodeURIComponent(JSON.stringify([w.path]))}" title="${label}">${label}</a>`
          : `<span class="ws-path" title="${label}">${label}</span>`;
        const badge = w.note ? ` <span class="ws-badge" title="${escapeCardHtml(w.note)}">${escapeCardHtml(w.note)}</span>` : "";
        return `<li>${link}${badge}</li>`;
      })
      .join("");
    const overflow = n > cap ? `<li class="ws-more">+${n - cap} more</li>` : "";
    body = `<ul class="ws-list">${rows}${overflow}</ul>`;
  }

  return `<section class="ws-card">
  <div class="ws-head"><span class="ws-title">Untested writes (${n})</span>${surface.status === "partial" ? '<span class="ws-count">partial extraction</span>' : ""}</div>
  ${subtitle}
  ${body}
  ${caveats}
</section>`;
}
