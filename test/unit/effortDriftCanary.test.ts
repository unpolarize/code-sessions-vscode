// Unit fixtures for the effort-semantics drift canary (pure module, no webview).
// Acceptance from KP ideas/csv-vendor-effort-semantics-drift-canary-detect:
//   - rolling per-(backend, model, effort) median baseline
//   - card on fingerprint divergence vs 7-day baseline (Fable high→low collapse)
//   - cold-start suppression until baseline sample size met
//   - no false alarm on intentional model upgrades (key includes model id)
//   - advisory only (autoSwitch always false)

import { describe, it, expect } from "vitest";
import {
  EFFORT_DRIFT_SCHEMA,
  PIN_SEMANTICS_COMMAND,
  buildBaselines,
  detectEffortDrift,
  detectEffortDriftFromSessions,
  effortFromExtras,
  effortLookupFromCodeBuildIndex,
  evaluateEffortDrift,
  fingerprintOf,
  formatPinnedSemanticsNote,
  observationFromSession,
  observationsFromSessions,
  renderEffortDriftCardHtml,
  renderEffortDriftSectionHtml,
  splitHistoryAndToday,
  type EffortObservation,
} from "../../src/effortDriftCanary";

const NOW = Date.UTC(2026, 8, 7, 6, 0, 0); // 2026-09-07T06:00Z
const DAY = 24 * 60 * 60 * 1000;

/** A healthy "high" session: ~2000 tokens/turn, ~3 tool calls/turn, ~40s/turn. */
function highSession(daysAgo: number, i = 0): EffortObservation {
  return {
    backend: "claude",
    model: "claude-fable-5",
    effort: "high",
    endedAt: NOW - daysAgo * DAY,
    turns: 10,
    outputTokens: 20000 + i * 500,
    toolCalls: 30 + i,
    wallMs: 400_000 + i * 10_000,
    sessionId: `base-${daysAgo}-${i}`,
  };
}

/** The Fable remap: "high" silently behaving like old "low". */
function collapsedSession(i = 0): EffortObservation {
  return {
    backend: "claude",
    model: "claude-fable-5",
    effort: "high",
    endedAt: NOW - 2 * 60 * 60 * 1000,
    turns: 10,
    outputTokens: 3000 + i * 100, // ~0.15x baseline
    toolCalls: 8, // ~0.27x baseline
    wallMs: 90_000, // ~0.22x baseline
    sessionId: `today-${i}`,
  };
}

// Days 1.5–6.5: strictly inside (now - 7d, now - 1d), off the window edges.
const BASELINE_WEEK = [1.5, 2.5, 3.5, 4.5, 5.5, 6.5].map((d, i) => highSession(d, i));

describe("fingerprintOf", () => {
  it("computes per-turn medians", () => {
    const fp = fingerprintOf(BASELINE_WEEK);
    expect(fp.samples).toBe(6);
    expect(fp.tokensPerTurn).toBeGreaterThan(1900);
    expect(fp.tokensPerTurn).toBeLessThan(2200);
    expect(fp.toolCallsPerTurn).toBeCloseTo(3.25, 1);
  });

  it("skips sessions with zero/invalid turns and missing metrics stay null", () => {
    const fp = fingerprintOf([
      { ...highSession(1), turns: 0 },
      {
        backend: "claude",
        model: "claude-fable-5",
        effort: "high",
        endedAt: NOW,
        turns: 4,
        toolCalls: 8,
      },
    ]);
    expect(fp.samples).toBe(1);
    expect(fp.tokensPerTurn).toBeNull();
    expect(fp.toolCallsPerTurn).toBe(2);
  });
});

describe("buildBaselines", () => {
  it("groups by backend+model+effort inside the window, excluding today", () => {
    const history = [
      ...BASELINE_WEEK,
      collapsedSession(), // today — must not dilute the baseline
      { ...highSession(9) }, // outside 7-day window
      { ...highSession(3), effort: "low", outputTokens: 3000 },
    ];
    const baselines = buildBaselines(history, { now: NOW });
    const high = baselines.find((b) => b.effort === "high")!;
    expect(high.fingerprint.samples).toBe(6);
    expect(baselines.find((b) => b.effort === "low")!.fingerprint.samples).toBe(1);
  });
});

