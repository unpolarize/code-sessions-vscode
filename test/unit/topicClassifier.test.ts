// parseClaudeOutput: the pure output-parsing half of the topic classifier
// (`claude -p --output-format json` envelope → {id, topic} list + token usage).
// No CLI is spawned — deterministic string inputs only.
import { describe, it, expect } from "vitest";
import { parseClaudeOutput } from "../../src/topicClassifier";

const JSONL = '{"id":"t1","topic":"vscode-extension-webview"}\n{"id":"t2","topic":"sqlite-wasm-shim"}';

describe("parseClaudeOutput", () => {
  it("peels the claude -p JSON envelope and reads usage", () => {
    const envelope = JSON.stringify({
      result: JSONL,
      usage: { input_tokens: 321, output_tokens: 45 },
    });
    const out = parseClaudeOutput(envelope);
    expect(out.topics).toEqual([
      { id: "t1", topic: "vscode-extension-webview" },
      { id: "t2", topic: "sqlite-wasm-shim" },
    ]);
    expect(out.inputTokens).toBe(321);
    expect(out.outputTokens).toBe(45);
  });

  it("accepts raw (non-enveloped) JSONL with zero usage", () => {
    const out = parseClaudeOutput(JSONL);
    expect(out.topics.length).toBe(2);
    expect(out.inputTokens).toBe(0);
    expect(out.outputTokens).toBe(0);
  });

  it("strips markdown fences and skips garbage / wrong-shape lines", () => {
    const chatty = "```jsonl\n" + JSONL + '\nnot json\n{"id":"t3"}\n```\n';
    const out = parseClaudeOutput(chatty);
    // t3 lacks "topic" → dropped; garbage line dropped; fences stripped
    expect(out.topics.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("trims and caps topic labels at 80 chars", () => {
    const long = "x".repeat(120);
    const out = parseClaudeOutput(`{"id":"t9","topic":"  ${long}  "}`);
    expect(out.topics.length).toBe(1);
    expect(out.topics[0].topic.length).toBe(80);
    expect(out.topics[0].topic).toBe("x".repeat(80));
  });

  it("returns empty topics for empty input", () => {
    const out = parseClaudeOutput("");
    expect(out.topics).toEqual([]);
  });
});
