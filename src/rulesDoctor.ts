// rulesDoctor.ts — pure core for the "never-referenced rules" doctor card.
//
// Joins project rule files (CLAUDE.md / AGENTS.md / .cursor/rules/*) against
// indexed multi-backend transcripts and ranks sections with zero transcript
// evidence as review candidates. Read-only analysis: this module never writes
// rule files and never touches the database — callers pass turn texts in.
//
// Matching validity: always-on rules shape behavior without being quoted, so
// zero literal hits ≠ proven dead. A section is scorable only when it carries
// at least one deterministic distinctive signal (code span, path-like token,
// quoted phrase, or rare n-gram). Sections whose only would-be evidence is a
// heading keyword or generic imperative are `unscorable`, never candidates.
// Short "Never …"/"Do not …" bullets are `protected` even at zero hits.

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Same defensive cap as memoryView's readEntries: skip accidental binaries. */
const MAX_RULE_FILE_BYTES = 2 * 1024 * 1024;

/** Hard bounds for the transcript scan — the extension runs on WASM sqlite,
 * so the in-memory matcher caps work per turn and per section. */
export const MAX_SIGNALS_PER_SECTION = 12;
/** UTF-16 code units, not bytes — a `String.slice` cap on each turn text. */
export const MAX_TURN_SCAN_CHARS = 16 * 1024;

export interface RuleFile {
  /** Path relative to the project root, e.g. `.cursor/rules/style.mdc`. */
  relPath: string;
  absPath: string;
}

/** Find rule files under a project root: CLAUDE.md, AGENTS.md (any casing —
 * this repo itself ships `Agents.md`) and `.cursor/rules/*.{md,mdc}`.
 * Oversized (>2 MB) and unreadable entries are skipped silently. */
export function discoverRuleFiles(rootDir: string): RuleFile[] {
  const out: RuleFile[] = [];
  const pushIfFile = (relPath: string, absPath: string) => {
    try {
      const st = fs.statSync(absPath);
      if (st.isFile() && st.size <= MAX_RULE_FILE_BYTES) out.push({ relPath, absPath });
    } catch {
      /* missing / unreadable — not an error */
    }
  };
  let rootEntries: string[] = [];
  try {
    rootEntries = fs.readdirSync(rootDir);
  } catch {
    return out;
  }
  for (const name of rootEntries) {
    if (/^(claude|agents)\.md$/i.test(name)) pushIfFile(name, path.join(rootDir, name));
  }
  const rulesDir = path.join(rootDir, ".cursor", "rules");
  try {
    for (const name of fs.readdirSync(rulesDir).sort()) {
      if (/\.(md|mdc)$/i.test(name)) {
        pushIfFile(path.join(".cursor", "rules", name), path.join(rulesDir, name));
      }
    }
  } catch {
    /* no .cursor/rules */
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section parsing
// ---------------------------------------------------------------------------

export interface RuleSection {
  /** relPath of the source file. */
  file: string;
  /** Heading text without the `##` marker; filename for headingless files. */
  heading: string;
  /** 1-based line of the heading (or 1 for the headingless fallback). */
  startLine: number;
  /** Section body (lines after the heading, before the next same-or-higher
   * heading), frontmatter already stripped. */
  body: string;
}

/** Strip a leading `.mdc`-style YAML frontmatter block. Returns the remaining
 * text plus how many lines were removed (to keep startLine anchors valid). */
export function stripFrontmatter(text: string): { body: string; removedLines: number } {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { body: text, removedLines: 0 };
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) {
      return { body: lines.slice(i + 1).join("\n"), removedLines: i + 1 };
    }
  }
  return { body: text, removedLines: 0 };
}

/** Split markdown into `##`/`###` sections. Fenced code blocks are respected
 * (a literal `## ` line inside a ``` fence does not start a section — same
 * walker discipline as memoryView.countH2Sections). A file with no headings
 * becomes one section named after the file. Preamble text before the first
 * heading is folded into that same filename-named section. */
