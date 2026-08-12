// IndexDiagnostics: path+reason logging + toast-once-per-changed-count.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { IndexDiagnostics } from "../../src/indexDiagnostics";

describe("IndexDiagnostics", () => {
  let lines: string[];
  let toasts: { msg: string; items: string[] }[];
  let shown: boolean;
  let diag: IndexDiagnostics;

  beforeEach(() => {
    lines = [];
    toasts = [];
    shown = false;
    diag = new IndexDiagnostics(
      {
        appendLine: (l) => lines.push(l),
        show: () => {
          shown = true;
        },
      },
      (msg, ...items) => {
        toasts.push({ msg, items });
        return Promise.resolve(undefined);
      },
    );
  });

  it("logs path+reason when a source reports errors", () => {
    const n = diag.reportSource("claude", {
      errors: 1,
      error_details: [{ path: "/tmp/a.jsonl", reason: "Unexpected end of JSON" }],
    });
    expect(n).toBe(1);
    expect(lines).toEqual([
      "[index:claude] FAIL /tmp/a.jsonl: Unexpected end of JSON",
      "[index:claude] 1 session file(s) failed to index",
    ]);
  });

  it("is silent when errors === 0", () => {
    diag.reportSource("claude", { errors: 0, error_details: [] });
    diag.maybeToast(0);
    expect(lines).toEqual([]);
    expect(toasts).toEqual([]);
    expect(diag.lastCount).toBe(0);
  });

  it("toasts once per changed total error count", () => {
    diag.reportSource("claude", {
      errors: 2,
      error_details: [
        { path: "/a", reason: "x" },
        { path: "/b", reason: "y" },
      ],
    });
    diag.maybeToast(2);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].msg).toBe("2 session file(s) failed to index");
    expect(toasts[0].items).toEqual(["Show log"]);

    // Same count → no re-toast, no re-log.
    const before = lines.length;
    diag.reportSource("claude", {
      errors: 2,
      error_details: [
        { path: "/a", reason: "x" },
        { path: "/b", reason: "y" },
      ],
    });
    diag.maybeToast(2);
    expect(toasts).toHaveLength(1);
    expect(lines.length).toBe(before);

    // Count changed → toast + log again.
    diag.reportSource("claude", {
      errors: 1,
      error_details: [{ path: "/a", reason: "x" }],
    });
    diag.maybeToast(1);
    expect(toasts).toHaveLength(2);
    expect(toasts[1].msg).toBe("1 session file failed to index");
  });

  it("re-toasts after recovery to zero then new failures", () => {
    diag.maybeToast(3);
    expect(toasts).toHaveLength(1);
    diag.maybeToast(0);
    expect(diag.lastCount).toBe(0);
    diag.maybeToast(3);
    expect(toasts).toHaveLength(2);
  });

  it("Show log opens the channel", async () => {
    const openDiag = new IndexDiagnostics(
      {
        appendLine: () => {},
        show: () => {
          shown = true;
        },
      },
      () => Promise.resolve("Show log"),
    );
    openDiag.maybeToast(1);
    // microtask for the then()
    await Promise.resolve();
    await Promise.resolve();
    expect(shown).toBe(true);
  });

  it("sums multi-source errors for the toast", () => {
    const a = diag.reportSource("claude", {
      errors: 1,
      error_details: [{ path: "/c", reason: "bad" }],
    });
    const b = diag.reportSource("grok", {
      errors: 2,
      error_details: [
        { path: "/g1", reason: "e1" },
        { path: "/g2", reason: "e2" },
      ],
    });
    diag.maybeToast(a + b);
    expect(toasts[0].msg).toBe("3 session file(s) failed to index");
    expect(lines.filter((l) => l.includes("FAIL"))).toHaveLength(3);
  });
});
