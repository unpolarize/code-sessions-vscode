// Fixture tests for the fork-cache inheritance bleed detector card
// (KP ideas/csv-fork-cache-inheritance-bleed-detector-card-w).
// #57751-shaped: child cache_read ~150K vs ~2K Agent brief.

import { describe, it, expect } from "vitest";
import {
  computeForkCacheBleed,
  renderForkCacheBleedSectionHtml,
  FORK_CACHE_BLEED_SCHEMA,
  DEFAULT_CACHE_TO_BRIEF_RATIO,
  estimateBriefTokensFromText,
  textLooksLikePlanRefuse,
  textLooksLikePlanPhase,
  type ForkBleedSessionInput,
  type ForkBleedFirstTurnUsage,
} from "../../src/forkCacheBleed";

const parent: ForkBleedSessionInput = {
  session_id: "parent-plan-1",
  source: "claude",
  kind: "session",
  title: "Plan mode: explore fork-cache bleed before edits",
  first_user_msg: "/plan investigate subagent cache inheritance",
};

/** #57751-shaped Claude Agent-tool child. */
function bleedChild(overrides: Partial<ForkBleedSessionInput> = {}): ForkBleedSessionInput {
  return {
    session_id: "agent-bleed-1",
    source: "claude",
    kind: "subagent",
    parent_session_id: "parent-plan-1",
    title: "Explore: map cache inheritance",
    // ~2K-token brief ≈ 8000 chars
    first_user_msg: "x".repeat(8000),
    input_tokens: 2_000,
    output_tokens: 500,
    cache_read_tokens: 154_445,
    cache_write_tokens: 1_200,
    ...overrides,
  };
}

function healthyChild(): ForkBleedSessionInput {
  return {
    session_id: "agent-ok-1",
    source: "claude",
    kind: "subagent",
    parent_session_id: "parent-plan-1",
    title: "Explore: small scoped brief",
    first_user_msg: "Check whether src/foo.ts exports bar.",
    input_tokens: 1_800,
    output_tokens: 400,
    cache_read_tokens: 2_100,
    cache_write_tokens: 900,
  };
}

describe("helpers", () => {
  it("estimates brief tokens from text at ~4 chars/token", () => {
    expect(estimateBriefTokensFromText("abcd")).toBe(1);
    expect(estimateBriefTokensFromText("x".repeat(8000))).toBe(2000);
    expect(estimateBriefTokensFromText("")).toBe(0);
  });

  it("detects plan-mode refuse and parent plan-phase phrases", () => {
    expect(textLooksLikePlanRefuse("You MUST NOT make edits until the plan is approved.")).toBe(true);
    expect(textLooksLikePlanRefuse("Implement the feature in src/foo.ts")).toBe(false);
    expect(textLooksLikePlanPhase("/plan investigate inheritance")).toBe(true);
    expect(textLooksLikePlanPhase("ship the patch tonight")).toBe(false);
  });
});

