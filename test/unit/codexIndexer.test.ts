// Characterization tests for the codex rollout parser.
// Fixtures in test/fixtures/transcripts/codex/ with *.expected.json sidecars.
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseCodexRollout } from "../../src/codexIndexer";

const FIX = path.resolve(__dirname, "../fixtures/transcripts/codex");

function fixture(rel: string): string {
  return path.join(FIX, rel);
}

function expected(rel: string): { records: number; errors: Array<{ line: number; kind: string }> } {
  const p = fixture(rel).replace(/\.jsonl$/, ".expected.json");
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

describe("parseCodexRollout", () => {
  it("parses session_meta, turn_context model, one turn, tool + usage", () => {
    const rel = "valid/basic-rollout.jsonl";
    const parsed = parseCodexRollout(fixture(rel));
    expect(parsed.turns.length, `${rel}: turn count`).toBe(expected(rel).records);
    expect(parsed.sessionId).toBe("55555555-5555-4555-8555-555555555555");
    expect(parsed.cwd).toBe("/Users/tester/projects/demo");
    expect(parsed.model).toBe("gpt-5.2-codex");
    expect(parsed.entrypoint).toBe("cli");
    expect(parsed.cliVersion).toBe("0.5.0");

    const t = parsed.turns[0];
    expect(t.userText).toBe("add a README");
    expect(t.assistantText).toBe("Created README.md.");
    expect(t.toolNames).toEqual(["shell"]);
    expect(parsed.totalTools).toBe(1);
    expect(parsed.badLines).toBe(0);
    expect(parsed.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 340,
      cache_read_tokens: 800,
    });
    expect(parsed.startedAt).toBe(Date.parse("2026-07-02T09:00:00.000Z"));
    expect(parsed.endedAt).toBe(Date.parse("2026-07-02T09:00:13.000Z"));
  });

  it("counts a truncated last line as badLines and keeps earlier turns", () => {
    const rel = "truncated/mid-object.jsonl";
    const exp = expected(rel);
    const parsed = parseCodexRollout(fixture(rel));
    expect(parsed.turns.length, `${rel}: line ${exp.errors[0].line} (${exp.errors[0].kind})`).toBe(exp.records);
    expect(parsed.badLines).toBe(exp.errors.length);
    expect(parsed.turns[0].userText).toBe("do the thing");
  });

  it("returns an empty parse (not a throw) for a nonexistent file", () => {
    const parsed = parseCodexRollout(fixture("does-not-exist.jsonl"));
    expect(parsed.turns.length).toBe(0);
    expect(parsed.sessionId).toBeNull();
    expect(parsed.badLines).toBe(0);
  });
});
