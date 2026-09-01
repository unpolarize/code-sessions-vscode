// Unit fixtures for compaction-cliff handoff (pure module, no webview).
// Acceptance from KP ideas/csv-compaction-cliff-cross-backend-handoff-card:
//   - per-backend thresholds (codex early, claude later)
//   - card on synthetic compact markers
//   - handoff pack schema (goal / paths / acceptance / decisions)
//   - recommendation only (autoFailover always false)
//   - user-editable threshold overrides

import { describe, it, expect } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  EMIT_HANDOFF_COMMAND,
  HANDOFF_PACK_SCHEMA,
  buildHandoffPack,
  countCompactionMarkers,
  evaluateCompactionCliff,
  eventsFromConversationTurns,
  renderCliffCardHtml,
  renderCliffCardHtmlForSession,
  renderCliffCardMarkdown,
  resolveCompactionSignals,
  signalsFromExtras,
  thresholdsFor,
} from "../../src/compactionCliff";

describe("DEFAULT_THRESHOLDS", () => {
  it("codex cliffs earlier than claude", () => {
    expect(DEFAULT_THRESHOLDS.codex.warnAtCompacts).toBeLessThan(
      DEFAULT_THRESHOLDS.claude.warnAtCompacts,
    );
    expect(DEFAULT_THRESHOLDS.codex.recommendAtCompacts).toBeLessThan(
      DEFAULT_THRESHOLDS.claude.recommendAtCompacts,
    );
  });
  it("exposes preferHandoffTo lists", () => {
    expect(DEFAULT_THRESHOLDS.codex.preferHandoffTo[0]).toBe("claude");
    expect(DEFAULT_THRESHOLDS.claude.preferHandoffTo).toContain("grok");
  });
});

describe("thresholdsFor", () => {
  it("applies per-backend overrides without mutating defaults", () => {
    const t = thresholdsFor("codex", {
      codex: { warnAtCompacts: 5, preferHandoffTo: ["grok"] },
    });
    expect(t.warnAtCompacts).toBe(5);
    expect(t.recommendAtCompacts).toBe(DEFAULT_THRESHOLDS.codex.recommendAtCompacts);
    expect(t.preferHandoffTo).toEqual(["grok"]);
    expect(DEFAULT_THRESHOLDS.codex.warnAtCompacts).toBe(1);
  });
  it("falls back for unknown backends", () => {
    const t = thresholdsFor("cursor");
    expect(t.warnAtCompacts).toBe(2);
    expect(t.recommendAtCompacts).toBe(3);
  });
});

describe("countCompactionMarkers", () => {
  it("counts synthetic compact markers from fixture transcripts", () => {
    const events = [
      { type: "user", content: "continue" },
      { type: "compaction" },
      { type: "system", subtype: "compact_boundary", content: "Context compacted" },
      "/compact",
      { type: "assistant", content: "ok" },
      { type: "compact" },
    ];
    expect(countCompactionMarkers(events)).toBe(4);
  });
  it("returns 0 for empty / unrelated events", () => {
    expect(countCompactionMarkers([])).toBe(0);
    expect(countCompactionMarkers([{ type: "user" }, { type: "assistant" }])).toBe(0);
  });
});

describe("signalsFromExtras", () => {
  it("reads grok signals.json compaction fields", () => {
    const s = signalsFromExtras(
      "grok",
      {
        compactionCount: 2,
        contextTokensUsed: 180_000,
        contextWindowTokens: 256_000,
        totalTokensBeforeCompaction: 90_000,
        primaryModelId: "grok-4",
      },
      { sessionId: "abc", title: "Long task" },
    );
    expect(s.compactionCount).toBe(2);
    expect(s.contextTokensUsed).toBe(180_000);
    expect(s.model).toBe("grok-4");
    expect(s.sessionId).toBe("abc");
  });
  it("tolerates missing extras", () => {
    const s = signalsFromExtras("claude", null);
    expect(s.compactionCount).toBeNull();
    expect(s.contextTokensUsed).toBeNull();
  });
});