export function parseRuleSections(text: string, relPath: string): RuleSection[] {
  const { body: afterFm, removedLines } = stripFrontmatter(text);
  const lines = afterFm.split("\n");
  const out: RuleSection[] = [];
  const fileFallbackName = path.basename(relPath);

  let inFence = false;
  let current: { heading: string; startLine: number; body: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const body = current.body.join("\n").trim();
    // Preamble/headingless chunks with no substance are dropped.
    if (current.heading !== fileFallbackName || body.length > 0) {
      out.push({ file: relPath, heading: current.heading, startLine: current.startLine, body });
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      current?.body.push(line);
      continue;
    }
    const m = !inFence ? /^(##|###)\s+(\S.*)$/.exec(line) : null;
    if (m) {
      flush();
      current = { heading: m[2].trim(), startLine: removedLines + i + 1, body: [] };
      continue;
    }
    if (!current) current = { heading: fileFallbackName, startLine: removedLines + 1, body: [] };
    current.body.push(line);
  }
  flush();
  return out;
}

/** Drop sections whose normalized body already appeared (CLAUDE.md ↔ AGENTS.md
 * symlinks and `@import` duplication). First occurrence wins. */
export function dedupeSections(sections: RuleSection[]): RuleSection[] {
  const seen = new Set<string>();
  const out: RuleSection[] = [];
  for (const s of sections) {
    const norm = s.body.replace(/\s+/g, " ").trim().toLowerCase();
    if (norm.length === 0) {
      out.push(s);
      continue;
    }
    const hash = crypto.createHash("sha1").update(norm).digest("hex");
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Distinctive signals
// ---------------------------------------------------------------------------

export type SignalKind = "code" | "path" | "quote" | "ngram";

export interface Signal {
  kind: SignalKind;
  /** Literal text matched case-insensitively as a substring of turn text. */
  text: string;
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "for", "from",
  "has", "have", "if", "in", "into", "is", "it", "its", "no", "not", "of",
  "on", "or", "our", "so", "than", "that", "the", "their", "them", "then",
  "there", "these", "they", "this", "to", "use", "was", "we", "when", "which",
  "will", "with", "you", "your",
]);

/** Words that never count as evidence on their own: generic imperatives and
 * ultra-common stack nouns. A signal made only of these (plus stopwords) is
 * junk — it would match transcripts constantly without meaning anything. */
const JUNK_WORDS = new Set([
  "always", "never", "prefer", "avoid", "must", "should", "shall", "dont",
  "don't", "do", "not", "please", "ensure", "make", "sure", "keep", "only",
  "typescript", "javascript", "react", "node", "python", "git", "npm", "pnpm",
  "yarn", "test", "tests", "testing", "code", "file", "files", "run", "build",
  "lint", "commit", "branch", "error", "errors", "function", "functions",
  "security", "style", "conventions", "overview", "notes", "important",
]);

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9_'./-]+/).filter(Boolean);
}

/** True when the tokens carry at least one word that is neither a stopword
 * nor a junk/generic word and is ≥4 chars — the distinctiveness floor. */
function hasDistinctiveToken(tokens: string[]): boolean {
  return tokens.some(
    (t) => t.length >= 4 && !STOPWORDS.has(t) && !JUNK_WORDS.has(t.replace(/[^a-z0-9']/g, ""))
  );
}

const PATH_TOKEN_RE =
  /(?:^|[\s(`'"])((?:\.{1,2}\/)?[\w@.-]+\/[\w@./*-]+|\*\.[a-z0-9]{1,8}|[\w-]{2,}\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdc|py|sh|yml|yaml|toml|sql|css|html))(?=$|[\s)`'".,;:])/gim;

/** Extract deterministic distinctive signals from a section body.
 * Kinds, in priority order:
 *  - `code`  — backtick spans ≥6 chars
 *  - `path`  — path-like tokens (`src/foo.ts`, `./scripts/x`, `*.mdc`)
 *  - `quote` — double-quoted phrases of ≥3 tokens
 *  - `ngram` — sliding 4–6-token windows of body prose that clear the
 *              distinctiveness floor (headings alone never produce these)
 * Junk sole-matches (heading keywords, always/never/prefer, lone stack nouns)
 * are rejected. Capped at MAX_SIGNALS_PER_SECTION, priority order. */
export function extractSignals(section: RuleSection): Signal[] {
  const body = section.body;
  const signals: Signal[] = [];
  const seen = new Set<string>();
  const push = (kind: SignalKind, raw: string) => {
    const text = raw.trim();
    const key = text.toLowerCase();
    if (text.length < 4 || seen.has(key)) return;
    seen.add(key);
    signals.push({ kind, text });
  };

  for (const m of body.matchAll(/`([^`\n]{6,})`/g)) {
    const inner = m[1].trim();
    if (hasDistinctiveToken(tokenize(inner)) || /[/.*()=[\]-]/.test(inner)) push("code", inner);
  }
  for (const m of body.matchAll(PATH_TOKEN_RE)) {
    // Same distinctiveness floor as prose: `and/or`, `CI/CD`, `a/b` would
    // otherwise make a section scorable on generic chatter. A real file
    // extension is distinctive on its own.
    const tok = m[1];
    if (/\.[a-z0-9]{1,8}$/i.test(tok) || hasDistinctiveToken(tok.split(/[/*]+/))) {
      push("path", tok);
    }
  }
  for (const m of body.matchAll(/[“"]([^"”\n]+)["”]/g)) {
    const tokens = tokenize(m[1]);
    if (tokens.length >= 3 && hasDistinctiveToken(tokens)) push("quote", m[1]);
  }

  // Prose n-grams: walk non-heading, non-fence lines; take 5-token windows
  // that clear the distinctiveness floor (≥2 non-stop tokens, ≥1 distinctive).
  if (signals.length < MAX_SIGNALS_PER_SECTION) {
    let inFence = false;
    for (const line of body.split("\n")) {
      if (/^```/.test(line.trim())) {
        inFence = !inFence;
        continue;
      }
      if (inFence || /^#{1,6}\s/.test(line.trim())) continue;
      const cleaned = line.replace(/`[^`]*`/g, " ");
      // Trim edge punctuation so a window never ends in `completes.` — the
      // needle must be a literal substring of transcript prose.
      const words = cleaned
        .split(/\s+/)
        .map((w) => w.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9)]+$/g, ""))
        .filter((w) => /[a-zA-Z0-9]/.test(w));
      for (let i = 0; i + 5 <= words.length; i += 3) {
        const window = words.slice(i, i + 5);
        const tokens = tokenize(window.join(" "));
        const nonStop = tokens.filter((t) => !STOPWORDS.has(t));
        if (nonStop.length >= 2 && hasDistinctiveToken(tokens)) {
          push("ngram", window.join(" "));
        }
        if (signals.length >= MAX_SIGNALS_PER_SECTION) break;
      }
      if (signals.length >= MAX_SIGNALS_PER_SECTION) break;
    }
  }
  return signals.slice(0, MAX_SIGNALS_PER_SECTION);
}

// ---------------------------------------------------------------------------
// Classification + hit counting
// ---------------------------------------------------------------------------

export type SectionClass = "protected" | "scorable" | "unscorable";

const NEVER_LINE_RE = /^\s*[-*]\s*(never|do not|don['’]t)\b/i;

/** Short irreversible "never …" bullets are shielded from the candidate list
 * even at zero hits: silent compliance makes them look dead while they may be
 * the most valuable lines in the file. */
export function hasNeverShield(section: RuleSection): boolean {
  return section.body
    .split("\n")
    .some((line) => line.length <= 160 && NEVER_LINE_RE.test(line));
}

export interface ScoredSection extends RuleSection {
  cls: SectionClass;
  signals: Signal[];
  /** Distinct sessions with ≥1 signal hit — the primary rank key. */
  sessionHits: number;
  /** Total matching turns — the secondary key. */
  turnHits: number;
  /** First signal that matched, for the UI's "why is this alive" affordance. */
  matchedSignal: Signal | null;
}

export function classifySection(section: RuleSection): ScoredSection {
  const signals = extractSignals(section);
  const cls: SectionClass = hasNeverShield(section)
    ? "protected"
    : signals.length === 0
      ? "unscorable"
      : "scorable";
  return { ...section, cls, signals, sessionHits: 0, turnHits: 0, matchedSignal: null };
}

export interface TurnText {
  sessionId: string;
  /** Concatenated user_text + COALESCE(assistant_full, assistant_excerpt). */
  text: string;
}

/** Count case-insensitive substring hits of each section's signals over the
 * provided turn texts. Mutates and returns `sections`. Scan work is bounded:
 * each turn text is truncated to MAX_TURN_SCAN_CHARS and each section carries
 * at most MAX_SIGNALS_PER_SECTION signals. */
export function countHits(sections: ScoredSection[], turns: Iterable<TurnText>): ScoredSection[] {
  const trackers = sections
    .filter((s) => s.signals.length > 0)
    .map((s) => ({
      section: s,
      needles: s.signals.map((sig) => ({ sig, lower: sig.text.toLowerCase() })),
      sessions: new Set<string>(),
    }));
  if (trackers.length === 0) return sections;

  for (const turn of turns) {
    const haystack = turn.text.slice(0, MAX_TURN_SCAN_CHARS).toLowerCase();
    if (haystack.length === 0) continue;
    for (const t of trackers) {
      for (const n of t.needles) {
        if (haystack.includes(n.lower)) {
          t.section.turnHits += 1;
          t.sessions.add(turn.sessionId);
          if (!t.section.matchedSignal) t.section.matchedSignal = n.sig;
          break;
        }
      }
    }
  }
  for (const t of trackers) t.section.sessionHits = t.sessions.size;
  return sections;
}

// ---------------------------------------------------------------------------
// Workspace ↔ session join (Gap A)
// ---------------------------------------------------------------------------

/** Minimal slice of db.SessionRow the join needs — keeps this module pure. */
export interface JoinableSession {
  session_id: string;
  source: string;
  project_path: string;
  kind?: string;
  parent_session_id?: string | null;
}

/** Encode a workspace cwd the way Claude Code names its per-project storage
 * directory: every non-alphanumeric character becomes `-`, e.g.
 * `/Users/me/projects/foo.bar_x` → `-Users-me-projects-foo-bar-x`. */
export function dashEncodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function normalizeDir(p: string): string {
  return p.replace(/\/+$/, "");
}

/** Cross-source join: does this session belong to `workspaceCwd`?
 * The sources disagree on what `project_path` holds —
 *  - claude: the dash-encoded storage dir `~/.claude/projects/-Users-…`
 *  - codex / grok / git: the real session cwd
 * so "project_path === workspace" alone silently drops every Claude session. */
export function sessionMatchesWorkspace(session: JoinableSession, workspaceCwd: string): boolean {
  const cwd = normalizeDir(workspaceCwd);
  if (cwd.length === 0 || !session.project_path) return false;
  const pp = normalizeDir(session.project_path);
  if (session.source === "claude") {
    return path.basename(pp) === dashEncodeCwd(cwd);
  }
  return pp === cwd;
}

/** Filter sessions to the workspace. Top-level sessions match directly;
 * `subagent`/`workflow` children are included only when their parent is in
 * the matched set (they carry synthetic paths of their own). */
export function filterWorkspaceSessions<T extends JoinableSession>(
  sessions: T[],
  workspaceCwd: string
): T[] {
  const parents = new Set<string>();
  const top: T[] = [];
  for (const s of sessions) {
    const kind = s.kind ?? "session";
    if (kind === "subagent" || kind === "workflow") continue;
    if (sessionMatchesWorkspace(s, workspaceCwd)) {
      parents.add(s.session_id);
      top.push(s);
    }
  }
  const children = sessions.filter((s) => {
    const kind = s.kind ?? "session";
    return (
      (kind === "subagent" || kind === "workflow") &&
      s.parent_session_id != null &&
      parents.has(s.parent_session_id)
    );
  });
  return [...top, ...children];
}

// ---------------------------------------------------------------------------
// Report + export
// ---------------------------------------------------------------------------

export interface DoctorReport {
  /** Scorable sections with zero session hits — review candidates. */
  candidates: ScoredSection[];
  /** NEVER-shielded sections, excluded from the checklist. */
  protected: ScoredSection[];
  /** No deterministic signal — cannot be judged from transcripts. */
  unscorable: ScoredSection[];
  /** Scorable sections with ≥1 session hit. */
  scoredWithHits: ScoredSection[];
  sessionCount: number;
  files: string[];
}

/** Classify, score, and bucket sections against the workspace's turn texts. */
export function buildDoctorReport(
  sections: RuleSection[],
  turns: Iterable<TurnText>,
  sessionCount: number
): DoctorReport {
  const scored = countHits(dedupeSections(sections).map(classifySection), turns);
  const byRank = (a: ScoredSection, b: ScoredSection) =>
    a.sessionHits - b.sessionHits || a.turnHits - b.turnHits || a.file.localeCompare(b.file);
  return {
    candidates: scored.filter((s) => s.cls === "scorable" && s.sessionHits === 0).sort(byRank),
    protected: scored.filter((s) => s.cls === "protected"),
    unscorable: scored.filter((s) => s.cls === "unscorable"),
    scoredWithHits: scored
      .filter((s) => s.cls === "scorable" && s.sessionHits > 0)
      .sort((a, b) => byRank(b, a)),
    sessionCount,
    files: [...new Set(sections.map((s) => s.file))],
  };
}

/** Markdown checklist of review candidates. Deliberately worded as "no
 * transcript evidence", never "delete these": hits are mention evidence, not
 * causal influence, and truncated/out-of-window transcripts hide compliance. */
export function exportChecklist(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`# Rules doctor — review candidates`);
  lines.push("");
  lines.push(
    `No transcript evidence in the last ${report.sessionCount} indexed sessions for this workspace. ` +
      `Rules can shape behavior without being quoted (silent compliance), and stored turn text is ` +
      `truncated — treat these as review candidates, not proven-dead sections.`
  );
  lines.push("");
  for (const s of report.candidates) {
    lines.push(`- [ ] ${s.file} › ${s.heading}`);
  }
  if (report.candidates.length === 0) {
    lines.push(`_No zero-evidence sections found._`);
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Disk load + store orchestration (still pure — no vscode import)
// ---------------------------------------------------------------------------

/** Hard cap on turns scanned per Insights open so WASM sqlite stays responsive. */
export const MAX_DOCTOR_TURNS = 3000;

/** Minimal store surface the doctor needs — SessionStore satisfies this. */
export interface DoctorTurnSource {
  listRecent(
    limit: number,
    includeAutomated: boolean
  ): Array<JoinableSession & { mtime_ns: number; ended_at?: number | null; started_at?: number | null }>;
  turnsForSession(sessionId: string): Array<{
    user_text: string | null;
    assistant_full: string | null;
    assistant_excerpt: string | null;
  }>;
}

export interface DoctorRunResult {
  report: DoctorReport;
  rootDir: string;
  /** ISO date of oldest / newest scoped top-level session activity (if any). */
  windowStart: string | null;
  windowEnd: string | null;
  emptyReason?: "no-workspace" | "no-rules" | "no-store" | "no-sessions";
}

/** Read + parse every discovered rule file under `rootDir`. */
export function loadRuleSections(rootDir: string): RuleSection[] {
  const out: RuleSection[] = [];
  for (const f of discoverRuleFiles(rootDir)) {
    try {
      const text = fs.readFileSync(f.absPath, "utf8");
      out.push(...parseRuleSections(text, f.relPath));
    } catch {
      /* unreadable — skip */
    }
  }
  return out;
}

function activityMs(s: {
  mtime_ns: number;
  ended_at?: number | null;
  started_at?: number | null;
}): number {
  if (s.ended_at && s.ended_at > 0) return s.ended_at;
  if (s.started_at && s.started_at > 0) return s.started_at;
  return Math.floor(s.mtime_ns / 1e6);
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Join workspace rule files against the last `sessionLimit` top-level sessions
 * for `rootDir`. Read-only; never writes rules or the DB.
 */
export function runRulesDoctor(
  rootDir: string,
  store: DoctorTurnSource | null | undefined,
  sessionLimit = 30
): DoctorRunResult {
  if (!rootDir) {
    return {
      report: emptyReport(0),
      rootDir: "",
      windowStart: null,
      windowEnd: null,
      emptyReason: "no-workspace",
    };
  }
  if (!store) {
    return {
      report: emptyReport(0),
      rootDir,
      windowStart: null,
      windowEnd: null,
      emptyReason: "no-store",
    };
  }
  if (discoverRuleFiles(rootDir).length === 0) {
    return {
      report: emptyReport(0),
      rootDir,
      windowStart: null,
      windowEnd: null,
      emptyReason: "no-rules",
    };
  }
  const sections = loadRuleSections(rootDir);

  const poolLimit = Math.max(sessionLimit * 20, 400);
  const pool = store.listRecent(poolLimit, true);
  const matched = filterWorkspaceSessions(pool, rootDir);
  const topLevel = matched
    .filter((s) => (s.kind ?? "session") === "session")
    .sort((a, b) => b.mtime_ns - a.mtime_ns)
    .slice(0, Math.max(1, sessionLimit));
  const topIds = new Set(topLevel.map((s) => s.session_id));
  const scoped = matched.filter(
    (s) => topIds.has(s.session_id) || (s.parent_session_id != null && topIds.has(s.parent_session_id))
  );

  if (topLevel.length === 0) {
    return {
      report: buildDoctorReport(sections, [], 0),
      rootDir,
      windowStart: null,
      windowEnd: null,
      emptyReason: "no-sessions",
    };
  }

  const turns: TurnText[] = [];
  let budget = MAX_DOCTOR_TURNS;
  for (const s of scoped) {
    if (budget <= 0) break;
    for (const t of store.turnsForSession(s.session_id)) {
      if (budget <= 0) break;
      const text = [t.user_text, t.assistant_full || t.assistant_excerpt]
        .filter((x): x is string => !!x && x.length > 0)
        .join("\n");
      if (!text) continue;
      turns.push({ sessionId: s.session_id, text });
      budget -= 1;
    }
  }

  const times = topLevel.map(activityMs).filter((n) => n > 0);
  const windowStart = times.length ? isoDay(Math.min(...times)) : null;
  const windowEnd = times.length ? isoDay(Math.max(...times)) : null;
  return {
    report: buildDoctorReport(sections, turns, topLevel.length),
    rootDir,
    windowStart,
    windowEnd,
  };
}

function emptyReport(sessionCount: number): DoctorReport {
  return {
    candidates: [],
    protected: [],
    unscorable: [],
    scoredWithHits: [],
    sessionCount,
    files: [],
  };
}

// ---------------------------------------------------------------------------
// Insights card HTML (script-free; command URIs for open/copy)
// ---------------------------------------------------------------------------

export interface DoctorCardRenderOpts {
  rootDir: string;
  windowStart?: string | null;
  windowEnd?: string | null;
  emptyReason?: DoctorRunResult["emptyReason"];
  /** When false, omit command: links (tests / non-webview). Default true. */
  commandUris?: boolean;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function commandHref(command: string, args: unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

function sectionRowHtml(
  s: ScoredSection,
  rootDir: string,
  commandUris: boolean,
  extra: string
): string {
  const label = `${escapeHtml(s.file)} › ${escapeHtml(s.heading)}`;
  const abs = path.join(rootDir, s.file);
  const link = commandUris
    ? `<a href="${commandHref("codeSessions.openRulesDoctorSection", [abs, s.startLine])}" title="Open at heading">${label}</a>`
    : `<code>${label}</code>`;
  return `<div class="doctor-row">${link}${extra}</div>`;
}

/** Insights dashboard card: 4 buckets + disclaimer + copy-checklist action. */
export function renderDoctorCardHtml(result: DoctorRunResult, opts?: Partial<DoctorCardRenderOpts>): string {
  const commandUris = opts?.commandUris !== false;
  const rootDir = opts?.rootDir ?? result.rootDir;
  const windowStart = opts?.windowStart ?? result.windowStart;
  const windowEnd = opts?.windowEnd ?? result.windowEnd;
  const emptyReason = opts?.emptyReason ?? result.emptyReason;
  const report = result.report;

  if (emptyReason === "no-workspace") {
    return `<div class="card"><div class="card-title">Rules doctor</div>
      <div class="subtitle">Open a workspace folder to audit CLAUDE.md / AGENTS.md / .cursor/rules against indexed transcripts.</div></div>`;
  }
  if (emptyReason === "no-store") {
    return `<div class="card"><div class="card-title">Rules doctor</div>
      <div class="subtitle">SQLite cache unavailable — enable <code>codeSessions.cacheEnabled</code> and reload.</div></div>`;
  }
  if (emptyReason === "no-rules") {
    return `<div class="card"><div class="card-title">Rules doctor</div>
      <div class="subtitle">No CLAUDE.md / AGENTS.md / .cursor/rules found under <code>${escapeHtml(rootDir)}</code>.</div></div>`;
  }

  const windowLabel =
    windowStart && windowEnd
      ? windowStart === windowEnd
        ? windowStart
        : `${windowStart} → ${windowEnd}`
      : "no dated sessions";
  const copyHref = commandUris
    ? commandHref("codeSessions.copyRulesDoctorChecklist", [])
    : "#";
  const copyBtn = commandUris
    ? `<a class="doctor-action" href="${copyHref}">Copy checklist</a>`
    : "";

  const bucket = (
    title: string,
    rows: ScoredSection[],
    empty: string,
    extra: (s: ScoredSection) => string
  ): string => {
    const body =
      rows.length === 0
        ? `<div class="muted">${escapeHtml(empty)}</div>`
        : rows
            .slice(0, 40)
            .map((s) => sectionRowHtml(s, rootDir, commandUris, extra(s)))
            .join("");
    const more =
      rows.length > 40 ? `<div class="muted">…and ${rows.length - 40} more</div>` : "";
    return `<div class="doctor-bucket"><h3>${escapeHtml(title)} (${rows.length})</h3>${body}${more}</div>`;
  };

  const sessionsNote =
    emptyReason === "no-sessions"
      ? `<div class="subtitle">No indexed sessions matched this workspace yet — sections are listed unscored. Index or open sessions for this project, then refresh Insights.</div>`
      : `<div class="subtitle">Last ${report.sessionCount} workspace sessions · ${escapeHtml(windowLabel)} · files: ${
          report.files.length ? report.files.map(escapeHtml).join(", ") : "(none)"
        }</div>`;

  return `<div class="card">
  <div class="card-title">Rules doctor · never-referenced sections ${copyBtn}</div>
  ${sessionsNote}
  ${bucket("Candidates — no transcript evidence", report.candidates, "None in this window.", () => "")}
  ${bucket("Protected — short Never/Do-not shields", report.protected, "None.", () => "")}
  ${bucket("Unscorable — no distinctive signal", report.unscorable, "None.", () => "")}
  ${bucket(
    "Scored with hits",
    report.scoredWithHits,
    "None yet.",
    (s) =>
      ` <span class="muted">${s.sessionHits} session${s.sessionHits === 1 ? "" : "s"} · ${s.turnHits} turn${s.turnHits === 1 ? "" : "s"}${
        s.matchedSignal ? ` · “${escapeHtml(s.matchedSignal.text.slice(0, 48))}”` : ""
      }</span>`
  )}
  <div class="doctor-disclaimer">
    No evidence in the last N sessions ≠ proven unused. Rules can shape behavior without being quoted
    (silent compliance), and stored turn text is truncated. Treat candidates as a review list — this
    card never deletes or edits rule files.
  </div>
</div>`;
}
