// Plan-assumption checklist — pure core (no vscode / no db).
//
// Plan-mode transcripts bury implicit facts ("I assume X", "we'll use Y") that
// the human should falsify in ~30s before a build run burns 10–20 minutes on
// the wrong premise. This module extracts candidate assumptions from
// plan/ask-phase text, builds a checkbox checklist card, and gates
// "Start build" / "Promote to KP constraints" until every item is checked or
// the human supplies an explicit skip reason.
//
// Heuristic / offline only — false positives are OK (dismiss path exists).
// No cloud calls. UI card wiring lands in a follow-up slice.

export type BackendId = "claude" | "grok" | "codex" | string;

export type AssumptionSource =
  | "explicit_assume"
  | "will_use"
  | "defaulting"
  | "implicit_given"
  | "plan_bullet";

export interface PlanTurn {
  /** "user" | "assistant" | "system" | other */
  role: string;
  content: string;
  /** Optional plan/ask phase marker from indexer / extras. */
  phase?: string | null;
}

export interface AssumptionCandidate {
  id: string;
  text: string;
  source: AssumptionSource;
  /** 0-based turn index in the input, or -1 when synthesized. */
  turnIndex: number;
}

export type ChecklistItemState = "unchecked" | "checked" | "dismissed";

export interface ChecklistItem {
  id: string;
  text: string;
  source: AssumptionSource;
  turnIndex: number;
  state: ChecklistItemState;
}

export interface AssumptionChecklist {
  sessionId: string | null;
  source: BackendId;
  /** True when the transcript looks like a plan/ask phase. */
  isPlanPhase: boolean;
  items: ChecklistItem[];
  /** Explicit human skip of remaining unchecked items. */
  skipReason: string | null;
  headline: string;
  detail: string;
}

export interface ChecklistGate {
  /** All items checked/dismissed, or a non-empty skipReason is set. */
  startBuildEnabled: boolean;
  promoteToKpEnabled: boolean;
  uncheckedCount: number;
  /** Why the gate is closed (empty when open). */
  blockedReason: string | null;
}

export const ASSUMPTION_CARD_SCHEMA = "code-sessions/plan-assumption-checklist@1";

/** Min / max candidates kept on the card (KP acceptance: 3–7). */
export const ASSUMPTION_COUNT = { min: 3, max: 7 } as const;

