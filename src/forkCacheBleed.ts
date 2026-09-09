// Fork-cache inheritance bleed detector card
// (KP ideas/csv-fork-cache-inheritance-bleed-detector-card-w).
// Pure module — no vscode imports — so the aggregator + renderer are
// fixture-testable.
//
// Claude Code 2.1.232 made fork subagents default: children inherit the
// parent's full conversation *and* prompt cache. That is a cost win — and a
// known failure mode (anthropics/claude-code#57751): Explore/Agent children
// reading ~150K cache_read_input_tokens while the Agent brief was ~2K caused
// plan-mode bleed ("MUST NOT make edits"), cross-subagent hallucination, and
// self-poisoning.
//
// This card flags a child when:
//   1. cache_read / brief_tokens ≥ configurable ratio (default 20×), OR
//   2. child transcript contains a plan-mode refuse while the parent looks
//      like it was in plan phase.
//
// Claude-first (usage blocks with cache_read_input_tokens). Degrades when
// usage is absent. Advisory only — warn + deep-link; never auto-kill.

export const FORK_CACHE_BLEED_SCHEMA =
  "code-sessions/fork-cache-inheritance-bleed@1";

/** Default: warn when child cache_read is ≥ 20× the Agent brief size. */
export const DEFAULT_CACHE_TO_BRIEF_RATIO = 20;

/** Minimal session-row shape (SessionStore row or Insights mirror). */
export interface ForkBleedSessionInput {
  session_id?: string | null;
  source?: string | null;
  kind?: string | null;
  parent_session_id?: string | null;
  title?: string | null;
  first_user_msg?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
}

/** First-turn usage for a child (from the per-turn token columns). */
export interface ForkBleedFirstTurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export type ForkBleedReason = "cache_ratio" | "plan_refuse";

export interface ForkBleedHit {
  sessionId: string;
  parentId: string;
  label: string;
  source: string;
  /** Child cache_read tokens used for the ratio (first-turn preferred). */
  cacheReadTokens: number;
  /** Estimated Agent-brief size in tokens. */
  briefTokens: number;
  /** cacheReadTokens / briefTokens (Infinity when brief is 0 and cache > 0). */
  ratio: number;
  reasons: ForkBleedReason[];
  /** How briefTokens was derived. */
  briefBasis: "first-turn-input" | "session-input" | "first_user_msg" | "missing";
  /** How cacheReadTokens was derived. */
  cacheBasis: "first-turn" | "session" | "missing";
}

export interface ForkCacheBleedCard {
  hits: ForkBleedHit[];
  /** Child transcripts considered (Claude-first; others skipped in v1). */
  childSessions: number;
  /** Ratio threshold used (cache_read / brief). */
  ratioThreshold: number;
}

export interface ForkCacheBleedOptions {
  /** Map child session_id → first-turn usage (preferred cache_read + brief). */
  firstTurnUsage?: Map<string, ForkBleedFirstTurnUsage>;
  /**
   * Optional child transcript text (or a representative snippet) keyed by
   * session_id — used for the plan-mode refuse detector. When absent, only
   * the cache-ratio path can fire.
   */
  childText?: Map<string, string>;
  /**
   * Optional parent transcript / title text keyed by parent session_id —
   * used to decide whether the parent was in plan phase. Falls back to the
   * parent's title + first_user_msg from `rows` when omitted.
   */
  parentText?: Map<string, string>;
  /** cache_read / brief ratio that flips the warning (default 20). */
  ratioThreshold?: number;
  /** Max hits listed on the card (default 8). */
  maxHits?: number;
  /** Open-session command id for deep links (default codeSessions.openSession). */
  openSessionCommand?: string;
}

