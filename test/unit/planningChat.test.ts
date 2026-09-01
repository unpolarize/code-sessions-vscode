import { describe, expect, it } from "vitest";
import { chatArgv, foldStreamLine, PLANNING_CHAT_SYSTEM_PROMPT } from "../../src/planningChat";

describe("planning chat argv", () => {
  it("first turn appends the system prompt, no resume", () => {
    const a = chatArgv({ prompt: "identify all ideas for today", model: "sonnet", systemPrompt: PLANNING_CHAT_SYSTEM_PROMPT });
    expect(a.slice(0, 2)).toEqual(["-p", "identify all ideas for today"]);
    expect(a).toContain("--append-system-prompt");
    expect(a).toContain("--dangerously-skip-permissions");
    expect(a).not.toContain("--resume");
  });

  it("later turns resume the same session without re-priming", () => {
    const a = chatArgv({ prompt: "now link them", model: "opus", resumeId: "sid-1" });
    expect(a).toContain("--resume");
    expect(a[a.indexOf("--resume") + 1]).toBe("sid-1");
    expect(a).not.toContain("--append-system-prompt");
  });
});

describe("stream-json folding", () => {
  it("captures the session id from init", () => {
    const r = foldStreamLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s-9" }));
    expect(r.sessionId).toBe("s-9");
    expect(r.events).toEqual([]);
  });

  it("folds assistant text and tool_use blocks", () => {
    const r = foldStreamLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Found 3 ideas." },
            { type: "tool_use", name: "Bash", input: { command: "kp search onboarding" } }
          ]
        }
      })
    );
    expect(r.events).toEqual([
      { kind: "text", text: "Found 3 ideas." },
      { kind: "tool", name: "Bash", detail: "kp search onboarding" }
    ]);
  });

  it("folds the result with cost, flags errors, and garbage lines are ignored", () => {
    const ok = foldStreamLine(
      JSON.stringify({ type: "result", subtype: "success", result: "Linked 2 sessions.", total_cost_usd: 0.12, session_id: "s-9" })
    );
    expect(ok.events[0]).toMatchObject({ kind: "result", text: "Linked 2 sessions.", costUsd: 0.12, isError: false });
    expect(ok.sessionId).toBe("s-9");
    const err = foldStreamLine(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }));
    expect(err.events[0]).toMatchObject({ kind: "result", isError: true });
    expect(foldStreamLine("not json").events).toEqual([]);
  });
});
