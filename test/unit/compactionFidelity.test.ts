// Fixture tests for the compaction fidelity leaderboard
// (KP ideas/csv-compaction-fidelity-leaderboard-cross-backen).
// Multi-backend compact events × KP Acceptance bullets; v1 substring heuristic.

import { describe, it, expect } from "vitest";
import {
  COMPACTION_FIDELITY_SCHEMA,
  DEFAULT_MIN_COMPACT_EVENTS,
  EXPORT_FIDELITY_JSON_COMMAND,
  MIN_BULLET_CHARS,
  bulletRetained,
  computeCompactionFidelity,
  exportCompactionFidelityJson,
  extractAcceptanceBullets,
  formatCompactionFidelityJson,
  normalizeBullet,
  observationsFromSessionRows,
  postCompactCorpus,
  renderCompactionFidelitySectionHtml,
  type FidelityObservation,
} from "../../src/compactionFidelity";

const CLAUDE_KEEP = "card renders with fixture multi-backend compact events";
const CLAUDE_DROP = "click-through lists example sessions that drove the score";
const CODEX_KEEP = "minimum sample filter so empty corpus does not fake ranks";
const CODEX_DROP = "json export matches on-screen ranks for night reports";
const GROK_KEEP = "read-only over session store plus kp links";

function obs(partial: Partial<FidelityObservation> & Pick<FidelityObservation, "sessionId" | "source">): FidelityObservation {
  return {
    compactCount: 1,
    planningRefs: ["ideas/csv-compaction-fidelity-leaderboard-cross-backen"],
    acceptance: [CLAUDE_KEEP, CLAUDE_DROP],
    postCompactText: "",
    ...partial,
  };
}

/** Claude keeps both bullets after compact (high fidelity). */
function claudeHigh(n: number): FidelityObservation {
  return obs({
    sessionId: `claude-hi-${n}`,
    source: "claude",
    label: `Claude keep-both ${n}`,
    compactCount: 1,
    postCompactText: `Handoff pack\n- ${CLAUDE_KEEP}\n- ${CLAUDE_DROP}\ncontinue on grok`,
  });
}

/** Codex keeps 1 of 2 (lobotomy). */
function codexLow(n: number): FidelityObservation {
  return obs({
    sessionId: `codex-lo-${n}`,
    source: "codex",
    label: `Codex drop-half ${n}`,
    compactCount: 1,
    acceptance: [CODEX_KEEP, CODEX_DROP],
    postCompactText: `After compact the only recoverable criterion is: ${CODEX_KEEP}`,
  });
}

/** Grok keeps 2 of 3 (middle fidelity). */
function grokMid(n: number): FidelityObservation {
  return obs({
    sessionId: `grok-mid-${n}`,
    source: "grok",
    label: `Grok keep-two-of-three ${n}`,
    compactCount: 2,
    acceptance: [GROK_KEEP, CLAUDE_DROP, CLAUDE_KEEP],
    postCompactText: `post-compact notes mention ${GROK_KEEP} and ${CLAUDE_KEEP} but not the click-through.`,
  });
}

describe("helpers", () => {
  it("normalizes list markers, checkboxes, and case", () => {
    expect(normalizeBullet("- [x] Card Renders With Fixture Multi-Backend Compact Events")).toBe(
      CLAUDE_KEEP.toLowerCase(),
    );
    expect(normalizeBullet("  *   " + CLAUDE_KEEP)).toBe(CLAUDE_KEEP.toLowerCase());
  });

  it("retains a bullet by substring and rejects missing / too-short", () => {
    const hay = `notes: ${CLAUDE_KEEP}. done.`;
    expect(bulletRetained(CLAUDE_KEEP, hay)).toBe(true);
    expect(bulletRetained(CLAUDE_KEEP.toUpperCase(), hay)).toBe(true);
    expect(bulletRetained(CLAUDE_DROP, hay)).toBe(false);
    expect(bulletRetained("ok", hay)).toBe(false);
    expect(bulletRetained("x".repeat(MIN_BULLET_CHARS - 1), hay)).toBe(false);
  });

  it("extracts Acceptance bullets from a KP-shaped markdown body", () => {
    const md = `# Title\n\n## Acceptance\n- ${CLAUDE_KEEP}\n- [ ] ${CLAUDE_DROP}\n\n## Constraints\n- do not invent ranks\n`;
    expect(extractAcceptanceBullets(md)).toEqual([CLAUDE_KEEP, CLAUDE_DROP]);
  });

  it("splits post-compact corpus after the last compact boundary", () => {
    const events = [
      { type: "user", content: CLAUDE_KEEP },
      { type: "compaction", compactMetadata: { preTokens: 80_000 } },
      { type: "assistant", content: `still here: ${CLAUDE_KEEP}` },
    ];
    const c = postCompactCorpus(events);
    expect(c.compactCount).toBe(1);
    expect(c.postCompactText).toContain(CLAUDE_KEEP);
    expect(postCompactCorpus([{ type: "user", content: "hi" }]).compactCount).toBe(0);
  });
});

