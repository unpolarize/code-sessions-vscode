import { describe, it, expect } from "vitest";
import { tickFinished } from "../../src/finishedNotify";

describe("tickFinished", () => {
  it("does not fire while the session is still on the board", () => {
    const cards = new Map([["s1", "Work"]]);
    const r = tickFinished({
      prevCards: cards,
      currentCards: cards,
      pending: new Map(),
      now: 10_000,
      graceMs: 300_000,
    });
    expect(r.fire).toEqual([]);
    expect(r.pending.size).toBe(0);
  });

  it("starts pending when a card leaves, fires after grace", () => {
    const prev = new Map([["s1", "Work"]]);
    const empty = new Map<string, string>();
    const mid = tickFinished({
      prevCards: prev,
      currentCards: empty,
      pending: new Map(),
      now: 10_000,
      graceMs: 300_000,
    });
    expect(mid.fire).toEqual([]);
    expect(mid.pending.get("s1")?.title).toBe("Work");

    const late = tickFinished({
      prevCards: empty,
      currentCards: empty,
      pending: mid.pending,
      now: 10_000 + 300_000,
      graceMs: 300_000,
    });
    expect(late.fire).toEqual([{ id: "s1", title: "Work" }]);
    expect(late.pending.size).toBe(0);
  });

  it("cancels pending if the session reappears on the board", () => {
    const pending = new Map([["s1", { title: "Work", leftAt: 0 }]]);
    const r = tickFinished({
      prevCards: new Map(),
      currentCards: new Map([["s1", "Work"]]),
      pending,
      now: 500_000,
      graceMs: 300_000,
    });
    expect(r.fire).toEqual([]);
    expect(r.pending.size).toBe(0);
  });
});
