import { describe, expect, it } from "vitest";
import { IndexCoalesce } from "../../src/indexCoalesce";

describe("IndexCoalesce", () => {
  it("allows the first pass, then skips until the gap after finish elapses", () => {
    let t = 1_000;
    const g = new IndexCoalesce(5_000, () => t);
    expect(g.tryStart()).toBe(true);
    t = 7_000; // 6 s of work
    g.finish();
    t = 8_000; // only 1 s after finish
    expect(g.tryStart()).toBe(false);
    t = 12_001;
    expect(g.tryStart()).toBe(true);
  });

  it("does not let a long pass immediately restart (start-based gap would)", () => {
    let t = 0;
    const g = new IndexCoalesce(5_000, () => t);
    expect(g.tryStart()).toBe(true);
    t = 6_000;
    g.finish();
    expect(g.tryStart()).toBe(false);
  });

  it("force bypasses the interval", () => {
    let t = 1_000;
    const g = new IndexCoalesce(5_000, () => t);
    expect(g.tryStart()).toBe(true);
    g.finish();
    t = 1_100;
    expect(g.tryStart({ force: true })).toBe(true);
  });

  it("skips while inFlight unless force", () => {
    const g = new IndexCoalesce(5_000, () => 1_000);
    expect(g.tryStart()).toBe(true);
    expect(g.tryStart()).toBe(false);
    expect(g.tryStart({ force: true })).toBe(true);
    g.finish();
  });
});
