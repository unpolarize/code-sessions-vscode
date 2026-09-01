import { describe, expect, it } from "vitest";
import {
  BOOT_INDEX_CLAUDE_MS,
  BOOT_INDEX_GROK_MS,
  BOOT_STORE_SYNC_MS,
  claudeOnlyIndexOpts,
  grokCatchupIndexOpts,
  periodicIndexOpts,
  scheduleUntilRun,
} from "../../src/bootIndex";

describe("boot index schedule", () => {
  it("does not index on the 0 ms turn (races cb.deserialize)", () => {
    expect(BOOT_INDEX_CLAUDE_MS).toBeGreaterThanOrEqual(2_000);
    expect(BOOT_INDEX_GROK_MS).toBeGreaterThanOrEqual(90_000);
    expect(BOOT_INDEX_GROK_MS).toBeGreaterThan(BOOT_INDEX_CLAUDE_MS);
    expect(BOOT_STORE_SYNC_MS).toBeGreaterThan(BOOT_INDEX_CLAUDE_MS);
  });

  it("first pass is Claude-only (no grok/git wasm)", () => {
    expect(claudeOnlyIndexOpts()).toEqual({
      includeGit: false,
      includeClaude: true,
      includeGrok: false,
      includeCodex: false,
    });
  });

  it("grok catch-up is not the first pass and skips git", () => {
    expect(grokCatchupIndexOpts().includeGrok).toBe(true);
    expect(grokCatchupIndexOpts().includeGit).toBe(false);
    expect(grokCatchupIndexOpts().includeClaude).toBe(false);
  });

  it("periodic timer never runs full grok", () => {
    expect(periodicIndexOpts().includeGrok).toBe(false);
    expect(periodicIndexOpts().includeGit).toBe(false);
  });

  it("catch-up retries until the gated pass actually runs", () => {
    // Regression: the 120 s grok catch-up was dropped by the 15 s coalesce
    // gap (a Claude turn-complete pass had just finished) and never retried,
    // so historic grok sessions never reached the tree after a reload.
    const timers: Array<{ ms: number; fn: () => void }> = [];
    const setTimer = (fn: () => void, ms: number) => {
      timers.push({ ms, fn });
      return timers.length;
    };
    let attempts = 0;
    const ran = scheduleUntilRun(() => (attempts += 1) >= 3, [100, 200, 300, 400], setTimer);
    expect(timers.map((x) => x.ms)).toEqual([100]);
    timers[0].fn(); // attempt 1: gated → re-arm
    expect(timers.map((x) => x.ms)).toEqual([100, 200]);
    timers[1].fn(); // attempt 2: gated → re-arm
    timers[2].fn(); // attempt 3: runs → stop
    expect(timers.length).toBe(3);
    expect(attempts).toBe(3);
    expect(ran.attempts()).toBe(3);
  });

  it("catch-up gives up after the delay list is exhausted", () => {
    const timers: Array<() => void> = [];
    let attempts = 0;
    scheduleUntilRun(() => { attempts += 1; return false; }, [1, 2], (fn) => { timers.push(fn); return timers.length; });
    timers[0]();
    timers[1]();
    expect(timers.length).toBe(2);
    expect(attempts).toBe(2);
  });
});
