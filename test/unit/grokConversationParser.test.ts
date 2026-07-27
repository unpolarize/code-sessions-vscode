// Tests for the shared grok chat_history.jsonl parser + the viewer adapter
// that emits the claude-parser ParsedConversation shape, and the viewer's
// source-routing decision (kp: tasks/csv-route-grok-sessions-to-the-grok-parser-in-th).
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  parseGrokConversation,
  parseGrokConversationAsParsed,
  parserKindForSource,
} from "../../src/grokConversationParser";

const FIX = path.resolve(__dirname, "../fixtures/transcripts/grok/valid/basic-session");
const CHAT = path.join(FIX, "chat_history.jsonl");

describe("parseGrokConversation", () => {
  it("turns = user message + following assistant events; tools and edits attached", () => {
    const g = parseGrokConversation(CHAT);
    expect(g.turns.length).toBe(2);

    const t0 = g.turns[0];
    expect(t0.userText).toBe("add a health endpoint");
    expect(t0.assistantText).toBe(
      "Sure — I'll add /health to the server.\n\nDone. The endpoint returns 200.",
    );
    expect(t0.toolNames).toEqual(["read_file", "search_replace"]);
    expect(t0.fileEdits).toEqual(["/Users/tester/projects/demo/src/server.ts"]);

    const t1 = g.turns[1];
    expect(t1.userText).toBe("now write a test for it");
    expect(t1.toolNames).toEqual(["write"]);
    expect(t1.fileEdits).toEqual(["/Users/tester/projects/demo/src/server.test.ts"]);

    expect(g.totalTools).toBe(3);
  });

  it("skips the pre-turn system prompt and malformed jsonl lines", () => {
    const g = parseGrokConversation(CHAT);
    for (const t of g.turns) {
      expect(t.userText).not.toContain("System prompt text");
      expect(t.assistantText).not.toContain("System prompt text");
    }
    // The non-JSON line sits between the two turns; both still parse fully.
    expect(g.turns[1].assistantText).toBe("Added server.test.ts covering /health.");
  });

  it("missing file → empty session, no throw", () => {
    const g = parseGrokConversation(path.join(FIX, "does-not-exist.jsonl"));
    expect(g.turns).toEqual([]);
    expect(g.totalTools).toBe(0);
  });
});

describe("parseGrokConversationAsParsed (viewer adapter)", () => {
  it("emits populated ParsedConversation turns with tool calls", () => {
    const c = parseGrokConversationAsParsed(CHAT);
    expect(c.sessionId).toBe("0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001");
    expect(c.title).toBe("Add health endpoint");
    expect(c.startMs).toBe(Date.parse("2026-07-20T10:00:00Z"));
    expect(c.endMs).toBe(Date.parse("2026-07-20T10:06:00Z"));

    expect(c.turns.length).toBe(2);
    expect(c.turns[0].userText.length).toBeGreaterThan(0);
    expect(c.turns[0].assistantText.length).toBeGreaterThan(0);

    const names = c.turns[0].toolCalls.map((tc) => tc.name);
    expect(names).toEqual(["read_file", "search_replace"]);
    // Arguments JSON-decode into ToolCall.input for the viewer's input pane.
    expect(c.turns[0].toolCalls[1].input.file_path).toBe(
      "/Users/tester/projects/demo/src/server.ts",
    );
    expect(c.turns[0].toolCalls.every((tc) => tc.isSubagent === false)).toBe(true);

    expect(c.summary.totalTurns).toBe(2);
    expect(c.summary.totalTools).toBe(3);
    expect(c.summary.toolCountsByName).toEqual({ read_file: 1, search_replace: 1, write: 1 });
  });

  it("survives a missing summary.json (ordinal timestamps, empty id/title)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-parse-"));
    const chat = path.join(tmp, "chat_history.jsonl");
    fs.copyFileSync(CHAT, chat);
    const c = parseGrokConversationAsParsed(chat);
    expect(c.sessionId).toBe("");
    expect(c.startMs).toBeNull();
    expect(c.turns.length).toBe(2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("parserKindForSource (viewer routing)", () => {
  it("routes grok to the grok parser and everything else to claude", () => {
    expect(parserKindForSource("grok")).toBe("grok");
    expect(parserKindForSource("claude")).toBe("claude");
    expect(parserKindForSource("codex")).toBe("claude");
    expect(parserKindForSource(null)).toBe("claude");
    expect(parserKindForSource(undefined)).toBe("claude");
  });
});
