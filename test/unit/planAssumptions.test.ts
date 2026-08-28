// Unit fixtures for plan-assumption checklist (pure module, no webview).
// Acceptance from KP ideas/csv-plan-assumption-checklist-card-extract-plan:
//   - fixture plan transcript → card renders ≥3 items
//   - dismiss + accept paths
//   - Start build / Promote to KP gated until resolved or skip-with-reason
//   - KP ## Constraints write-back formatter

import { describe, it, expect } from "vitest";
import {
  ASSUMPTION_CARD_SCHEMA,
  ASSUMPTION_COUNT,
  buildAssumptionChecklist,
  detectPlanPhase,
  evaluateChecklistGate,
  extractAssumptions,
  formatConstraintsMarkdown,
  renderAssumptionCardMarkdown,
  setItemState,
  setSkipReason,
  turnsFromTexts,
  type PlanTurn,
} from "../../src/planAssumptions";

/** Synthetic plan-mode transcript with ≥3 extractable assumptions. */
const PLAN_FIXTURE: PlanTurn[] = [
  {
    role: "user",
    phase: "plan",
    content: "How should we land the CSV card? Enter plan mode.",
  },
  {
    role: "assistant",
    phase: "plan",
    content: [
      "Planning approach:",
      "",
      "I assume the night-build branch is already clean and up to date.",
      "I'll use vitest for the unit fixtures rather than mocha.",
      "Defaulting to a pure core module with no vscode imports.",
      "",
      "Given that the UI wiring lands in a later slice, we keep markdown render only.",
      "",
      "1. Will write `src/planAssumptions.ts` first",
      "2. Prefer heuristic extraction over an LLM call",
      "3. Skip marketplace publish in this session",
    ].join("\n"),
  },
];

describe("detectPlanPhase", () => {
  it("detects explicit plan phase markers", () => {
    expect(detectPlanPhase(PLAN_FIXTURE)).toBe(true);
  });
  it("detects /plan in content without phase field", () => {
    expect(
      detectPlanPhase([{ role: "user", content: "Please /plan the refactor" }]),
    ).toBe(true);
  });
  it("returns false for ordinary build chats", () => {
    expect(
      detectPlanPhase([
        { role: "user", content: "Fix the flaky test" },
        { role: "assistant", content: "Looking at the assertion…" },
      ]),
    ).toBe(false);
  });
});

describe("extractAssumptions", () => {
  it("extracts ≥3 candidates from the plan fixture", () => {
    const found = extractAssumptions(PLAN_FIXTURE);
    expect(found.length).toBeGreaterThanOrEqual(ASSUMPTION_COUNT.min);
    expect(found.length).toBeLessThanOrEqual(ASSUMPTION_COUNT.max);
    const texts = found.map((f) => f.text.toLowerCase()).join(" | ");
    expect(texts).toMatch(/night-build|vitest|pure core|ui wiring|heuristic/);
  });

  it("dedupes near-identical lines", () => {
    const turns = turnsFromTexts([
      "I assume the API is stable.\nI assume the API is stable.",
      "I assume the API is stable.",
    ]);
    const found = extractAssumptions(turns);
    expect(found.filter((f) => /api is stable/i.test(f.text))).toHaveLength(1);
  });

  it("caps at ASSUMPTION_COUNT.max", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `I assume fact number ${i} holds.`);
    const found = extractAssumptions(turnsFromTexts([lines.join("\n")]));
    expect(found).toHaveLength(ASSUMPTION_COUNT.max);
  });

  it("returns [] on empty / unrelated turns", () => {
    expect(extractAssumptions([])).toEqual([]);
    expect(
      extractAssumptions([
        { role: "assistant", content: "Sure, I'll look into that." },
      ]),
    ).toEqual([]);
  });
});

