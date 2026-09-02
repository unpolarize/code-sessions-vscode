import { describe, expect, it } from "vitest";
import { CHAT_ALLOWED_TOOLS, CHAT_DENIED_TOOLS, buildChatSystemPrompt, chatArgv, exitOutcome, foldStreamLine, PLANNING_CHAT_SYSTEM_PROMPT } from "../../src/planningChat";

describe("planning chat argv", () => {
  it("first turn appends the system prompt, no resume", () => {
    const a = chatArgv({ prompt: "identify all ideas for today", model: "sonnet", systemPrompt: PLANNING_CHAT_SYSTEM_PROMPT });
    expect(a.slice(0, 2)).toEqual(["-p", "identify all ideas for today"]);
    expect(a).toContain("--append-system-prompt");
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

describe("permission gating and exit outcomes (review findings #1/#3)", () => {
  it("defaults to an enforced kp-only allowlist, not skip-permissions", () => {
    const a = chatArgv({ prompt: "x", model: "sonnet" });
    expect(a).not.toContain("--dangerously-skip-permissions");
    expect(a[a.indexOf("--allowedTools") + 1]).toBe(CHAT_ALLOWED_TOOLS);
    expect(a[a.indexOf("--disallowedTools") + 1]).toBe(CHAT_DENIED_TOOLS);
    expect(CHAT_DENIED_TOOLS).toContain("git push");
  });

  it("a kp shim path adds a path-scoped allow rule and rewrites the primer", () => {
    const a = chatArgv({ prompt: "x", model: "sonnet", kpPath: "/gs/bin/kp" });
    expect(a[a.indexOf("--allowedTools") + 1]).toBe(`Bash(/gs/bin/kp:*),${CHAT_ALLOWED_TOOLS}`);
    const sp = buildChatSystemPrompt("/gs/bin/kp");
    expect(sp).toContain("/gs/bin/kp export --date today");
    expect(sp).toContain("/gs/bin/kp search");
  });

  it("fullAccess opt-in switches to skip-permissions and drops the allowlist", () => {
    const a = chatArgv({ prompt: "x", model: "sonnet", fullAccess: true });
    expect(a).toContain("--dangerously-skip-permissions");
    expect(a).not.toContain("--allowedTools");
    expect(a).not.toContain("--disallowedTools");
  });

  it("a user Stop is a clean finish, not an 'exited with code null' error", () => {
    expect(exitOutcome(null, false, true, "whatever")).toBeNull();
    expect(exitOutcome(0, false, false, "")).toBeNull();
    expect(exitOutcome(1, true, false, "")).toBeNull(); // result already arrived
    expect(exitOutcome(1, false, false, "boom")).toMatch(/code 1: boom/);
  });
});
