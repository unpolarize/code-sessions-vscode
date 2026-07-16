// Cross-device transcript fallback.
//
// The native Claude/Grok transcript (~/.claude/projects/**/<uuid>.jsonl) only
// exists on the laptop a session ran on. The ~/.sessions git store, however,
// captures every session's turns as hosts/<host>/<YYYY-MM>/<uuid>/turns/*.json
// (schema session-store/turn@1) and syncs across machines. When the native
// transcript is absent locally, we render the conversation from those turns so
// a session can be reviewed on any device.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ParsedConversation, Turn, ToolCall } from "./conversationParser";

export interface StoreTurnsRef {
  /** …/hosts/<host>/<month>/<uuid>/turns */
  dir: string;
  /** the machine the session ran on (hosts/<host>) */
  host: string;
}

function sessionsHostsRoot(): string {
  return path.join(os.homedir(), ".sessions", "hosts");
}

/** Locate a session's turns/ dir in the git store, scanning every host/month. */
export function locateStoreTurns(sessionId: string): StoreTurnsRef | null {
  const root = sessionsHostsRoot();
  let hosts: string[];
  try {
    hosts = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const host of hosts) {
    const hostDir = path.join(root, host);
    let months: string[];
    try {
      months = fs.readdirSync(hostDir);
    } catch {
      continue;
    }
    for (const month of months) {
      const turns = path.join(hostDir, month, sessionId, "turns");
      if (fs.existsSync(turns)) return { dir: turns, host };
    }
  }
  return null;
}

/**
 * A compact seed prompt for resuming a cross-device session in Code Build:
 * the last `maxTurns` user/assistant exchanges plus a continue instruction.
 * (Native `claude --resume` can't reach another laptop's JSONL, so we seed a
 * fresh conversation with the prior context instead.)
 */
export function buildResumeSeed(ref: StoreTurnsRef, sessionId: string, maxTurns = 12): string | null {
  const c = turnsToConversation(ref, sessionId);
  if (!c.turns.length) return null;
  const tail = c.turns.slice(-maxTurns);
  const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n) + " …[truncated]");
  const body = tail
    .map((t) => {
      const u = t.userText.trim() ? `USER: ${clip(t.userText.trim(), 2000)}` : "";
      const a = t.assistantText.trim() ? `ASSISTANT: ${clip(t.assistantText.trim(), 2000)}` : "";
      const tools = t.toolCalls.length ? `  (tools: ${t.toolCalls.map((x) => x.name).join(", ")})` : "";
      return [u, a + tools].filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
  return (
    `You are resuming a prior session (id ${sessionId}) that ran on another machine (${ref.host}).\n` +
    `Its native transcript isn't on this device, so here is the recent history to continue from.\n` +
    `Pick up where it left off.\n\n----- prior conversation (last ${tail.length} turns) -----\n\n${body}\n\n----- end of history -----\n`
  );
}

function tsMs(s: unknown): number {
  if (typeof s !== "string") return 0;
  const v = Date.parse(s);
  return Number.isFinite(v) ? v : 0;
}

/** turn@1 tool_calls carry {name, input} only (no result/duration). */
function toToolCall(raw: any, startMs: number): ToolCall {
  const name = String(raw?.name ?? "");
  const input = raw?.input ?? {};
  const isSubagent = name === "Task" || name === "Agent";
  return {
    id: "",
    name,
    input,
    startMs,
    endMs: null,
    durationMs: null,
    resultText: null,
    resultIsError: false,
    isSubagent,
    subagentType: isSubagent ? (input.subagent_type ?? input.subagentType) : undefined,
    subagentDescription: isSubagent ? (input.description ?? input.prompt) : undefined,
  };
}

/**
 * Fold the store's per-message turn files into conversationParser Turns: a
 * `user` message opens a Turn; the `assistant` messages that follow contribute
 * assistantText + toolCalls until the next `user` message.
 */
export function turnsToConversation(ref: StoreTurnsRef, sessionId: string, fallbackTitle = ""): ParsedConversation {
  let files: string[];
  try {
    files = fs.readdirSync(ref.dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    files = [];
  }
  const turns: Turn[] = [];
  let current: Turn | null = null;
  const push = () => {
    if (current) turns.push(current);
  };
  for (const f of files) {
    let obj: any;
    try {
      obj = JSON.parse(fs.readFileSync(path.join(ref.dir, f), "utf-8"));
    } catch {
      continue;
    }
    const ts = tsMs(obj.ts);
    const text = typeof obj.text === "string" ? obj.text : "";
    const toolCalls: ToolCall[] = Array.isArray(obj.tool_calls) ? obj.tool_calls.map((t: any) => toToolCall(t, ts)) : [];
    if (obj.role === "user") {
      push();
      current = {
        index: turns.length,
        userText: text,
        userTimestampMs: ts,
        assistantText: "",
        assistantStartMs: null,
        turnEndMs: ts,
        toolCalls: [],
      };
    } else {
      // assistant (or anything non-user) folds into the open turn; synthesize
      // one if a session opens with an assistant message.
      if (!current) {
        current = { index: 0, userText: "", userTimestampMs: ts, assistantText: "", assistantStartMs: ts, turnEndMs: ts, toolCalls: [] };
      }
      if (text) current.assistantText += (current.assistantText ? "\n\n" : "") + text;
      if (current.assistantStartMs == null) current.assistantStartMs = ts;
      current.toolCalls.push(...toolCalls);
    }
    if (current && ts) current.turnEndMs = Math.max(current.turnEndMs ?? 0, ts);
  }
  push();

  let startMs: number | null = null;
  let endMs: number | null = null;
  let lastAssistantTextMs: number | null = null;
  let totalTools = 0;
  let totalSubagents = 0;
  let totalAssistantTextChars = 0;
  const toolCountsByName: Record<string, number> = {};
  for (const t of turns) {
    if (t.userTimestampMs && (startMs == null || t.userTimestampMs < startMs)) startMs = t.userTimestampMs;
    if (t.turnEndMs && (endMs == null || t.turnEndMs > endMs)) endMs = t.turnEndMs;
    if (t.assistantText && t.turnEndMs) lastAssistantTextMs = Math.max(lastAssistantTextMs ?? 0, t.turnEndMs);
    totalTools += t.toolCalls.length;
    totalAssistantTextChars += t.assistantText.length;
    for (const tc of t.toolCalls) {
      toolCountsByName[tc.name] = (toolCountsByName[tc.name] ?? 0) + 1;
      if (tc.isSubagent) totalSubagents += 1;
    }
  }

  // Title from the sibling session.json when available.
  let title = fallbackTitle;
  try {
    const env = JSON.parse(fs.readFileSync(path.join(path.dirname(ref.dir), "session.json"), "utf-8"));
    if (env?.title) title = String(env.title);
  } catch {
    /* keep fallback */
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
      totalTurnDurationMs: 0,
      totalToolDurationMs: 0,
      userThinkingMsList: [],
      toolCountsByName,
    },
    startMs,
    endMs,
    lastAssistantTextMs,
  };
}
