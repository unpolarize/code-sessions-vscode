/**
 * Parse a JSONL tail into the live-monitor "now" chip.
 * Pure — no vscode, no fs — so unit tests can feed fixture strings.
 */

export interface NowStatus {
  kind: "in_tool" | "responding" | "idle" | "awaiting_user";
  detail: string;
  ageSec: number;
}

/** Tools whose open (unanswered) state means the session is blocked on the human. */
export const AWAITS_USER_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode", "ask_user_question"]);

/** Any event this recent keeps the session in `responding` (thinking, streaming). */
export const RESPONDING_WINDOW_MS = 90_000;

export function nowStatusFromTail(
  tail: string,
  now: number,
  respondingWindowMs = RESPONDING_WINDOW_MS,
): { status: NowStatus; toolsLast60s: number } {
  const lines = tail.split("\n").filter(Boolean);
  const events: Array<{ ts: number; type: string; obj: any }> = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : 0;
      events.unshift({ ts, type: obj.type || "?", obj });
    } catch {
      // skip
    }
  }
  let toolsLast60s = 0;
  const openTools = new Map<string, { name: string; ts: number }>();
  let lastAssistantText = 0;
  for (const ev of events) {
    if (ev.type === "assistant") {
      const content = ev.obj?.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== "object") continue;
          if (b.type === "tool_use") {
            openTools.set(String(b.id), { name: String(b.name), ts: ev.ts });
            if (now - ev.ts < 60_000) toolsLast60s += 1;
          } else if (b.type === "text" || b.type === "thinking") {
            lastAssistantText = Math.max(lastAssistantText, ev.ts);
          }
        }
      }
    } else if (
      ev.type === "user" &&
      Array.isArray(ev.obj?.message?.content) &&
      ev.obj.message.content[0]?.type === "tool_result"
    ) {
      const id = String(ev.obj.message.content[0].tool_use_id);
      openTools.delete(id);
    }
  }

  let status: NowStatus = { kind: "idle", detail: "", ageSec: 0 };
  if (openTools.size > 0) {
    let awaitingTs = 0,
      awaitingName = "";
    let bestTs = 0,
      bestName = "";
    for (const v of openTools.values()) {
      if (AWAITS_USER_TOOLS.has(v.name) && v.ts > awaitingTs) {
        awaitingTs = v.ts;
        awaitingName = v.name;
      }
      if (v.ts > bestTs) {
        bestTs = v.ts;
        bestName = v.name;
      }
    }
    if (awaitingTs > 0) {
      status = {
        kind: "awaiting_user",
        detail: awaitingName,
        ageSec: Math.floor((now - awaitingTs) / 1000),
      };
    } else {
      status = { kind: "in_tool", detail: bestName, ageSec: Math.floor((now - bestTs) / 1000) };
    }
  } else {
    let last = lastAssistantText;
    for (const ev of events) if (ev.ts > last) last = ev.ts;
    if (last && now - last < respondingWindowMs) {
      status = { kind: "responding", detail: "", ageSec: Math.floor((now - last) / 1000) };
    } else {
      status = { kind: "idle", detail: "", ageSec: last ? Math.floor((now - last) / 1000) : 0 };
    }
  }
  return { status, toolsLast60s };
}
