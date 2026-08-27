// Compaction-cliff cross-backend handoff — pure core (no vscode / no db).
//
// Multi-stack sessions hit asymmetric compaction cliffs: Codex tends to compact
// earlier on long tasks; Claude/Grok often survive further. This module turns
// observed compact counts (+ optional context-fill) into a recommendation card
// and a KP-cartridge-shaped handoff markdown pack. Recommendation only in v1 —
// never auto-kills or auto-failovers an ACP session.
//
// Callers pass CompactionSignals (from extras_json / indexer fields / fixtures).
// Thresholds are heuristics, user-overridable; not vendor-guaranteed remaining-
// context APIs.

export type BackendId = "claude" | "grok" | "codex" | string;

export type CliffLevel = "ok" | "approaching" | "recommend_handoff";

/** Per-backend cliff heuristics. Counts are observed compaction events. */
export interface CompactionThresholds {
  /** Compact count ≥ this → "approaching" warning. */
  warnAtCompacts: number;
  /** Compact count ≥ this → recommend cross-backend handoff. */
  recommendAtCompacts: number;
  /** Optional context fill ratio in [0, 1] that also raises at least "approaching". */
  warnAtContextFill?: number;
  /** Preferred handoff targets, first available wins. */
  preferHandoffTo: BackendId[];
}

/**
 * Defaults (README / CHANGELOG): Codex earliest, Claude later, Grok mid.
 * Editable by merging overrides into evaluateCompactionCliff(..., thresholds).
 */
export const DEFAULT_THRESHOLDS: Readonly<Record<string, CompactionThresholds>> = {
  codex: {
    warnAtCompacts: 1,
    recommendAtCompacts: 2,
    warnAtContextFill: 0.7,
    preferHandoffTo: ["claude", "grok"],
  },
  claude: {
    warnAtCompacts: 2,
    recommendAtCompacts: 3,
    warnAtContextFill: 0.85,
    preferHandoffTo: ["grok", "codex"],
  },
  grok: {
    warnAtCompacts: 1,
    recommendAtCompacts: 2,
    warnAtContextFill: 0.8,
    preferHandoffTo: ["claude", "codex"],
  },
};

const FALLBACK_THRESHOLDS: CompactionThresholds = {
  warnAtCompacts: 2,
  recommendAtCompacts: 3,
  warnAtContextFill: 0.8,
  preferHandoffTo: ["claude", "grok"],
};

/** Handoff-pack schema id — documented for CB / KP cartridge consumers. */
export const HANDOFF_PACK_SCHEMA = "code-sessions/compaction-cliff-handoff@1";

export interface CompactionSignals {
  source: BackendId;
  /** Observed compaction events (0 if never compacted). */
  compactionCount?: number | null;
  contextTokensUsed?: number | null;
  contextWindowTokens?: number | null;
  totalTokensBeforeCompaction?: number | null;
  sessionId?: string | null;
  title?: string | null;
  projectPath?: string | null;
  model?: string | null;
  /** KP goal / acceptance cartridge fields (optional). */
  goal?: string | null;
  acceptance?: string[] | null;
  paths?: string[] | null;
  /** Last N decisions / milestones to carry into the handoff. */
  recentDecisions?: string[] | null;
}

export interface CliffCard {
  level: CliffLevel;
  source: BackendId;
  compactionCount: number;
  contextFill: number | null;
  threshold: CompactionThresholds;
  /** Recommended target backend, or null when level === 'ok'. */
  recommendBackend: BackendId | null;
  headline: string;
  detail: string;
  /** Always false in v1 — recommendation surface only. */
  autoFailover: false;
}

export interface HandoffPackInput {
  signals: CompactionSignals;
  card: CliffCard;
  /** Override decision count (default 8). */
  maxDecisions?: number;
}

