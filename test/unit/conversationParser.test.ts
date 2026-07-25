// Characterization tests for the Claude JSONL transcript parser.
// Fixtures live in test/fixtures/transcripts/claude/ — one fault per file,
// with an *.expected.json sidecar ({ records, errors[] }) documenting today's
// behavior. These lock current edge-case handling; they do not prescribe fixes.
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseConversation } from "../../src/conversationParser";

const FIX = path.resolve(__dirname, "../fixtures/transcripts/claude");

function fixture(rel: string): string {
  return path.join(FIX, rel);
}

function expected(rel: string): { records: number; errors: Array<{ line: number; kind: string }> } {
  const p = fixture(rel).replace(/\.jsonl$/, ".expected.json");
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

describe("parseConversation", () => {
  it("parses a valid multi-turn transcript with a tool call", () => {
    const rel = "valid/multi-turn-toolcall.jsonl";
    const parsed = parseConversation(fixture(rel));
    expect(parsed.turns.length, `${rel}: turn count`).toBe(expected(rel).records);
    expect(parsed.sessionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.title).toBe("Fixture: two turns with one tool call");

    const t0 = parsed.turns[0];
    expect(t0.userText).toBe("list the files in src");
    expect(t0.toolCalls.length).toBe(1);
    expect(t0.toolCalls[0].name).toBe("Bash");
    expect(t0.toolCalls[0].resultText).toBe("a.ts\nb.ts");
    expect(t0.toolCalls[0].resultIsError).toBe(false);
    expect(t0.toolCalls[0].durationMs).toBe(3000); // 10:00:02 → 10:00:05
    expect(t0.assistantText).toContain("two files");

    expect(parsed.summary.totalTurns).toBe(2);
    expect(parsed.summary.totalTools).toBe(1);
    expect(parsed.summary.toolCountsByName).toEqual({ Bash: 1 });
    // one gap: turn 0 ended 10:00:07, turn 1 user at 10:01:00 → 53s
    expect(parsed.summary.userThinkingMsList).toEqual([53000]);
    expect(parsed.startMs).toBe(Date.parse("2026-07-01T10:00:00.000Z"));
    expect(parsed.endMs).toBe(Date.parse("2026-07-01T10:01:03.000Z"));
  });

  it("skips a bad JSON line without poisoning subsequent good lines", () => {
    const rel = "malformed/bad-json-line.jsonl";
    const exp = expected(rel);
    const parsed = parseConversation(fixture(rel));
    expect(parsed.turns.length, `${rel}: line ${exp.errors[0].line} (${exp.errors[0].kind}) should be skipped`).toBe(exp.records);
    // the assistant line AFTER the garbage still attaches to the turn
    expect(parsed.turns[0].assistantText).toBe("hi");
  });

  it("returns zero turns for an empty file without throwing", () => {
    const rel = "malformed/empty-file.jsonl";
    const parsed = parseConversation(fixture(rel));
    expect(parsed.turns.length, `${rel}: empty input`).toBe(expected(rel).records);
    expect(parsed.summary.totalTurns).toBe(0);
    expect(parsed.startMs).toBeNull();
    expect(parsed.endMs).toBeNull();
  });

  it("tolerates a last line truncated mid-object", () => {
    const rel = "truncated/mid-object.jsonl";
    const exp = expected(rel);
    const parsed = parseConversation(fixture(rel));
    expect(parsed.turns.length, `${rel}: line ${exp.errors[0].line} (${exp.errors[0].kind})`).toBe(exp.records);
    expect(parsed.turns[0].userText).toBe("parse this");
    // the truncated assistant line contributes nothing
    expect(parsed.turns[0].assistantText).toBe("");
  });

  it("parses all records when the final newline is missing", () => {
    const rel = "truncated/missing-final-newline.jsonl";
    const parsed = parseConversation(fixture(rel));
    expect(parsed.turns.length, `${rel}`).toBe(expected(rel).records);
    expect(parsed.turns[0].assistantText).toBe("done");
  });
});