describe("evaluateEffortDrift — Fable high→low semantic collapse", () => {
  it("fires a drift card when all metrics collapse vs baseline", () => {
    const cards = detectEffortDrift(BASELINE_WEEK, [collapsedSession()], { now: NOW });
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.level).toBe("drift");
    expect(card.headline).toContain("lower effort tier");
    expect(card.metrics.filter((m) => m.drifted)).toHaveLength(3);
    expect(card.autoSwitch).toBe(false);
    expect(card.sampleSessionIds).toContain("today-0");
  });

  it("stays silent when today matches the baseline", () => {
    const cards = detectEffortDrift(BASELINE_WEEK, [{ ...highSession(0), endedAt: NOW }], {
      now: NOW,
    });
    expect(cards).toHaveLength(0);
  });

  it("cold start: suppressed until minBaselineSamples sessions exist", () => {
    const thin = BASELINE_WEEK.slice(0, 3); // < default 5
    expect(detectEffortDrift(thin, [collapsedSession()], { now: NOW })).toHaveLength(0);
    expect(
      detectEffortDrift(thin, [collapsedSession()], { now: NOW, minBaselineSamples: 3 }),
    ).toHaveLength(1);
  });

  it("no false alarm on intentional model upgrade (different model id)", () => {
    const upgraded = { ...collapsedSession(), model: "claude-fable-6" };
    expect(detectEffortDrift(BASELINE_WEEK, [upgraded], { now: NOW })).toHaveLength(0);
  });

  it("watch level when only one metric drifts", () => {
    const partial: EffortObservation = {
      ...highSession(0),
      endedAt: NOW,
      outputTokens: 3000, // collapsed
      toolCalls: 30, // normal
      wallMs: 400_000, // normal
      sessionId: "today-partial",
    };
    const cards = detectEffortDrift(BASELINE_WEEK, [partial], { now: NOW });
    expect(cards).toHaveLength(1);
    expect(cards[0].level).toBe("watch");
  });

  it("inflate direction is labeled as higher effort tier", () => {
    const inflated: EffortObservation = {
      ...highSession(0),
      endedAt: NOW,
      outputTokens: 100_000,
      toolCalls: 120,
      wallMs: 1_600_000,
    };
    const cards = detectEffortDrift(BASELINE_WEEK, [inflated], { now: NOW });
    expect(cards[0].headline).toContain("higher effort tier");
  });

  it("respects minTodaySamples", () => {
    const cards = evaluateEffortDrift(
      [collapsedSession()],
      buildBaselines(BASELINE_WEEK, { now: NOW }),
      { now: NOW, minTodaySamples: 2 },
    );
    expect(cards).toHaveLength(0);
  });
});

describe("renderEffortDriftCardHtml", () => {
  it("renders schema, level, drifted rows and pin action on fixture divergence", () => {
    const [card] = detectEffortDrift(BASELINE_WEEK, [collapsedSession()], { now: NOW });
    const html = renderEffortDriftCardHtml(card, {
      openSessionCommand: "codeSessions.openSession",
    });
    expect(html).toContain(`data-schema="${EFFORT_DRIFT_SCHEMA}"`);
    expect(html).toContain('data-level="drift"');
    expect(html).toContain("edc-drifted");
    expect(html).toContain(`command:${PIN_SEMANTICS_COMMAND}`);
    expect(html).toContain("command:codeSessions.openSession");
  });

  it("omits command: links when commandUris is false", () => {
    const [card] = detectEffortDrift(BASELINE_WEEK, [collapsedSession()], { now: NOW });
    const html = renderEffortDriftCardHtml(card, { commandUris: false });
    expect(html).not.toContain("command:");
  });

  it("escapes html in vendor-controlled strings", () => {
    const evil = [collapsedSession()].map((s) => ({ ...s, model: '<img src=x onerror="1">' }));
    const history = BASELINE_WEEK.map((s) => ({ ...s, model: '<img src=x onerror="1">' }));
    const [card] = detectEffortDrift(history, evil, { now: NOW });
    const html = renderEffortDriftCardHtml(card, { commandUris: false });
    expect(html).not.toContain('<img src=x onerror="1">');
  });

  it("section helper joins cards + disclaimer, empty when nothing drifted", () => {
    expect(renderEffortDriftSectionHtml([])).toBe("");
    const [card] = detectEffortDrift(BASELINE_WEEK, [collapsedSession()], { now: NOW });
    const html = renderEffortDriftSectionHtml([card], { openSessionCommand: "codeSessions.openSession" });
    expect(html).toContain("edc-card");
    expect(html).toContain("edc-disclaimer");
    expect(html).toContain("Advisory only");
  });
});

