// UI%-vs-autocompact-trigger mismatch card — pure core (no vscode / no db).
//
// "Meter lies" failure mode (Claude Code #90406 class): the UI context meter
// shows ~24% used while auto-compact fires at ~1M tokens on a large-context
// model, and the injected summary falsely claims the conversation "ran out of
// context". This module joins displayed % × compact-trigger preTokens ×
// declared window class into a mismatch card for session detail.
//
// Observational only — the card never rewrites or suppresses a vendor compact.
// Callers pass MismatchSignals built from indexed usage fields / transcript
// events / fixtures; every field is optional and missing data degrades to a
// "no verdict" card rather than throwing.

export type BackendId = "claude" | "grok" | "codex" | string;

export type MismatchLevel = "mismatch" | "ok" | "insufficient_data";

export const MISMATCH_CARD_SCHEMA = "code-sessions/compact-mismatch@1";

/**
 * Disagreement tolerance between UI-reported fill and the fill implied by the
 * compact trigger (preTokens / declared window). |implied − ui| > ε → mismatch.
 */
export const DEFAULT_EPSILON = 0.15;

/** Known context-window classes (tokens). Heuristic, not vendor-guaranteed. */
export const WINDOW_CLASSES: Readonly<Record<string, number>> = {
  "1m": 1_000_000,
  "500k": 500_000,
  "200k": 200_000,
  "128k": 128_000,
};

/** One observed compaction event from a transcript. */
export interface CompactBoundary {
  /** Index of the boundary event in the transcript (for open-at-boundary). */
  eventIndex: number | null;
  /** Total tokens in context just before the compact fired. */
  preTokens: number | null;
  /** Vendor trigger kind when recorded ("auto" | "manual" | null). */
  trigger: string | null;
  /** Injected summary text claims the conversation ran out of context. */
  claimsOutOfContext: boolean;
}

export interface MismatchSignals {
  source: BackendId;
  sessionId?: string | null;
  model?: string | null;
  /** Declared context window in tokens (from index / model class pin). */
  declaredWindowTokens?: number | null;
  /** UI-reported context fill at (or near) the compact, in [0, 1]. */
  uiReportedFill?: number | null;
  /** Observed compact boundaries, oldest first. */
  boundaries?: CompactBoundary[] | null;
}

export interface MismatchCard {
  schema: typeof MISMATCH_CARD_SCHEMA;
  level: MismatchLevel;
  source: BackendId;
  model: string | null;
  windowClass: string | null;
  declaredWindowTokens: number | null;
  uiReportedFill: number | null;
  /** The boundary the verdict is based on (worst disagreement). */
  boundary: CompactBoundary | null;
  /** preTokens / declaredWindowTokens for that boundary, in [0, 1]. */
  impliedFillAtCompact: number | null;
  /** |impliedFillAtCompact − uiReportedFill|, null when either is missing. */
  disagreement: number | null;
  epsilon: number;
  /** Any boundary's summary falsely claims "ran out of context" while UI% was low. */
  falseOutOfContext: boolean;
  headline: string;
  detail: string;
  /** Missing inputs that kept the card from reaching a verdict. */
  missing: string[];
}

function asNonNegNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Map a declared token count to the nearest named window class chip
 * ("1m", "200k", …), or null when unknown.
 */
export function windowClassOf(declaredWindowTokens: number | null | undefined): string | null {
  const w = asNonNegNumber(declaredWindowTokens);
  if (w == null || w <= 0) return null;
  let bestName: string | null = null;
  let bestDelta = Infinity;
  for (const [name, tokens] of Object.entries(WINDOW_CLASSES)) {
    const delta = Math.abs(tokens - w) / tokens;
    if (delta < bestDelta) {
      bestDelta = delta;
      bestName = name;
    }
  }
  // Only claim a class when within 20% of it; otherwise show raw tokens.
  return bestDelta <= 0.2 ? bestName : null;
}

const OOC_CLAIM =
  /ran out of context|out of context|context (window )?(was )?(full|exhausted|exceeded)/i;