describe("computeForkCacheBleed", () => {
  it("flags a #57751-shaped child when cache_read / brief ≥ 20× (first-turn usage)", () => {
    const firstTurn = new Map<string, ForkBleedFirstTurnUsage>([
      [
        "agent-bleed-1",
        {
          input_tokens: 2_048,
          output_tokens: 120,
          cache_read_tokens: 154_445,
          cache_write_tokens: 800,
        },
      ],
    ]);
    const card = computeForkCacheBleed([parent, bleedChild()], { firstTurnUsage: firstTurn });
    expect(card.ratioThreshold).toBe(DEFAULT_CACHE_TO_BRIEF_RATIO);
    expect(card.hits).toHaveLength(1);
    const hit = card.hits[0];
    expect(hit.sessionId).toBe("agent-bleed-1");
    expect(hit.cacheReadTokens).toBe(154_445);
    expect(hit.briefTokens).toBe(2_048);
    expect(hit.ratio).toBeGreaterThan(70);
    expect(hit.reasons).toContain("cache_ratio");
    expect(hit.cacheBasis).toBe("first-turn");
    expect(hit.briefBasis).toBe("first-turn-input");
  });

  it("falls back to session cache_read + session input brief when no turn usage", () => {
    const card = computeForkCacheBleed([parent, bleedChild()]);
    expect(card.hits).toHaveLength(1);
    const hit = card.hits[0];
    expect(hit.cacheBasis).toBe("session");
    expect(hit.briefBasis).toBe("session-input");
    expect(hit.briefTokens).toBe(2000);
    expect(hit.ratio).toBeCloseTo(154_445 / 2000, 0);
    expect(hit.reasons).toContain("cache_ratio");
  });

  it("falls back to first_user_msg chars/4 when session input is absent", () => {
    const child = bleedChild({ input_tokens: 0, first_user_msg: "x".repeat(8000) });
    const card = computeForkCacheBleed([parent, child]);
    expect(card.hits).toHaveLength(1);
    expect(card.hits[0].briefBasis).toBe("first_user_msg");
    expect(card.hits[0].briefTokens).toBe(2000);
  });

  it("stays silent for a healthy child (cache_read ≈ brief)", () => {
    const firstTurn = new Map<string, ForkBleedFirstTurnUsage>([
      [
        "agent-ok-1",
        {
          input_tokens: 1_800,
          output_tokens: 200,
          cache_read_tokens: 2_100,
          cache_write_tokens: 500,
        },
      ],
    ]);
    const card = computeForkCacheBleed([parent, healthyChild()], { firstTurnUsage: firstTurn });
    expect(card.hits).toHaveLength(0);
  });

  it("flags plan-mode refuse in the child while the parent was in plan", () => {
    const child = bleedChild({
      session_id: "agent-refuse-1",
      cache_read_tokens: 0,
      input_tokens: 500,
      first_user_msg: "short brief",
    });
    const card = computeForkCacheBleed([parent, child], {
      childText: new Map([
        [
          "agent-refuse-1",
          "System: You are in plan mode. You MUST NOT make edits. Explore only.",
        ],
      ]),
    });
    expect(card.hits).toHaveLength(1);
    expect(card.hits[0].reasons).toEqual(["plan_refuse"]);
  });

  it("does not flag plan refuse when the parent was not in plan", () => {
    const nonPlanParent: ForkBleedSessionInput = {
      session_id: "parent-build-1",
      source: "claude",
      kind: "session",
      title: "IMPLEMENT: land the patch",
      first_user_msg: "Ship the fix on auto/night-build",
    };
    const child = bleedChild({
      session_id: "agent-refuse-2",
      parent_session_id: "parent-build-1",
      cache_read_tokens: 0,
      input_tokens: 400,
      first_user_msg: "short",
    });
    const card = computeForkCacheBleed([nonPlanParent, child], {
      childText: new Map([
        ["agent-refuse-2", "You MUST NOT make edits — plan mode reminder."],
      ]),
    });
    expect(card.hits).toHaveLength(0);
  });

  it("skips non-Claude children (Claude-first; no false alarms)", () => {
    const codex: ForkBleedSessionInput = {
      ...bleedChild({ session_id: "agent-codex-1", source: "codex" }),
    };
    const card = computeForkCacheBleed([parent, codex]);
    expect(card.childSessions).toBe(1);
    expect(card.hits).toHaveLength(0);
  });

  it("degrades gracefully when usage blocks are absent", () => {
    const silent: ForkBleedSessionInput = {
      session_id: "agent-silent-1",
      source: "claude",
      kind: "subagent",
      parent_session_id: "parent-plan-1",
      title: "no usage yet",
      first_user_msg: null,
      cache_read_tokens: 0,
    };
    const card = computeForkCacheBleed([parent, silent]);
    expect(card.hits).toHaveLength(0);
  });
});

describe("renderForkCacheBleedSectionHtml", () => {
  it("renders warn rows with schema, 20× help text, and openSession deep links", () => {
    const firstTurn = new Map<string, ForkBleedFirstTurnUsage>([
      [
        "agent-bleed-1",
        {
          input_tokens: 2_048,
          output_tokens: 120,
          cache_read_tokens: 154_445,
          cache_write_tokens: 800,
        },
      ],
    ]);
    const card = computeForkCacheBleed([parent, bleedChild()], { firstTurnUsage: firstTurn });
    const html = renderForkCacheBleedSectionHtml(card);
    expect(html).toContain(FORK_CACHE_BLEED_SCHEMA);
    expect(html).toContain("Fork-cache inheritance bleed");
    expect(html).toContain("bleed risk");
    expect(html).toContain(`${DEFAULT_CACHE_TO_BRIEF_RATIO}×`);
    expect(html).toContain(`cache_read / brief ≥ ${DEFAULT_CACHE_TO_BRIEF_RATIO}`);
    expect(html).toContain("command:codeSessions.openSession?");
    expect(html).toContain("Explore: map cache inheritance");
    expect(html).toContain("cache ≫ brief");
    expect(html).toContain("never auto-kill");
    expect(html).not.toContain("<script");
  });

  it("renders empty string when there are no hits", () => {
    expect(
      renderForkCacheBleedSectionHtml(computeForkCacheBleed([parent, healthyChild()])),
    ).toBe("");
  });
});