describe("session → observation adapter (host wiring)", () => {
  it("reads effort from extras_json and derives turns/wall from row fields", () => {
    const obs = observationFromSession({
      session_id: "sess-1",
      source: "claude",
      model: "claude-fable-5",
      message_count: 20,
      tool_count: 30,
      output_tokens: 20000,
      started_at: NOW - 400_000,
      ended_at: NOW,
      kind: "session",
      extras_json: JSON.stringify({ effort: "high" }),
    });
    expect(obs).toMatchObject({
      backend: "claude",
      model: "claude-fable-5",
      effort: "high",
      turns: 10,
      toolCalls: 30,
      outputTokens: 20000,
      wallMs: 400_000,
      sessionId: "sess-1",
    });
  });

  it("falls back to Code Build effort lookup by backendSessionId", () => {
    const lookup = effortLookupFromCodeBuildIndex([
      {
        backendSessionId: "cb-linked",
        effort: "High",
        backendSessionHistory: [{ id: "older-id" }],
      },
    ]);
    expect(lookup.get("cb-linked")).toBe("high");
    expect(lookup.get("older-id")).toBe("high");
    const obs = observationFromSession(
      {
        session_id: "cb-linked",
        source: "claude",
        model: "claude-fable-5",
        message_count: 10,
        tool_count: 5,
        output_tokens: 5000,
        ended_at: NOW,
        kind: "session",
      },
      lookup,
    );
    expect(obs?.effort).toBe("high");
  });

  it("skips default/missing effort, synthetic models, and child kinds", () => {
    expect(
      observationFromSession({
        session_id: "a",
        source: "claude",
        model: "claude-fable-5",
        message_count: 10,
        ended_at: NOW,
        extras_json: JSON.stringify({ effort: "default" }),
      }),
    ).toBeNull();
    expect(
      observationFromSession({
        session_id: "b",
        source: "claude",
        model: "<synthetic>",
        message_count: 10,
        ended_at: NOW,
        effort: "high",
      }),
    ).toBeNull();
    expect(
      observationFromSession({
        session_id: "c",
        source: "claude",
        model: "claude-fable-5",
        message_count: 10,
        ended_at: NOW,
        effort: "high",
        kind: "subagent",
      }),
    ).toBeNull();
  });

  it("effortFromExtras accepts reasoningEffort aliases", () => {
    expect(effortFromExtras({ reasoning_effort: "xhigh" })).toBe("xhigh");
    expect(effortFromExtras('{"effortLabel":"Medium"}')).toBe("medium");
    expect(effortFromExtras("{")).toBeNull();
  });

  it("detectEffortDriftFromSessions end-to-end with session rows + CB lookup", () => {
    const lookup = new Map([["today-0", "high"]]);
    const historyRows = BASELINE_WEEK.map((o, i) => ({
      session_id: o.sessionId,
      source: o.backend,
      model: o.model,
      message_count: o.turns * 2,
      tool_count: o.toolCalls,
      output_tokens: o.outputTokens,
      started_at: o.endedAt - (o.wallMs ?? 0),
      ended_at: o.endedAt,
      kind: "session",
      effort: o.effort,
    }));
    const todayRow = {
      session_id: "today-0",
      source: "claude",
      model: "claude-fable-5",
      message_count: 20,
      tool_count: 8,
      output_tokens: 3000,
      started_at: NOW - 90_000,
      ended_at: NOW - 2 * 60 * 60 * 1000,
      kind: "session",
    };
    const cards = detectEffortDriftFromSessions([...historyRows, todayRow], {
      now: NOW,
      effortBySessionId: lookup,
    });
    expect(cards[0]?.level).toBe("drift");
    expect(formatPinnedSemanticsNote(cards[0]!)).toContain("Effort semantics pin");
  });

  it("splitHistoryAndToday cuts at 24h", () => {
    const { history, today } = splitHistoryAndToday(
      [...BASELINE_WEEK, collapsedSession()],
      NOW,
    );
    expect(today).toHaveLength(1);
    expect(history).toHaveLength(BASELINE_WEEK.length);
  });

  it("observationsFromSessions drops rows the adapter rejects", () => {
    expect(
      observationsFromSessions([
        { session_id: "x", source: "claude", model: "m", message_count: 2, ended_at: NOW },
      ]),
    ).toHaveLength(0);
  });
});
