import { describe, it, expect } from "vitest";
import { buildExplainPrompt, parseLabelJson } from "../../src/sessionExplain";

describe("parseLabelJson", () => {
  it("parses a bare object", () => {
    const l = parseLabelJson(
      '{"topic":"fix timestamps","intent":"bugfix","tags":["cb"],"projects":["code-build-vscode"],"summary":"Replay used Date.now()."}',
    );
    expect(l?.intent).toBe("bugfix");
    expect(l?.tags).toEqual(["cb"]);
  });
  it("strips fences and preamble", () => {
    const l = parseLabelJson('Sure.\n```json\n{"topic":"x","intent":"docs","tags":[],"projects":[],"summary":"y"}\n```\n');
    expect(l?.topic).toBe("x");
    expect(l?.intent).toBe("docs");
  });
  it("returns null on garbage", () => {
    expect(parseLabelJson("not json")).toBeNull();
  });
});

describe("buildExplainPrompt", () => {
  it("includes excerpt and candidates for label mode", () => {
    const p = buildExplainPrompt({
      uuid: "aaaaaaaa-0000-4000-8000-000000000001",
      title: "timestamps",
      firstUserMsg: "events reset on restart",
      candidateItems: [{ id: "tasks/foo", title: "Fleet board", type: "task" }],
    });
    expect(p).toContain("intent");
    expect(p).toContain("tasks/foo");
    expect(p).toContain("events reset on restart");
  });
  it("freeform question mode", () => {
    const p = buildExplainPrompt({
      uuid: "aaaaaaaa-0000-4000-8000-000000000001",
      excerpt: "hello",
      question: "what was this about?",
    });
    expect(p).toContain("what was this about?");
    expect(p).toContain("5-12 sentences");
  });
});