/**
 * Extract compact boundaries from transcript-shaped events. Recognizes the
 * Claude Code JSONL shape (`type: "system", subtype: "compact_boundary"` with
 * `compactMetadata.preTokens` / `pre_tokens` and `trigger`) plus generic
 * `{ type: "compaction"|"compact" }` markers. A summary event whose text
 * matches an "out of context" claim marks the preceding boundary (or a
 * boundary of its own when none precedes it).
 */
export function extractCompactBoundaries(events: unknown[]): CompactBoundary[] {
  const out: CompactBoundary[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev == null || typeof ev !== "object") continue;
    const o = ev as Record<string, unknown>;
    const type = String(o.type ?? o.kind ?? "").toLowerCase();
    const subtype = String(o.subtype ?? o.subType ?? "").toLowerCase();
    const meta =
      o.compactMetadata && typeof o.compactMetadata === "object"
        ? (o.compactMetadata as Record<string, unknown>)
        : null;
    const content = typeof o.content === "string" ? o.content : "";

    const isBoundary =
      type === "compaction" ||
      type === "compact" ||
      subtype === "compact_boundary" ||
      subtype === "compaction" ||
      subtype === "compact";

    if (isBoundary) {
      out.push({
        eventIndex: i,
        preTokens: asNonNegNumber(meta?.preTokens ?? meta?.pre_tokens ?? o.preTokens),
        trigger:
          typeof meta?.trigger === "string"
            ? meta.trigger
            : typeof o.trigger === "string"
              ? o.trigger
              : null,
        claimsOutOfContext: OOC_CLAIM.test(content),
      });
      continue;
    }

    // Injected compact summary claiming OOC — attach to the latest boundary.
    const looksLikeSummary =
      (o.isCompactSummary === true || subtype.includes("compact") || type === "summary") &&
      OOC_CLAIM.test(content || String(o.summary ?? ""));
    if (looksLikeSummary) {
      const last = out[out.length - 1];
      if (last) last.claimsOutOfContext = true;
      else out.push({ eventIndex: i, preTokens: null, trigger: null, claimsOutOfContext: true });
    }
  }
  return out;
}

/**
 * Evaluate one session's UI% vs compact-trigger agreement. Always returns a
 * card; missing inputs yield `insufficient_data` with `missing` populated.
 */
export function evaluateCompactMismatch(
  signals: MismatchSignals,
  epsilon: number = DEFAULT_EPSILON,
): MismatchCard {
  const source = signals.source || "unknown";
  const window = asNonNegNumber(signals.declaredWindowTokens);
  const uiFillRaw = asNonNegNumber(signals.uiReportedFill);
  const uiFill = uiFillRaw == null ? null : clamp01(uiFillRaw);
  const boundaries = (signals.boundaries ?? []).filter(Boolean);

  const missing: string[] = [];
  if (window == null || window <= 0) missing.push("declaredWindowTokens");
  if (uiFill == null) missing.push("uiReportedFill");
  if (boundaries.length === 0) missing.push("compact boundaries");

  // Pick the boundary with the worst disagreement (falling back to the last
  // boundary when preTokens are unrecorded).
  let boundary: CompactBoundary | null = boundaries[boundaries.length - 1] ?? null;
  let impliedFill: number | null = null;
  let disagreement: number | null = null;
  if (window != null && window > 0) {
    for (const b of boundaries) {
      const pre = asNonNegNumber(b.preTokens);
      if (pre == null) continue;
      const fill = clamp01(pre / window);
      const d = uiFill == null ? null : Math.abs(fill - uiFill);
      if (impliedFill == null || (d != null && (disagreement == null || d > disagreement))) {
        boundary = b;
        impliedFill = fill;
        disagreement = d;
      }
    }
  }
  if (boundaries.length > 0 && impliedFill == null) missing.push("boundary preTokens");

  // The "ran out of context" claim is flagged false only when the displayed
  // fill was demonstrably low; with no UI reading we can't call it a lie.
  const falseOutOfContext =
    boundaries.some((b) => b.claimsOutOfContext) && uiFill != null && uiFill < 0.5;

  let level: MismatchLevel;
  if (disagreement != null) {
    level = disagreement > epsilon ? "mismatch" : "ok";
  } else {
    level = "insufficient_data";
  }

  const windowClass = windowClassOf(window);
  const pct = (f: number | null) => (f == null ? "n/a" : `${Math.round(f * 100)}%`);

  let headline: string;
  let detail: string;
  if (level === "mismatch") {
    headline = `Context meter disagrees with auto-compact on ${source}`;
    detail =
      `UI showed ~${pct(uiFill)} used but ${boundary?.trigger === "manual" ? "compact" : "auto-compact"} fired at ` +
      `${boundary?.preTokens?.toLocaleString("en-US") ?? "?"} tokens (~${pct(impliedFill)} of the ` +
      `${windowClass ?? window?.toLocaleString("en-US") ?? "declared"} window)` +
      (falseOutOfContext
        ? `. The injected summary claims the conversation ran out of context — likely false at the displayed fill.`
        : `.`) +
      ` The meter and the compact trigger are using different window assumptions; trust preTokens over the meter.`;
  } else if (level === "ok") {
    headline = `Context meter agrees with compact trigger on ${source}`;
    detail = `UI ${pct(uiFill)} vs implied ${pct(impliedFill)} at compact — within ε=${epsilon}.`;
  } else {
    headline = `Compact-mismatch check: not enough data on ${source}`;
    detail = `Missing ${missing.join(", ")} — card is observational and needs indexed usage fields.`;
  }

  return {
    schema: MISMATCH_CARD_SCHEMA,
    level,
    source,
    model: signals.model ?? null,
    windowClass,
    declaredWindowTokens: window,
    uiReportedFill: uiFill,
    boundary,
    impliedFillAtCompact: impliedFill,
    disagreement,
    epsilon,
    falseOutOfContext,
    headline,
    detail,
    missing,
  };
}