describe("buildAssumptionChecklist + gate", () => {
  it("builds a plan card with ≥3 unchecked items and blocks Start build", () => {
    const card = buildAssumptionChecklist({
      turns: PLAN_FIXTURE,
      source: "claude",
      sessionId: "sess-plan-1",
    });
    expect(card.isPlanPhase).toBe(true);
    expect(card.items.length).toBeGreaterThanOrEqual(3);
    expect(card.items.every((i) => i.state === "unchecked")).toBe(true);
    expect(card.headline.toLowerCase()).toMatch(/assumption/);

    const gate = evaluateChecklistGate(card);
    expect(gate.startBuildEnabled).toBe(false);
    expect(gate.promoteToKpEnabled).toBe(false);
    expect(gate.uncheckedCount).toBe(card.items.length);
    expect(gate.blockedReason).toMatch(/unchecked/i);
  });

  it("accept path: checking all items opens the gate", () => {
    let card = buildAssumptionChecklist({
      turns: PLAN_FIXTURE,
      source: "grok",
      sessionId: "sess-plan-2",
    });
    for (const it of card.items) {
      card = setItemState(card, it.id, "checked");
    }
    const gate = evaluateChecklistGate(card);
    expect(gate.startBuildEnabled).toBe(true);
    expect(gate.promoteToKpEnabled).toBe(true);
    expect(gate.uncheckedCount).toBe(0);
    expect(gate.blockedReason).toBeNull();
  });

  it("dismiss path: dismissed items count as resolved", () => {
    let card = buildAssumptionChecklist({
      turns: PLAN_FIXTURE,
      source: "codex",
    });
    for (const it of card.items) {
      card = setItemState(card, it.id, "dismissed");
    }
    const gate = evaluateChecklistGate(card);
    expect(gate.startBuildEnabled).toBe(true);
    expect(gate.promoteToKpEnabled).toBe(true);
  });

  it("skip-with-reason opens the gate while leaving items unchecked", () => {
    let card = buildAssumptionChecklist({
      turns: PLAN_FIXTURE,
      source: "claude",
    });
    expect(evaluateChecklistGate(card).startBuildEnabled).toBe(false);
    card = setSkipReason(card, "Human already validated offline");
    const gate = evaluateChecklistGate(card);
    expect(gate.startBuildEnabled).toBe(true);
    expect(gate.promoteToKpEnabled).toBe(true);
    expect(gate.uncheckedCount).toBeGreaterThan(0);
    expect(card.skipReason).toBe("Human already validated offline");
  });

  it("empty skip reason does not open the gate", () => {
    let card = buildAssumptionChecklist({ turns: PLAN_FIXTURE, source: "claude" });
    card = setSkipReason(card, "   ");
    expect(card.skipReason).toBeNull();
    expect(evaluateChecklistGate(card).startBuildEnabled).toBe(false);
  });

  it("non-plan chats do not block Start build", () => {
    const card = buildAssumptionChecklist({
      turns: [{ role: "assistant", content: "I assume nothing special here." }],
      source: "claude",
    });
    expect(card.isPlanPhase).toBe(false);
    expect(evaluateChecklistGate(card).startBuildEnabled).toBe(true);
  });

  it("forcePlanPhase surfaces weak cards", () => {
    const card = buildAssumptionChecklist({
      turns: [{ role: "assistant", content: "Hello" }],
      forcePlanPhase: true,
    });
    expect(card.isPlanPhase).toBe(true);
    expect(card.items).toHaveLength(0);
    expect(card.headline.toLowerCase()).toMatch(/no extractable/);
  });
});

describe("formatConstraintsMarkdown", () => {
  it("emits ## Constraints with checked items only", () => {
    let card = buildAssumptionChecklist({
      turns: PLAN_FIXTURE,
      source: "claude",
      sessionId: "sess-kp",
    });
    card = setItemState(card, card.items[0].id, "checked");
    if (card.items[1]) card = setItemState(card, card.items[1].id, "dismissed");
    const md = formatConstraintsMarkdown(card);
    expect(md).toContain("## Constraints");
    expect(md).toContain(ASSUMPTION_CARD_SCHEMA);
    expect(md).toContain(`- [x] ${card.items[0].text}`);
    if (card.items[1]) {
      expect(md).not.toContain(card.items[1].text);
    }
  });

  it("records skip reason in the constraints block", () => {
    let card = buildAssumptionChecklist({ turns: PLAN_FIXTURE, source: "grok" });
    card = setSkipReason(card, "Already mirrored in KP");
    const md = formatConstraintsMarkdown(card);
    expect(md).toMatch(/Skip reason:.*Already mirrored in KP/);
  });
});

describe("renderAssumptionCardMarkdown", () => {
  it("renders a markdown card with checkboxes and gate status", () => {
    const card = buildAssumptionChecklist({
      turns: PLAN_FIXTURE,
      source: "claude",
      sessionId: "sess-md",
    });
    const md = renderAssumptionCardMarkdown(card);
    expect(md).toContain("### Plan assumption checklist");
    expect(md).toContain("Start build");
    expect(md).toContain("blocked");
    expect(md).toMatch(/\[ \]/);
  });
});
