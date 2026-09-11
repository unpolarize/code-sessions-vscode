// Compaction fidelity leaderboard (KP ideas/csv-compaction-fidelity-leaderboard-cross-backen).
// Pure module — no vscode / db imports — so aggregator + renderer are
// fixture-testable.
//
// Per-session compaction-loss audit and cliff-handoff already exist. This card
// aggregates across KP-linked compact events: for each backend, what % of
// Acceptance bullets are still recoverable in the post-compact transcript
// (or handoff pack)? Vendors will not publish an honest "we lobotomize less"
// score; CSV is the only join of multi-backend transcripts × KP acceptance.
//
// v1 heuristic: normalized substring match. No LLM judge. Unlinked sessions
// (no planning_refs / no acceptance bullets) are excluded from the
// denominator — they are dark work, not a fidelity fail. Backends below the
// minimum compact-event sample are listed but not ranked.
//
// Read-only. Never triggers a compact.

import { extractCompactBoundaries } from "./compactMismatch";

export const COMPACTION_FIDELITY_SCHEMA =
  "code-sessions/compaction-fidelity-leaderboard@1";

export const EXPORT_FIDELITY_JSON_COMMAND = "codeSessions.exportCompactionFidelityJson";

/** Backends with fewer compact events than this are shown but not ranked. */
export const DEFAULT_MIN_COMPACT_EVENTS = 2;

/** Click-through examples listed per backend. */
export const DEFAULT_EXAMPLES_PER_BACKEND = 3;

/** Short bullets ("ok") would false-positive as retained. */
export const MIN_BULLET_CHARS = 12;

export interface FidelityObservation {
  sessionId: string;
  source: string;
  label?: string | null;
  /** Observed compact events in this session (0 = never compacted). */
  compactCount: number;
  /** KP ids linked at (or before) compact time. */
  planningRefs: string[];
  /** Acceptance bullets from the linked KP item(s). */
  acceptance: string[];
  /** Transcript / handoff pack text after the last compact. */
  postCompactText: string;
}

export interface FidelityExample {
  sessionId: string;
  label: string;
  retained: number;
  total: number;
  /** retained / total in [0, 1]. */
  fidelity: number;
}

export interface FidelityBackendRank {
  backend: string;
  compactEvents: number;
  linkedSessions: number;
  bulletsTotal: number;
  bulletsRetained: number;
  /** bulletsRetained / bulletsTotal in [0, 1]; 0 when total is 0. */
  fidelity: number;
  /** False when compactEvents < minCompactEvents (not a fake rank). */
  ranked: boolean;
  /** 1-based among ranked backends only; null when unranked. */
  rank: number | null;
  examples: FidelityExample[];
}

export interface FidelityLeaderboard {
  schema: typeof COMPACTION_FIDELITY_SCHEMA;
  minCompactEvents: number;
  ranks: FidelityBackendRank[];
  excludedUnlinked: number;
  excludedNoCompact: number;
  excludedNoText: number;
}

export interface FidelityComputeOptions {
  minCompactEvents?: number;
  examplesPerBackend?: number;
  openSessionCommand?: string;
  exportCommand?: string;
}

/** Minimal session-row shape (SessionStore row or Insights mirror). */
export interface FidelitySessionInput {
  session_id?: string | null;
  session?: string | null;
  source?: string | null;
  title?: string | null;
  first_user_msg?: string | null;
  extras_json?: string | null;
}

export interface FidelityFromRowsOptions {
  /** sessionId → post-compact transcript / handoff pack. */
  postCompactText?: Map<string, string>;
  /** kp id → acceptance bullets (unioned across a session's planning_refs). */
  acceptanceByKpId?: Map<string, string[]>;
  /** sessionId → compact count when extras omit it. */
  compactCountBySession?: Map<string, number>;
}

// --------------------------------------------------------------------------- //
// Heuristic
// --------------------------------------------------------------------------- //