/**
 * KP handoff primer for continuing past a lying meter on a fresh backend.
 * Companion to the one-click "copy primer" action next to "open transcript at
 * compact boundary" (use `card.boundary.eventIndex`).
 */
export function buildMismatchPrimer(card: MismatchCard): string {
  const pct = (f: number | null) => (f == null ? "n/a" : `${Math.round(f * 100)}%`);
  return [
    `# Compact-mismatch primer`,
    ``,
    `schema: ${MISMATCH_CARD_SCHEMA}`,
    `backend: ${card.source}`,
    `model: ${card.model ?? ""}`,
    `window_class: ${card.windowClass ?? card.declaredWindowTokens ?? "unknown"}`,
    `ui_reported: ${pct(card.uiReportedFill)}`,
    `pre_tokens: ${card.boundary?.preTokens ?? ""}`,
    `trigger: ${card.boundary?.trigger ?? ""}`,
    `false_out_of_context: ${card.falseOutOfContext}`,
    ``,
    `## What happened`,
    card.detail,
    ``,
    `## Notes`,
    `- Observational card — the vendor compact was not rewritten or suppressed.`,
    `- The compact summary may misstate why it fired; re-read the transcript at the boundary before trusting it.`,
    ``,
  ].join("\n");
}

/** Markdown body for a session-detail card. */
export function renderMismatchCardMarkdown(card: MismatchCard): string {
  const pct = (f: number | null) => (f == null ? "n/a" : `${Math.round(f * 100)}%`);
  const lines = [
    `### UI% vs auto-compact mismatch`,
    ``,
    `**${card.headline}**`,
    ``,
    card.detail,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| Backend | ${card.source} |`,
    `| Model | ${card.model ?? "—"} |`,
    `| Window class | ${card.windowClass ?? (card.declaredWindowTokens?.toLocaleString("en-US") ?? "—")} |`,
    `| UI reported | ${pct(card.uiReportedFill)} |`,
    `| preTokens at compact | ${card.boundary?.preTokens?.toLocaleString("en-US") ?? "—"} |`,
    `| Implied fill | ${pct(card.impliedFillAtCompact)} |`,
    `| Trigger | ${card.boundary?.trigger ?? "—"} |`,
    `| False "out of context" | ${card.falseOutOfContext ? "yes" : "no"} |`,
    `| Verdict | ${card.level} (ε=${card.epsilon}) |`,
  ];
  return lines.join("\n") + "\n";
}