describe("computeCompactionFidelity", () => {
  const corpus = [claudeHigh(1), claudeHigh(2), codexLow(1), codexLow(2), grokMid(1)];

  it("ranks backends by retained/total Acceptance bullets (claude > grok > codex)", () => {
    const board = computeCompactionFidelity(corpus);
    expect(board.schema).toBe(COMPACTION_FIDELITY_SCHEMA);
    expect(board.minCompactEvents).toBe(DEFAULT_MIN_COMPACT_EVENTS);
    const ranked = board.ranks.filter((r) => r.ranked);
    expect(ranked.map((r) => r.backend)).toEqual(["claude", "grok", "codex"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(ranked[0].fidelity).toBe(1);
    expect(ranked[1].fidelity).toBeCloseTo(2 / 3);
    expect(ranked[2].fidelity).toBe(0.5);
  });

  it("excludes unlinked, never-compacted, and no-post-text sessions from the denominator", () => {
    const board = computeCompactionFidelity([
      ...corpus,
      obs({ sessionId: "dark-1", source: "claude", planningRefs: [], acceptance: [], compactCount: 3, postCompactText: CLAUDE_KEEP }),
      obs({ sessionId: "fresh-1", source: "claude", compactCount: 0, postCompactText: CLAUDE_KEEP }),
      obs({ sessionId: "silent-1", source: "claude", compactCount: 2, postCompactText: "   " }),
    ]);
    expect(board.excludedUnlinked).toBe(1);
    expect(board.excludedNoCompact).toBe(1);
    expect(board.excludedNoText).toBe(1);
    const claude = board.ranks.find((r) => r.backend === "claude");
    expect(claude?.linkedSessions).toBe(2);
  });

  it("does not rank a backend below the minimum compact-event sample", () => {
    const board = computeCompactionFidelity([claudeHigh(1), claudeHigh(2), grokMid(1)], {
      minCompactEvents: 3,
    });
    const grok = board.ranks.find((r) => r.backend === "grok");
    const claude = board.ranks.find((r) => r.backend === "claude");
    expect(claude?.ranked).toBe(false);
    expect(claude?.rank).toBeNull();
    expect(grok?.ranked).toBe(false);
    expect(board.ranks[0].ranked).toBe(false);
  });

  it("lists 1–3 worst-fidelity example sessions per backend", () => {
    const mixedClaude: FidelityObservation[] = [
      claudeHigh(1),
      obs({
        sessionId: "claude-worst",
        source: "claude",
        label: "Claude lost a bullet",
        compactCount: 1,
        postCompactText: CLAUDE_KEEP,
      }),
    ];
    const board = computeCompactionFidelity(mixedClaude);
    const claude = board.ranks.find((r) => r.backend === "claude");
    expect(claude?.examples[0].sessionId).toBe("claude-worst");
    expect(claude?.examples[0].fidelity).toBe(0.5);
    expect(claude!.examples.length).toBeLessThanOrEqual(3);
  });

  it("returns an empty ranks list for an empty corpus (no fake ranks)", () => {
    const board = computeCompactionFidelity([]);
    expect(board.ranks).toEqual([]);
    expect(board.excludedUnlinked).toBe(0);
  });
});

describe("JSON export matches on-screen ranks", () => {
  it("export ranks[] order equals HTML table backend order", () => {
    const board = computeCompactionFidelity([
      claudeHigh(1),
      claudeHigh(2),
      codexLow(1),
      codexLow(2),
      grokMid(1),
    ]);
    const json = exportCompactionFidelityJson(board);
    expect(json.schema).toBe(COMPACTION_FIDELITY_SCHEMA);
    expect(json.ranks.map((r) => r.backend)).toEqual(board.ranks.map((r) => r.backend));
    expect(json.ranks.map((r) => r.rank)).toEqual(board.ranks.map((r) => r.rank));
    expect(json.ranks.map((r) => r.fidelity)).toEqual(board.ranks.map((r) => r.fidelity));

    const html = renderCompactionFidelitySectionHtml(board);
    const backendsInHtml: string[] = [];
    const re = /<td class="cff-backend">([^<]+)<\/td>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) backendsInHtml.push(m[1]);
    expect(backendsInHtml).toEqual(json.ranks.map((r) => r.backend));
  });
});

describe("renderCompactionFidelitySectionHtml", () => {
  it("renders schema, ranks, example deep-links, and export command", () => {
    const board = computeCompactionFidelity([
      claudeHigh(1),
      claudeHigh(2),
      codexLow(1),
      codexLow(2),
      grokMid(1),
    ]);
    const html = renderCompactionFidelitySectionHtml(board);
    expect(html).toContain(COMPACTION_FIDELITY_SCHEMA);
    expect(html).toContain("Compaction fidelity");
    expect(html).toContain("anti-lobotomy");
    expect(html).toContain("command:codeSessions.openSession?");
    expect(html).toContain(`command:${EXPORT_FIDELITY_JSON_COMMAND}?`);
    expect(html).toContain("Export JSON");
    expect(html).toContain("claude");
    expect(html).toContain("codex");
    expect(html).toContain("grok");
    expect(html).toContain("never triggers a compact");
    expect(html).not.toContain("<script");
  });

  it("renders empty string when nothing scored", () => {
    expect(renderCompactionFidelitySectionHtml(computeCompactionFidelity([]))).toBe("");
    expect(
      renderCompactionFidelitySectionHtml(
        computeCompactionFidelity([
          obs({ sessionId: "x", source: "claude", compactCount: 0, postCompactText: "n/a" }),
        ]),
      ),
    ).toBe("");
  });

  it("pretty JSON export is parseable and round-trips ranks", () => {
    const board = computeCompactionFidelity([claudeHigh(1), claudeHigh(2)]);
    const parsed = JSON.parse(formatCompactionFidelityJson(board));
    expect(parsed.ranks[0].backend).toBe("claude");
    expect(parsed.ranks[0].ranked).toBe(true);
  });
});

describe("observationsFromSessionRows", () => {
  it("reads compact count, planning_refs, and acceptance from extras_json", () => {
    const rows = observationsFromSessionRows([
      {
        session_id: "s1",
        source: "claude",
        title: "fixture session",
        extras_json: JSON.stringify({
          compactionCount: 2,
          planning_refs: ["ideas/csv-compaction-fidelity-leaderboard-cross-backen"],
          acceptance: [CLAUDE_KEEP],
          postCompactText: CLAUDE_KEEP,
        }),
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].compactCount).toBe(2);
    expect(rows[0].planningRefs).toEqual(["ideas/csv-compaction-fidelity-leaderboard-cross-backen"]);
    expect(rows[0].acceptance).toEqual([CLAUDE_KEEP]);
    expect(rows[0].postCompactText).toContain(CLAUDE_KEEP);
  });

  it("joins KP acceptance maps and first_user_msg ## Acceptance fallback", () => {
    const fromMap = observationsFromSessionRows(
      [
        {
          session_id: "s-map",
          source: "codex",
          extras_json: JSON.stringify({
            compactionCount: 1,
            planning_refs: ["ideas/foo"],
          }),
        },
      ],
      { acceptanceByKpId: new Map([["ideas/foo", [CODEX_KEEP]]]), postCompactText: new Map([["s-map", CODEX_KEEP]]) },
    );
    expect(fromMap[0].acceptance).toEqual([CODEX_KEEP]);
    expect(fromMap[0].postCompactText).toBe(CODEX_KEEP);

    const fromPrompt = observationsFromSessionRows([
      {
        session: "s-prompt",
        source: "grok",
        first_user_msg: `## Acceptance\n- ${GROK_KEEP}\n`,
        extras_json: JSON.stringify({ compactionCount: 1, planning_refs: ["ideas/bar"] }),
      },
    ]);
    expect(fromPrompt[0].acceptance).toEqual([GROK_KEEP]);
  });
});
