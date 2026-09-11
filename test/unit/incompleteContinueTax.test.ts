// Fixture tests for the incomplete-continue tax card
// (KP ideas/csv-say-the-word-incomplete-continue-tax-card-de).
// Precision-first phrase detector after ≥1 successful Write/Edit.

import { describe, it, expect } from "vitest";
import {
  COPY_CONTINUE_BINDER_COMMAND,
  INCOMPLETE_CONTINUE_TAX_SCHEMA,
  buildContinueBinder,
  computeIncompleteContinueTax,
  detectSoftAbandon,
  formatIdleMinutes,
  isWriteEditTool,
  looksLikeContinueReply,
  matchSoftAbandonPhrases,
  renderIncompleteContinueTaxHtml,
  sessionsFromStoreRows,
  turnsFromStoreRows,
  type TaxSessionInput,
  type TaxTurn,
} from "../../src/incompleteContinueTax";

const NOW = Date.parse("2026-09-11T18:00:00.000Z");
function localMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
/** Always "today" relative to NOW in the machine's local TZ. */
const T0 = localMidnight(NOW) + 8 * 3600_000;

function write(path = "src/card.ts"): TaxTurn["toolCalls"][number] {
  return { name: "Write", resultIsError: false, input: { file_path: path } };
}

function turn(partial: Partial<TaxTurn> & Pick<TaxTurn, "assistantText">): TaxTurn {
  return {
    toolCalls: [write()],
    turnEndMs: T0,
    nextUserMs: T0 + 12 * 60_000,
    nextUserText: "continue",
    ...partial,
  };
}

function session(partial: Partial<TaxSessionInput> & Pick<TaxSessionInput, "sessionId" | "turns">): TaxSessionInput {
  return {
    source: "claude",
    label: partial.label ?? partial.sessionId,
    goal: "ship the incomplete-continue tax card",
    acceptance: ["detector tests green", "binder copies a non-empty prompt"],
    ...partial,
  };
}

describe("matchSoftAbandonPhrases", () => {
  it("hits known positive phrases", () => {
    expect(matchSoftAbandonPhrases("Say the word if you want me to keep going.")).toContain("say-the-word");
    expect(matchSoftAbandonPhrases("Let me know if you want me to continue.")).toContain("let-me-know-continue");
    expect(matchSoftAbandonPhrases("The rest would be a separate task.")).toContain("rest-separate-task");
    expect(matchSoftAbandonPhrases("Should I continue?")).toContain("should-i-continue");
    expect(matchSoftAbandonPhrases("Happy to continue if you'd like.")).toContain("happy-to-continue");
    expect(matchSoftAbandonPhrases("If you'd like me to continue I can.")).toContain("if-youd-like-continue");
  });

  it("rejects negatives: empty, unrelated, permission-wait-only", () => {
    expect(matchSoftAbandonPhrases("")).toEqual([]);
    expect(matchSoftAbandonPhrases("A separate task queue drains the worker pool.")).toEqual([]);
    expect(matchSoftAbandonPhrases("I need your permission to continue writing.")).toEqual([]);
    expect(matchSoftAbandonPhrases("Waiting for permission before the next edit.")).toEqual([]);
  });
});

describe("detectSoftAbandon", () => {
  it("fires after a successful Write + say-the-word", () => {
    const hit = detectSoftAbandon(
      turn({ assistantText: "Tests are green. Say the word and I'll wire Insights." }),
      NOW,
    );
    expect(hit).not.toBeNull();
    expect(hit!.phrases).toContain("say-the-word");
    expect(hit!.writeCount).toBe(1);
    expect(hit!.openFiles).toEqual(["src/card.ts"]);
    expect(hit!.idleKind).toBe("continue-reply");
    expect(hit!.idleMinutes).toBeCloseTo(12);
  });

  it("fires on Grok search_replace + want-me-to-continue", () => {
    const hit = detectSoftAbandon(
      turn({
        assistantText: "Want me to continue with the remaining files?",
        toolCalls: [{ name: "search_replace", resultIsError: false, input: { file_path: "src/a.ts" } }],
      }),
      NOW,
    );
    expect(hit?.phrases).toContain("want-me-to-continue");
    expect(hit?.openFiles).toEqual(["src/a.ts"]);
  });

  it("fires on Codex apply_patch + rest-would-be-a-separate-task", () => {
    const hit = detectSoftAbandon(
      turn({
        assistantText: "The rest would be a separate task.",
        toolCalls: [{ name: "apply_patch", resultIsError: false }],
      }),
      NOW,
    );
    expect(hit?.phrases).toContain("rest-separate-task");
    expect(hit?.writeCount).toBe(1);
  });

  it("does not fire without a Write/Edit in the turn", () => {
    expect(
      detectSoftAbandon(
        turn({
          assistantText: "Say the word if you want me to start.",
          toolCalls: [{ name: "Read", resultIsError: false, input: { file_path: "src/card.ts" } }],
        }),
        NOW,
      ),
    ).toBeNull();
  });

  it("does not fire when every Write/Edit failed", () => {
    expect(
      detectSoftAbandon(
        turn({
          assistantText: "Say the word and I'll retry.",
          toolCalls: [{ name: "Edit", resultIsError: true, input: { file_path: "src/card.ts" } }],
        }),
        NOW,
      ),
    ).toBeNull();
  });

  it("does not fire on permission-wait copy after an edit", () => {
    expect(
      detectSoftAbandon(
        turn({ assistantText: "I need your permission to continue with the next write." }),
        NOW,
      ),
    ).toBeNull();
  });

  it("treats listed Write/Edit with unknown error as success (store CSV)", () => {
    const hit = detectSoftAbandon(
      turn({
        assistantText: "Let me know if you want me to continue.",
        toolCalls: [{ name: "Edit" }],
      }),
      NOW,
    );
    expect(hit?.writeCount).toBe(1);
  });

  it("attributes still-open idle to now when there is no next user", () => {
    const hit = detectSoftAbandon(
      turn({
        assistantText: "Say the word.",
        nextUserMs: null,
        nextUserText: null,
        turnEndMs: NOW - 5 * 60_000,
      }),
      NOW,
    );
    expect(hit?.idleKind).toBe("still-open");
    expect(hit?.idleMinutes).toBeCloseTo(5);
  });
});