const PLAN_PHASE_RE =
  /(?:\b(?:plan[\s_-]?mode|ask[\s_-]?mode|planning\s+mode|enter(?:ing)?\s+plan)\b|(?:^|[\s"'`(])\/plan\b)/i;

const EXPLICIT_ASSUME_RE =
  /\b(?:I\s+assume|I'm\s+assuming|I\s+am\s+assuming|assuming\s+that|assumption\s*:\s*|we(?:'ll|\s+will)?\s+assume|based\s+on\s+the\s+assumption\s+that)\b\s*(.+)/i;

const WILL_USE_RE =
  /\b(?:I(?:'ll|\s+will)|we(?:'ll|\s+will)|planning\s+to)\s+use\b\s+(.+)/i;

const DEFAULTING_RE =
  /\b(?:default(?:ing)?\s+to|going\s+with|opting\s+for|choosing)\b\s+(.+)/i;

const IMPLICIT_GIVEN_RE =
  /\b(?:given\s+that|since\s+(?:we|the|this)|it(?:'s|\s+is)\s+safe\s+to\s+assume)\b\s+(.+)/i;

/** Strip trailing clause noise so checkbox text stays short. */
function cleanTail(s: string): string {
  let t = s.trim();
  // Cut at sentence end / clause break when long.
  const cut = t.search(/[.!?\n](?:\s|$)/);
  if (cut > 20) t = t.slice(0, cut);
  // Drop leading punctuation / quotes.
  t = t.replace(/^[:\-\s"'`]+/, "").replace(/["'`]+$/, "").trim();
  // Cap length for the card.
  if (t.length > 160) t = t.slice(0, 157).trimEnd() + "…";
  return t;
}

function slugId(text: string, index: number): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `a${index}-${base || "assumption"}`;
}

function matchAssumption(
  line: string,
): { text: string; source: AssumptionSource } | null {
  const trimmed = line.trim();
  if (trimmed.length < 12) return null;

  let m = EXPLICIT_ASSUME_RE.exec(trimmed);
  if (m?.[1]) return { text: cleanTail(m[1]), source: "explicit_assume" };

  m = WILL_USE_RE.exec(trimmed);
  if (m?.[1]) return { text: `will use ${cleanTail(m[1])}`, source: "will_use" };

  m = DEFAULTING_RE.exec(trimmed);
  if (m?.[1]) return { text: `defaulting to ${cleanTail(m[1])}`, source: "defaulting" };

  m = IMPLICIT_GIVEN_RE.exec(trimmed);
  if (m?.[1]) return { text: cleanTail(m[1]), source: "implicit_given" };

  // Numbered / bulleted plan lines that assert a chosen approach.
  if (
    /^\s*(?:[-*]|\d+[.)])\s+/.test(trimmed) &&
    /\b(?:will|use|assume|default|instead of|rather than|not\s+\w+)\b/i.test(trimmed)
  ) {
    const body = trimmed.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "");
    if (body.length >= 16) {
      return { text: cleanTail(body), source: "plan_bullet" };
    }
  }

  return null;
}

/**
 * True when the transcript (or an explicit phase marker) looks like plan/ask
 * mode. Used to decide whether to surface the card at all.
 */
export function detectPlanPhase(turns: PlanTurn[]): boolean {
  for (const t of turns) {
    const phase = (t.phase ?? "").toLowerCase();
    if (phase.includes("plan") || phase.includes("ask")) return true;
    const content = t.content ?? "";
    if (PLAN_PHASE_RE.test(content)) return true;
  }
  return false;
}

/**
 * Extract 0..N assumption candidates from plan-phase assistant (and user)
 * turns. Dedupes near-identical text; prefers earlier explicit matches.
 */
export function extractAssumptions(turns: PlanTurn[]): AssumptionCandidate[] {
  const out: AssumptionCandidate[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const role = (turn.role || "").toLowerCase();
    // Prefer assistant plan narration; still scan user confirms that restate assumptions.
    if (role && role !== "assistant" && role !== "user" && role !== "model") {
      continue;
    }
    const content = turn.content ?? "";
    const lines = content.split(/\n+/);
    for (const line of lines) {
      const hit = matchAssumption(line);
      if (!hit || hit.text.length < 8) continue;
      const key = hit.text.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: slugId(hit.text, out.length),
        text: hit.text,
        source: hit.source,
        turnIndex: i,
      });
      if (out.length >= ASSUMPTION_COUNT.max) return out;
    }
  }
  return out;
}

export interface BuildChecklistInput {
  turns: PlanTurn[];
  source?: BackendId;
  sessionId?: string | null;
  /** Pre-seed item states (e.g. from UI). Keys are assumption ids. */
  states?: Record<string, ChecklistItemState>;
  skipReason?: string | null;
  /** Force card even when plan-phase detection is weak (tests / manual). */
  forcePlanPhase?: boolean;
}

/**
 * Build the checklist card. Returns items even when below the preferred
 * minimum so callers can still render a weak card; `isPlanPhase` tells the
 * UI whether to show it.
 */
export function buildAssumptionChecklist(input: BuildChecklistInput): AssumptionChecklist {
  const source = input.source ?? "unknown";
  const isPlanPhase = input.forcePlanPhase === true || detectPlanPhase(input.turns);
  const candidates = extractAssumptions(input.turns);
  const states = input.states ?? {};
  const items: ChecklistItem[] = candidates.map((c) => ({
    id: c.id,
    text: c.text,
    source: c.source,
    turnIndex: c.turnIndex,
    state: states[c.id] ?? "unchecked",
  }));

  const skipReason =
    typeof input.skipReason === "string" && input.skipReason.trim()
      ? input.skipReason.trim()
      : null;

  let headline: string;
  let detail: string;
  if (!isPlanPhase) {
    headline = "No plan/ask phase detected";
    detail = "Assumption checklist stays hidden until a plan/ask phase is present.";
  } else if (items.length === 0) {
    headline = "Plan phase — no extractable assumptions";
    detail =
      "Heuristics found no assume/will-use/defaulting lines. Proceed carefully, or add constraints manually in KP.";
  } else if (items.length < ASSUMPTION_COUNT.min) {
    headline = `Plan assumptions (${items.length} found — below preferred ${ASSUMPTION_COUNT.min})`;
    detail =
      "Review the candidates below before starting a build. False positives can be dismissed.";
  } else {
    headline = `Plan assumptions — falsify before build (${items.length})`;
    detail =
      "Check each assumption or dismiss it. Start build / Promote to KP stay disabled until all are resolved or you skip with a reason.";
  }

  return {
    sessionId: input.sessionId ?? null,
    source,
    isPlanPhase,
    items,
    skipReason,
    headline,
    detail,
  };
}

/** Gate for Start-build / Promote-to-KP actions. */
export function evaluateChecklistGate(checklist: AssumptionChecklist): ChecklistGate {
  if (!checklist.isPlanPhase) {
    return {
      startBuildEnabled: true,
      promoteToKpEnabled: true,
      uncheckedCount: 0,
      blockedReason: null,
    };
  }
  if (checklist.items.length === 0) {
    return {
      startBuildEnabled: true,
      promoteToKpEnabled: true,
      uncheckedCount: 0,
      blockedReason: null,
    };
  }

  const unchecked = checklist.items.filter((i) => i.state === "unchecked");
  if (unchecked.length === 0) {
    return {
      startBuildEnabled: true,
      promoteToKpEnabled: true,
      uncheckedCount: 0,
      blockedReason: null,
    };
  }
  if (checklist.skipReason) {
    return {
      startBuildEnabled: true,
      promoteToKpEnabled: true,
      uncheckedCount: unchecked.length,
      blockedReason: null,
    };
  }
  const reason = `${unchecked.length} assumption(s) still unchecked — check, dismiss, or skip with a reason`;
  return {
    startBuildEnabled: false,
    promoteToKpEnabled: false,
    uncheckedCount: unchecked.length,
    blockedReason: reason,
  };
}

/** Immutable update: set one item's state. */
export function setItemState(
  checklist: AssumptionChecklist,
  id: string,
  state: ChecklistItemState,
): AssumptionChecklist {
  return {
    ...checklist,
    items: checklist.items.map((it) => (it.id === id ? { ...it, state } : it)),
  };
}

/** Immutable update: set skip reason (empty/null clears). */
export function setSkipReason(
  checklist: AssumptionChecklist,
  reason: string | null,
): AssumptionChecklist {
  const skipReason =
    typeof reason === "string" && reason.trim() ? reason.trim() : null;
  return { ...checklist, skipReason };
}

/**
 * Accepted (checked, not dismissed) assumptions as a `## Constraints` block
 * suitable for KP item write-back. Dismissed items are omitted; unchecked
 * items are omitted unless includeUnchecked is set.
 */
export function formatConstraintsMarkdown(
  checklist: AssumptionChecklist,
  opts?: { includeUnchecked?: boolean },
): string {
  const includeUnchecked = opts?.includeUnchecked === true;
  const kept = checklist.items.filter((it) => {
    if (it.state === "dismissed") return false;
    if (it.state === "checked") return true;
    return includeUnchecked;
  });

  const lines: string[] = [
    `## Constraints`,
    ``,
    `<!-- ${ASSUMPTION_CARD_SCHEMA} session=${checklist.sessionId ?? ""} source=${checklist.source} -->`,
  ];
  if (kept.length === 0) {
    lines.push(`_No accepted plan assumptions._`);
  } else {
    for (const it of kept) {
      const mark = it.state === "checked" ? "x" : " ";
      lines.push(`- [${mark}] ${it.text}`);
    }
  }
  if (checklist.skipReason) {
    lines.push(``, `_Skip reason:_ ${checklist.skipReason}`);
  }
  lines.push(``);
  return lines.join("\n");
}

/** Markdown body for a session-detail / insights card. */
export function renderAssumptionCardMarkdown(checklist: AssumptionChecklist): string {
  const gate = evaluateChecklistGate(checklist);
  const lines = [
    `### Plan assumption checklist`,
    ``,
    `**${checklist.headline}**`,
    ``,
    checklist.detail,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| Backend | ${checklist.source} |`,
    `| Plan phase | ${checklist.isPlanPhase ? "yes" : "no"} |`,
    `| Items | ${checklist.items.length} |`,
    `| Unchecked | ${gate.uncheckedCount} |`,
    `| Start build | ${gate.startBuildEnabled ? "enabled" : "blocked"} |`,
    `| Promote to KP | ${gate.promoteToKpEnabled ? "enabled" : "blocked"} |`,
    ``,
  ];
  if (checklist.items.length > 0) {
    lines.push(`#### Assumptions`, ``);
    for (const it of checklist.items) {
      const box =
        it.state === "checked" ? "[x]" : it.state === "dismissed" ? "[–]" : "[ ]";
      lines.push(`- ${box} ${it.text} _(via ${it.source})_`);
    }
    lines.push(``);
  }
  if (checklist.skipReason) {
    lines.push(`_Skipped:_ ${checklist.skipReason}`, ``);
  }
  if (gate.blockedReason) {
    lines.push(`> ${gate.blockedReason}`, ``);
  }
  return lines.join("\n");
}

/** Command ids used by the conversation-viewer HTML card (command: URIs). */
export const PLAN_ASSUMPTION_COMMANDS = {
  setState: "codeSessions.planAssumption.setState",
  skip: "codeSessions.planAssumption.skip",
  clearSkip: "codeSessions.planAssumption.clearSkip",
  promoteToKp: "codeSessions.planAssumption.promoteToKp",
  startBuild: "codeSessions.planAssumption.startBuild",
} as const;

/** workspaceState map key: sessionId → persisted checklist UI state. */
export const PLAN_ASSUMPTION_STATE_KEY = "codeSessions.planAssumptionState";

export interface PersistedAssumptionState {
  states: Record<string, ChecklistItemState>;
  skipReason: string | null;
}

export interface AssumptionCardHtmlOpts {
  /** Emit command: URIs for check/dismiss/skip/promote/start-build (default true). */
  commandUris?: boolean;
}

function escapeCardHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cmdHref(command: string, args: unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

/**
 * Map a parsed conversation's turn cards into PlanTurn[] for extraction.
 * User + assistant text become separate turns (phase left unset — detection
 * still matches /plan and plan-mode phrases in content).
 */
export function planTurnsFromConversation(turns: Array<{
  userText?: string | null;
  assistantText?: string | null;
}>): PlanTurn[] {
  const out: PlanTurn[] = [];
  for (const t of turns) {
    const user = (t.userText ?? "").trim();
    const assistant = (t.assistantText ?? "").trim();
    if (user) out.push({ role: "user", content: user });
    if (assistant) out.push({ role: "assistant", content: assistant });
  }
  return out;
}

/**
 * HTML card for the conversation viewer. Hidden (empty string) when the
 * transcript is not a plan/ask phase. Uses command: URIs — webview scripts
 * stay off (same pattern as the untested-write surface card).
 */
export function renderAssumptionCardHtml(
  checklist: AssumptionChecklist,
  opts?: AssumptionCardHtmlOpts,
): string {
  if (!checklist.isPlanPhase) return "";

  const commandUris = opts?.commandUris !== false;
  const gate = evaluateChecklistGate(checklist);
  const sessionId = checklist.sessionId ?? "";
  const n = checklist.items.length;

  const itemsHtml =
    n === 0
      ? `<div class="pa-empty">${escapeCardHtml(
          "No extractable assumptions — proceed carefully, or add constraints in KP.",
        )}</div>`
      : `<ul class="pa-list">${checklist.items
          .map((it) => {
            const label = escapeCardHtml(it.text);
            const src = escapeCardHtml(it.source);
            const checked = it.state === "checked";
            const dismissed = it.state === "dismissed";
            const box = checked ? "[x]" : dismissed ? "[–]" : "[ ]";
            const cls = dismissed ? "pa-item pa-dismissed" : checked ? "pa-item pa-checked" : "pa-item";
            if (!commandUris || !sessionId) {
              return `<li class="${cls}"><span class="pa-box">${box}</span> ${label} <span class="pa-src">${src}</span></li>`;
            }
            const nextState: ChecklistItemState = checked
              ? "unchecked"
              : "checked";
            const toggleHref = cmdHref(PLAN_ASSUMPTION_COMMANDS.setState, [
              sessionId,
              it.id,
              nextState,
            ]);
            const dismissHref = cmdHref(PLAN_ASSUMPTION_COMMANDS.setState, [
              sessionId,
              it.id,
              dismissed ? "unchecked" : "dismissed",
            ]);
            return `<li class="${cls}">
  <a class="pa-box" href="${toggleHref}" title="Toggle checked">${box}</a>
  <span class="pa-text">${label}</span>
  <span class="pa-src">${src}</span>
  <a class="pa-dismiss" href="${dismissHref}" title="${dismissed ? "Undismiss" : "Dismiss"}">${dismissed ? "undo" : "dismiss"}</a>
</li>`;
          })
          .join("")}</ul>`;

  let actions = "";
  if (commandUris && sessionId) {
    const skipHref = cmdHref(PLAN_ASSUMPTION_COMMANDS.skip, [sessionId]);
    const clearSkipHref = cmdHref(PLAN_ASSUMPTION_COMMANDS.clearSkip, [sessionId]);
    const promoteHref = cmdHref(PLAN_ASSUMPTION_COMMANDS.promoteToKp, [sessionId]);
    const startHref = cmdHref(PLAN_ASSUMPTION_COMMANDS.startBuild, [sessionId]);
    const promoteTitle = gate.promoteToKpEnabled
      ? "Copy ## Constraints for KP"
      : (gate.blockedReason ?? "Resolve assumptions first");
    const startTitle = gate.startBuildEnabled
      ? "Continue this session in Code Build"
      : (gate.blockedReason ?? "Resolve assumptions first");
    // Gated actions render as inert <span> (no href) so a blocked click cannot
    // fire the command; handlers still re-check the gate as a second line.
    const startBtn = gate.startBuildEnabled
      ? `<a class="pa-btn pa-primary" href="${startHref}" title="${escapeCardHtml(startTitle)}">Start build in CB</a>`
      : `<span class="pa-btn pa-primary pa-disabled" title="${escapeCardHtml(startTitle)}">Start build in CB</span>`;
    const promoteBtn = gate.promoteToKpEnabled
      ? `<a class="pa-btn" href="${promoteHref}" title="${escapeCardHtml(promoteTitle)}">Promote to KP constraints</a>`
      : `<span class="pa-btn pa-disabled" title="${escapeCardHtml(promoteTitle)}">Promote to KP constraints</span>`;
    actions = `<div class="pa-actions">
  ${startBtn}
  ${promoteBtn}
  <a class="pa-btn" href="${skipHref}" title="Skip remaining unchecked with a reason">Skip with reason…</a>
  ${
    checklist.skipReason
      ? `<a class="pa-btn" href="${clearSkipHref}" title="Clear skip reason">Clear skip</a>`
      : ""
  }
</div>`;
  }

  const skipLine = checklist.skipReason
    ? `<div class="pa-skip">Skipped: ${escapeCardHtml(checklist.skipReason)}</div>`
    : "";
  const blockLine = gate.blockedReason
    ? `<div class="pa-block">${escapeCardHtml(gate.blockedReason)}</div>`
    : "";

  return `<section class="pa-card" data-schema="${escapeCardHtml(ASSUMPTION_CARD_SCHEMA)}">
  <div class="pa-head"><span class="pa-title">Plan assumptions${n ? ` (${n})` : ""}</span><span class="pa-count">${gate.startBuildEnabled ? "gate open" : "gate blocked"}</span></div>
  <div class="pa-sub">${escapeCardHtml(checklist.headline)}</div>
  <div class="pa-detail">${escapeCardHtml(checklist.detail)}</div>
  ${itemsHtml}
  ${skipLine}
  ${blockLine}
  ${actions}
</section>`;
}

/**
 * Convenience: build checklist from a flat assistant/user string array
 * (fixtures that do not carry role metadata). Alternates assistant/user
 * starting with assistant when roles are omitted.
 */
export function turnsFromTexts(
  texts: string[],
  opts?: { role?: string; phase?: string | null },
): PlanTurn[] {
  const role = opts?.role ?? "assistant";
  const phase = opts?.phase ?? "plan";
  return texts.map((content) => ({ role, content, phase }));
}
