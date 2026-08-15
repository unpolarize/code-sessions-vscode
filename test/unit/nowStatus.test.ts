import { describe, it, expect } from "vitest";
import { nowStatusFromTail, RESPONDING_WINDOW_MS } from "../../src/nowStatus";

const ts = (ms: number) => new Date(ms).toISOString();

describe("nowStatusFromTail", () => {
  it("treats an open Bash tool_use as in_tool", () => {
    const now = 1_000_000;
    const tail = JSON.stringify({
      type: "assistant",
      timestamp: ts(now - 5_000),
      message: { content: [{ type: "tool_use", id: "t1", name: "Bash" }] },
    });
    const { status } = nowStatusFromTail(tail, now);
    expect(status.kind).toBe("in_tool");
    expect(status.detail).toBe("Bash");
  });

  it("treats open AskUserQuestion as awaiting_user", () => {
    const now = 1_000_000;
    const tail = JSON.stringify({
      type: "assistant",
      timestamp: ts(now - 2_000),
      message: { content: [{ type: "tool_use", id: "t1", name: "AskUserQuestion" }] },
    });
    expect(nowStatusFromTail(tail, now).status.kind).toBe("awaiting_user");
  });

  it("keeps recent thinking as responding past the old 30s window", () => {
    const now = 1_000_000;
    const tail = JSON.stringify({
      type: "assistant",
      timestamp: ts(now - 45_000),
      message: { content: [{ type: "thinking", text: "…" }] },
    });
    expect(nowStatusFromTail(tail, now).status.kind).toBe("responding");
  });

  it("is idle after the responding window", () => {
    const now = 1_000_000;
    const tail = JSON.stringify({
      type: "assistant",
      timestamp: ts(now - RESPONDING_WINDOW_MS - 1_000),
      message: { content: [{ type: "text", text: "done" }] },
    });
    expect(nowStatusFromTail(tail, now).status.kind).toBe("idle");
  });
});
