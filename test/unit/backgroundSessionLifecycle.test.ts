// Fixture tests for the background-session lifecycle matrix
// (KP ideas/csv-background-session-lifecycle-matrix-card-att).
// Three capability classes: native ACP/CLI · CB host shim · unsupported.

import { describe, it, expect } from "vitest";
import {
  ACP_METHOD_ALIASES,
  BACKGROUND_SESSION_LIFECYCLE_SCHEMA,
  CLAUDE_BG_VERBS_SINCE,
  CLAUDE_CLI_VERBS,
  CLAUDE_LIFECYCLE_DOCS_URL,
  LIFECYCLE_VERBS,
  classifyLifecycleVerb,
  classifySessionLifecycle,
  computeBackgroundSessionLifecycle,
  isBackgroundOrDetached,
  probeFromExtras,
  renderBackgroundSessionLifecycleHtml,
  sessionsFromStoreRows,
  versionAtLeast,
  type LifecycleProbe,
  type LifecycleSessionInput,
} from "../../src/backgroundSessionLifecycle";

const NOW = Date.parse("2026-09-11T18:00:00.000Z");

function session(
  partial: Partial<LifecycleSessionInput> & Pick<LifecycleSessionInput, "sessionId">,
): LifecycleSessionInput {
  return {
    source: "claude",
    label: partial.label ?? partial.sessionId,
    extras: { background: true },
    lastActivityMs: NOW - 60_000,
    endedAt: null,
    ...partial,
  };
}

describe("versionAtLeast", () => {
  it("treats 2.1.251 as the Claude verb floor", () => {
    expect(versionAtLeast("2.1.251", CLAUDE_BG_VERBS_SINCE)).toBe(true);
    expect(versionAtLeast("2.1.252", CLAUDE_BG_VERBS_SINCE)).toBe(true);
    expect(versionAtLeast("2.2.0", CLAUDE_BG_VERBS_SINCE)).toBe(true);
    expect(versionAtLeast("claude 2.1.251 (beta)", CLAUDE_BG_VERBS_SINCE)).toBe(true);
    expect(versionAtLeast("2.1.250", CLAUDE_BG_VERBS_SINCE)).toBe(false);
    expect(versionAtLeast("2.0.251", CLAUDE_BG_VERBS_SINCE)).toBe(false);
    expect(versionAtLeast("", CLAUDE_BG_VERBS_SINCE)).toBe(false);
    expect(versionAtLeast(null, CLAUDE_BG_VERBS_SINCE)).toBe(false);
  });
});

