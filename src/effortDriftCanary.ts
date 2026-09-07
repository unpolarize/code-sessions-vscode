// Vendor effort-semantics drift canary — pure core (no vscode / no db).
//
// Motivating case (Aug 2026): Claude Fable after 2.1.237 silently remapped the
// effort label "high" to the old "low" class — declared effort was unchanged,
// so the effort pin chip stayed green while sessions behaved "dumb". The only
// tell is behavioral: tokens/turn, tool-calls/turn and wall-time/turn for the
// same backend+model+label collapsed versus the rolling baseline.
//
// This module fingerprints label→behavior per (backend, model, effort label),
// maintains a rolling median baseline from historical session aggregates, and
// emits an advisory card when today's fingerprint diverges. Advisory only in
// v1 — never auto-switches models. Distinct from the effort pin chip (declared
// effort display) and the vendor quality-regression canary (forgetful loops).
//
// Guards (from KP acceptance):
// - cold start: suppressed until the baseline has >= minBaselineSamples sessions
// - no false alarms on intentional upgrades: the grouping key includes the
//   exact model id, so a model change never compares against the old baseline

export const EFFORT_DRIFT_SCHEMA = "code-sessions/effort-drift-canary@1";

/** Command id a host may register for the one-click "pin expected semantics" note. */
export const PIN_SEMANTICS_COMMAND = "codeSessions.effortDrift.pinSemantics";

export type DriftLevel = "ok" | "watch" | "drift";

/** One session's aggregate observation (from indexer rows / extras / fixtures). */
export interface EffortObservation {
  backend: string;
  /** Exact vendor model id, e.g. "claude-fable-5". */
  model: string;
  /** Declared effort label, e.g. "high" | "medium" | "low". */
  effort: string;
  /** Session end (or last activity) in ms since epoch. */
  endedAt: number;
  /** Assistant turns in the session (must be > 0 to contribute). */
  turns: number;
  /** Total output tokens across the session (reasoning-inclusive when known). */
  outputTokens?: number | null;
  /** Total tool calls across the session. */
  toolCalls?: number | null;
  /** Total wall time in ms across the session. */
  wallMs?: number | null;
  sessionId?: string | null;
}

/** Per-turn behavioral fingerprint (medians over sessions). Null = no data. */
export interface EffortFingerprint {
  tokensPerTurn: number | null;
  toolCallsPerTurn: number | null;
  wallMsPerTurn: number | null;
  /** Sessions that contributed at least one metric. */
  samples: number;
}

export interface EffortKey {
  backend: string;
  model: string;
  effort: string;
}

export interface EffortBaseline extends EffortKey {
  fingerprint: EffortFingerprint;
  windowDays: number;
}

export interface DriftMetric {
  name: "tokensPerTurn" | "toolCallsPerTurn" | "wallMsPerTurn";
  baseline: number;
  today: number;
  /** today / baseline. */
  ratio: number;
  drifted: boolean;
}

export interface EffortDriftCard extends EffortKey {
  level: DriftLevel;
  headline: string;
  detail: string;
  metrics: DriftMetric[];
  baselineSamples: number;
  todaySamples: number;
  /** Session ids behind today's fingerprint, for deep links. */
  sampleSessionIds: string[];
  /** Always false in v1 — advisory card only. */
  autoSwitch: false;
}

export interface EffortDriftOptions {
  /** Rolling baseline window in days (default 7). */
  windowDays?: number;
  /** Cold-start guard: baseline sessions required per key (default 5). */
  minBaselineSamples?: number;
  /** Today's sessions required per key before evaluating (default 1). */
  minTodaySamples?: number;
  /**
   * A metric drifts when its ratio leaves [1 - tolerance, 1 / (1 - tolerance)].
   * Default 0.5 → fires below 0.5x or above 2x baseline.
   */
  tolerance?: number;
  /** "now" in ms since epoch (default Date.now()) — injectable for tests. */
  now?: number;
}

