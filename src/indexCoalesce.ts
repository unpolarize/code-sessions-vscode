/** Minimum gap between CSV index passes (performance.md #6). */
export const INDEX_MIN_INTERVAL_MS = 5000;

/**
 * Shared gate for the JSONL watcher (1.5 s debounce) and the 10 s timer.
 * User-initiated `force` always runs. Single-threaded callers cannot overlap
 * a sync pass; `inFlight` is for a future async worker.
 */
export class IndexCoalesce {
  private lastStarted = 0;
  private inFlight = false;

  constructor(
    private readonly minIntervalMs = INDEX_MIN_INTERVAL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  tryStart(opts: { force?: boolean } = {}): boolean {
    if (opts.force) {
      this.inFlight = true;
      this.lastStarted = this.now();
      return true;
    }
    if (this.inFlight) return false;
    const t = this.now();
    if (this.lastStarted > 0 && t - this.lastStarted < this.minIntervalMs) return false;
    this.inFlight = true;
    this.lastStarted = t;
    return true;
  }

  finish(): void {
    this.inFlight = false;
  }
}
