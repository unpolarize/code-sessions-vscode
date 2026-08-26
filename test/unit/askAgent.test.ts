import { describe, it, expect } from "vitest";
import { askArgv } from "../../src/askAgent";

describe("askArgv", () => {
  it("matches Code Build: claude -p --model <alias> --output-format text", () => {
    expect(askArgv("claude", "sonnet", "what is this session?")).toEqual({
      bin: "claude",
      args: ["-p", "what is this session?", "--model", "sonnet", "--output-format", "text"],
    });
  });

  it("matches Code Build: grok -p --model <id>", () => {
    expect(askArgv("grok", "grok-4.6", "summarize")).toEqual({
      bin: "grok",
      args: ["-p", "summarize", "--model", "grok-4.6"],
    });
  });
});
