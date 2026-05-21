// Pure parser: a Claude Code JSONL → list of conversation Turns.
//
// A "turn" begins with a user message (real user prompt, not a tool_result)
// and includes every assistant message and tool_result that follows until
// the next real user message.

import * as fs from "fs";

export interface ToolCall {
  id: string;
  name: string;
  input: any;
  startMs: number;
  endMs: number | null;
  durationMs: number | null;
  resultText: string | null;
  resultIsError: boolean;
  // Subagent-specific
  isSubagent: boolean;
  subagentType?: string;
  subagentDescription?: string;
}

export interface Turn {
  index: number;
  userText: string;
  userTimestampMs: number;
  // Assistant-side blocks: a single string with concatenated text blocks
  // (across multiple assistant messages within this turn).
  assistantText: string;
  // First assistant timestamp in this turn.
  assistantStartMs: number | null;
  // Wall-clock end of the turn: last assistant or tool_result timestamp.
  turnEndMs: number | null;
  toolCalls: ToolCall[];
}

export interface ConversationSummary {
  totalTurns: number;
  totalTools: number;
  totalSubagents: number;
  totalAssistantTextChars: number;
  // Time-related aggregates (ms)
  totalTurnDurationMs: number;
  totalToolDurationMs: number;
  // Per-turn "user thinking time": gap between previous turn's end and this
  // turn's user message, in ms. Length = totalTurns - 1 (no value for the
  // first turn).
  userThinkingMsList: number[];
  // Tool counts by name across the whole session.
  toolCountsByName: Record<string, number>;
}

export interface ParsedConversation {
  sessionId: string;
  title: string;
  turns: Turn[];
  summary: ConversationSummary;
  startMs: number | null;
  endMs: number | null;
  /** Timestamp (ms) of the most recent assistant message that contained a
   * text block — i.e. the last time the model actually "said something" to
   * the user. Distinct from endMs (which includes tool_uses and tool_results
   * that follow the last text). Null if the session has no text yet. */
  lastAssistantTextMs: number | null;
}

function tsMs(s: any): number {
  if (typeof s !== "string") return 0;
  const v = Date.parse(s);
  return Number.isFinite(v) ? v : 0;
}

function extractText(content: any): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (typeof b === "string") return b;
        if (b && b.type === "text") return String(b.text ?? "");
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

function isToolResultLine(line: any): boolean {
  return (
    line?.type === "user" &&
    Array.isArray(line?.message?.content) &&
    line.message.content[0]?.type === "tool_result"
  );
}

