import { describe, expect, it } from "vitest";
import { IndexCoalesce } from "../../src/indexCoalesce";

describe("IndexCoalesce", () => {
  it("allows the first pass, then skips until the interval elapses", () => {
    let t = 1_000;
    const g = new IndexCoalesce(5_000, () => t);
    expect(g.tryStart()).toBe(true);
    g.finish();
    t = 3_000;
    expect(g.tryStart()).toBe(false);
    t = 6_001;
    expect(g.tryStart()).toBe(true);
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
