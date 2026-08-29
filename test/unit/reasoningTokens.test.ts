import { describe, it, expect } from "vitest";
import {
  extractReasoningTokens,
  reasoningShare,
  formatReasoningShare,
} from "../../src/reasoningTokens";
import { parseCodexRollout, buildCodexRows } from "../../src/codexIndexer";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { SessionStore } from "../../src/db";

const FIX = path.resolve(__dirname, "../fixtures/transcripts/codex");

describe("extractReasoningTokens", () => {
  it("maps Codex reasoning_output_tokens", () => {
    expect(extractReasoningTokens({ reasoning_output_tokens: 9, output_tokens: 19 })).toBe(9);
  });

  it("maps Claude output_tokens_details.thinking_tokens", () => {
    expect(
      extractReasoningTokens({
        output_tokens: 100,
        output_tokens_details: { thinking_tokens: 40 },
      }),
    ).toBe(40);
  });

  it("maps OpenAI/xAI nested reasoning_tokens", () => {
    expect(
      extractReasoningTokens({
        completion_tokens_details: { reasoning_tokens: 12 },
      }),
    ).toBe(12);
    expect(
      extractReasoningTokens({
        output_tokens_details: { reasoning_tokens: 7 },
      }),
    ).toBe(7);
  });

  it("returns null when no known key is present (never invents 0)", () => {
    expect(extractReasoningTokens({ input_tokens: 1, output_tokens: 2 })).toBeNull();
    expect(extractReasoningTokens(null)).toBeNull();
    expect(extractReasoningTokens(undefined)).toBeNull();
  });

  it("preserves reported zero", () => {
    expect(extractReasoningTokens({ reasoning_output_tokens: 0 })).toBe(0);
  });
});

describe("reasoningShare / formatReasoningShare", () => {
  it("Codex 9/19 ≈ 47.4%", () => {
    expect(reasoningShare(9, 19)).toBeCloseTo(9 / 19, 6);
    expect(formatReasoningShare(9, 19)).toBe("47.4%");
  });

  it("NULL reasoning → n/a (not 0%)", () => {
    expect(reasoningShare(null, 19)).toBeNull();
    expect(formatReasoningShare(null, 19)).toBe("n/a");
  });

  it("output 0 → n/a", () => {
    expect(reasoningShare(0, 0)).toBeNull();
    expect(formatReasoningShare(5, 0)).toBe("n/a");
  });

  it("reasoning > output → n/a (guard)", () => {
    expect(reasoningShare(20, 19)).toBeNull();
    expect(formatReasoningShare(20, 19)).toBe("n/a");
  });

  it("reported zero with positive output → 0%", () => {
    expect(reasoningShare(0, 19)).toBe(0);
    expect(formatReasoningShare(0, 19)).toBe("0%");
  });
});

describe("Codex parser + store: reasoning_output_tokens", () => {
  it("parses fixture 9/19 into usage and session row", () => {
    const parsed = parseCodexRollout(path.join(FIX, "valid/reasoning-rollout.jsonl"));
    expect(parsed.usage).toEqual({
      input_tokens: 500,
      output_tokens: 19,
      cache_read_tokens: 100,
      reasoning_tokens: 9,
    });
    expect(reasoningShare(parsed.usage!.reasoning_tokens, parsed.usage!.output_tokens)).toBeCloseTo(
      9 / 19,
      6,
    );
  });

  it("basic rollout without reasoning keeps NULL (not 0)", () => {
    const parsed = parseCodexRollout(path.join(FIX, "valid/basic-rollout.jsonl"));
    expect(parsed.usage?.reasoning_tokens).toBeNull();
  });

  it("round-trips reasoning_tokens through SessionStore (v19 NULL default)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-reason-"));
    const store = SessionStore.open(dir);
    try {
      const info = {
        path: path.join(FIX, "valid/reasoning-rollout.jsonl"),
        fileUuid: "66666666-6666-4666-8666-666666666666",
        mtime_ns: 1,
        size_bytes: 100,
      };
      const rows = buildCodexRows(info);
      expect(rows).not.toBeNull();
      expect(rows!.session.reasoning_tokens).toBe(9);
      expect(rows!.session.output_tokens).toBe(19);
      store.upsertSession(rows!.session);
      store.upsertTurns(rows!.turns);
      const got = store.getById(rows!.session.session_id);
      expect(got!.reasoning_tokens).toBe(9);
      expect(formatReasoningShare(got!.reasoning_tokens, got!.output_tokens)).toBe("47.4%");

      // Pre-v19 semantics: a session upserted without the field stays NULL
      // after migrate — verify a row written with null stays null.
      store.upsertSession({
        ...rows!.session,
        session_id: "null-reason-sid",
        jsonl_path: rows!.session.jsonl_path + ".null-reason",
        reasoning_tokens: null,
      });
      expect(store.getById("null-reason-sid")!.reasoning_tokens).toBeNull();
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