/** Plan-mode refuse / reminder phrases seen in #57751-class bleeds. */
export const PLAN_REFUSE_PATTERNS: RegExp[] = [
  /\bMUST NOT make edits?\b/i,
  /\byou(?:'re| are) in plan mode\b/i,
  /\bplan mode(?: reminder)?\b.*\b(?:no|not|don't|do not)\b.*\b(?:edit|write|chang)/i,
  /\bdo not (?:make|perform) (?:any )?(?:edits?|changes?|writes?)\b/i,
  /\bread-only(?:\s+exploration)?(?:\s+mode)?\b.*\bplan\b/i,
];

/** Parent-looks-like-plan heuristics (title / first msg / optional text). */
const PARENT_PLAN_RE =
  /(?:^|[\s"'`(])\/plan\b|\b(?:plan mode|exitplanmode|awaiting plan|planning mode|write a plan|draft(?:ing)? a plan)\b/i;

function childLabel(r: ForkBleedSessionInput): string {
  const raw = (r.title || r.first_user_msg || r.session_id || "").trim();
  return raw.slice(0, 70);
}

/** ~4 chars/token estimate for Agent-tool brief text when usage is absent. */
export function estimateBriefTokensFromText(text: string | null | undefined): number {
  const t = (text ?? "").trim();
  if (!t) return 0;
  return Math.max(1, Math.round(t.length / 4));
}

export function textLooksLikePlanRefuse(text: string | null | undefined): boolean {
  const t = text ?? "";
  if (!t) return false;
  return PLAN_REFUSE_PATTERNS.some((re) => re.test(t));
}

export function textLooksLikePlanPhase(text: string | null | undefined): boolean {
  const t = text ?? "";
  if (!t) return false;
  return PARENT_PLAN_RE.test(t);
}

function parentLooksInPlan(
  parent: ForkBleedSessionInput | undefined,
  parentId: string,
  parentText?: Map<string, string>,
): boolean {
  const extra = parentText?.get(parentId) ?? "";
  if (textLooksLikePlanPhase(extra)) return true;
  if (!parent) return false;
  const blob = `${parent.title ?? ""}\n${parent.first_user_msg ?? ""}`;
  return textLooksLikePlanPhase(blob);
}

/**
 * Detect fork-cache inheritance bleed on Claude children.
 * Non-Claude children are counted but never flagged in v1 (no reliable
 * cache_read_input_tokens join yet).
 */
export function computeForkCacheBleed(
  rows: ForkBleedSessionInput[],
  opts: ForkCacheBleedOptions = {},
): ForkCacheBleedCard {
  const ratioThreshold = opts.ratioThreshold ?? DEFAULT_CACHE_TO_BRIEF_RATIO;
  const maxHits = opts.maxHits ?? 8;
  const firstTurn = opts.firstTurnUsage;

  const parentById = new Map<string, ForkBleedSessionInput>();
  const children: ForkBleedSessionInput[] = [];
  for (const r of rows) {
    const kind = r.kind ?? "session";
    if (kind === "session") {
      if (r.session_id) parentById.set(r.session_id, r);
      continue;
    }
    if (kind !== "subagent" && kind !== "workflow") continue;
    if (!r.parent_session_id || !r.session_id) continue;
    children.push(r);
  }

  const hits: ForkBleedHit[] = [];
  let childSessions = 0;
  for (const child of children) {
    childSessions++;
    const src = (child.source || "claude").toLowerCase();
    // Claude-first: other backends degrade silently (no false alarms).
    if (src !== "claude") continue;

    const sid = child.session_id!;
    const parentId = child.parent_session_id!;
    const ft = firstTurn?.get(sid);

    let cacheRead = 0;
    let cacheBasis: ForkBleedHit["cacheBasis"] = "missing";
    if (ft && ft.cache_read_tokens > 0) {
      cacheRead = ft.cache_read_tokens;
      cacheBasis = "first-turn";
    } else if ((child.cache_read_tokens ?? 0) > 0) {
      cacheRead = child.cache_read_tokens ?? 0;
      cacheBasis = "session";
    }

    let briefTokens = 0;
    let briefBasis: ForkBleedHit["briefBasis"] = "missing";
    if (ft && ft.input_tokens > 0) {
      // Non-cache input on the first turn ≈ declared Agent brief / prompt.
      briefTokens = ft.input_tokens;
      briefBasis = "first-turn-input";
    } else if ((child.input_tokens ?? 0) > 0) {
      // Session rollup input (excludes cache_read / cache_write columns).
      briefTokens = child.input_tokens ?? 0;
      briefBasis = "session-input";
    } else {
      const est = estimateBriefTokensFromText(child.first_user_msg);
      if (est > 0) {
        briefTokens = est;
        briefBasis = "first_user_msg";
      }
    }

    const reasons: ForkBleedReason[] = [];
    let ratio = 0;
    if (cacheBasis !== "missing" && briefBasis !== "missing" && briefTokens > 0) {
      ratio = cacheRead / briefTokens;
      if (ratio >= ratioThreshold) reasons.push("cache_ratio");
    } else if (cacheBasis !== "missing" && briefTokens === 0 && cacheRead > 0) {
      // Brief unknown but huge cache_read still smells like inheritance bleed
      // when we have plan-refuse evidence; ratio path alone stays quiet without
      // a denominator (avoid inventing a brief).
      ratio = Infinity;
    }

    const childBlob = opts.childText?.get(sid) ?? child.first_user_msg ?? "";
    if (
      textLooksLikePlanRefuse(childBlob) &&
      parentLooksInPlan(parentById.get(parentId), parentId, opts.parentText)
    ) {
      reasons.push("plan_refuse");
    }

    if (reasons.length === 0) continue;

    hits.push({
      sessionId: sid,
      parentId,
      label: childLabel(child),
      source: src,
      cacheReadTokens: cacheRead,
      briefTokens,
      ratio: Number.isFinite(ratio) ? ratio : Infinity,
      reasons,
      briefBasis,
      cacheBasis,
    });
  }

  // Worst ratio first; plan_refuse-only (no ratio) sorts after finite ratios.
  hits.sort((a, b) => {
    const ar = Number.isFinite(a.ratio) ? a.ratio : 1e12;
    const br = Number.isFinite(b.ratio) ? b.ratio : 1e12;
    return br - ar;
  });

  return {
    hits: hits.slice(0, maxHits),
    childSessions,
    ratioThreshold,
  };
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

function fmtTokShort(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${Math.round(n)}`;
}

function fmtRatio(r: number): string {
  if (!Number.isFinite(r)) return "∞";
  if (r >= 100) return `${Math.round(r)}×`;
  if (r >= 10) return `${r.toFixed(0)}×`;
  return `${r.toFixed(1)}×`;
}

function reasonLabel(reasons: ForkBleedReason[]): string {
  const parts: string[] = [];
  if (reasons.includes("cache_ratio")) parts.push("cache ≫ brief");
  if (reasons.includes("plan_refuse")) parts.push("plan-mode refuse");
  return parts.join(" · ");
}

function sessionHref(sessionId: string, command: string): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([sessionId]))}`;
}

/** Insights section ("" when no bleed hits). */
export function renderForkCacheBleedSectionHtml(
  card: ForkCacheBleedCard,
  opts: Pick<ForkCacheBleedOptions, "openSessionCommand"> = {},
): string {
  if (card.hits.length === 0) return "";
  const cmd = opts.openSessionCommand ?? "codeSessions.openSession";

  const rows = card.hits
    .map((h) => {
      const childHref = sessionHref(h.sessionId, cmd);
      const parentHref = sessionHref(h.parentId, cmd);
      const ratioTitle =
        h.briefBasis === "missing"
          ? "Brief size unknown — ratio not used for the warn"
          : `cache_read (${h.cacheBasis}) / brief (${h.briefBasis})`;
      return `<tr>
        <td class="fcb-label"><a class="fcb-session" href="${esc(childHref)}" title="${esc(h.sessionId)}">${esc(h.label.slice(0, 48))}</a></td>
        <td><a class="fcb-session" href="${esc(parentHref)}" title="${esc(h.parentId)}">${esc(h.parentId.slice(0, 8))}</a></td>
        <td class="num" title="${esc(ratioTitle)}">${esc(fmtTokShort(h.cacheReadTokens))}</td>
        <td class="num">${esc(fmtTokShort(h.briefTokens))}</td>
        <td class="num fcb-hot" title="${esc(ratioTitle)}">${esc(fmtRatio(h.ratio))}</td>
        <td>${esc(reasonLabel(h.reasons))}</td>
      </tr>`;
    })
    .join("");

  return `<section class="fcb-card" data-schema="${esc(FORK_CACHE_BLEED_SCHEMA)}">
  <div class="fcb-head"><span class="fcb-title">Fork-cache inheritance bleed</span>
    <span class="fcb-chip" title="Child cache_read / Agent brief ≥ ${card.ratioThreshold}×, or plan-mode refuse text while parent was in plan">bleed risk</span>
  </div>
  <div class="fcb-sub">Forked Claude children inherit the parent's prompt cache. When <b>cache_read ≫ Agent brief</b> (default <b>${card.ratioThreshold}×</b>) or a child echoes plan-mode refuse while the parent was planning, the child may be poisoned by parent context (#57751 class). ${card.hits.length} hit${card.hits.length === 1 ? "" : "s"} below · ${card.childSessions} child transcript${card.childSessions === 1 ? "" : "s"} scanned.</div>
  <table class="fcb-table"><tr><th>child</th><th>parent</th><th>cache_read</th><th>brief</th><th>ratio</th><th>signal</th></tr>${rows}</table>
  <div class="fcb-help">Threshold: warn when <code>cache_read / brief ≥ ${card.ratioThreshold}</code> (configurable in compute options). Brief prefers first-turn non-cache <code>input_tokens</code>, else session <code>input_tokens</code>, else ~chars/4 from the child's first user message. Cache prefers first-turn <code>cache_read_input_tokens</code>, else session rollup. Claude-only in v1.</div>
  <div class="fcb-disclaimer">Read-only over the local session index — warn + deep-link only; never auto-kills children. Fan-out governors belong to the host (Code Build).</div>
</section>`;
}

/** CSS for Insights — keep in sync with `.fcb-*` markup above. */
export const FORK_CACHE_BLEED_CARD_CSS = `
.fcb-card { background: var(--card-bg, var(--vscode-editorWidget-background, #1e1e1e)); border: 1px solid var(--border, var(--vscode-panel-border, #333)); border-radius: 6px; padding: 12px 14px; margin-top: 8px; }
.fcb-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; }
.fcb-title { font-size: 11px; text-transform: uppercase; color: var(--muted, var(--vscode-descriptionForeground, #999)); letter-spacing: 0.5px; font-weight: 600; }
.fcb-chip { display: inline-block; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; color: var(--vscode-inputValidation-errorForeground, #f88); border: 1px solid var(--vscode-inputValidation-errorForeground, #f88); border-radius: 8px; padding: 1px 7px; vertical-align: middle; }
.fcb-sub { font-size: 12px; color: var(--muted, var(--vscode-descriptionForeground, #999)); line-height: 1.45; margin-bottom: 8px; }
.fcb-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 2px; }
.fcb-table th, .fcb-table td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--border, var(--vscode-panel-border, #333)); }
.fcb-table th { color: var(--muted, var(--vscode-descriptionForeground, #999)); font-weight: 500; font-size: 10px; text-transform: uppercase; }
.fcb-table td.num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.fcb-table th:nth-child(n+3):nth-child(-n+5) { text-align: right; }
.fcb-label { font-family: var(--vscode-editor-font-family, monospace); }
.fcb-session { color: var(--accent, var(--vscode-textLink-foreground, #4af)); text-decoration: none; }
.fcb-session:hover { text-decoration: underline; }
.fcb-hot { color: var(--vscode-inputValidation-errorForeground, #f88); font-weight: 600; }
.fcb-help { font-size: 11px; color: var(--muted, var(--vscode-descriptionForeground, #999)); margin-top: 8px; line-height: 1.45; }
.fcb-help code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; }
.fcb-disclaimer { font-size: 11px; color: var(--muted, var(--vscode-descriptionForeground, #999)); margin-top: 8px; line-height: 1.45; border-top: 1px solid var(--border, var(--vscode-panel-border, #333)); padding-top: 8px; }
`;