describe("looksLikeContinueReply / write-edit tools", () => {
  it("recognizes short continue replies", () => {
    expect(looksLikeContinueReply("continue")).toBe(true);
    expect(looksLikeContinueReply("yes please")).toBe(true);
    expect(looksLikeContinueReply("go ahead")).toBe(true);
    expect(looksLikeContinueReply("please rewrite the parser from scratch")).toBe(false);
  });

  it("classifies Claude/Grok/Codex write tools", () => {
    expect(isWriteEditTool("Write")).toBe(true);
    expect(isWriteEditTool("Edit")).toBe(true);
    expect(isWriteEditTool("search_replace")).toBe(true);
    expect(isWriteEditTool("apply_patch")).toBe(true);
    expect(isWriteEditTool("fs/write_text_file")).toBe(true);
    expect(isWriteEditTool("Read")).toBe(false);
    expect(isWriteEditTool("Bash")).toBe(false);
  });
});

describe("buildContinueBinder", () => {
  it("copies a non-empty KP-primed prompt with goal, files, acceptance", () => {
    const text = buildContinueBinder(
      {
        sessionId: "sess-1",
        goal: "Detect 80%-then-ask soft-abandons",
        acceptance: ["detector tests green", "card renders on fixture"],
        planningRefs: ["ideas/csv-say-the-word-incomplete-continue-tax-card-de"],
      },
      { phrases: ["say-the-word"], openFiles: ["src/incompleteContinueTax.ts"] },
    );
    expect(text.length).toBeGreaterThan(40);
    expect(text).toMatch(/^Continue\./);
    expect(text).toContain("Detect 80%-then-ask soft-abandons");
    expect(text).toContain("src/incompleteContinueTax.ts");
    expect(text).toContain("detector tests green");
    expect(text).toContain("ideas/csv-say-the-word-incomplete-continue-tax-card-de");
    expect(text).toContain("say-the-word");
    expect(text.toLowerCase()).not.toContain("auto-send");
  });

  it("stays non-empty when goal/files/acceptance are missing", () => {
    const text = buildContinueBinder(
      { sessionId: "bare" },
      { phrases: [], openFiles: [] },
    );
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).toContain("bare");
  });
});

describe("computeIncompleteContinueTax", () => {
  const claude = session({
    sessionId: "claude-1",
    source: "claude",
    label: "Claude say-the-word",
    turns: [turn({ assistantText: "Say the word if you want the Insights wiring." })],
  });
  const grok = session({
    sessionId: "grok-1",
    source: "grok",
    label: "Grok continue-offer",
    turns: [
      turn({
        assistantText: "Let me know if you want me to continue.",
        toolCalls: [{ name: "write", resultIsError: false, input: { filePath: "src/b.ts" } }],
        turnEndMs: T0 + 60_000,
        nextUserMs: T0 + 60_000 + 6 * 60_000,
        nextUserText: "ok",
      }),
    ],
  });
  const clean = session({
    sessionId: "clean-1",
    source: "codex",
    turns: [turn({ assistantText: "All done. Tests green." })],
  });

  it("counts soft-abandons per session and sums idle minutes", () => {
    const card = computeIncompleteContinueTax([claude, grok, clean], { nowMs: NOW });
    expect(card.schema).toBe(INCOMPLETE_CONTINUE_TAX_SCHEMA);
    expect(card.abandonCount).toBe(2);
    expect(card.sessionCount).toBe(2);
    expect(card.idleMinutes).toBeCloseTo(18);
    expect(card.todayCount).toBe(2);
    expect(card.examples.map((e) => e.sessionId).sort()).toEqual(["claude-1", "grok-1"]);
    expect(card.examples.every((e) => e.binder.trim().length > 0)).toBe(true);
  });

  it("returns zeros for an empty corpus (no fake tax)", () => {
    const card = computeIncompleteContinueTax([], { nowMs: NOW });
    expect(card.abandonCount).toBe(0);
    expect(card.sessionCount).toBe(0);
    expect(card.examples).toEqual([]);
    expect(card.todayCount).toBe(0);
  });

  it("does not count yesterday's hit in todayCount", () => {
    const midnight = localMidnight(NOW);
    const yesterday = session({
      sessionId: "old-1",
      turns: [
        turn({
          assistantText: "Say the word.",
          turnEndMs: midnight - 60_000,
          nextUserMs: midnight - 30_000,
        }),
      ],
    });
    const card = computeIncompleteContinueTax([yesterday], { nowMs: NOW });
    expect(card.abandonCount).toBe(1);
    expect(card.todayCount).toBe(0);
  });
});