describe("classifyLifecycleVerb — not hard-coded optimism", () => {
  it("Claude without a probe is unsupported (not assumed native)", () => {
    for (const verb of LIFECYCLE_VERBS) {
      const cell = classifyLifecycleVerb(verb, {}, "claude");
      expect(cell.klass).toBe("unsupported");
      expect(cell.claudeVerb).toBeFalsy();
    }
  });

  it("Claude CLI version below 2.1.251 does not unlock the verb set", () => {
    const probe: LifecycleProbe = { cliVersion: "2.1.250", claudeCli: true };
    expect(classifyLifecycleVerb("attach", probe, "claude").klass).toBe("unsupported");
    expect(classifyLifecycleVerb("rm", probe, "claude").klass).toBe("unsupported");
  });

  it("Claude CLI ≥ 2.1.251 unlocks all five verbs as native + deep-links", () => {
    const probe: LifecycleProbe = { cliVersion: "2.1.251", claudeCli: true };
    for (const verb of LIFECYCLE_VERBS) {
      const cell = classifyLifecycleVerb(verb, probe, "claude");
      expect(cell.klass).toBe("native");
      expect(cell.claudeVerb).toBe(CLAUDE_CLI_VERBS[verb]);
      expect(cell.docsUrl).toBe(CLAUDE_LIFECYCLE_DOCS_URL);
      expect(cell.reason).toMatch(/2\.1\.251/);
    }
  });

  it("ACP session/stop advertisement is native stop only — not attach/rm", () => {
    const probe: LifecycleProbe = { acpMethods: ["session/stop"] };
    expect(classifyLifecycleVerb("stop", probe, "codex").klass).toBe("native");
    expect(classifyLifecycleVerb("stop", probe, "codex").reason).toContain("session/stop");
    expect(classifyLifecycleVerb("attach", probe, "codex").klass).toBe("unsupported");
    expect(classifyLifecycleVerb("rm", probe, "codex").klass).toBe("unsupported");
    expect(classifyLifecycleVerb("stop", probe, "codex").claudeVerb).toBeFalsy();
  });

  it("sessionCapabilities.close counts as native stop", () => {
    const probe: LifecycleProbe = { sessionCapabilities: { close: true } };
    expect(classifyLifecycleVerb("stop", probe, "grok").klass).toBe("native");
    expect(classifyLifecycleVerb("logs", probe, "grok").klass).toBe("unsupported");
  });

  it("sessionCapabilities.load counts as native attach", () => {
    const probe: LifecycleProbe = { sessionCapabilities: { load: {} } };
    expect(classifyLifecycleVerb("attach", probe, "claude").klass).toBe("native");
    expect(ACP_METHOD_ALIASES.attach).toContain("session/load");
  });

  it("CLI help-probe verbs are native without a version", () => {
    const probe: LifecycleProbe = { cliVerbs: ["attach", "logs"] };
    expect(classifyLifecycleVerb("attach", probe, "claude").klass).toBe("native");
    expect(classifyLifecycleVerb("logs", probe, "claude").klass).toBe("native");
    expect(classifyLifecycleVerb("rm", probe, "claude").klass).toBe("unsupported");
  });

  it("CB host shim marks stop as shim, not native, and leaves others absent", () => {
    const probe: LifecycleProbe = { hostShims: ["stop"] };
    const stop = classifyLifecycleVerb("stop", probe, "grok");
    expect(stop.klass).toBe("shim");
    expect(stop.reason).toMatch(/process kill/i);
    expect(stop.reason).toMatch(/not session\/stop/i);
    expect(classifyLifecycleVerb("attach", probe, "grok").klass).toBe("unsupported");
    expect(classifyLifecycleVerb("respawn", probe, "grok").klass).toBe("unsupported");
  });

  it("native wins over shim when both are advertised", () => {
    const probe: LifecycleProbe = { acpMethods: ["session/stop"], hostShims: ["stop"] };
    expect(classifyLifecycleVerb("stop", probe, "grok").klass).toBe("native");
  });

  it("Codex/Grok do not inherit Claude 2.1.251 verbs from a version string", () => {
    const probe: LifecycleProbe = { cliVersion: "2.1.251" };
    expect(classifyLifecycleVerb("attach", probe, "codex").klass).toBe("unsupported");
    expect(classifyLifecycleVerb("attach", probe, "grok").klass).toBe("unsupported");
  });
});

describe("probeFromExtras", () => {
  it("reads initialize-shaped extras without inventing methods", () => {
    const p = probeFromExtras({
      agentCapabilities: { sessionCapabilities: { stop: true } },
      methods: ["session/load"],
      hostShims: ["stop"],
      cliVersion: "2.1.251",
    });
    expect(p.acpMethods).toContain("session/load");
    expect(p.sessionCapabilities?.stop).toBe(true);
    expect(p.hostShims).toContain("stop");
    expect(p.cliVersion).toBe("2.1.251");
  });

  it("cbHostTeardown stamps a stop shim", () => {
    expect(probeFromExtras({ cbHostTeardown: true }).hostShims).toContain("stop");
  });

  it("garbage extras yield an empty probe", () => {
    const p = probeFromExtras({});
    expect(p.acpMethods).toEqual([]);
    expect(p.cliVerbs).toEqual([]);
    expect(p.hostShims).toEqual([]);
    expect(p.cliVersion).toBeNull();
  });
});

