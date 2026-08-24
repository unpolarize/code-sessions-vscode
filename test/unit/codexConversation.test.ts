// Viewer routing + adapter for codex rollouts: parserKindForSource must send
// codex sessions to parseCodexRolloutAsParsed (never the claude parser, which
// renders rollouts as blank turn bodies), and the adapter must emit the same
// ParsedConversation shape the claude parser does — with name-only tool calls,
// since rollouts carry no tool arguments or results.
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseCodexRolloutAsParsed } from "../../src/codexIndexer";
import { parserKindForSource } from "../../src/grokConversationParser";

const FIX = path.resolve(__dirname, "../fixtures/transcripts/codex");

describe("parserKindForSource codex routing", () => {
  it("routes source codex to the codex parser", () => {
    expect(parserKindForSource("codex", "/anywhere/rollout-x.jsonl")).toBe("codex");
    expect(parserKindForSource("codex", null)).toBe("codex");
  });

  it("routes an unknown-source ~/.codex/sessions path to the codex parser", () => {
    expect(
      parserKindForSource(null, "/Users/t/.codex/sessions/2026/07/02/rollout-x.jsonl"),
    ).toBe("codex");
    expect(
      parserKindForSource(undefined, "C:\\Users\\t\\.codex\\sessions\\rollout-x.jsonl"),
    ).toBe("codex");
  });

  it("leaves claude/grok/git routing unchanged", () => {
    expect(parserKindForSource("claude", "/Users/t/.claude/projects/p/x.jsonl")).toBe("claude");
    expect(parserKindForSource("git", null)).toBe("claude");
    expect(parserKindForSource("grok", null)).toBe("grok");
    expect(parserKindForSource(null, "/Users/t/.grok/sessions/x/chat_history.jsonl")).toBe("grok");
    expect(parserKindForSource(null, "/Users/t/.claude/projects/p/x.jsonl")).toBe("claude");
  });
});

describe("parseCodexRolloutAsParsed", () => {
  it("adapts a valid rollout into ParsedConversation turns", () => {
    const parsed = parseCodexRolloutAsParsed(path.join(FIX, "valid/basic-rollout.jsonl"));
    expect(parsed.sessionId).toBe("55555555-5555-4555-8555-555555555555");
    expect(parsed.turns.length).toBe(1);

    const t = parsed.turns[0];
    expect(t.userText).toBe("add a README");
    expect(t.assistantText).toContain("Created README.md.");
    expect(t.userTimestampMs).toBe(Date.parse("2026-07-02T09:00:05.000Z"));

    // Name-only tool calls: no input/result exists in a rollout.
    expect(t.toolCalls.map((tc) => tc.name)).toEqual(["shell"]);
    expect(t.toolCalls[0].input).toBeNull();
    expect(t.toolCalls[0].resultText).toBeNull();

    expect(parsed.summary.totalTurns).toBe(1);
    expect(parsed.summary.totalTools).toBe(1);
    expect(parsed.summary.toolCountsByName).toEqual({ shell: 1 });
    expect(parsed.startMs).toBe(Date.parse("2026-07-02T09:00:00.000Z"));
    expect(parsed.lastAssistantTextMs).not.toBeNull();
  });

  it("yields zero turns for a meta-only rollout (viewer empty state)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-conv-"));
    const p = path.join(dir, "rollout-meta-only.jsonl");
    fs.writeFileSync(
      p,
      JSON.stringify({
        timestamp: "2026-07-02T09:00:00.000Z",
        type: "session_meta",
        payload: { id: "66666666-6666-4666-8666-666666666666", cwd: "/tmp" },
      }) + "\n",
    );
    try {
      const parsed = parseCodexRolloutAsParsed(p);
      expect(parsed.turns).toEqual([]);
      expect(parsed.summary.totalTurns).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws 'rollout missing' for an absent file instead of a parser error", () => {
    expect(() =>
      parseCodexRolloutAsParsed("/nonexistent/rollout-gone.jsonl"),
    ).toThrow(/rollout missing/);
  });
});
