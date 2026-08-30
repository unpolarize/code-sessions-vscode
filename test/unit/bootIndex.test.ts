import { describe, expect, it } from "vitest";
import {
  BOOT_INDEX_CLAUDE_MS,
  BOOT_INDEX_GROK_MS,
  BOOT_STORE_SYNC_MS,
  claudeOnlyIndexOpts,
  grokCatchupIndexOpts,
  periodicIndexOpts,
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
});