const DEFAULT_OPTIONS: Required<Omit<EffortDriftOptions, "now">> = {
  windowDays: 7,
  minBaselineSamples: 5,
  minTodaySamples: 1,
  tolerance: 0.5,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function asPosNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function keyOf(k: EffortKey): string {
  return `${k.backend}\u0000${k.model}\u0000${k.effort}`;
}

/** Per-turn rates for one session, or null when turns is unusable. */
function ratesOf(obs: EffortObservation): {
  tokensPerTurn: number | null;
  toolCallsPerTurn: number | null;
  wallMsPerTurn: number | null;
} | null {
  const turns = asPosNum(obs.turns);
  if (turns == null || turns <= 0) return null;
  const tokens = asPosNum(obs.outputTokens);
  const tools = asPosNum(obs.toolCalls);
  const wall = asPosNum(obs.wallMs);
  return {
    tokensPerTurn: tokens == null ? null : tokens / turns,
    toolCallsPerTurn: tools == null ? null : tools / turns,
    wallMsPerTurn: wall == null ? null : wall / turns,
  };
}

/** Median fingerprint over a set of observations (all assumed same key). */
export function fingerprintOf(observations: EffortObservation[]): EffortFingerprint {
  const tokens: number[] = [];
  const tools: number[] = [];
  const wall: number[] = [];
  let samples = 0;
  for (const obs of observations) {
    const r = ratesOf(obs);
    if (!r) continue;
    let contributed = false;
    if (r.tokensPerTurn != null) {
      tokens.push(r.tokensPerTurn);
      contributed = true;
    }
    if (r.toolCallsPerTurn != null) {
      tools.push(r.toolCallsPerTurn);
      contributed = true;
    }
    if (r.wallMsPerTurn != null) {
      wall.push(r.wallMsPerTurn);
      contributed = true;
    }
    if (contributed) samples++;
  }
  return {
    tokensPerTurn: median(tokens),
    toolCallsPerTurn: median(tools),
    wallMsPerTurn: median(wall),
    samples,
  };
}

function groupByKey(observations: EffortObservation[]): Map<string, EffortObservation[]> {
  const groups = new Map<string, EffortObservation[]>();
  for (const obs of observations) {
    if (!obs.backend || !obs.model || !obs.effort) continue;
    const k = keyOf(obs);
    const list = groups.get(k);
    if (list) list.push(obs);
    else groups.set(k, [obs]);
  }
  return groups;
}

/**
 * Rolling baselines per (backend, model, effort) from historical observations.
 * Only sessions inside [now - windowDays, todayStart) contribute — today's
 * sessions must not dilute the baseline they are compared against.
 */
export function buildBaselines(
  history: EffortObservation[],
  opts?: EffortDriftOptions,
): EffortBaseline[] {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const now = opts?.now ?? Date.now();
  const todayStart = now - DAY_MS;
  const windowStart = now - o.windowDays * DAY_MS;
  const inWindow = history.filter(
    (obs) => obs.endedAt >= windowStart && obs.endedAt < todayStart,
  );
  const out: EffortBaseline[] = [];
  for (const group of groupByKey(inWindow).values()) {
    const { backend, model, effort } = group[0];
    out.push({
      backend,
      model,
      effort,
      fingerprint: fingerprintOf(group),
      windowDays: o.windowDays,
    });
  }
  return out;
}

function driftDirection(metrics: DriftMetric[]): "collapse" | "inflate" | "mixed" {
  const drifted = metrics.filter((m) => m.drifted);
  const down = drifted.filter((m) => m.ratio < 1).length;
  if (down === drifted.length) return "collapse";
  if (down === 0) return "inflate";
  return "mixed";
}

/**
 * Compare today's sessions against the rolling baseline; one card per
 * (backend, model, effort) key that has both a mature baseline and enough
 * sessions today. Level: "drift" when >= 2 metrics diverge, "watch" when 1.
 *
 * Caller contract: `today` must contain only the sessions under evaluation
 * (last ~24h) — this function does not time-filter, and buildBaselines
 * excludes the last 24h so the same bag never lands on both sides.
 */
export function evaluateEffortDrift(
  today: EffortObservation[],
  baselines: EffortBaseline[],
  opts?: EffortDriftOptions,
): EffortDriftCard[] {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const tolerance = Math.min(0.95, Math.max(0.05, o.tolerance));
  const low = 1 - tolerance;
  const high = 1 / low;
  const baselineByKey = new Map(baselines.map((b) => [keyOf(b), b]));
  const cards: EffortDriftCard[] = [];

  for (const group of groupByKey(today).values()) {
    const { backend, model, effort } = group[0];
    const baseline = baselineByKey.get(keyOf(group[0]));
    // Cold start / intentional model change: no mature baseline for this exact
    // (backend, model, effort) → stay silent.
    if (!baseline || baseline.fingerprint.samples < o.minBaselineSamples) continue;

    const todayFp = fingerprintOf(group);
    if (todayFp.samples < o.minTodaySamples) continue;

    const metrics: DriftMetric[] = [];
    const pairs = [
      ["tokensPerTurn", baseline.fingerprint.tokensPerTurn, todayFp.tokensPerTurn],
      ["toolCallsPerTurn", baseline.fingerprint.toolCallsPerTurn, todayFp.toolCallsPerTurn],
      ["wallMsPerTurn", baseline.fingerprint.wallMsPerTurn, todayFp.wallMsPerTurn],
    ] as const;
    for (const [name, base, cur] of pairs) {
      if (base == null || cur == null || base <= 0) continue;
      const ratio = cur / base;
      metrics.push({
        name,
        baseline: base,
        today: cur,
        ratio,
        drifted: ratio < low || ratio > high,
      });
    }

    const driftedCount = metrics.filter((m) => m.drifted).length;
    if (driftedCount === 0) continue;

    const level: DriftLevel = driftedCount >= 2 ? "drift" : "watch";
    const direction = driftDirection(metrics);
    const headline =
      direction === "collapse"
        ? `"${effort}" on ${model} is behaving like a lower effort tier`
        : direction === "inflate"
          ? `"${effort}" on ${model} is behaving like a higher effort tier`
          : `"${effort}" on ${model} no longer matches its ${baseline.windowDays}-day fingerprint`;
    const worst = metrics
      .filter((m) => m.drifted)
      .sort((a, b) => Math.abs(Math.log(a.ratio)) - Math.abs(Math.log(b.ratio)))
      .pop()!;
    const detail =
      `${backend}: ${worst.name} is ${worst.ratio.toFixed(2)}x the ` +
      `${baseline.windowDays}-day baseline (${driftedCount}/${metrics.length} metrics drifted, ` +
      `${baseline.fingerprint.samples} baseline / ${todayFp.samples} today sessions). ` +
      `Possible silent effort-label remap — verify before trusting "${effort}".`;

    cards.push({
      backend,
      model,
      effort,
      level,
      headline,
      detail,
      metrics,
      baselineSamples: baseline.fingerprint.samples,
      todaySamples: todayFp.samples,
      sampleSessionIds: group
        .map((g) => g.sessionId)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .slice(0, 5),
      autoSwitch: false,
    });
  }

  // Most severe first: drift before watch, then by worst log-ratio.
  const severity = (c: EffortDriftCard) =>
    Math.max(...c.metrics.filter((m) => m.drifted).map((m) => Math.abs(Math.log(m.ratio))), 0);
  return cards.sort((a, b) => {
    if (a.level !== b.level) return a.level === "drift" ? -1 : 1;
    return severity(b) - severity(a);
  });
}

/** One-shot convenience: baselines from history, then evaluate today. */
export function detectEffortDrift(
  history: EffortObservation[],
  today: EffortObservation[],
  opts?: EffortDriftOptions,
): EffortDriftCard[] {
  return evaluateEffortDrift(today, buildBaselines(history, opts), opts);
}

function escapeCardHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatMetric(name: DriftMetric["name"], v: number): string {
  if (name === "wallMsPerTurn") return `${(v / 1000).toFixed(1)}s`;
  return v >= 100 ? String(Math.round(v)) : v.toFixed(1);
}

const METRIC_LABELS: Record<DriftMetric["name"], string> = {
  tokensPerTurn: "tokens/turn",
  toolCallsPerTurn: "tool calls/turn",
  wallMsPerTurn: "wall time/turn",
};

export interface DriftCardHtmlOpts {
  /** Emit command: links (default true). Set false for restricted webviews. */
  commandUris?: boolean;
  /** command id that opens a session by id (for deep links). */
  openSessionCommand?: string;
}

export function renderEffortDriftCardHtml(
  card: EffortDriftCard,
  opts?: DriftCardHtmlOpts,
): string {
  if (card.level === "ok") return "";
  const levelClass = card.level === "drift" ? "edc-level edc-warn" : "edc-level edc-watch";

  const rows = card.metrics
    .map((m) => {
      const cls = m.drifted ? ' class="edc-drifted"' : "";
      return `<tr${cls}><th>${escapeCardHtml(METRIC_LABELS[m.name])}</th><td>${escapeCardHtml(
        formatMetric(m.name, m.baseline),
      )}</td><td>${escapeCardHtml(formatMetric(m.name, m.today))}</td><td>${escapeCardHtml(
        `${m.ratio.toFixed(2)}x`,
      )}</td></tr>`;
    })
    .join("");

  const commandUris = opts?.commandUris !== false;
  const links = commandUris
    ? card.sampleSessionIds
        .map((id) => {
          const href = opts?.openSessionCommand
            ? `command:${opts.openSessionCommand}?${encodeURIComponent(JSON.stringify([id]))}`
            : "";
          const short = escapeCardHtml(id.slice(0, 8));
          return href ? `<a class="edc-session" href="${href}">${short}</a>` : short;
        })
        .join(" ")
    : card.sampleSessionIds.map((id) => escapeCardHtml(id.slice(0, 8))).join(" ");

  const pin = commandUris
    ? `<div class="edc-actions"><a class="edc-btn" href="command:${PIN_SEMANTICS_COMMAND}?${encodeURIComponent(
        JSON.stringify([card.backend, card.model, card.effort]),
      )}" title="Record expected semantics for this label as a KP/doctor note">Pin expected semantics</a></div>`
    : "";

  return `<section class="edc-card" data-schema="${escapeCardHtml(EFFORT_DRIFT_SCHEMA)}" data-level="${escapeCardHtml(card.level)}">
  <div class="edc-head"><span class="edc-title">Effort drift canary</span><span class="${levelClass}">${escapeCardHtml(card.level)}</span></div>
  <div class="edc-sub">${escapeCardHtml(card.headline)}</div>
  <div class="edc-detail">${escapeCardHtml(card.detail)}</div>
  <table class="edc-table"><tr><th></th><th>baseline</th><th>today</th><th>ratio</th></tr>${rows}</table>
  ${links ? `<div class="edc-sessions">Sessions: ${links}</div>` : ""}
  ${pin}
</section>`;
}
