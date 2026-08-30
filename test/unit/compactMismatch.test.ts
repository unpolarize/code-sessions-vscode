// Unit fixtures for the UI%-vs-autocompact mismatch card (pure module).
// Acceptance from KP ideas/csv-ui-vs-autocompact-trigger-mismatch-card-mete:
//   - card when compact preTokens / declared window ≫ UI-reported pct (± ε)
//   - shows backend, window class, UI%, preTokens, trigger, false-OOC flag
//   - fixture from Claude Code #90406-shaped numbers (UI ~24%, compact ~999k @ 1M)
//   - degrades gracefully when window-class / usage fields are missing
//   - observational only (no vendor compact rewrite)

import { describe, it, expect } from "vitest";
import {
  DEFAULT_EPSILON,
  MISMATCH_CARD_SCHEMA,
  buildMismatchPrimer,
  evaluateCompactMismatch,
  extractCompactBoundaries,
  renderMismatchCardMarkdown,
  windowClassOf,
} from "../../src/compactMismatch";

/** Claude Code #90406-shaped transcript slice. */
const ISSUE_90406_EVENTS: unknown[] = [
  { type: "user", content: "keep going" },
  {
    type: "system",
    subtype: "compact_boundary",
    compactMetadata: { trigger: "auto", preTokens: 999_000 },
  },
  {
    type: "user",
    isCompactSummary: true,
    content:
      "This session is being continued from a previous conversation that ran out of context.",
  },
  { type: "assistant", content: "…" },
];

describe("extractCompactBoundaries", () => {
  it("parses Claude JSONL compact_boundary with metadata and attaches the OOC summary", () => {
    const boundaries = extractCompactBoundaries(ISSUE_90406_EVENTS);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].eventIndex).toBe(1);
    expect(boundaries[0].preTokens).toBe(999_000);
    expect(boundaries[0].trigger).toBe("auto");
    expect(boundaries[0].claimsOutOfContext).toBe(true);
  });

  it("accepts snake_case pre_tokens and generic compaction markers", () => {
    const boundaries = extractCompactBoundaries([
      { type: "compaction", pre_tokens: "not-a-number" },
      { type: "system", subtype: "compact_boundary", compactMetadata: { pre_tokens: 150000 } },
    ]);
    expect(boundaries).toHaveLength(2);
    expect(boundaries[0].preTokens).toBeNull();
    expect(boundaries[1].preTokens).toBe(150000);
  });

  it("keeps an orphan OOC summary as its own boundary", () => {
    const boundaries = extractCompactBoundaries([
      { type: "user", isCompactSummary: true, content: "the context window was full" },
    ]);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].claimsOutOfContext).toBe(true);
    expect(boundaries[0].preTokens).toBeNull();
  });

  it("ignores unrelated events and nulls", () => {
    expect(extractCompactBoundaries([null, "x", { type: "assistant" }, 42])).toHaveLength(0);
  });
});

describe("evaluateCompactMismatch — #90406 fixture", () => {
  const card = evaluateCompactMismatch({
    source: "claude",
    model: "claude-sonnet-4-5 [1m]",
    declaredWindowTokens: 1_000_000,
    uiReportedFill: 0.24,
    boundaries: extractCompactBoundaries(ISSUE_90406_EVENTS),
  });

  it("flags a mismatch: UI ~24% vs auto-compact at ~999k of 1M", () => {
    expect(card.level).toBe("mismatch");
    expect(card.impliedFillAtCompact).toBeCloseTo(0.999, 3);
    expect(card.disagreement).toBeGreaterThan(DEFAULT_EPSILON);
  });

  it("surfaces window class, trigger, and the false-OOC flag", () => {
    expect(card.windowClass).toBe("1m");
    expect(card.boundary?.trigger).toBe("auto");
    expect(card.falseOutOfContext).toBe(true);
  });

  it("card and primer render the load-bearing numbers", () => {
    const md = renderMismatchCardMarkdown(card);
    expect(md).toContain("999,000");
    expect(md).toContain("24%");
    expect(md).toContain("1m");
    expect(md).toContain('False "out of context" | yes');
    const primer = buildMismatchPrimer(card);
    expect(primer).toContain(MISMATCH_CARD_SCHEMA);
    expect(primer).toContain("pre_tokens: 999000");
    expect(primer).toContain("false_out_of_context: true");
  });

  it("keeps the boundary index for open-at-boundary one-click", () => {
    expect(card.boundary?.eventIndex).toBe(1);
  });
});

describe("evaluateCompactMismatch — agreement and degradation", () => {
  it("agreeing meter and trigger → ok", () => {
    const card = evaluateCompactMismatch({
      source: "claude",
      declaredWindowTokens: 200_000,
      uiReportedFill: 0.92,
      boundaries: [
        { eventIndex: 3, preTokens: 190_000, trigger: "auto", claimsOutOfContext: true },
      ],
    });
    expect(card.level).toBe("ok");
    // OOC claim at 92% displayed fill is plausible, not flagged false.
    expect(card.falseOutOfContext).toBe(false);
  });

  it("missing window class degrades to insufficient_data, not a throw", () => {
    const card = evaluateCompactMismatch({
      source: "codex",
      uiReportedFill: 0.3,
      boundaries: [{ eventIndex: 0, preTokens: 100_000, trigger: null, claimsOutOfContext: false }],
    });
    expect(card.level).toBe("insufficient_data");
    expect(card.missing).toContain("declaredWindowTokens");
    expect(() => renderMismatchCardMarkdown(card)).not.toThrow();
  });

  it("no compact boundaries → insufficient_data with missing listed", () => {
    const card = evaluateCompactMismatch({
      source: "grok",
      declaredWindowTokens: 128_000,
      uiReportedFill: 0.5,
      boundaries: [],
    });
    expect(card.level).toBe("insufficient_data");
    expect(card.missing).toContain("compact boundaries");
  });

  it("boundaries without preTokens cannot reach a verdict", () => {
    const card = evaluateCompactMismatch({
      source: "claude",
      declaredWindowTokens: 1_000_000,
      uiReportedFill: 0.24,
      boundaries: [{ eventIndex: 2, preTokens: null, trigger: "auto", claimsOutOfContext: false }],
    });
    expect(card.level).toBe("insufficient_data");
    expect(card.missing).toContain("boundary preTokens");
  });

  it("picks the worst-disagreement boundary across multiple compacts", () => {
    const card = evaluateCompactMismatch({
      source: "claude",
      declaredWindowTokens: 1_000_000,
      uiReportedFill: 0.24,
      boundaries: [
        { eventIndex: 1, preTokens: 260_000, trigger: "auto", claimsOutOfContext: false },
        { eventIndex: 9, preTokens: 999_000, trigger: "auto", claimsOutOfContext: false },
      ],
    });
    expect(card.boundary?.eventIndex).toBe(9);
    expect(card.level).toBe("mismatch");
  });
});

describe("windowClassOf", () => {
  it("maps near-1M and near-200k to class chips", () => {
    expect(windowClassOf(1_000_000)).toBe("1m");
    expect(windowClassOf(200_000)).toBe("200k");
    expect(windowClassOf(190_000)).toBe("200k");
  });
  it("returns null for unknown or missing sizes", () => {
    expect(windowClassOf(42)).toBeNull();
    expect(windowClassOf(null)).toBeNull();
    expect(windowClassOf(0)).toBeNull();
  });
});
