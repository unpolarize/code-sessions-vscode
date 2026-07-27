// Pure parser for Grok Build chat_history.jsonl — shared between the indexer
// (grokIndexer.ts, which folds turns into SessionRow/TurnRow) and the
// conversation viewer (conversationView.ts, which needs the same
// ParsedConversation shape the claude parser emits).
//
// Grok events lack per-event timestamps; the sibling summary.json carries
// created_at / last_active_at for the session as a whole. The viewer adapter
// synthesises per-turn timestamps from created_at + line ordinal, matching
// the indexer's convention.

import * as fs from "fs";
import * as path from "path";
import {
  ConversationSummary,
  ParsedConversation,
  ToolCall,
  Turn,
} from "./conversationParser";

export interface GrokToolCall {
  name: string;
  /** Raw JSON-string arguments as grok records them; parsed lazily. */
  arguments?: string;
}

export interface GrokTurn {
  index: number;
  userText: string;
  assistantText: string;
  toolNames: string[];
  toolCalls: GrokToolCall[];
  fileEdits: string[];
  isSubagent: boolean;
}

export interface ParsedGrokSession {
  turns: GrokTurn[];
  totalTools: number;
  rawMessageCount: number;
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

/** Try to extract a file path from a frontend tool_call's arguments. Grok
 * uses `file_path` for search_replace and `filePath` for write (inconsistent
 * key naming verified across multiple sessions). Returns null if the call
 * is read-only (read_file / list_dir / grep) or if arguments are unparseable. */
export function fileEditPathFromToolCall(tc: { name?: string; arguments?: string }): string | null {
  if (!tc?.name) return null;
  if (tc.name !== "search_replace" && tc.name !== "write") return null;
  if (typeof tc.arguments !== "string") return null;
  try {
    const args = JSON.parse(tc.arguments);
    const p = tc.name === "search_replace" ? args?.file_path : args?.filePath;
    return typeof p === "string" && p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

/** Pure parser: grok chat_history.jsonl → conversation turns. Mirrors the
 * "turn = user message + everything until the next user message" convention
 * used by the claude conversationParser, so downstream code (classifier,
 * KB rollup, viewer) sees comparable structure. Malformed lines are skipped;
 * the rest of the file still parses. */
export function parseGrokConversation(chatPath: string): ParsedGrokSession {
  let raw = "";
  try {
    raw = fs.readFileSync(chatPath, "utf-8");
  } catch {
    return { turns: [], totalTools: 0, rawMessageCount: 0 };
  }
  const lines = raw.split("\n").filter(Boolean);

  const turns: GrokTurn[] = [];
  let current: GrokTurn | null = null;
  let totalTools = 0;
  let rawMessageCount = 0;

  for (const ln of lines) {
    let obj: any;
    try {
      obj = JSON.parse(ln);
    } catch {
      continue;
    }
    const type = obj?.type;

    if (type === "user") {
      // Real user message — start a new turn.
      const userText = extractText(obj.content);
      rawMessageCount += 1;
      current = {
        index: turns.length,
        userText,
        assistantText: "",
        toolNames: [],
        toolCalls: [],
        fileEdits: [],
        isSubagent: false,
      };
      turns.push(current);
      continue;
    }

    if (!current) {
      // Stray events before the first user message (e.g. system prompt).
      // System prompts dominate text but don't belong to any turn; skip.
      continue;
    }

    if (type === "assistant") {
      rawMessageCount += 1;
      const text = extractText(obj.content);
      if (text) {
        current.assistantText = current.assistantText
          ? `${current.assistantText}\n\n${text}`
          : text;
      }
      const tcs: any[] = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
      for (const tc of tcs) {
        const name = typeof tc?.name === "string" ? tc.name : null;
        if (!name) continue;
        current.toolNames.push(name);
        current.toolCalls.push({
          name,
          arguments: typeof tc.arguments === "string" ? tc.arguments : undefined,
        });
        totalTools += 1;
        // Grok has no sub-agent equivalent in v1; we deliberately leave
        // isSubagent false for every turn. spawn_subagent / use_tool would
        // surface here if a future grok release records them.
        const fp = fileEditPathFromToolCall({ name, arguments: tc.arguments });
        if (fp) current.fileEdits.push(fp);
      }
      continue;
    }

    // backend_tool_call / tool_result / system: ignored. backend tool calls
    // in observed sessions are web_search and similar — not editor-side
    // activity the user cares to surface in this view.
  }

  return { turns, totalTools, rawMessageCount };
}

/** Which parser a session's transcript needs. Routes on the SessionRow's
 * `source`; when the row is unavailable (no store, cache miss) a transcript
 * living under ~/.grok/sessions/ still routes to the grok parser so it never
 * falls back to the claude parser's blank-body rendering. Everything else
 * stays on the claude parser (codex rollouts never reach this viewer path). */
export function parserKindForSource(
  source: string | null | undefined,
  jsonlPath?: string | null,
): "grok" | "claude" {
  if (source === "grok") return "grok";
  if (source == null && jsonlPath && /[\\/]\.grok[\\/]sessions[\\/]/.test(jsonlPath)) {
    return "grok";
  }
  return "claude";
}

/** Viewer adapter: grok chat_history.jsonl → the same ParsedConversation the
 * claude parser emits, so renderHtml stays parser-agnostic. Session id, title
 * and start/end come from the sibling summary.json when present; grok events
 * carry no per-event timestamps, so per-turn times are synthesised from
 * created_at + turn ordinal and durations stay null/zero. */
export function parseGrokConversationAsParsed(chatPath: string): ParsedConversation {
  const g = parseGrokConversation(chatPath);

  let sessionId = "";
  let title = "";
  let startMs: number | null = null;
  let endMs: number | null = null;
  try {
    const s = JSON.parse(
      fs.readFileSync(path.join(path.dirname(chatPath), "summary.json"), "utf-8"),
    );
    sessionId = s?.info?.id || "";
    title = String(s?.generated_title || s?.session_summary || "").trim();
    const cr = Date.parse(s?.created_at);
    if (Number.isFinite(cr)) startMs = cr;
    const en = Date.parse(s?.last_active_at ?? s?.updated_at ?? s?.created_at);
    if (Number.isFinite(en)) endMs = en;
  } catch {
    // summary.json missing/corrupt — ordinal-only timestamps.
  }
  // No summary.json → no anchor for synthesised times. Use 0 for every turn
  // (fmtClock(0) renders as "—") instead of base+ordinal, which would paint
  // 1970-epoch clocks on turns 1..n.
  const turnTs = (index: number): number => (startMs != null ? startMs + index : 0);

  const toolCountsByName: Record<string, number> = {};
  let totalTools = 0;
  let assistantChars = 0;

  const turns: Turn[] = g.turns.map((t) => {
    const toolCalls: ToolCall[] = t.toolCalls.map((tc, j) => {
      let input: any = null;
      if (typeof tc.arguments === "string") {
        try {
          input = JSON.parse(tc.arguments);
        } catch {
          input = tc.arguments;
        }
      }
      toolCountsByName[tc.name] = (toolCountsByName[tc.name] ?? 0) + 1;
      totalTools += 1;
      return {
        id: `grok-${t.index}-${j}`,
        name: tc.name,
        input,
        startMs: turnTs(t.index),
        endMs: null,
        durationMs: null,
        resultText: null,
        resultIsError: false,
        isSubagent: false,
      };
    });
    assistantChars += t.assistantText.length;
    return {
      index: t.index,
      userText: t.userText,
      userTimestampMs: turnTs(t.index),
      assistantText: t.assistantText,
      assistantStartMs: null,
      turnEndMs: null,
      toolCalls,
    };
  });

  const summary: ConversationSummary = {
    totalTurns: turns.length,
    totalTools,
    totalSubagents: 0,
    totalAssistantTextChars: assistantChars,
    totalTurnDurationMs: 0,
    totalToolDurationMs: 0,
    userThinkingMsList: [],
    toolCountsByName,
  };

  return {
    sessionId,
    title,
    turns,
    summary,
    startMs,
    endMs,
    lastAssistantTextMs: null,
  };
}
