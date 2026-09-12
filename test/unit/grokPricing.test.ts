import { afterEach, describe, expect, it } from "vitest";
import {
  GROK_API_PRICES,
  estimateGrokCostUsd,
  grokCostStampPresent,
  grokRatesForModel,
  grokUsageFromBlob,
  mergeGrokPriceTable,
  setGrokPriceOverrides,
  splitGrokPromptTokens,
} from "../../src/grokPricing";

afterEach(() => setGrokPriceOverrides(null));

describe("grokRatesForModel", () => {
  it("looks up grok-4.6 and grok-4.5 prefixes", () => {
    expect(grokRatesForModel("grok-4.6-build").key).toBe("grok-4.6");
    expect(grokRatesForModel("grok-4.6-build").rates).toEqual(GROK_API_PRICES["grok-4.6"]);
    expect(grokRatesForModel("grok-4.5").key).toBe("grok-4.5");
    expect(grokRatesForModel("grok-4.5").rates.cacheRead).toBe(0.3);
  });

  it("unknown / missing model falls back to grok-4.6, not $0", () => {
    expect(grokRatesForModel(null).key).toBe("grok-4.6");
    expect(grokRatesForModel("").key).toBe("grok-4.6");
    expect(grokRatesForModel("mystery-model").key).toBe("grok-4.6");
    expect(grokRatesForModel("grok-code-fast").rates).toEqual(GROK_API_PRICES["grok-4.6"]);
  });
});

describe("splitGrokPromptTokens", () => {
  it("treats usage.json inputTokens as full prompt (cache ⊆ input)", () => {
    expect(splitGrokPromptTokens(1000, 200)).toEqual({ uncached: 800, cacheRead: 200 });
    expect(splitGrokPromptTokens(100, 200)).toEqual({ uncached: 0, cacheRead: 200 });
  });
});

describe("estimateGrokCostUsd", () => {
  it("missing tokens → $0", () => {
    expect(
      estimateGrokCostUsd({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(0);
  });

  it("grok-4.6 list-price math (exclusive buckets)", () => {
    // 800 uncached × $2 + 50 out × $6 + 200 cache-read × $0.50 + 10 cache-write × $2.50
    // = 1600 + 300 + 100 + 25 = 2025 / 1e6 = 0.002025 → 0.0020
    expect(
      estimateGrokCostUsd(
        { inputTokens: 800, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 10 },
        "grok-4.6",
      ),
    ).toBe(0.002);
  });

  it("unknown model uses grok-4.6 rates (nonzero)", () => {
    const cost = estimateGrokCostUsd(
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      "not-a-real-model",
    );
    expect(cost).toBe(2);
  });

  it("mergeGrokPriceTable override changes lookup", () => {
    const table = mergeGrokPriceTable({ "grok-4.6": { input: 10, output: 20 } });
    expect(
      estimateGrokCostUsd(
        { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
        "grok-4.6",
        table,
      ),
    ).toBe(30);
  });

  it("day-group aggregate is the sum of session estimates (no double count)", () => {
    const a = estimateGrokCostUsd(
      { inputTokens: 500_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      "grok-4.6",
    );
    const b = estimateGrokCostUsd(
      { inputTokens: 0, outputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      "grok-4.5",
    );
    expect(a).toBe(1);
    expect(b).toBe(3);
    expect(Number((a + b).toFixed(4))).toBe(4);
  });
});

describe("grokUsageFromBlob", () => {
  it("reads session totals and splits cache out of input", () => {
    const parsed = grokUsageFromBlob({
      session: {
        inputTokens: 1000,
        outputTokens: 40,
        cachedReadTokens: 200,
        cacheCreationTokens: 5,
        reasoningTokens: 12,
        primaryModelId: "grok-4.6-build",
      },
    });
    expect(parsed).toEqual({
      usage: { inputTokens: 800, outputTokens: 40, cacheReadTokens: 200, cacheWriteTokens: 5 },
      reasoningTokens: 12,
      model: "grok-4.6-build",
    });
  });

  it("missing token fields → null", () => {
    expect(grokUsageFromBlob({})).toBeNull();
    expect(grokUsageFromBlob(null)).toBeNull();
  });
});

describe("grokCostStampPresent", () => {
  it("detects the extras stamp used for one-shot reindex", () => {
    expect(grokCostStampPresent(null)).toBe(false);
    expect(grokCostStampPresent("{}")).toBe(false);
    expect(grokCostStampPresent(JSON.stringify({ cost_token_source: "usage.json" }))).toBe(true);
  });
});