describe("isBackgroundOrDetached", () => {
  it("requires an explicit background/detached/automated signal", () => {
    expect(
      isBackgroundOrDetached(
        { sessionId: "x", lastActivityMs: NOW, extras: {} },
        NOW,
      ),
    ).toBe(false);
  });

  it("accepts extras.background and extras.detached", () => {
    expect(isBackgroundOrDetached(session({ sessionId: "bg" }), NOW)).toBe(true);
    expect(
      isBackgroundOrDetached(session({ sessionId: "dt", extras: { detached: true } }), NOW),
    ).toBe(true);
  });

  it("rejects closed background sessions outside the open window", () => {
    expect(
      isBackgroundOrDetached(
        session({
          sessionId: "old",
          lastActivityMs: NOW - 2 * 3600_000,
          endedAt: NOW - 2 * 3600_000,
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it("rejects subagent children even when automated", () => {
    expect(
      isBackgroundOrDetached(
        {
          sessionId: "child",
          kind: "subagent",
          isAutomated: true,
          lastActivityMs: NOW,
          extras: {},
        },
        NOW,
      ),
    ).toBe(false);
  });
});

describe("computeBackgroundSessionLifecycle — three capability classes", () => {
  const claude: LifecycleSessionInput = session({
    sessionId: "claude-bg-1",
    source: "claude",
    label: "Claude background worker",
    probe: { cliVersion: "2.1.251", claudeCli: true },
  });
  const grok: LifecycleSessionInput = session({
    sessionId: "grok-bg-1",
    source: "grok",
    label: "Grok detached run",
    extras: { detached: true },
    probe: { hostShims: ["stop"] },
  });
  const codex: LifecycleSessionInput = session({
    sessionId: "codex-bg-1",
    source: "codex",
    label: "Codex overnight",
    extras: { background: true },
    probe: {},
  });

  it("classifies the three fixtures as native / shim / unsupported", () => {
    const card = computeBackgroundSessionLifecycle([claude, grok, codex], { nowMs: NOW });
    expect(card.schema).toBe(BACKGROUND_SESSION_LIFECYCLE_SCHEMA);
    expect(card.rows).toHaveLength(3);

    const byId = Object.fromEntries(card.rows.map((r) => [r.sessionId, r]));
    for (const verb of LIFECYCLE_VERBS) {
      expect(byId["claude-bg-1"].cells[verb].klass).toBe("native");
    }
    expect(byId["grok-bg-1"].cells.stop.klass).toBe("shim");
    expect(byId["grok-bg-1"].cells.attach.klass).toBe("unsupported");
    expect(byId["grok-bg-1"].cells.logs.klass).toBe("unsupported");
    expect(byId["grok-bg-1"].cells.respawn.klass).toBe("unsupported");
    expect(byId["grok-bg-1"].cells.rm.klass).toBe("unsupported");
    for (const verb of LIFECYCLE_VERBS) {
      expect(byId["codex-bg-1"].cells[verb].klass).toBe("unsupported");
    }
    expect(card.nativeCells).toBe(5);
    expect(card.shimCells).toBe(1);
    expect(card.unsupportedCells).toBe(9);
  });

  it("skips interactive sessions and closed background ones", () => {
    const card = computeBackgroundSessionLifecycle(
      [
        { sessionId: "interactive", source: "claude", extras: {}, lastActivityMs: NOW },
        session({
          sessionId: "closed-bg",
          extras: { background: true },
          lastActivityMs: NOW - 3 * 3600_000,
          endedAt: NOW - 3 * 3600_000,
        }),
        claude,
      ],
      { nowMs: NOW },
    );
    expect(card.rows.map((r) => r.sessionId)).toEqual(["claude-bg-1"]);
    expect(card.skippedNotBackground).toBe(1);
    expect(card.skippedClosed).toBe(1);
  });

  it("backend-level probe applies when the session itself has none", () => {
    const card = computeBackgroundSessionLifecycle(
      [session({ sessionId: "c2", source: "claude", probe: null, extras: { background: true } })],
      {
        nowMs: NOW,
        probesByBackend: { claude: { cliVerbs: ["attach"] } },
      },
    );
    expect(card.rows[0].cells.attach.klass).toBe("native");
    expect(card.rows[0].cells.rm.klass).toBe("unsupported");
  });

  it("maxRows caps visible rows and chip counts together", () => {
    const many = Array.from({ length: 4 }, (_, i) =>
      session({
        sessionId: `codex-bg-${i}`,
        source: "codex",
        extras: { background: true },
        probe: {},
      }),
    );
    const card = computeBackgroundSessionLifecycle(many, { nowMs: NOW, maxRows: 2 });
    expect(card.rows).toHaveLength(2);
    expect(card.unsupportedCells).toBe(10); // 2 rows × 5 verbs
    expect(card.nativeCells).toBe(0);
  });

  it("empty corpus does not invent native cells", () => {
    const card = computeBackgroundSessionLifecycle([], { nowMs: NOW });
    expect(card.rows).toEqual([]);
    expect(card.nativeCells).toBe(0);
    expect(renderBackgroundSessionLifecycleHtml(card)).toBe("");
  });
});

describe("sessionsFromStoreRows + render", () => {
  it("lifts store extras into a probe", () => {
    const sessions = sessionsFromStoreRows([
      {
        session_id: "s1",
        source: "claude",
        title: "bg worker",
        extras_json: JSON.stringify({
          background: true,
          cliVersion: "2.1.251",
          claudeCli: true,
        }),
        is_automated: true,
        ended_at: null,
        last_assistant_text_at: NOW - 10_000,
      },
    ]);
    expect(sessions[0].probe?.cliVersion).toBe("2.1.251");
    expect(isBackgroundOrDetached(sessions[0], NOW)).toBe(true);
  });

  it("renders traffic-lights, Claude deep-links, and no Codex/Grok action buttons", () => {
    const card = computeBackgroundSessionLifecycle(
      [
        session({
          sessionId: "claude-bg-1",
          source: "claude",
          label: "Claude background worker",
          probe: { cliVersion: "2.1.251", claudeCli: true },
        }),
        session({
          sessionId: "grok-bg-1",
          source: "grok",
          label: "Grok detached run",
          extras: { detached: true },
          probe: { hostShims: ["stop"] },
        }),
        session({
          sessionId: "codex-bg-1",
          source: "codex",
          label: "Codex overnight",
          probe: {},
        }),
      ],
      { nowMs: NOW },
    );
    const html = renderBackgroundSessionLifecycleHtml(card);
    expect(html).toContain(BACKGROUND_SESSION_LIFECYCLE_SCHEMA);
    expect(html).toContain("bsl-native");
    expect(html).toContain("bsl-shim");
    expect(html).toContain("bsl-unsupported");
    expect(html).toContain("claude attach");
    expect(html).toContain(CLAUDE_LIFECYCLE_DOCS_URL);
    expect(html).toContain("bsl-table-wrap");
    expect(html).toContain("command:codeSessions.openSession");
    expect(html).toContain("Read-only");
    expect(html).not.toMatch(/codex attach/i);
    expect(html).not.toContain("<button");
    const trs = [...html.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map((m) => m[0]);
    const claudeTr = trs.find((t) => t.includes("claude-bg-1"));
    const grokTr = trs.find((t) => t.includes("grok-bg-1"));
    const codexTr = trs.find((t) => t.includes("codex-bg-1"));
    expect(claudeTr).toMatch(/claude attach/);
    expect(grokTr).not.toMatch(/claude attach/);
    expect(codexTr).not.toMatch(/claude attach/);
    expect(codexTr).not.toMatch(/bsl-native/);
    const nativeDots = html.match(/aria-label="native"/g) ?? [];
    const shimDots = html.match(/aria-label="shim"/g) ?? [];
    const absentDots = html.match(/aria-label="unsupported"/g) ?? [];
    expect(nativeDots.length).toBe(5);
    expect(shimDots.length).toBe(1);
    expect(absentDots.length).toBe(9);
  });
});

describe("classifySessionLifecycle shape", () => {
  it("returns all five verbs", () => {
    const cells = classifySessionLifecycle({ hostShims: ["stop"] }, "grok");
    expect(Object.keys(cells).sort()).toEqual([...LIFECYCLE_VERBS].sort());
  });
});