describe("evaluateCompactionCliff", () => {
  it("codex: 0 compacts → ok", () => {
    const card = evaluateCompactionCliff({ source: "codex", compactionCount: 0 });
    expect(card.level).toBe("ok");
    expect(card.recommendBackend).toBeNull();
    expect(card.autoFailover).toBe(false);
  });

  it("codex: 1 compact → approaching (early cliff)", () => {
    const card = evaluateCompactionCliff({ source: "codex", compactionCount: 1 });
    expect(card.level).toBe("approaching");
    expect(card.recommendBackend).toBe("claude");
    expect(card.headline.toLowerCase()).toContain("approaching");
  });

  it("codex: 2 compacts → recommend_handoff with KP cartridge headline", () => {
    const count = countCompactionMarkers([{ type: "compaction" }, { type: "compaction" }]);
    const card = evaluateCompactionCliff({ source: "codex", compactionCount: count });
    expect(card.level).toBe("recommend_handoff");
    expect(card.recommendBackend).toBe("claude");
    expect(card.headline).toMatch(/handoff to claude.*KP cartridge/i);
    expect(card.autoFailover).toBe(false);
  });

  it("claude: 1 compact stays ok (later cliff than codex)", () => {
    const card = evaluateCompactionCliff({ source: "claude", compactionCount: 1 });
    expect(card.level).toBe("ok");
  });

  it("claude: 2 compacts → approaching; 3 → recommend_handoff", () => {
    expect(evaluateCompactionCliff({ source: "claude", compactionCount: 2 }).level).toBe(
      "approaching",
    );
    const card = evaluateCompactionCliff({ source: "claude", compactionCount: 3 });
    expect(card.level).toBe("recommend_handoff");
    expect(card.recommendBackend).toBe("grok");
  });

  it("context fill alone can raise approaching", () => {
    const card = evaluateCompactionCliff({
      source: "codex",
      compactionCount: 0,
      contextTokensUsed: 200_000,
      contextWindowTokens: 256_000, // ~78% > 70% warn
    });
    expect(card.level).toBe("approaching");
    expect(card.contextFill).toBeCloseTo(200_000 / 256_000, 5);
  });

  it("honors threshold overrides", () => {
    const card = evaluateCompactionCliff(
      { source: "codex", compactionCount: 2 },
      { codex: { recommendAtCompacts: 5, warnAtCompacts: 3 } },
    );
    expect(card.level).toBe("ok");
  });

  it("never recommends the same backend as source when alternatives exist", () => {
    const card = evaluateCompactionCliff({ source: "grok", compactionCount: 2 });
    expect(card.recommendBackend).not.toBe("grok");
    expect(card.recommendBackend).toBe("claude");
  });
});

describe("renderCliffCardMarkdown", () => {
  it("renders card fields for a recommend_handoff fixture", () => {
    const card = evaluateCompactionCliff({ source: "codex", compactionCount: 2 });
    const md = renderCliffCardMarkdown(card);
    expect(md).toContain("### Compaction cliff");
    expect(md).toContain("recommend_handoff");
    expect(md).toContain("claude");
    expect(md).toContain("Auto-failover | no");
  });
});

