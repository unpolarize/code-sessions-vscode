import { describe, it, expect } from "vitest";
import { turnsToReplayRecords } from "../../src/storeTranscript";
import type { ParsedConversation } from "../../src/conversationParser";

function conv(turns: Array<{ userText: string; assistantText: string }>): ParsedConversation {
  return {
    sessionId: "s1",
    title: "t",
    turns: turns.map((t, i) => ({
      index: i,
      userText: t.userText,
      userTimestampMs: i * 1000,
      assistantText: t.assistantText,
      assistantStartMs: i * 1000 + 1,
      turnEndMs: i * 1000 + 2,
      toolCalls: [],
    })),
    summary: {
      totalTurns: turns.length,
      totalTools: 0,
      totalSubagents: 0,
      totalAssistantTextChars: 0,
      totalTurnDurationMs: 0,
      totalToolDurationMs: 0,
      userThinkingMsList: [],
      toolCountsByName: {},
    },
    startMs: 0,
    endMs: 1,
    lastAssistantTextMs: 1,
  };
}

describe("turnsToReplayRecords", () => {
  it("emits user + agent_message_chunk pairs for CB historyLoaded", () => {
    const rec = turnsToReplayRecords(
      conv([
        { userText: "hello", assistantText: "hi there" },
        { userText: "  ", assistantText: "only assistant" },
      ]),
    );
    expect(rec).toEqual([
      { type: "user", text: "hello" },
      { type: "update", update: { kind: "agent_message_chunk", content: { type: "text", text: "hi there" } } },
      { type: "update", update: { kind: "agent_message_chunk", content: { type: "text", text: "only assistant" } } },
    ]);
  });
});
