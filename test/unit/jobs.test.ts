import { describe, expect, it } from "vitest";
import { JobTracker, backoffBudgetMs, formatJobLabel, formatMs } from "../../src/jobs";

describe("JobTracker", () => {
  it("tracks running → ok with elapsed and detail", () => {
    let t = 1_000;
    const j = new JobTracker(10, () => t);
    j.start("index:grok", "index grok");
    j.progress("index:grok", 120, 346);
    t = 5_000;
    j.finish("index:grok", { detail: "parsed 346" });
    expect(j.runningJobs()).toEqual([]);
    const done = j.recentJobs()[0];
    expect(done.phase).toBe("ok");
    expect(done.endedMs).toBe(4_000);
    expect(done.detail).toBe("parsed 346");
  });

  it("statusBarText shows the oldest running job with progress, count of others", () => {
    let t = 1_000;
    const j = new JobTracker(10, () => t);
    j.start("a", "index grok");
    j.progress("a", 120, 346);
    t = 5_000;
    j.start("b", "store sync");
    expect(j.statusBarText(t)).toBe("$(sync~spin) index grok · 120/346 · 4.0s (+1)");
  });

  it("statusBarText shows an unsuperseded error, then hides after a later ok", () => {
    const j = new JobTracker(10, () => 0);
    j.start("x", "index claude");
    j.finish("x", { error: "boom" });
    expect(j.statusBarText(0)).toBe("$(warning) index claude failed");
    j.start("x", "index claude");
    j.finish("x", {});
    expect(j.statusBarText(0)).toBeNull();
  });

  it("keeps only the newest N finished jobs", () => {
    const j = new JobTracker(3, () => 0);
    for (let i = 0; i < 5; i++) {
      j.start(`j${i}`, `job ${i}`);
      j.finish(`j${i}`, {});
    }
    expect(j.recentJobs().map((x) => x.id)).toEqual(["j4", "j3", "j2"]);
  });

  it("notifies listeners on every transition", () => {
    const j = new JobTracker();
    let n = 0;
    const d = j.onChange(() => n++);
    j.start("a", "a");
    j.progress("a", 1, 2);
    j.finish("a", {});
    d.dispose();
    j.start("b", "b");
    expect(n).toBe(3);
  });

  it("formats labels and durations", () => {
    expect(formatMs(900)).toBe("900ms");
    expect(formatMs(9_400)).toBe("9.4s");
    expect(formatMs(59_000)).toBe("59s");
    expect(formatMs(61_000)).toBe("1m1s");
    expect(formatJobLabel({ id: "a", title: "grok", phase: "ok", startedAt: 0, endedMs: 2000 }, 99)).toBe("grok · 2.0s");
  });

  it("backoff budget doubles per failure and caps", () => {
    expect(backoffBudgetMs(45_000, 0, 180_000)).toBe(45_000);
    expect(backoffBudgetMs(45_000, 1, 180_000)).toBe(90_000);
    expect(backoffBudgetMs(45_000, 2, 180_000)).toBe(180_000);
    expect(backoffBudgetMs(45_000, 5, 180_000)).toBe(180_000);
  });
});
