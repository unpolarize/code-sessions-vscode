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
  evaluateEffortDrift,
  fingerprintOf,
  renderEffortDriftCardHtml,
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
});