describe("buildHandoffPack", () => {
  it("emits schema + goal/paths/acceptance/decisions", () => {
    const signals = {
      source: "codex" as const,
      compactionCount: 2,
      sessionId: "sess-1",
      title: "Land handoff card",
      goal: "Ship compaction-cliff handoff before quality drop",
      acceptance: ["card renders on fixtures", "pack schema documented"],
      paths: ["src/compactionCliff.ts", "test/unit/compactionCliff.test.ts"],
      projectPath: "/Users/z/projects/unpolarize/code-sessions-vscode",
      model: "gpt-5.3-codex",
      recentDecisions: ["Pure core first", "UI wiring later", "No auto-kill"],
    };
    const card = evaluateCompactionCliff(signals);
    const pack = buildHandoffPack({ signals, card });

    expect(pack).toContain(`schema: ${HANDOFF_PACK_SCHEMA}`);
    expect(pack).toContain("source_session: sess-1");
    expect(pack).toContain("from_backend: codex");
    expect(pack).toContain("to_backend: claude");
    expect(pack).toContain("auto_failover: false");
    expect(pack).toContain("## Goal");
    expect(pack).toContain("Ship compaction-cliff handoff before quality drop");
    expect(pack).toContain("- [ ] card renders on fixtures");
    expect(pack).toContain("`src/compactionCliff.ts`");
    expect(pack).toContain("1. Pure core first");
    expect(pack).toContain("Recommendation only");
  });

  it("falls back when goal/acceptance/paths missing", () => {
    const signals = { source: "claude" as const, compactionCount: 3, title: "Untitled work" };
    const card = evaluateCompactionCliff(signals);
    const pack = buildHandoffPack({ signals, card });
    expect(pack).toContain("Untitled work");
    expect(pack).toContain("_Add acceptance criteria from the KP cartridge_");
    expect(pack).toContain("_No paths listed_");
    expect(pack).toContain("_No decisions captured._");
  });

  it("caps recent decisions at maxDecisions", () => {
    const signals = {
      source: "codex" as const,
      compactionCount: 2,
      recentDecisions: ["a", "b", "c", "d", "e"],
    };
    const card = evaluateCompactionCliff(signals);
    const pack = buildHandoffPack({ signals, card, maxDecisions: 2 });
    expect(pack).toContain("1. a");
    expect(pack).toContain("2. b");
    expect(pack).not.toContain("3. c");
  });
});

describe("eventsFromConversationTurns + resolveCompactionSignals", () => {
  it("counts /compact and compaction phrasing in turn text", () => {
    const events = eventsFromConversationTurns([
      { userText: "please /compact", assistantText: "ok" },
      { userText: "continue", assistantText: "Context compacted successfully" },
    ]);
    expect(countCompactionMarkers(events)).toBe(2);
  });

  it("takes max of extras compactionCount and marker count", () => {
    const events = eventsFromConversationTurns([
      { userText: "/compact", assistantText: null },
    ]);
    const signals = resolveCompactionSignals({
      source: "codex",
      extras: { compactionCount: 2, contextTokensUsed: 200_000, contextWindowTokens: 256_000 },
      events,
      sessionId: "s1",
    });
    expect(signals.compactionCount).toBe(2);
    expect(signals.contextTokensUsed).toBe(200_000);
    const lowExtras = resolveCompactionSignals({
      source: "codex",
      extras: { compactionCount: 0 },
      events,
    });
    expect(lowExtras.compactionCount).toBe(1);
  });
});

describe("renderCliffCardHtml", () => {
  it("hides the card when level is ok", () => {
    const card = evaluateCompactionCliff({ source: "codex", compactionCount: 0 });
    expect(renderCliffCardHtml(card)).toBe("");
    expect(renderCliffCardHtmlForSession(card, "sess")).toBe("");
  });

  it("renders approaching/recommend cards with emit command URI", () => {
    const approaching = evaluateCompactionCliff({ source: "codex", compactionCount: 1 });
    const html = renderCliffCardHtmlForSession(approaching, "sess-cliff");
    expect(html).toContain('class="cc-card"');
    expect(html).toContain(HANDOFF_PACK_SCHEMA);
    expect(html).toContain("approaching");
    expect(html).toContain(`command:${EMIT_HANDOFF_COMMAND}`);
    expect(html).toContain("sess-cliff");
    expect(html).toContain("Emit handoff pack");

    const handoff = evaluateCompactionCliff({ source: "codex", compactionCount: 2 });
    const h2 = renderCliffCardHtmlForSession(handoff, "sess-cliff");
    expect(h2).toContain("recommend_handoff");
    expect(h2).toContain('data-level="recommend_handoff"');
    expect(h2).toContain("claude");
  });

  it("omits command URI when commandUris is false", () => {
    const card = evaluateCompactionCliff({ source: "claude", compactionCount: 3 });
    const html = renderCliffCardHtmlForSession(card, "sess", { commandUris: false });
    expect(html).toContain("cc-card");
    expect(html).not.toContain(`command:${EMIT_HANDOFF_COMMAND}`);
  });
});
