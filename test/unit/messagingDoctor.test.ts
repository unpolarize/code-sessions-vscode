import { describe, it, expect } from "vitest";
import {
  MESSAGING_DISABLE_ENV_VARS,
  buildRemediationSnippet,
  isDisablingValue,
  renderMessagingDoctorCardHtml,
  resolveDisableReasons,
  runMessagingDoctor,
} from "../../src/messagingDoctor";

describe("isDisablingValue", () => {
  it("treats unset / empty / explicit-off spellings as not disabling", () => {
    for (const v of [undefined, "", "  ", "0", "false", "FALSE", "no", "off", " Off "]) {
      expect(isDisablingValue(v)).toBe(false);
    }
  });

  it("treats truthy-style values as disabling", () => {
    for (const v of ["1", "true", "TRUE", "yes", "2", "anything"]) {
      expect(isDisablingValue(v)).toBe(true);
    }
  });
});

describe("resolveDisableReasons", () => {
  it("returns [] on a clean env", () => {
    expect(resolveDisableReasons({})).toEqual([]);
    expect(resolveDisableReasons({ PATH: "/usr/bin", DO_NOT_TRACK: "0" })).toEqual([]);
  });

  it("env fixture → expected disable reasons[], in canonical order", () => {
    const env = {
      DO_NOT_TRACK: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "true",
      UNRELATED: "1",
    };
    const reasons = resolveDisableReasons(env);
    expect(reasons.map((r) => r.envVar)).toEqual([
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "DO_NOT_TRACK",
    ]);
    expect(reasons[1].value).toBe("1");
    expect(reasons[0].purpose).toMatch(/non-essential/);
  });

  it("flags all four known vars when all are set", () => {
    const env = Object.fromEntries(MESSAGING_DISABLE_ENV_VARS.map((k) => [k.name, "1"]));
    expect(resolveDisableReasons(env)).toHaveLength(4);
  });
});

describe("buildRemediationSnippet", () => {
  it("is empty for no reasons", () => {
    expect(buildRemediationSnippet([])).toBe("");
  });

  it("contains one unset line per reason and a profile grep hint", () => {
    const snippet = buildRemediationSnippet(
      resolveDisableReasons({ DO_NOT_TRACK: "1", DISABLE_TELEMETRY: "yes" })
    );
    expect(snippet).toContain("unset DISABLE_TELEMETRY");
    expect(snippet).toContain("unset DO_NOT_TRACK");
    expect(snippet).toContain("DISABLE_TELEMETRY|DO_NOT_TRACK");
    expect(snippet).toContain("shell profile");
    // Read-only guarantee: the snippet unsets, it never writes a profile.
    expect(snippet).not.toMatch(/>>|sed -i|tee /);
  });
});

describe("runMessagingDoctor", () => {
  it("ok on clean env, warn when any known var disables", () => {
    expect(runMessagingDoctor({}).severity).toBe("ok");
    const r = runMessagingDoctor({ DISABLE_GROWTHBOOK: "1" });
    expect(r.severity).toBe("warn");
    expect(r.reasons).toHaveLength(1);
    expect(r.remediation).toContain("unset DISABLE_GROWTHBOOK");
  });
});

describe("renderMessagingDoctorCardHtml", () => {
  it("renders nothing when severity is ok", () => {
    expect(renderMessagingDoctorCardHtml(runMessagingDoctor({}))).toBe("");
  });

  it("lists each set var with its value and purpose", () => {
    const html = renderMessagingDoctorCardHtml(
      runMessagingDoctor({ DO_NOT_TRACK: "1", DISABLE_TELEMETRY: "true" }),
      { commandUris: false }
    );
    expect(html).toContain("DO_NOT_TRACK=1");
    expect(html).toContain("DISABLE_TELEMETRY=true");
    expect(html).toContain("messaging likely disabled");
    expect(html).toContain("ListAgents");
    // No command links in non-webview mode.
    expect(html).not.toContain("command:");
  });

  it("includes the copy-fix command URI in webview mode", () => {
    const html = renderMessagingDoctorCardHtml(runMessagingDoctor({ DO_NOT_TRACK: "1" }));
    expect(html).toContain("command:codeSessions.copyMessagingDoctorFix");
  });

  it("escapes hostile env values", () => {
    const html = renderMessagingDoctorCardHtml(
      runMessagingDoctor({ DO_NOT_TRACK: '<script>alert("x")</script>' }),
      { commandUris: false }
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
