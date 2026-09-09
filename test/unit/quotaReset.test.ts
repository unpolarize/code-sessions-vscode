// Acceptance (kp: ideas/csv-cross-vendor-quota-reset-wall-clock-chip-cla):
// - Chip lists next reset timestamps per backend (Claude session; Codex
//   windows + banked when present); Cursor omitted until telemetry exists.
// - "Next workable window" = earliest reset among backends currently exhausted.
// - Fixture from sample usage JSON; graceful omit when a backend has no
//   reset signal (never invent times).
import { describe, it, expect } from "vitest";
import {
  extractCodexQuotaSignals,
  extractClaudeQuotaSignals,
  buildQuotaResetCard,
  formatQuotaResetChip,
  fmtWallClock,
} from "../../src/quotaReset";

const T0 = Date.parse("2026-09-08T04:00:00.000Z");
const HOUR = 3_600_000;

// Real Codex rollout shape (see ~/.codex/sessions rollouts): event_msg /
// token_count with rate_limits.{primary,secondary,credits}.
function codexLine(overrides: {
  usedPct?: number;
  resetsAtSec?: number;
  secondary?: { used_percent: number; window_minutes: number; resets_at: number } | null;
  credits?: unknown;
  reached?: string | null;
  ts?: string;
}): string {
  return JSON.stringify({
    timestamp: overrides.ts ?? new Date(T0).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { total_tokens: 100 } },
      rate_limits: {
        limit_id: "codex",
        primary: {
          used_percent: overrides.usedPct ?? 42.0,
          window_minutes: 300,
          resets_at: overrides.resetsAtSec ?? Math.floor((T0 + 2 * HOUR) / 1000),
        },
        secondary: overrides.secondary ?? null,
        credits: overrides.credits ?? null,
        rate_limit_reached_type: overrides.reached ?? null,
      },
    },
  });
}

// Claude Code 5h-cap marker: pipe-delimited reset epoch inside the message.
const claudeLimitLine = (epochSec: number) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: `Claude AI usage limit reached|${epochSec}` }] },
  });

describe("extractCodexQuotaSignals", () => {
  it("parses primary + secondary windows and banked credits from the tail", () => {
    const tail = [
      '{"type":"event_msg","payload":{"type":"agent_message"}}',
      codexLine({
        usedPct: 100,
        secondary: {
          used_percent: 61,
          window_minutes: 7 * 24 * 60,
          resets_at: Math.floor((T0 + 30 * HOUR) / 1000),
        },
        credits: { has_credits: true, unlimited: false, balance: 250 },
        reached: "primary",
      }),
      "{broken json",
    ].join("\n");
    const sigs = extractCodexQuotaSignals(tail);
    expect(sigs.map((s) => s.label)).toEqual(["5h", "7d", "banked"]);
    expect(sigs[0].exhausted).toBe(true);
    expect(sigs[0].resetAt).toBe(T0 + 2 * HOUR);
    expect(sigs[1].exhausted).toBe(false);
    expect(sigs[1].usedPct).toBe(61);
    expect(sigs[2].resetAt).toBeNull();
    expect(sigs[2].detail).toBe("balance 250");
  });

  it("uses the most recent rate_limits event in the tail", () => {
    const tail = [
      codexLine({ usedPct: 10, ts: new Date(T0 - HOUR).toISOString() }),
      codexLine({ usedPct: 95 }),
    ].join("\n");
    const sigs = extractCodexQuotaSignals(tail);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].usedPct).toBe(95);
  });

  it("returns [] when no rate_limits event is visible (graceful omit)", () => {
    expect(extractCodexQuotaSignals("")).toEqual([]);
    expect(extractCodexQuotaSignals('{"type":"event_msg","payload":{"type":"token_count"}}')).toEqual([]);
  });
});

describe("extractClaudeQuotaSignals", () => {
  it("parses the pipe-delimited reset epoch (seconds) as an exhausted 5h window", () => {
    const resetSec = Math.floor((T0 + 3 * HOUR) / 1000);
    const sigs = extractClaudeQuotaSignals(claudeLimitLine(resetSec), T0);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({
      backend: "claude",
      label: "5h",
      resetAt: resetSec * 1000,
      exhausted: true,
      observedAt: T0,
    });
  });

  it("returns [] on a tail without the marker (graceful omit)", () => {
    expect(extractClaudeQuotaSignals('{"type":"assistant"}', T0)).toEqual([]);
  });
});

