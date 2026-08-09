// Gate + trailing debounce for fs-sourced planning reloads.
//
// The KP-store FileSystemWatcher must be a dirty bit, not a direct re-export
// trigger: rapid events collapse into one trailing fire, and events caused by
// our own CLI mutations (kp edit/set-status/… writing the store) are dropped —
// while a mutation is in flight plus a short grace after it lands, since every
// mutation call site already does an explicit post-mutation reload. Deliberately
// vscode-free so unit tests can drive it with a fake clock.

export interface ReloadGateOptions {
  /** trailing debounce for fs events, read per event (setting can change) */
  debounceMs: () => number;
  /** the coalesced reload — runs at most once per quiet period */
  fire: () => void;
  /** suppress window after a mutation finishes (default 500ms; keep ≤500 or external captures get dropped) */
  graceMs?: number;
  log?: (line: string) => void;
  /** test seams */
  now?: () => number;
}

export class ReloadGate {
  private mutationDepth = 0;
  private graceUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private opts: ReloadGateOptions) {}

  private nowMs(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  noteMutationStart(): void {
    this.mutationDepth++;
  }

  noteMutationEnd(): void {
    this.mutationDepth = Math.max(0, this.mutationDepth - 1);
    this.graceUntil = this.nowMs() + (this.opts.graceMs ?? 500);
  }

  /** True while our own CLI write (or its short after-grace) should mute fs events. */
  get suppressed(): boolean {
    return this.mutationDepth > 0 || this.nowMs() < this.graceUntil;
  }

  /** One fs event. Returns true if it (re)armed the debounce, false if muted. */
  fsEvent(): boolean {
    if (this.disposed || this.suppressed) return false;
    this.arm(this.debounce());
    return true;
  }

  private debounce(): number {
    const ms = this.opts.debounceMs();
    return Number.isFinite(ms) ? Math.min(10_000, Math.max(100, ms)) : 800;
  }

  private arm(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed) return;
      if (this.suppressed) {
        // A mutation started while the debounce was pending. The external change
        // that armed us must not be lost: retry once the grace can have passed.
        // Loop-free — self-write events never arm (fsEvent mutes them).
        this.arm((this.opts.graceMs ?? 500) + this.debounce());
        return;
      }
      this.opts.log?.("[planning] reload source=fs");
      this.opts.fire();
    }, ms);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
