// ReloadGate: fs-event debounce + self-write suppression — fake timers, no vscode.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReloadGate } from "../../src/reloadGate";

describe("ReloadGate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function gate(fire: () => void, opts: { debounce?: number; grace?: number; log?: (l: string) => void } = {}) {
    return new ReloadGate({
      debounceMs: () => opts.debounce ?? 800,
      fire,
      graceMs: opts.grace,
      log: opts.log,
    });
  }

  it("coalesces rapid fs events into one trailing fire", () => {
    const fire = vi.fn();
    const g = gate(fire);
    for (let i = 0; i < 10; i++) {
      expect(g.fsEvent()).toBe(true);
      vi.advanceTimersByTime(100);
    }
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(800);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("mutes events while a mutation is in flight and during the after-grace", () => {
    const fire = vi.fn();
    const g = gate(fire, { grace: 500 });
    g.noteMutationStart();
    expect(g.fsEvent()).toBe(false);
    g.noteMutationEnd();
    expect(g.fsEvent()).toBe(false); // still inside the 500ms grace
    vi.advanceTimersByTime(501);
    expect(g.fsEvent()).toBe(true);
    vi.advanceTimersByTime(800);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("defers a pending debounce across a mutation instead of dropping it", () => {
    const fire = vi.fn();
    const g = gate(fire, { grace: 500 });
    g.fsEvent(); // external change armed us
    g.noteMutationStart();
    vi.advanceTimersByTime(2000); // timer fires mid-mutation → re-arms, no fire
    expect(fire).not.toHaveBeenCalled();
    g.noteMutationEnd();
    vi.advanceTimersByTime(5000); // retries re-arm until past the grace, then fire once
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default debounce when the setting is NaN", () => {
    const fire = vi.fn();
    const g = new ReloadGate({ debounceMs: () => NaN, fire });
    g.fsEvent();
    vi.advanceTimersByTime(799);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("nested mutations suppress until the last one ends", () => {
    const fire = vi.fn();
    const g = gate(fire, { grace: 500 });
    g.noteMutationStart();
    g.noteMutationStart();
    g.noteMutationEnd();
    expect(g.suppressed).toBe(true); // one still in flight (grace aside)
    vi.advanceTimersByTime(1000);
    expect(g.suppressed).toBe(true);
    g.noteMutationEnd();
    vi.advanceTimersByTime(501);
    expect(g.suppressed).toBe(false);
  });

  it("clamps the debounce and re-reads the setting per event", () => {
    const fire = vi.fn();
    let ms = 1; // below the 100ms floor
    const g = new ReloadGate({ debounceMs: () => ms, fire });
    g.fsEvent();
    vi.advanceTimersByTime(99);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
    ms = 50_000; // above the 10s ceiling
    g.fsEvent();
    vi.advanceTimersByTime(10_000);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("dispose cancels a pending fire and refuses new events", () => {
    const fire = vi.fn();
    const g = gate(fire);
    g.fsEvent();
    g.dispose();
    vi.advanceTimersByTime(2000);
    expect(fire).not.toHaveBeenCalled();
    expect(g.fsEvent()).toBe(false);
  });
});
