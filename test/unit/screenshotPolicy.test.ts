// Screenshot-evidence policy: the red "missing" chip + done-without-screenshot
// nudge only apply to items targeting UI repos. annotateScreenshots (planning.ts)
// skips non-UI target repos, leaving has_screenshot undefined — and the webview
// only renders the chip / inline warn on `has_screenshot === false` (covered by
// planningPipeline.test.ts "unknown → no badge"), so this classifier is the
// single gate for chip + nudge.
import { describe, it, expect } from "vitest";
import { DEFAULT_UI_REPOS, screenshotApplies } from "../../src/screenshotPolicy";

describe("screenshotApplies", () => {
  it("exempts CLI-only target repos (e.g. knowledge-planning) by default", () => {
    expect(screenshotApplies("knowledge-planning")).toBe(false);
    expect(screenshotApplies("some-random-cli")).toBe(false);
  });

  it("keeps UI repos nagged (default classification, zero config)", () => {
    expect(DEFAULT_UI_REPOS).toContain("code-sessions-vscode");
    expect(screenshotApplies("code-sessions-vscode")).toBe(true);
    expect(screenshotApplies("code-build-vscode")).toBe(true);
  });

  it("items with no target_repo keep today's behavior (evidence applies)", () => {
    expect(screenshotApplies(undefined)).toBe(true);
    expect(screenshotApplies(null)).toBe(true);
    expect(screenshotApplies("")).toBe(true);
    expect(screenshotApplies("   ")).toBe(true);
    expect(screenshotApplies(42)).toBe(true); // non-string junk → default behavior
  });

  it("matches owner/repo paths by basename", () => {
    expect(screenshotApplies("unpolarize/code-sessions-vscode")).toBe(true);
    expect(screenshotApplies("unpolarize/knowledge-planning")).toBe(false);
  });

  it("respects a settings override list", () => {
    expect(screenshotApplies("my-web-app", ["my-web-app"])).toBe(true);
    expect(screenshotApplies("code-sessions-vscode", ["my-web-app"])).toBe(false);
    expect(screenshotApplies("", ["my-web-app"])).toBe(true); // no target_repo unaffected by override
  });
});
