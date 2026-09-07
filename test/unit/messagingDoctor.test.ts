import { describe, it, expect } from "vitest";
import {
  MESSAGING_DISABLE_ENV_VARS,
  buildInvestigationSnippet,
  buildRemediationSnippet,
  collectTranscriptEvidence,
  isDisablingValue,
  renderMessagingDoctorCardHtml,
  resolveDisableReasons,
  resolveTranscriptEvidence,
  runMessagingDoctor,
  transcriptEvidenceVerdict,
} from "../../src/messagingDoctor";

describe("isDisablingValue", () => {
  it("boolean semantics: unset / empty / explicit-off spellings do not disable", () => {
    for (const v of [undefined, "", "  ", "0", "false", "FALSE", "no", "off", " Off "]) {
      expect(isDisablingValue(v, "boolean")).toBe(false);
    }
  });

  it("boolean semantics: truthy-style values disable", () => {
    for (const v of ["1", "true", "TRUE", "yes", "2", "anything"]) {
      expect(isDisablingValue(v, "boolean")).toBe(true);
    }
  });

  it("presence semantics: ANY non-empty value disables, even 0/false", () => {
    for (const v of ["1", "0", "false", "no", "off", "anything"]) {
      expect(isDisablingValue(v, "presence")).toBe(true);
    }
    for (const v of [undefined, "", "  "]) {
      expect(isDisablingValue(v, "presence")).toBe(false);
    }
  });
});