describe("turnsFromStoreRows / sessionsFromStoreRows", () => {
  it("wires next-user from the following store turn and COALESCE assistant_full", () => {
    const turns = turnsFromStoreRows([
      {
        turn_index: 0,
        user_text: "ship the card",
        assistant_excerpt: "Say the word",
        assistant_full: "Say the word if you want me to continue.",
        tool_names_csv: "Write,Read",
        started_at: T0 - 5_000,
        ended_at: T0,
      },
      {
        turn_index: 1,
        user_text: "continue",
        assistant_excerpt: "done",
        tool_names_csv: "",
        started_at: T0 + 12 * 60_000,
        ended_at: T0 + 13 * 60_000,
      },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].assistantText).toContain("Say the word if you want me");
    expect(turns[0].nextUserText).toBe("continue");
    expect(turns[0].nextUserMs).toBe(T0 + 12 * 60_000);
    expect(turns[0].toolCalls.map((t) => t.name)).toEqual(["Write", "Read"]);
  });

  it("joins extras acceptance + planning_refs onto the session", () => {
    const turns = turnsFromStoreRows([
      {
        turn_index: 0,
        assistant_excerpt: "Say the word.",
        tool_names_csv: "Edit",
        ended_at: T0,
      },
    ]);
    const sessions = sessionsFromStoreRows(
      [
        {
          session_id: "s1",
          source: "claude",
          title: "fixture",
          first_user_msg: "goal text",
          extras_json: JSON.stringify({
            planning_refs: ["ideas/csv-say-the-word-incomplete-continue-tax-card-de"],
            acceptance: ["binder copies a non-empty prompt"],
          }),
        },
      ],
      new Map([["s1", turns]]),
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0].planningRefs).toEqual(["ideas/csv-say-the-word-incomplete-continue-tax-card-de"]);
    expect(sessions[0].acceptance).toEqual(["binder copies a non-empty prompt"]);
    expect(sessions[0].goal).toContain("goal text");
  });
});

describe("renderIncompleteContinueTaxHtml", () => {
  it("renders schema, chips, example deep-links, and copy-binder command", () => {
    const card = computeIncompleteContinueTax(
      [
        session({
          sessionId: "claude-1",
          source: "claude",
          label: "Claude say-the-word",
          turns: [turn({ assistantText: "Say the word if you want the Insights wiring." })],
        }),
      ],
      { nowMs: NOW },
    );
    const html = renderIncompleteContinueTaxHtml(card);
    expect(html).toContain(INCOMPLETE_CONTINUE_TAX_SCHEMA);
    expect(html).toContain("Incomplete-continue tax");
    expect(html).toContain("command:codeSessions.openSession?");
    expect(html).toContain(`command:${COPY_CONTINUE_BINDER_COMMAND}?`);
    expect(html).toContain("Continue binder");
    expect(html).toContain("Does not auto-send");
    expect(html).toContain("claude");
    expect(html).not.toContain("<script");
    expect(html).toContain("today");
  });

  it("renders empty string when nothing scored", () => {
    expect(renderIncompleteContinueTaxHtml(computeIncompleteContinueTax([], { nowMs: NOW }))).toBe("");
    expect(
      renderIncompleteContinueTaxHtml(
        computeIncompleteContinueTax(
          [session({ sessionId: "x", turns: [turn({ assistantText: "all done" })] })],
          { nowMs: NOW },
        ),
      ),
    ).toBe("");
  });

  it("formats idle minutes for chips", () => {
    expect(formatIdleMinutes(0.5)).toBe("30s");
    expect(formatIdleMinutes(12)).toBe("12m");
    expect(formatIdleMinutes(90)).toBe("1.5h");
  });
});
