import { describe, it, expect } from "vitest";
import {
  isAutomatedSession,
  defaultAutomationConfig,
  DEFAULT_TITLE_PATTERNS,
} from "../../src/automation";

const interactive = {
  is_automated: false,
  entrypoint: "sdk-cli",
  title: "Fix the flaky retry test",
  first_user_msg: "the retry helper flakes on CI — look at src/retry.ts",
  extras_json: null,
  kind: "session" as const,
};

describe("isAutomatedSession", () => {
  it("honors the DB is_automated flag", () => {
    expect(isAutomatedSession({ ...interactive, is_automated: true })).toBe(true);
  });

  it("keeps Code Build sdk-cli sessions that have no automation signature", () => {
    expect(isAutomatedSession(interactive)).toBe(false);
  });

  it("flags sdk-cli night-loop prompts that the indexer treats as interactive", () => {
    expect(
      isAutomatedSession({
        ...interactive,
        title: "Night IMPLEMENT — autonomous build",
        first_user_msg:
          "You are an autonomous overnight engineer. This is the IMPLEMENTATION phase, scheduled ~1 hour before the current 5-hour window closes.",
      }),
    ).toBe(true);
  });

  it("flags daily-digest / cron skill invocations", () => {
    expect(
      isAutomatedSession({
        ...interactive,
        title: "daily-digest",
        first_user_msg:
          "Run /daily-digest — scan the knowledge base. This is running via cron with no user interaction — skip Step 6.",
      }),
    ).toBe(true);
  });

  it("flags unknown / extra entrypoints (routine, headless, cron)", () => {
    expect(isAutomatedSession({ ...interactive, entrypoint: "routine" })).toBe(true);
    expect(isAutomatedSession({ ...interactive, entrypoint: "headless" })).toBe(true);
    expect(isAutomatedSession({ ...interactive, entrypoint: "cron" })).toBe(true);
    expect(isAutomatedSession({ ...interactive, entrypoint: "cli" })).toBe(false);
    expect(isAutomatedSession({ ...interactive, entrypoint: "claude-vscode" })).toBe(false);
  });

  it("keeps Grok Build / Code Build interactive sessions (grok-build-plan)", () => {
    expect(
      isAutomatedSession({
        ...interactive,
        entrypoint: "grok-build-plan",
        title: "Session fleet board and restart timestamp fix",
        first_user_msg: "looks like there is a bug in code build",
      }),
    ).toBe(false);
    expect(isAutomatedSession({ ...interactive, entrypoint: "grok" })).toBe(false);
    expect(isAutomatedSession({ ...interactive, entrypoint: "code-build" })).toBe(false);
  });

  it("flags git-store extras.labels that mark suite automation", () => {
    expect(
      isAutomatedSession({
        ...interactive,
        extras_json: JSON.stringify({ host: "air-15", agent: "claude", labels: ["night-ideate"] }),
      }),
    ).toBe(true);
    expect(
      isAutomatedSession({
        ...interactive,
        extras_json: JSON.stringify({ labels: ["night"] }),
      }),
    ).toBe(false); // bare "night" is too broad — not a default label
  });

  it("flags subagent / workflow children", () => {
    expect(isAutomatedSession({ ...interactive, kind: "subagent" })).toBe(true);
    expect(isAutomatedSession({ ...interactive, kind: "workflow" })).toBe(true);
  });

  it("honors custom titlePatterns from settings", () => {
    expect(
      isAutomatedSession(
        { ...interactive, first_user_msg: "please run the fleet-watcher smoke" },
        { titlePatterns: ["fleet-watcher"] },
      ),
    ).toBe(true);
    expect(
      isAutomatedSession(
        { ...interactive, first_user_msg: "please run the fleet-watcher smoke" },
        { titlePatterns: ["no-match"] },
      ),
    ).toBe(false);
  });

  it("can ignore the DB flag when honorDbFlag is false", () => {
    expect(
      isAutomatedSession({ ...interactive, is_automated: true }, { honorDbFlag: false }),
    ).toBe(false);
  });

  it("default pattern list includes the night-loop lead-in", () => {
    expect(DEFAULT_TITLE_PATTERNS.some((p) => p.includes("autonomous overnight"))).toBe(true);
    expect(defaultAutomationConfig().titlePatterns.length).toBeGreaterThan(5);
  });
});