describe("buildQuotaResetCard", () => {
  const sig = (backend: string, label: string, resetAt: number | null, exhausted: boolean, observedAt = T0) => ({
    backend,
    label,
    resetAt,
    usedPct: null,
    exhausted,
    observedAt,
  });

  it("next workable window = earliest reset among exhausted backends", () => {
    const card = buildQuotaResetCard(
      [
        sig("claude", "5h", T0 + 3 * HOUR, true),
        sig("codex", "5h", T0 + 2 * HOUR, true),
        sig("codex", "7d", T0 + 30 * HOUR, false),
      ],
      T0,
    );
    expect(card).not.toBeNull();
    expect(card!.nextWorkableAt).toBe(T0 + 2 * HOUR);
    // Rows sorted soonest-first.
    expect(card!.rows.map((r) => `${r.backend} ${r.label}`)).toEqual([
      "codex 5h",
      "claude 5h",
      "codex 7d",
    ]);
  });

  it("nothing exhausted → nextWorkableAt null (workable now)", () => {
    const card = buildQuotaResetCard([sig("codex", "5h", T0 + HOUR, false)], T0);
    expect(card!.nextWorkableAt).toBeNull();
  });

  it("no signals at all → null card (chip omitted entirely)", () => {
    expect(buildQuotaResetCard([], T0)).toBeNull();
  });

  it("drops stale rows whose reset already passed", () => {
    const card = buildQuotaResetCard([sig("claude", "5h", T0 - HOUR, true)], T0);
    expect(card).toBeNull();
  });

  it("dedupes to the latest observation per backend+window", () => {
    const card = buildQuotaResetCard(
      [
        sig("codex", "5h", T0 + HOUR, true, T0 - HOUR),
        sig("codex", "5h", T0 + 2 * HOUR, false, T0),
      ],
      T0,
    );
    expect(card!.rows).toHaveLength(1);
    expect(card!.rows[0].resetAt).toBe(T0 + 2 * HOUR);
    expect(card!.nextWorkableAt).toBeNull();
  });

  it("clock-less rows (banked credits) sort last and never drive the window", () => {
    const card = buildQuotaResetCard(
      [sig("codex", "banked", null, false), sig("claude", "5h", T0 + HOUR, true)],
      T0,
    );
    expect(card!.rows.map((r) => r.label)).toEqual(["5h", "banked"]);
    expect(card!.nextWorkableAt).toBe(T0 + HOUR);
  });
});

describe("formatQuotaResetChip", () => {
  it("renders ≥2 backend rows with wall-clock times and the multi-subscription intent tooltip", () => {
    const claudeReset = T0 + 3 * HOUR;
    const codexReset = T0 + 2 * HOUR;
    const card = buildQuotaResetCard(
      [
        {
          backend: "claude",
          label: "5h",
          resetAt: claudeReset,
          usedPct: 100,
          exhausted: true,
          observedAt: T0,
        },
        {
          backend: "codex",
          label: "5h",
          resetAt: codexReset,
          usedPct: 87,
          exhausted: false,
          observedAt: T0,
        },
      ],
      T0,
    );
    const chip = formatQuotaResetChip(card, T0)!;
    expect(chip.value).toBe(`⏳ ${fmtWallClock(claudeReset, T0)}`);
    expect(chip.title).toContain(`claude 5h — resets ${fmtWallClock(claudeReset, T0)} · 100% · exhausted`);
    expect(chip.title).toContain(`codex 5h — resets ${fmtWallClock(codexReset, T0)} · 87%`);
    expect(chip.title).toContain("When can I work next across all subscriptions");
  });

  it('shows "open" when signals exist but nothing is exhausted', () => {
    const card = buildQuotaResetCard(
      [{ backend: "codex", label: "5h", resetAt: T0 + HOUR, usedPct: 12, exhausted: false, observedAt: T0 }],
      T0,
    );
    expect(formatQuotaResetChip(card, T0)!.value).toBe("open");
  });

  it("passes the null card through (omit)", () => {
    expect(formatQuotaResetChip(null, T0)).toBeNull();
  });
});

describe("fmtWallClock", () => {
  it("prefixes the weekday when the reset is not today", () => {
    expect(fmtWallClock(T0 + 26 * HOUR, T0)).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2}$/);
    expect(fmtWallClock(T0 + 1000, T0)).toMatch(/^\d{2}:\d{2}$/);
  });
});