describe("resolveDisableReasons", () => {
  it("returns [] on a clean env", () => {
    expect(resolveDisableReasons({})).toEqual([]);
    expect(resolveDisableReasons({ PATH: "/usr/bin", DO_NOT_TRACK: "0" })).toEqual([]);
  });

  it("presence-based vars disable even when set to 0/false", () => {
    expect(resolveDisableReasons({ DISABLE_TELEMETRY: "0" }).map((r) => r.envVar)).toEqual([
      "DISABLE_TELEMETRY",
    ]);
    expect(
      resolveDisableReasons({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "false" })
    ).toHaveLength(1);
    // …but boolean vars honor explicit-off.
    expect(resolveDisableReasons({ DISABLE_GROWTHBOOK: "0" })).toEqual([]);
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

describe("resolveTranscriptEvidence / transcriptEvidenceVerdict", () => {
  const turn = (userText: string | null, toolNamesCsv: string | null) => ({
    userText,
    toolNamesCsv,
  });

  it("no sessions → no-signal", () => {
    const ev = resolveTranscriptEvidence([]);
    expect(ev).toEqual({ sessionsScanned: 0, attemptTurns: 0, toolSeen: false });
    expect(transcriptEvidenceVerdict(ev)).toBe("no-signal");
    expect(transcriptEvidenceVerdict(undefined)).toBe("no-signal");
  });

  it("sessions with no attempts and no tool → no-signal (never-users don't warn)", () => {
    const ev = resolveTranscriptEvidence([[turn("fix the bug", "Bash,Edit")]]);
    expect(transcriptEvidenceVerdict(ev)).toBe("no-signal");
  });

  it("ListAgents or SendMessage in tool_names_csv → seen, even alongside attempts", () => {
    const ev = resolveTranscriptEvidence([
      [turn("/list-agents", null)],
      [turn("hi", "Bash,ListAgents,Edit")],
    ]);
    expect(ev.toolSeen).toBe(true);
    expect(ev.attemptTurns).toBe(1);
    expect(transcriptEvidenceVerdict(ev)).toBe("seen");
    const ev2 = resolveTranscriptEvidence([[turn(null, "SendMessage")]]);
    expect(transcriptEvidenceVerdict(ev2)).toBe("seen");
  });

  it("/list-agents attempted (case-insensitive) with no tool run → attempted-absent", () => {
    const ev = resolveTranscriptEvidence([
      [turn("why does /LIST-AGENTS say unknown command?", "Bash")],
      [turn("/list-agents", null)],
    ]);
    expect(ev.attemptTurns).toBe(2);
    expect(ev.toolSeen).toBe(false);
    expect(transcriptEvidenceVerdict(ev)).toBe("attempted-absent");
  });

  it("tool detection is exact-name: substring tool names do not count as seen", () => {
    const ev = resolveTranscriptEvidence([[turn("hello", "MyListAgentsHelper,SendMessages,Bash")]]);
    expect(ev.toolSeen).toBe(false);
  });
});

describe("collectTranscriptEvidence", () => {
  it("scans only claude-source sessions, capped, via the store surface", () => {
    const asked: string[] = [];
    const store = {
      listRecent: (limit: number, includeAutomated: boolean) => {
        expect(includeAutomated).toBe(true);
        expect(limit).toBeGreaterThanOrEqual(2);
        return [
          { session_id: "g1", source: "grok" },
          { session_id: "c1", source: "claude" },
          { session_id: "c2", source: "claude" },
        ];
      },
      turnsForSession: (id: string) => {
        asked.push(id);
        return id === "c1"
          ? [{ user_text: "/list-agents", tool_names_csv: null }]
          : [{ user_text: "hello", tool_names_csv: "Bash" }];
      },
    };
    const ev = collectTranscriptEvidence(store, 2);
    expect(asked).toEqual(["c1", "c2"]);
    expect(ev.sessionsScanned).toBe(2);
    expect(ev.attemptTurns).toBe(1);
    expect(transcriptEvidenceVerdict(ev)).toBe("attempted-absent");
  });
});

describe("runMessagingDoctor with transcript evidence", () => {
  const attemptedAbsent = { sessionsScanned: 5, attemptTurns: 2, toolSeen: false };
  const seen = { sessionsScanned: 5, attemptTurns: 0, toolSeen: true };

  it("clean env + attempted-absent → warn with investigation (not unset) snippet", () => {
    const r = runMessagingDoctor({}, attemptedAbsent);
    expect(r.severity).toBe("warn");
    expect(r.reasons).toHaveLength(0);
    expect(r.evidenceVerdict).toBe("attempted-absent");
    expect(r.remediation).toBe(buildInvestigationSnippet());
    expect(r.remediation).toContain("grep");
    expect(r.remediation).not.toContain("unset ");
    // Hunt covers all four known vars and the settings.json override.
    for (const k of MESSAGING_DISABLE_ENV_VARS) expect(r.remediation).toContain(k.name);
    expect(r.remediation).toContain(".claude/settings.json");
  });

  it("clean env + seen or no-signal → ok, no card", () => {
    expect(runMessagingDoctor({}, seen).severity).toBe("ok");
    expect(
      runMessagingDoctor({}, { sessionsScanned: 5, attemptTurns: 0, toolSeen: false }).severity,
    ).toBe("ok");
    expect(renderMessagingDoctorCardHtml(runMessagingDoctor({}, seen))).toBe("");
  });

  it("env reasons + attempted-absent → unset snippet wins, card shows corroboration", () => {
    const r = runMessagingDoctor({ DO_NOT_TRACK: "1" }, attemptedAbsent);
    expect(r.remediation).toContain("unset DO_NOT_TRACK");
    const html = renderMessagingDoctorCardHtml(r, { commandUris: false });
    expect(html).toContain("Corroborated by transcripts");
    expect(html).toContain("2 turn(s)");
  });

  it("env reasons + seen → card softens with a may-still-be-working note", () => {
    const html = renderMessagingDoctorCardHtml(runMessagingDoctor({ DO_NOT_TRACK: "1" }, seen), {
      commandUris: false,
    });
    expect(html).toContain("may still be working");
  });

  it("evidence-only card explains the clean-env-here nuance and copies hunt commands", () => {
    const r = runMessagingDoctor({}, attemptedAbsent);
    const html = renderMessagingDoctorCardHtml(r);
    expect(html).toContain("No disabling env vars are visible in this VS Code process");
    expect(html).toContain("messaging likely disabled");
    // Copy fix carries the card's own snippet as the command argument.
    expect(html).toContain(encodeURIComponent(JSON.stringify([r.remediation])).slice(0, 40));
    expect(html).toContain("hunt commands");
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