function asNonNegInt(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function contextFillOf(signals: CompactionSignals): number | null {
  const used = asNonNegInt(signals.contextTokensUsed);
  const window = asNonNegInt(signals.contextWindowTokens);
  if (used == null || window == null || window <= 0) return null;
  const fill = used / window;
  if (!Number.isFinite(fill)) return null;
  return Math.min(1, Math.max(0, fill));
}

/** Resolve thresholds for a backend, applying optional overrides. */
export function thresholdsFor(
  source: BackendId,
  overrides?: Partial<Record<string, Partial<CompactionThresholds>>>,
): CompactionThresholds {
  const key = String(source || "").toLowerCase() || "unknown";
  const base = DEFAULT_THRESHOLDS[key] ?? FALLBACK_THRESHOLDS;
  const over = overrides?.[key];
  if (!over) return { ...base, preferHandoffTo: [...base.preferHandoffTo] };
  return {
    warnAtCompacts: over.warnAtCompacts ?? base.warnAtCompacts,
    recommendAtCompacts: over.recommendAtCompacts ?? base.recommendAtCompacts,
    warnAtContextFill:
      over.warnAtContextFill !== undefined ? over.warnAtContextFill : base.warnAtContextFill,
    preferHandoffTo: over.preferHandoffTo ? [...over.preferHandoffTo] : [...base.preferHandoffTo],
  };
}

function pickHandoffTarget(source: BackendId, prefer: BackendId[]): BackendId | null {
  const src = String(source).toLowerCase();
  for (const t of prefer) {
    if (String(t).toLowerCase() !== src) return t;
  }
  return prefer[0] ?? null;
}

/**
 * Count synthetic / transcript compact markers. Recognizes:
 * - `{ type: "compaction" }` / `{ type: "compact" }`
 * - system events with subtype/content mentioning compact
 * - string markers equal to "compaction" / "/compact"
 *
 * Fixtures use this to drive evaluateCompactionCliff without a live indexer.
 */
export function countCompactionMarkers(events: unknown[]): number {
  let n = 0;
  for (const ev of events) {
    if (ev == null) continue;
    if (typeof ev === "string") {
      const s = ev.trim().toLowerCase();
      if (s === "compaction" || s === "compact" || s === "/compact") n += 1;
      continue;
    }
    if (typeof ev !== "object") continue;
    const o = ev as Record<string, unknown>;
    const type = String(o.type ?? o.kind ?? "").toLowerCase();
    const subtype = String(o.subtype ?? o.subType ?? "").toLowerCase();
    const content = typeof o.content === "string" ? o.content.toLowerCase() : "";
    if (type === "compaction" || type === "compact") {
      n += 1;
      continue;
    }
    if (type === "system" && (subtype.includes("compact") || /\/?compact/.test(content))) {
      n += 1;
      continue;
    }
    if (subtype === "compaction" || subtype === "compact") {
      n += 1;
    }
  }
  return n;
}

/**
 * Pull compaction fields from a Grok-style signals / extras_json object
 * (or a parsed SessionRow.extras_json). Missing fields stay null.
 */
export function signalsFromExtras(
  source: BackendId,
  extras: unknown,
  base?: Partial<CompactionSignals>,
): CompactionSignals {
  const o =
    extras && typeof extras === "object" ? (extras as Record<string, unknown>) : ({} as Record<string, unknown>);
  return {
    source,
    compactionCount: asNonNegInt(o.compactionCount),
    contextTokensUsed: asNonNegInt(o.contextTokensUsed),
    contextWindowTokens: asNonNegInt(o.contextWindowTokens),
    totalTokensBeforeCompaction: asNonNegInt(o.totalTokensBeforeCompaction),
    sessionId: base?.sessionId ?? null,
    title: base?.title ?? null,
    projectPath: base?.projectPath ?? null,
    model: base?.model ?? (typeof o.primaryModelId === "string" ? o.primaryModelId : null),
    goal: base?.goal ?? null,
    acceptance: base?.acceptance ?? null,
    paths: base?.paths ?? null,
    recentDecisions: base?.recentDecisions ?? null,
  };
}

/**
 * Evaluate cliff level for one session. Always returns a card (level may be
 * `ok`). Never throws on missing optional fields.
 */
export function evaluateCompactionCliff(
  signals: CompactionSignals,
  overrides?: Partial<Record<string, Partial<CompactionThresholds>>>,
): CliffCard {
  const source = signals.source || "unknown";
  const threshold = thresholdsFor(source, overrides);
  const compactionCount = asNonNegInt(signals.compactionCount) ?? 0;
  const fill = contextFillOf(signals);
  const fillWarn =
    fill != null &&
    threshold.warnAtContextFill != null &&
    fill >= threshold.warnAtContextFill;

  let level: CliffLevel = "ok";
  if (compactionCount >= threshold.recommendAtCompacts) {
    level = "recommend_handoff";
  } else if (compactionCount >= threshold.warnAtCompacts || fillWarn) {
    level = "approaching";
  }

  const recommendBackend =
    level === "ok" ? null : pickHandoffTarget(source, threshold.preferHandoffTo);

  const fillPct = fill == null ? null : `${Math.round(fill * 100)}%`;
  let headline: string;
  let detail: string;
  if (level === "recommend_handoff") {
    headline = `Approaching cliff — handoff to ${recommendBackend ?? "another backend"} with KP cartridge`;
    detail =
      `${source} has compacted ${compactionCount} time(s)` +
      (fillPct ? ` (context ~${fillPct})` : "") +
      `. Quality often drops after early/repeated compact — emit a handoff pack and continue on ${recommendBackend ?? "a fresher backend"}. Recommendation only; session is not stopped.`;
  } else if (level === "approaching") {
    headline = `Context cliff approaching on ${source}`;
    detail =
      (compactionCount > 0
        ? `${compactionCount} compaction(s) so far`
        : `Context fill ${fillPct ?? "high"}`) +
      ` — nearing the ${source} cliff threshold (warn@${threshold.warnAtCompacts}, handoff@${threshold.recommendAtCompacts}). Consider preparing a KP handoff to ${recommendBackend ?? "another backend"}.`;
  } else {
    headline = `Compaction OK on ${source}`;
    detail =
      `Compacts ${compactionCount}/${threshold.warnAtCompacts} warn · handoff at ${threshold.recommendAtCompacts}` +
      (fillPct ? ` · context ${fillPct}` : "") +
      `.`;
  }

  return {
    level,
    source,
    compactionCount,
    contextFill: fill,
    threshold,
    recommendBackend,
    headline,
    detail,
    autoFailover: false,
  };
}

/** Markdown body for a session-detail / insights card. */
export function renderCliffCardMarkdown(card: CliffCard): string {
  const lines = [
    `### Compaction cliff`,
    ``,
    `**${card.headline}**`,
    ``,
    card.detail,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| Backend | ${card.source} |`,
    `| Level | ${card.level} |`,
    `| Compacts | ${card.compactionCount} |`,
    `| Context fill | ${card.contextFill == null ? "n/a" : `${Math.round(card.contextFill * 100)}%`} |`,
    `| Recommend | ${card.recommendBackend ?? "—"} |`,
    `| Auto-failover | no (v1 recommendation only) |`,
  ];
  return lines.join("\n") + "\n";
}

/**
 * One-click handoff markdown: goal, paths, acceptance, last N decisions.
 * Schema: code-sessions/compaction-cliff-handoff@1 — reusable by Code Build /
 * KP cartridge inject.
 */
export function buildHandoffPack(input: HandoffPackInput): string {
  const { signals, card } = input;
  const maxDecisions = input.maxDecisions ?? 8;
  const decisions = (signals.recentDecisions ?? []).slice(0, maxDecisions);
  const acceptance = signals.acceptance ?? [];
  const paths = signals.paths ?? [];

  const lines: string[] = [
    `# Compaction-cliff handoff pack`,
    ``,
    `schema: ${HANDOFF_PACK_SCHEMA}`,
    `source_session: ${signals.sessionId ?? ""}`,
    `from_backend: ${card.source}`,
    `to_backend: ${card.recommendBackend ?? ""}`,
    `level: ${card.level}`,
    `compaction_count: ${card.compactionCount}`,
    `auto_failover: false`,
    ``,
    `## Goal`,
    goalLine(signals),
    ``,
    `## Acceptance`,
  ];

  if (acceptance.length === 0) {
    lines.push(`- [ ] _Add acceptance criteria from the KP cartridge_`);
  } else {
    for (const a of acceptance) lines.push(`- [ ] ${a}`);
  }

  lines.push(``, `## Paths`);
  if (paths.length === 0) {
    lines.push(`- _No paths listed_`);
  } else {
    for (const p of paths) lines.push(`- \`${p}\``);
  }

  if (signals.projectPath) {
    lines.push(``, `## Project`, `\`${signals.projectPath}\``);
  }
  if (signals.model) {
    lines.push(``, `## Model (source)`, signals.model);
  }

  lines.push(``, `## Recent decisions (last ${maxDecisions})`);
  if (decisions.length === 0) {
    lines.push(`_No decisions captured._`);
  } else {
    decisions.forEach((d, i) => lines.push(`${i + 1}. ${d}`));
  }

  lines.push(
    ``,
    `## Why handoff`,
    card.detail,
    ``,
    `## Notes`,
    `- Recommendation only — do not auto-kill the source ACP session.`,
    `- Thresholds are heuristics (not vendor remaining-context guarantees).`,
    `- Continue on \`${card.recommendBackend ?? "target-backend"}\` with this pack as the primer.`,
    ``,
  );

  return lines.join("\n");
}

function goalLine(signals: CompactionSignals): string {
  const goal = signals.goal?.trim();
  if (goal) return goal;
  const title = signals.title?.trim();
  if (title) return title;
  return `_No goal captured — fill from KP item before resume._`;
}