/** Collapse whitespace, strip list/checkbox markers, lowercase. */
export function normalizeBullet(raw: string): string {
  return raw
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
    .replace(/^\[(?: |x|X)\]\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function normalizeHaystack(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * True when the (normalized) bullet is recoverable in the haystack.
 * Empty / too-short bullets are not scored as retained (would false-positive).
 */
export function bulletRetained(bullet: string, haystack: string): boolean {
  const b = normalizeBullet(bullet);
  if (b.length < MIN_BULLET_CHARS) return false;
  const h = normalizeHaystack(haystack);
  if (!h) return false;
  if (h.includes(b)) return true;
  // Long bullets: first 80 chars is enough to claim "still present".
  if (b.length > 80 && h.includes(b.slice(0, 80))) return true;
  return false;
}

/**
 * Pull Acceptance / Acceptance criteria bullets from a markdown body
 * (KP item, board-spawned first_user_msg, handoff pack).
 */
export function extractAcceptanceBullets(text: string | null | undefined): string[] {
  const raw = text ?? "";
  if (!raw.trim()) return [];
  const heading = raw.match(/^#{1,3}\s*acceptance(?:\s+criteria)?\s*$/im);
  if (!heading || heading.index == null) return [];
  const after = raw.slice(heading.index + heading[0].length);
  const nextH = after.search(/\n#{1,3}\s+\S/);
  const section = nextH >= 0 ? after.slice(0, nextH) : after;
  const bullets: string[] = [];
  for (const line of section.split(/\n/)) {
    const m = line.match(/^\s*(?:[-*+]|\d+\.)\s+(?:\[(?: |x|X)\]\s+)?(.+?)\s*$/);
    if (m) {
      const t = m[1].trim();
      if (t && t.length >= MIN_BULLET_CHARS) bullets.push(t);
    }
  }
  return bullets;
}

function textFromEvent(ev: unknown): string {
  if (ev == null) return "";
  if (typeof ev === "string") return ev;
  if (typeof ev !== "object") return "";
  const o = ev as Record<string, unknown>;
  const parts: string[] = [];
  const pushContent = (c: unknown) => {
    if (typeof c === "string") parts.push(c);
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (typeof b === "string") parts.push(b);
        else if (b && typeof b === "object") {
          const t = (b as Record<string, unknown>).text;
          if (typeof t === "string") parts.push(t);
        }
      }
    }
  };
  pushContent(o.content);
  if (typeof o.text === "string") parts.push(o.text);
  if (typeof o.summary === "string") parts.push(o.summary);
  return parts.join("\n");
}

/**
 * Compact-event count + concatenated text after the last compact boundary.
 * Empty postCompactText when the session never compacted.
 */
export function postCompactCorpus(events: unknown[]): { compactCount: number; postCompactText: string } {
  const bounds = extractCompactBoundaries(events);
  const compactCount = bounds.length;
  if (compactCount === 0) return { compactCount: 0, postCompactText: "" };
  const lastIdx = bounds[bounds.length - 1]?.eventIndex ?? -1;
  const after = lastIdx >= 0 ? events.slice(lastIdx + 1) : events;
  return {
    compactCount,
    postCompactText: after.map(textFromEvent).filter(Boolean).join("\n"),
  };
}

function asNonNegInt(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function parseExtrasObject(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const o = JSON.parse(json);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(String).map((s) => s.trim()).filter(Boolean);
}

function sessionIdOf(r: FidelitySessionInput): string {
  return (r.session_id || r.session || "").trim();
}

function backendOf(source: string | null | undefined): string {
  const s = (source || "claude").trim().toLowerCase();
  return s || "claude";
}

/**
 * Lift store / Insights rows into scoring observations. Missing KP bullets
 * or post-compact text stay empty — compute() excludes them from the
 * denominator rather than inventing a 0% score.
 */
export function observationsFromSessionRows(
  rows: FidelitySessionInput[],
  opts: FidelityFromRowsOptions = {},
): FidelityObservation[] {
  const out: FidelityObservation[] = [];
  for (const r of rows) {
    const sid = sessionIdOf(r);
    if (!sid) continue;
    const extras = parseExtrasObject(r.extras_json);
    const planningRefs = stringList(extras.planning_refs);
    const compactFromExtras = asNonNegInt(extras.compactionCount) ?? 0;
    const compactCount = Math.max(
      compactFromExtras,
      opts.compactCountBySession?.get(sid) ?? 0,
    );
    let acceptance = stringList(extras.acceptance);
    if (acceptance.length === 0) {
      for (const id of planningRefs) {
        const bullets = opts.acceptanceByKpId?.get(id);
        if (bullets) acceptance.push(...bullets);
      }
    }
    if (acceptance.length === 0) {
      acceptance = extractAcceptanceBullets(r.first_user_msg ?? "");
    }
    const post =
      (typeof extras.postCompactText === "string" ? extras.postCompactText : "") ||
      (typeof extras.handoffPack === "string" ? extras.handoffPack : "") ||
      opts.postCompactText?.get(sid) ||
      "";
    out.push({
      sessionId: sid,
      source: backendOf(r.source),
      label: (r.title || r.first_user_msg || sid).trim().slice(0, 70),
      compactCount,
      planningRefs,
      acceptance,
      postCompactText: post,
    });
  }
  return out;
}

function scoreObservation(obs: FidelityObservation): { retained: number; total: number } {
  const seen = new Set<string>();
  let retained = 0;
  let total = 0;
  for (const raw of obs.acceptance) {
    const b = normalizeBullet(raw);
    if (b.length < MIN_BULLET_CHARS) continue;
    if (seen.has(b)) continue;
    seen.add(b);
    total += 1;
    if (bulletRetained(raw, obs.postCompactText)) retained += 1;
  }
  return { retained, total };
}

interface BackendAcc {
  backend: string;
  compactEvents: number;
  linkedSessions: number;
  bulletsTotal: number;
  bulletsRetained: number;
  examples: FidelityExample[];
}

/**
 * Rank backends by post-compact KP-acceptance retention. Always returns a
 * board (ranks may be empty). Never throws on missing optional fields.
 */
export function computeCompactionFidelity(
  observations: FidelityObservation[],
  opts: FidelityComputeOptions = {},
): FidelityLeaderboard {
  const minCompactEvents = Math.max(1, opts.minCompactEvents ?? DEFAULT_MIN_COMPACT_EVENTS);
  const examplesPerBackend = Math.max(1, opts.examplesPerBackend ?? DEFAULT_EXAMPLES_PER_BACKEND);

  let excludedUnlinked = 0;
  let excludedNoCompact = 0;
  let excludedNoText = 0;
  const byBackend = new Map<string, BackendAcc>();

  for (const obs of observations) {
    const compactCount = asNonNegInt(obs.compactCount) ?? 0;
    if (compactCount < 1) {
      excludedNoCompact += 1;
      continue;
    }
    const refs = (obs.planningRefs ?? []).map(String).filter(Boolean);
    const scored = scoreObservation(obs);
    if (refs.length === 0 || scored.total === 0) {
      excludedUnlinked += 1;
      continue;
    }
    if (!(obs.postCompactText ?? "").trim()) {
      excludedNoText += 1;
      continue;
    }
    const backend = backendOf(obs.source);
    let acc = byBackend.get(backend);
    if (!acc) {
      acc = {
        backend,
        compactEvents: 0,
        linkedSessions: 0,
        bulletsTotal: 0,
        bulletsRetained: 0,
        examples: [],
      };
      byBackend.set(backend, acc);
    }
    acc.compactEvents += compactCount;
    acc.linkedSessions += 1;
    acc.bulletsTotal += scored.total;
    acc.bulletsRetained += scored.retained;
    acc.examples.push({
      sessionId: obs.sessionId,
      label: (obs.label || obs.sessionId).slice(0, 70),
      retained: scored.retained,
      total: scored.total,
      fidelity: scored.total > 0 ? scored.retained / scored.total : 0,
    });
  }

  const ranks: FidelityBackendRank[] = [];
  for (const acc of byBackend.values()) {
    acc.examples.sort((a, b) => {
      if (a.fidelity !== b.fidelity) return a.fidelity - b.fidelity;
      return a.sessionId.localeCompare(b.sessionId);
    });
    const ranked = acc.compactEvents >= minCompactEvents;
    ranks.push({
      backend: acc.backend,
      compactEvents: acc.compactEvents,
      linkedSessions: acc.linkedSessions,
      bulletsTotal: acc.bulletsTotal,
      bulletsRetained: acc.bulletsRetained,
      fidelity: acc.bulletsTotal > 0 ? acc.bulletsRetained / acc.bulletsTotal : 0,
      ranked,
      rank: null,
      examples: acc.examples.slice(0, examplesPerBackend),
    });
  }

  ranks.sort((a, b) => {
    if (a.ranked !== b.ranked) return a.ranked ? -1 : 1;
    if (a.fidelity !== b.fidelity) return b.fidelity - a.fidelity;
    if (a.compactEvents !== b.compactEvents) return b.compactEvents - a.compactEvents;
    return a.backend.localeCompare(b.backend);
  });

  let n = 0;
  for (const r of ranks) {
    if (r.ranked) {
      n += 1;
      r.rank = n;
    }
  }

  return {
    schema: COMPACTION_FIDELITY_SCHEMA,
    minCompactEvents,
    ranks,
    excludedUnlinked,
    excludedNoCompact,
    excludedNoText,
  };
}

/** Stable JSON for night reports — rank order matches the on-screen table. */
export function exportCompactionFidelityJson(board: FidelityLeaderboard): {
  schema: string;
  minCompactEvents: number;
  excludedUnlinked: number;
  excludedNoCompact: number;
  excludedNoText: number;
  ranks: Array<{
    rank: number | null;
    backend: string;
    fidelity: number;
    fidelityPct: number;
    compactEvents: number;
    linkedSessions: number;
    bulletsTotal: number;
    bulletsRetained: number;
    ranked: boolean;
    examples: FidelityExample[];
  }>;
} {
  return {
    schema: board.schema,
    minCompactEvents: board.minCompactEvents,
    excludedUnlinked: board.excludedUnlinked,
    excludedNoCompact: board.excludedNoCompact,
    excludedNoText: board.excludedNoText,
    ranks: board.ranks.map((r) => ({
      rank: r.rank,
      backend: r.backend,
      fidelity: r.fidelity,
      fidelityPct: Math.round(r.fidelity * 1000) / 10,
      compactEvents: r.compactEvents,
      linkedSessions: r.linkedSessions,
      bulletsTotal: r.bulletsTotal,
      bulletsRetained: r.bulletsRetained,
      ranked: r.ranked,
      examples: r.examples,
    })),
  };
}

export function formatCompactionFidelityJson(board: FidelityLeaderboard): string {
  return JSON.stringify(exportCompactionFidelityJson(board), null, 2);
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

function fmtPct(f: number): string {
  if (!Number.isFinite(f)) return "—";
  return `${(Math.round(f * 1000) / 10).toFixed(1)}%`;
}

function sessionHref(sessionId: string, command: string): string {
  return commandHref(command, [sessionId]);
}

/** Insights section ("" when nothing scored — empty corpus does not fake ranks). */
export function renderCompactionFidelitySectionHtml(
  board: FidelityLeaderboard,
  opts: Pick<FidelityComputeOptions, "openSessionCommand" | "exportCommand"> = {},
): string {
  if (board.ranks.length === 0) return "";
  const cmd = opts.openSessionCommand ?? "codeSessions.openSession";
  const exportCmd = opts.exportCommand ?? EXPORT_FIDELITY_JSON_COMMAND;
  const json = formatCompactionFidelityJson(board);
  const exportHref = commandHref(exportCmd, [json]);
  const rankedN = board.ranks.filter((r) => r.ranked).length;

  const rows = board.ranks
    .map((r) => {
      const examples = r.examples
        .map((ex) => {
          const href = sessionHref(ex.sessionId, cmd);
          return `<a class="cff-session" href="${esc(href)}" title="${esc(ex.sessionId)}">${esc(ex.label.slice(0, 40))}</a> <span class="cff-exf">${esc(fmtPct(ex.fidelity))}</span>`;
        })
        .join("<br>");
      const rankCell = r.ranked
        ? String(r.rank)
        : `<span class="cff-skip" title="Fewer than ${board.minCompactEvents} compact events — not ranked">n&lt;${board.minCompactEvents}</span>`;
      const hot = r.ranked && r.fidelity < 0.5 ? " cff-hot" : "";
      return `<tr>
        <td class="num">${rankCell}</td>
        <td class="cff-backend">${esc(r.backend)}</td>
        <td class="num${hot}">${esc(fmtPct(r.fidelity))}</td>
        <td class="num">${r.compactEvents}</td>
        <td class="num">${r.linkedSessions}</td>
        <td class="num">${r.bulletsRetained}/${r.bulletsTotal}</td>
        <td class="cff-ex">${examples}</td>
      </tr>`;
    })
    .join("");

  return `<section class="cff-card" data-schema="${esc(COMPACTION_FIDELITY_SCHEMA)}">
  <div class="cff-head"><span class="cff-title">Compaction fidelity</span>
    <span class="cff-chip" title="Acceptance bullets still recoverable after compact / bullets at KP-link time">anti-lobotomy</span>
    <a class="cff-export" href="${esc(exportHref)}" title="Copy leaderboard JSON for night reports">Export JSON</a>
  </div>
  <div class="cff-sub">${rankedN} ranked backend${rankedN === 1 ? "" : "s"} (min ${board.minCompactEvents} compact events). Fidelity = KP Acceptance bullets still present in the post-compact transcript or handoff pack. Unlinked sessions excluded (${board.excludedUnlinked} unlinked · ${board.excludedNoCompact} never-compacted · ${board.excludedNoText} no post-compact text).</div>
  <table class="cff-table"><tr><th>#</th><th>backend</th><th>fidelity</th><th>compacts</th><th>sessions</th><th>bullets</th><th>examples</th></tr>${rows}</table>
  <div class="cff-help">v1 heuristic: case-insensitive substring match of each Acceptance bullet (min ${MIN_BULLET_CHARS} chars) against post-compact text. No LLM judge. Distinct from the per-session compaction-loss audit and the cliff-handoff card.</div>
  <div class="cff-disclaimer">Read-only over the local session store + KP links — never triggers a compact. Missing KP linkage is excluded from the denominator, not scored as 0%.</div>
</section>`;
}

/** CSS for Insights — keep in sync with `.cff-*` markup above. */
export const COMPACTION_FIDELITY_CARD_CSS = `
.cff-card { background: var(--card-bg, var(--vscode-editorWidget-background, #1e1e1e)); border: 1px solid var(--border, var(--vscode-panel-border, #333)); border-radius: 6px; padding: 12px 14px; margin-top: 8px; }
.cff-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; }
.cff-title { font-size: 11px; text-transform: uppercase; color: var(--muted, var(--vscode-descriptionForeground, #999)); letter-spacing: 0.5px; font-weight: 600; }
.cff-chip { display: inline-block; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; color: var(--vscode-charts-green, #5eba7d); border: 1px solid var(--vscode-charts-green, #5eba7d); border-radius: 8px; padding: 1px 7px; vertical-align: middle; }
.cff-export { margin-left: auto; font-size: 11px; color: var(--accent, var(--vscode-textLink-foreground, #4af)); text-decoration: none; font-weight: 500; }
.cff-export:hover { text-decoration: underline; }
.cff-sub { font-size: 12px; color: var(--muted, var(--vscode-descriptionForeground, #999)); line-height: 1.45; margin-bottom: 8px; }
.cff-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 2px; }
.cff-table th, .cff-table td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--border, var(--vscode-panel-border, #333)); vertical-align: top; }
.cff-table th { color: var(--muted, var(--vscode-descriptionForeground, #999)); font-weight: 500; font-size: 10px; text-transform: uppercase; }
.cff-table td.num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.cff-table th:nth-child(1), .cff-table th:nth-child(n+3):nth-child(-n+6) { text-align: right; }
.cff-backend { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; }
.cff-session { color: var(--accent, var(--vscode-textLink-foreground, #4af)); text-decoration: none; }
.cff-session:hover { text-decoration: underline; }
.cff-ex { font-size: 11px; line-height: 1.45; }
.cff-exf { color: var(--muted, var(--vscode-descriptionForeground, #999)); font-variant-numeric: tabular-nums; }
.cff-hot { color: var(--vscode-inputValidation-errorForeground, #f88); font-weight: 600; }
.cff-skip { font-size: 10px; color: var(--muted, var(--vscode-descriptionForeground, #999)); }
.cff-help { font-size: 11px; color: var(--muted, var(--vscode-descriptionForeground, #999)); margin-top: 8px; line-height: 1.45; }
.cff-disclaimer { font-size: 11px; color: var(--muted, var(--vscode-descriptionForeground, #999)); margin-top: 8px; line-height: 1.45; border-top: 1px solid var(--border, var(--vscode-panel-border, #333)); padding-top: 8px; }
`;