export function parseConversation(filePath: string): ParsedConversation {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter(Boolean);

  let sessionId = "";
  let title = "";
  const turns: Turn[] = [];
  let lastAssistantTextMs: number | null = null;
  // toolUseId -> ToolCall (to attach results when they arrive)
  const pendingTools = new Map<string, ToolCall>();
  let current: Turn | null = null;
  let firstUserSeen = false;

  for (const ln of lines) {
    let obj: any;
    try {
      obj = JSON.parse(ln);
    } catch {
      continue;
    }
    if (!obj || !obj.type) continue;
    if (!sessionId && obj.sessionId) sessionId = obj.sessionId;

    if (obj.type === "ai-title" && obj.aiTitle) {
      title = obj.aiTitle;
      continue;
    }

    // Tool result lines — attach to the matching tool call in the current turn.
    if (isToolResultLine(obj)) {
      const block = obj.message.content[0];
      const id = block.tool_use_id;
      const text = extractText(block.content);
      const tc = pendingTools.get(id);
      if (tc) {
        tc.resultText = text;
        tc.resultIsError = !!block.is_error;
        tc.endMs = tsMs(obj.timestamp);
        tc.durationMs = tc.endMs && tc.startMs ? Math.max(0, tc.endMs - tc.startMs) : null;
        pendingTools.delete(id);
      }
      if (current) {
        current.turnEndMs = Math.max(current.turnEndMs ?? 0, tsMs(obj.timestamp));
      }
      continue;
    }

    // Real user message → start a new turn.
    if (obj.type === "user") {
      const text = extractText(obj.message?.content);
      // skip truly empty user messages
      if (!text.trim() && firstUserSeen) {
        // ignore but don't break
        continue;
      }
      firstUserSeen = true;
      current = {
        index: turns.length,
        userText: text,
        userTimestampMs: tsMs(obj.timestamp),
        assistantText: "",
        assistantStartMs: null,
        turnEndMs: tsMs(obj.timestamp),
        toolCalls: [],
      };
      turns.push(current);
      continue;
    }

    // Assistant message → append text + tool calls to current turn.
    if (obj.type === "assistant" && current) {
      const ts = tsMs(obj.timestamp);
      if (current.assistantStartMs == null) current.assistantStartMs = ts;
      current.turnEndMs = Math.max(current.turnEndMs ?? 0, ts);
      const content = obj.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text") {
            current.assistantText += (current.assistantText ? "\n\n" : "") + String(block.text ?? "");
            if (ts > 0 && (lastAssistantTextMs == null || ts > lastAssistantTextMs)) {
              lastAssistantTextMs = ts;
            }
          } else if (block.type === "tool_use") {
            const isSubagent = block.name === "Agent" || block.name === "Task";
            const tc: ToolCall = {
              id: String(block.id),
              name: String(block.name),
              input: block.input,
              startMs: ts,
              endMs: null,
              durationMs: null,
              resultText: null,
              resultIsError: false,
              isSubagent,
              subagentType: isSubagent ? String(block.input?.subagent_type ?? "") : undefined,
              subagentDescription: isSubagent ? String(block.input?.description ?? "") : undefined,
            };
            current.toolCalls.push(tc);
            pendingTools.set(tc.id, tc);
          }
        }
      }
    }
  }

  // Summary
  let totalTools = 0;
  let totalSubagents = 0;
  let totalAssistantTextChars = 0;
  let totalTurnDurationMs = 0;
  let totalToolDurationMs = 0;
  let startMs: number | null = null;
  let endMs: number | null = null;
  const userThinkingMsList: number[] = [];
  const toolCountsByName: Record<string, number> = {};

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (startMs == null || (t.userTimestampMs && t.userTimestampMs < startMs)) {
      startMs = t.userTimestampMs || null;
    }
    if (t.turnEndMs && (endMs == null || t.turnEndMs > endMs)) endMs = t.turnEndMs;
    totalTools += t.toolCalls.length;
    totalAssistantTextChars += t.assistantText.length;
    if (t.userTimestampMs && t.turnEndMs)
      totalTurnDurationMs += Math.max(0, t.turnEndMs - t.userTimestampMs);
    for (const tc of t.toolCalls) {
      if (tc.isSubagent) totalSubagents += 1;
      if (tc.durationMs) totalToolDurationMs += tc.durationMs;
      toolCountsByName[tc.name] = (toolCountsByName[tc.name] ?? 0) + 1;
    }
    // user thinking time: gap from previous turn's end to this turn's user message
    if (i > 0) {
      const prev = turns[i - 1];
      if (prev.turnEndMs && t.userTimestampMs) {
        const gap = t.userTimestampMs - prev.turnEndMs;
        if (gap >= 0 && gap < 7 * 24 * 3600 * 1000) {
          // Clamp pathological gaps (e.g., a session resumed days later).
          userThinkingMsList.push(gap);
        }
      }
    }
  }

  return {
    sessionId,
    title,
    turns,
    summary: {
      totalTurns: turns.length,
      totalTools,
      totalSubagents,
      totalAssistantTextChars,
      totalTurnDurationMs,
      totalToolDurationMs,
      userThinkingMsList,
      toolCountsByName,
    },
    startMs,
    endMs,
    lastAssistantTextMs,
  };
}
