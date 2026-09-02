// The dashboard webview JS used to live inside a TypeScript template literal.
// `'\n'` in that template became a real newline inside a JS string, so Chromium
// failed document.write with "Invalid or unexpected token". Keep the media file
// valid JS — parse it here so the regression cannot ship again.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Script } from "node:vm";

const src = readFileSync(resolve(__dirname, "../../media/planning-dashboard.js"), "utf8");

describe("planning-dashboard.js", () => {
  it("parses as JavaScript", () => {
    expect(() => new Script(src, { filename: "planning-dashboard.js" })).not.toThrow();
  });

  it("does not close the HTML script tag", () => {
    expect(src.toLowerCase()).not.toContain("</script");
  });

  it("coalesces agent chat and applies @@board commands", () => {
    expect(src).toContain("paintAgent");
    expect(src).toContain("applyBoardCmd");
    expect(src).toContain("ev.kind==='board'");
    expect(src).toContain("mdChat");
  });
});
