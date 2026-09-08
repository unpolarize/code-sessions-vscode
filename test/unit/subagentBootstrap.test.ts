// Fixture tests for the subagent bootstrap-vs-useful waterfall card
// (KP ideas/csv-subagent-bootstrap-vs-useful-waterfall-card).

import { describe, it, expect } from "vitest";
import {
  computeSubagentBootstrap,
  renderSubagentBootstrapSectionHtml,
  SUBAGENT_BOOTSTRAP_SCHEMA,
  type BootstrapSessionInput,
  type FirstTurnUsage,
} from "../../src/subagentBootstrap";

const parent: BootstrapSessionInput = {
  session_id: "parent-1",
  source: "claude",
  kind: "session",
  title: "Night IMPLEMENT — fan out review agents",
  input_tokens: 50_000,
  output_tokens: 20_000,
};

/** Claude Agent-tool child with per-turn usage available. */
function claudeChild(n: number, total: number, messages: number): BootstrapSessionInput {
  return {
    session_id: `agent-claude-${n}`,
    source: "claude",
    kind: "subagent",
    parent_session_id: "parent-1",
    title: `review:dimension-${n}`,
    message_count: messages,
    input_tokens: total * 0.3,
    output_tokens: total * 0.1,
    cache_read_tokens: total * 0.4,
    cache_write_tokens: total * 0.2,
  };
}

/** Codex subagent-shaped child — no per-turn usage in the index. */
function codexChild(n: number, total: number): BootstrapSessionInput {
  return {
    session_id: `agent-codex-${n}`,
    source: "codex",
    kind: "subagent",
    parent_session_id: "parent-1",
    title: `codex worker ${n}`,
    message_count: 6,
    input_tokens: total * 0.7,
    output_tokens: total * 0.3,
  };
}

describe("computeSubagentBootstrap", () => {
  it("measures bootstrap from first-turn usage when available (Claude Agent-tool children)", () => {
    const firstTurn = new Map<string, FirstTurnUsage>([
      // 18K of context bought before the first output token.
      ["agent-claude-1", { input_tokens: 3_000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 15_000 }],
      ["agent-claude-2", { input_tokens: 3_000, output_tokens: 400, cache_read_tokens: 0, cache_write_tokens: 15_000 }],
    ]);
    const card = computeSubagentBootstrap(
      [parent, claudeChild(1, 100_000, 20), claudeChild(2, 40_000, 8)],
      { firstTurnUsage: firstTurn },
    );

    expect(card.families).toHaveLength(1);
    const fam = card.families[0];
    expect(fam.parentLabel).toContain("Night IMPLEMENT");
    expect(fam.children).toHaveLength(2);
    // Children sort by total desc.
    const [big, small] = fam.children;
    expect(big.sessionId).toBe("agent-claude-1");
    expect(big.basis).toBe("measured");
    expect(big.bootstrapTokens).toBe(18_000); // first-turn input + cache, output excluded
    expect(big.usefulTokens).toBe(big.totalTokens - 18_000);
    expect(big.bootstrapShare).toBeCloseTo(0.18, 2);
    // Same fixed cost, smaller total → higher share.
    expect(small.bootstrapShare).toBeCloseTo(0.45, 2);
    expect(fam.bootstrapHeavy).toBe(false);
  });

  it("falls back to sibling-min for backends without per-turn usage", () => {
    const card = computeSubagentBootstrap([parent, codexChild(1, 90_000), codexChild(2, 30_000)]);
    const fam = card.families[0];
    const [big, small] = fam.children;
    expect(big.basis).toBe("sibling-min");
    // Cheapest sibling's total (30K) stands in for fixed bootstrap.
    expect(big.bootstrapTokens).toBe(30_000);
    expect(big.bootstrapShare).toBeCloseTo(1 / 3, 3);
    // The cheapest child is by construction all bootstrap.
    expect(small.bootstrapTokens).toBe(small.totalTokens);
    expect(small.usefulTokens).toBe(0);
  });

  it("warns when the median child bootstrap share exceeds the threshold", () => {
    // Mixed Claude + Codex fan-out: every child pays ~ its whole budget booting.
    const firstTurn = new Map<string, FirstTurnUsage>([
      ["agent-claude-1", { input_tokens: 2_000, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 16_000 }],
      ["agent-claude-2", { input_tokens: 2_000, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 16_000 }],
    ]);
    const card = computeSubagentBootstrap(
      [parent, claudeChild(1, 22_000, 3), claudeChild(2, 20_000, 2), codexChild(1, 31_000), codexChild(2, 30_000)],
      { firstTurnUsage: firstTurn },
    );
    const fam = card.families[0];
    expect(fam.medianBootstrapShare).toBeGreaterThan(0.5);
    expect(fam.bootstrapHeavy).toBe(true);
    expect(fam.backends).toEqual(["claude", "codex"]);
  });

  it("ignores single-child parents and orphan children", () => {
    const orphan = { ...codexChild(1, 10_000), parent_session_id: null };
    const solo = { ...claudeChild(1, 10_000, 4), parent_session_id: "parent-solo" };
    const card = computeSubagentBootstrap([parent, orphan, solo]);
    expect(card.families).toHaveLength(0);
    expect(card.childSessions).toBe(1); // solo counted, orphan dropped
  });
});

describe("renderSubagentBootstrapSectionHtml", () => {
  it("renders per-child waterfall rows with the warn chip and marks estimates", () => {
    const firstTurn = new Map<string, FirstTurnUsage>([
      ["agent-claude-1", { input_tokens: 2_000, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 16_000 }],
      ["agent-claude-2", { input_tokens: 2_000, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 16_000 }],
    ]);
    const card = computeSubagentBootstrap(
      [parent, claudeChild(1, 22_000, 3), claudeChild(2, 20_000, 2), codexChild(1, 31_000), codexChild(2, 30_000)],
      { firstTurnUsage: firstTurn },
    );
    const html = renderSubagentBootstrapSectionHtml(card);
    expect(html).toContain(SUBAGENT_BOOTSTRAP_SCHEMA);
    expect(html).toContain("review:dimension-1");
    expect(html).toContain("sbw-boot"); // bootstrap bar segment
    expect(html).toContain("bootstrap-heavy fan-out");
    expect(html).toContain("~"); // estimated codex figures marked approximate
    expect(html).not.toContain("<script");
  });

  it("renders empty string when there are no fan-out families", () => {
    expect(renderSubagentBootstrapSectionHtml(computeSubagentBootstrap([parent]))).toBe("");
  });
});
