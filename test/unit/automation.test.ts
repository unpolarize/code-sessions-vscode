import { describe, it, expect } from "vitest";
import {
  isAutomatedSession,
  hideAutomatedSession,
  isHumanContinuedSession,
  firstMeaningfulUserText,
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

  it("flags Grok IMPLEMENT / IDEATE / overnight-validate prompts on grok-build-plan", () => {
    expect(
      isAutomatedSession({
        ...interactive,
        entrypoint: "grok-build-plan",
        title: "KP preflight gate implement slice",
        first_user_msg:
          "<user_query>\n# Grok IMPLEMENT — one-hour autonomous build slice\n\nYou are Grok Build running a 60-minute autonomous implementation slot.\nPrimary queue is KP:\n$KP implementable --json\n</user_query>",
      }),
    ).toBe(true);
    expect(
      isAutomatedSession({
        ...interactive,
        entrypoint: "grok-build-plan",
        title: "Grok Ideate Market Research Product Directions",
        first_user_msg:
          "You are Grok Build running an autonomous ideation slot for the unpolarize org. You are the **divergent-thinking lane**.",
      }),
    ).toBe(true);
    expect(
      isAutomatedSession({
        ...interactive,
        entrypoint: "grok-build-plan",
        title: "Validate Insights probe-provider overnight KP",
        first_user_msg:
          "Validate this KP task for overnight auto-implement: gaps, risks, sharper acceptance.",
      }),
    ).toBe(true);
  });

  it("skips Grok harness turns when locating the real prompt", () => {
    expect(
      firstMeaningfulUserText([
        "<user_info>\nOS Version: macos\n</user_info>",
        "<system-reminder>\nMCP servers connecting\n</system-reminder>",
        "<user_query>\nYou are Grok Build running a 60-minute autonomous implementation slot.\n</user_query>",
      ]),
    ).toContain("autonomous implementation slot");
  });

  it("honors extras.automated and extras.phase provenance", () => {
    expect(
      isAutomatedSession({
        ...interactive,
        extras_json: JSON.stringify({ automated: true }),
      }),
    ).toBe(true);
    expect(
      isAutomatedSession({
        ...interactive,
        extras_json: JSON.stringify({ phase: "grok-implement" }),
      }),
    ).toBe(true);
  });
});

describe("hideAutomatedSession (filter rule)", () => {
  it("hides automated-not-continued, shows automated-continued and human", () => {
    const autoNotContinued = {
      ...interactive,
      entrypoint: "grok-build-plan",
      title: "KP queue autonomous one-hour implement slice",
      first_user_msg:
        "# Grok IMPLEMENT — one-hour autonomous build slice from the KP queue\nYou are Grok Build running a 60-minute autonomous implementation slot.",
    };
    const autoContinued = {
      ...autoNotContinued,
      extras_json: JSON.stringify({ automated: true, continued_by_human: true }),
      later_user_msgs: ["the resume stall is still reproducing — look at src/acp.ts"],
    };
    const human = {
      ...interactive,
      entrypoint: "grok-build-plan",
      title: "Grok ACP resume stall, missing prompt, wipe",
      first_user_msg:
        "Deep research: CB bug — restarting/resuming a Grok ACP session shows a stall",
    };

    expect(hideAutomatedSession(autoNotContinued)).toBe(true);
    expect(isAutomatedSession(autoNotContinued)).toBe(true);

    expect(isAutomatedSession(autoContinued)).toBe(true);
    expect(isHumanContinuedSession(autoContinued)).toBe(true);
    expect(hideAutomatedSession(autoContinued)).toBe(false);

    expect(isAutomatedSession(human)).toBe(false);
    expect(hideAutomatedSession(human)).toBe(false);
  });

  it("treats a later non-machine user_query as human-continued", () => {
    expect(
      isHumanContinuedSession({
        ...interactive,
        first_user_msg: "You are Grok Build running a 60-minute autonomous implementation slot.",
        later_user_msgs: ["ok, now fix the filter count on the tree tip"],
      }),
    ).toBe(true);
    expect(
      isHumanContinuedSession({
        ...interactive,
        first_user_msg: "You are Grok Build running a 60-minute autonomous implementation slot.",
        later_user_msgs: [
          "You are Grok Build running a 60-minute autonomous implementation slot. Primary queue is KP.",
        ],
      }),
    ).toBe(false);
  });
});
