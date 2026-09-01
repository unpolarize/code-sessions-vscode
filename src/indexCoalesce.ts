/** Minimum quiet time **after a pass finishes** before another background index. */
export const INDEX_MIN_INTERVAL_MS = 15_000;

/**
 * Shared gate for watchers and timers. The gap is measured from **finish**,
 * not start: a 6 s grok pass must not immediately start another (that was a
 * ~1.0 duty cycle on the extension host).
 * User-initiated `force` always runs.
 */
export class IndexCoalesce {
  private lastFinished = 0;
  private inFlight = false;

  constructor(
    private readonly minIntervalMs = INDEX_MIN_INTERVAL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * `force` — user-initiated; always runs.
   * `priority` — one-shot boot catch-up: skips the quiet gap (a Claude
   * turn-complete pass finishing 1 s earlier must not drop it) but still
   * yields to an in-flight pass.
   */
  tryStart(opts: { force?: boolean; priority?: boolean } = {}): boolean {
    if (opts.force) {
      this.inFlight = true;
      return true;
    }
    if (this.inFlight) return false;
    if (opts.priority) {
      this.inFlight = true;
      return true;
    }
    const t = this.now();
    if (this.lastFinished > 0 && t - this.lastFinished < this.minIntervalMs) return false;
    this.inFlight = true;
    return true;
  }

  finish(): void {
    this.inFlight = false;
    this.lastFinished = this.now();
  }
}
