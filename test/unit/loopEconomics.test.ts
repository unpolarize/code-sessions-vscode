// Fixture tests for the multi-backend loop runaway economics card
// (KP ideas/csv-loop-runaway-economics-card-multi-backend-lo).

import { describe, it, expect } from "vitest";
import {
  computeLoopEconomics,
  normalizeLoopKey,
  renderLoopEconomicsSectionHtml,
  LOOP_KILL_COMMAND,
  LOOP_REBIND_COMMAND,
  LOOP_SOFT_STOP_COMMAND,
  type LoopSessionInput,
} from "../../src/loopEconomics";

const NOW = Date.parse("2026-09-07T06:00:00Z");
const HOUR = 3600_000;

function claudeLoopRun(n: number, tokens: number): LoopSessionInput {
  // Claude Loops-shaped usage: same recurring /loop job, tokens growing per
  // run as each tick re-buys context.
  return {
    session_id: `claude-loop-${n}`,
    source: "claude",
    kind: "session",
    title: `Night IMPLEMENT 2026-09-0${n} — autonomous build`,
    first_user_msg: "You are an autonomous overnight engineer. This is the implementation phase, scheduled",
    entrypoint: "sdk-cli",
    is_automated: true,
    message_count: 40 + n,
    input_tokens: tokens / 2,
    output_tokens: tokens / 2,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: tokens / 1e6,
    ended_at: NOW - n * 24 * HOUR,
  };
}

/** Non-Claude automation stub: Codex records no token usage. */
function codexAutomationRun(n: number): LoopSessionInput {
  return {
    session_id: `codex-auto-${n}`,
    source: "codex",
    kind: "session",
    title: `Automated hourly sync #${n}`,
    entrypoint: "cron",
    is_automated: false,
    message_count: 12,
    tokens_total: 0,
    cost_usd: 0,
    extras_json: JSON.stringify({ labels: ["cron"] }),
    ended_at: NOW - n * HOUR,
  };
}

const interactive: LoopSessionInput = {
  session_id: "human-1",
  source: "claude",
  kind: "session",
  title: "fix the flaky test in planning.ts",
  entrypoint: "claude-vscode",
  is_automated: false,
  message_count: 30,
  tokens_total: 9_000_000,
  cost_usd: 12,
  ended_at: NOW - HOUR,
};

const FIXTURE: LoopSessionInput[] = [
  claudeLoopRun(1, 4_000_000),
  claudeLoopRun(2, 2_000_000),
  claudeLoopRun(3, 1_000_000),
  codexAutomationRun(1),
  codexAutomationRun(2),
  interactive,
];

describe("normalizeLoopKey", () => {
  it("collapses per-run dates/times/counters so runs group", () => {
    const a = normalizeLoopKey("Night IMPLEMENT 2026-09-06 — autonomous build");
    const b = normalizeLoopKey("Night IMPLEMENT 2026-09-07 — autonomous build");
    expect(a).toBe(b);
    expect(normalizeLoopKey("run #12 at 03:15")).toBe(normalizeLoopKey("run #13 at 04:45"));
  });

  it("falls back to first_user_msg when title is empty", () => {
    expect(normalizeLoopKey("", "hourly digest run 4")).toBe("hourly digest run #");
  });
});

describe("computeLoopEconomics", () => {
  it("groups repeated automated runs and ranks token-bearing loops by tokens/run", () => {
    const card = computeLoopEconomics(FIXTURE, {});
    expect(card.groups.length).toBe(2);
    expect(card.automatedSessions).toBe(5); // interactive session excluded

    const [top, second] = card.groups;
    expect(top.backends).toEqual(["claude"]);
    expect(top.runs).toBe(3);
    expect(top.totalTokens).toBe(7_000_000);
    expect(top.tokensPerRun).toBeCloseTo(7_000_000 / 3);
    expect(top.tokensProxy).toBe(false);
    expect(top.sessionIds[0]).toBe("claude-loop-1"); // most recent run first

    // Codex automation stub: no tokens recorded → messages/run proxy, ranked
    // below any token-measured loop.
    expect(second.backends).toEqual(["codex"]);
    expect(second.runs).toBe(2);
    expect(second.tokensProxy).toBe(true);
    expect(second.messagesPerRun).toBe(12);
  });

  it("excludes interactive sessions and child transcripts", () => {
    const card = computeLoopEconomics([
      interactive,
      { ...claudeLoopRun(1, 1000), kind: "subagent" },
      { ...claudeLoopRun(2, 1000), kind: "subagent" },
    ]);
    expect(card.groups).toEqual([]);
    expect(card.automatedSessions).toBe(0);
  });

  it("drops single-run automated jobs unless schedule-labelled", () => {
    const oneOff = computeLoopEconomics([claudeLoopRun(1, 1000)]);
    expect(oneOff.groups).toEqual([]);

    const labelled = computeLoopEconomics([codexAutomationRun(1)]);
    expect(labelled.groups.length).toBe(1);
    expect(labelled.groups[0].runs).toBe(1);
  });
});

describe("renderLoopEconomicsSectionHtml", () => {
  it("renders the fixture's ≥2 loop-like groups with kill/rebind/soft-stop links", () => {
    const html = renderLoopEconomicsSectionHtml(computeLoopEconomics(FIXTURE), { now: NOW });
    expect(html).toContain("Loop runaway economics");
    expect(html).toContain(`command:${LOOP_KILL_COMMAND}?`);
    expect(html).toContain(`command:${LOOP_REBIND_COMMAND}?`);
    expect(html).toContain(`command:${LOOP_SOFT_STOP_COMMAND}?`);
    expect(html).toContain("claude");
    expect(html).toContain("codex");
    expect(html).toContain("~12 msgs"); // token-silent backend shows proxy
    // Kill link carries (label, sessionIds) args for the host command.
    const m = html.match(new RegExp(`command:${LOOP_KILL_COMMAND.replace(/\./g, "\\.")}\\?([^"]+)`));
    expect(m).toBeTruthy();
    const args = JSON.parse(decodeURIComponent(m![1]));
    expect(Array.isArray(args[1])).toBe(true);
    expect(args[1]).toContain("claude-loop-1");
  });

  it("renders nothing when no loop-shaped groups exist", () => {
    expect(renderLoopEconomicsSectionHtml(computeLoopEconomics([interactive]))).toBe("");
  });

  it("omits command links for restricted webviews", () => {
    const html = renderLoopEconomicsSectionHtml(computeLoopEconomics(FIXTURE), {
      commandUris: false,
      now: NOW,
    });
    expect(html).not.toContain("command:");
  });
});
