// Fixtures for the context-switch tax aggregator (pure module, no webview).
// Acceptance from KP ideas/csv-toxic-flow-context-switch-tax-meter-count-hu:
//   - count focus transitions between multi-backend session views
//   - debounce <300ms flickers
//   - today's switch_count + estimated tax_minutes (23 s/switch, overridable)

import { describe, it, expect } from "vitest";
import {
  aggregateSwitchTax,
  SwitchTaxRecorder,
  DEFAULT_TAX_SECONDS_PER_SWITCH,
  type FocusEvent,
} from "../../src/switchTax";

const T0 = new Date("2026-09-05T09:00:00").getTime();
const ev = (sessionId: string, offsetMs: number, backend = "claude"): FocusEvent => ({
  sessionId,
  backend,
  ts: T0 + offsetMs,
});

describe("aggregateSwitchTax", () => {
  it("returns zeros for no events", () => {
    expect(aggregateSwitchTax([])).toEqual({ switchCount: 0, medianDwellS: null, taxMinutes: 0 });
  });

  it("single session focused repeatedly is zero switches", () => {
    const events = [ev("a", 0), ev("a", 10_000), ev("a", 60_000)];
    const s = aggregateSwitchTax(events);
    expect(s.switchCount).toBe(0);
    expect(s.taxMinutes).toBe(0);
  });

  it("counts transitions across backends and prices them at the default rate", () => {
    const events = [
      ev("a", 0, "claude"),
      ev("b", 60_000, "codex"),
      ev("c", 120_000, "grok"),
      ev("a", 200_000, "claude"),
    ];
    const s = aggregateSwitchTax(events);
    expect(s.switchCount).toBe(3);
    expect(s.taxMinutes).toBeCloseTo((3 * DEFAULT_TAX_SECONDS_PER_SWITCH) / 60, 5);
  });

  it("drops sub-debounce flickers: A→B(120ms)→A is zero switches", () => {
    const events = [ev("a", 0), ev("b", 30_000), ev("a", 30_120)];
    const s = aggregateSwitchTax(events);
    expect(s.switchCount).toBe(0);
  });

  it("a dwell exactly at the debounce threshold is kept", () => {
    const events = [ev("a", 0), ev("b", 30_000), ev("a", 30_300)];
    const s = aggregateSwitchTax(events);
    expect(s.switchCount).toBe(2);
  });

  it("computes median dwell over closed segments only", () => {
    // a: 60s, b: 120s, c: open-ended (excluded from dwell median)
    const events = [ev("a", 0), ev("b", 60_000), ev("c", 180_000)];
    const s = aggregateSwitchTax(events);
    expect(s.switchCount).toBe(2);
    expect(s.medianDwellS).toBeCloseTo(90, 5);
  });

  it("respects since/until window (yesterday's events excluded)", () => {
    const events = [ev("a", -3600_000), ev("b", -3500_000), ev("a", 0), ev("b", 60_000)];
    const s = aggregateSwitchTax(events, { since: T0, until: T0 + 3600_000 });
    expect(s.switchCount).toBe(1);
  });

  it("closes the final dwell against until and debounces it", () => {
    // Final segment b lives only 100ms before `until` — flicker, dropped.
    const events = [ev("a", 0), ev("b", 60_000)];
    const s = aggregateSwitchTax(events, { until: T0 + 60_100 });
    expect(s.switchCount).toBe(0);
  });

  it("honours a taxSecondsPerSwitch override", () => {
    const events = [ev("a", 0), ev("b", 60_000)];
    const s = aggregateSwitchTax(events, { taxSecondsPerSwitch: 60 });
    expect(s.taxMinutes).toBeCloseTo(1, 5);
  });

  it("collapses unsorted / interleaved same-session events", () => {
    const events = [ev("b", 60_000), ev("a", 0), ev("a", 30_000), ev("b", 90_000)];
    const s = aggregateSwitchTax(events);
    expect(s.switchCount).toBe(1);
  });
});

describe("SwitchTaxRecorder", () => {
  it("dedupes rapid same-session records but keeps later refocuses", () => {
    const r = new SwitchTaxRecorder();
    r.record("a", "claude", T0);
    r.record("a", "claude", T0 + 100); // dropped: same session inside debounce
    r.record("b", "codex", T0 + 60_000);
    r.record("a", "claude", T0 + 120_000); // kept: real return to a
    expect(r.eventsSnapshot()).toHaveLength(3);
    const s = r.summarizeToday(T0 + 180_000);
    expect(s.switchCount).toBe(2);
  });

  it("summarizeToday only counts events since local midnight", () => {
    const r = new SwitchTaxRecorder();
    const yesterday = T0 - 20 * 3600_000;
    r.record("a", "claude", yesterday);
    r.record("b", "codex", yesterday + 60_000);
    r.record("a", "claude", T0);
    r.record("b", "codex", T0 + 60_000);
    const s = r.summarizeToday(T0 + 120_000);
    expect(s.switchCount).toBe(1);
  });

  it("ignores empty session ids and clears", () => {
    const r = new SwitchTaxRecorder();
    r.record("", "claude", T0);
    r.record("a", "claude", T0);
    expect(r.eventsSnapshot()).toHaveLength(1);
    r.clear();
    expect(r.eventsSnapshot()).toHaveLength(0);
  });

  it("prunes events older than the 48h retention window", () => {
    const r = new SwitchTaxRecorder();
    r.record("a", "claude", T0 - 49 * 3600_000);
    r.record("b", "codex", T0);
    expect(r.eventsSnapshot().map((e) => e.sessionId)).toEqual(["b"]);
  });
});
