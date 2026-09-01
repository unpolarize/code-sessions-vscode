/**
 * Uniform job/status vocabulary for every long-running operation the
 * extension performs or observes (index passes, store git sync, daemon
 * connect, kp export). Pure — no vscode — so unit tests drive it directly.
 *
 * Spec: architecture/tools/specs/2026-08-31-async-jobs-status-design.md (R2/R4):
 * every long operation is a visible job; nothing fails silently.
 */

export type JobPhase = "running" | "ok" | "error";

export interface Job {
  id: string;
  title: string;
  phase: JobPhase;
  startedAt: number;
  endedMs?: number;
  done?: number;
  total?: number;
  /** One-line outcome (e.g. `parsed 346 · removed 0`). */
  detail?: string;
  error?: string;
}

export class JobTracker {
  private readonly running = new Map<string, Job>();
  private readonly finished: Job[] = [];
  private readonly listeners: Array<() => void> = [];

  constructor(
    private readonly cap = 10,
    private readonly now: () => number = Date.now,
  ) {}

  onChange(fn: () => void): { dispose(): void } {
    this.listeners.push(fn);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(fn);
        if (i >= 0) this.listeners.splice(i, 1);
      },
    };
  }

  private fire(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* listener errors never break the tracker */
      }
    }
  }

  /** Begin (or restart) a job. Restarting an id replaces the running entry. */
  start(id: string, title: string): void {
    this.running.set(id, { id, title, phase: "running", startedAt: this.now() });
    this.fire();
  }

  progress(id: string, done: number, total: number): void {
    const j = this.running.get(id);
    if (!j) return;
    j.done = done;
    j.total = total;
    this.fire();
  }

  finish(id: string, outcome: { detail?: string; error?: string } = {}): void {
    const j = this.running.get(id);
    if (!j) return;
    this.running.delete(id);
    const ended: Job = {
      ...j,
      phase: outcome.error ? "error" : "ok",
      endedMs: this.now() - j.startedAt,
      detail: outcome.detail,
      error: outcome.error,
    };
    this.finished.unshift(ended);
    if (this.finished.length > this.cap) this.finished.pop();
    this.fire();
  }

  runningJobs(): Job[] {
    return [...this.running.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  recentJobs(): Job[] {
    return [...this.finished];
  }

  /** Latest finished error that has not been superseded by a later ok of the same id. */
  lastError(): Job | null {
    const okSeen = new Set<string>();
    for (const j of this.finished) {
      if (j.phase === "ok") okSeen.add(j.id);
      else if (!okSeen.has(j.id)) return j;
    }
    return null;
  }

  /**
   * Status-bar text: running job (oldest first) with progress + elapsed,
   * else a warning for the latest unsuperseded error, else null (hide).
   */
  statusBarText(now: number = this.now()): string | null {
    const running = this.runningJobs();
    if (running.length > 0) {
      const j = running[0];
      const extra = running.length > 1 ? ` (+${running.length - 1})` : "";
      return `$(sync~spin) ${formatJobLabel(j, now)}${extra}`;
    }
    const err = this.lastError();
    if (err) return `$(warning) ${err.title} failed`;
    return null;
  }
}

/** `grok 120/346 · 4s` / `store sync · 2s`. */
export function formatJobLabel(j: Job, now: number): string {
  const parts: string[] = [j.title];
  if (j.total && j.total > 0) parts.push(`${j.done ?? 0}/${j.total}`);
  const elapsed = j.phase === "running" ? now - j.startedAt : (j.endedMs ?? 0);
  parts.push(`${formatMs(elapsed)}`);
  return parts.join(" · ");
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** Exponential budget: base·2^streak, capped. Used by kp export Retry (issue #3). */
export function backoffBudgetMs(baseMs: number, failStreak: number, capMs: number): number {
  return Math.min(baseMs * Math.pow(2, Math.max(0, failStreak)), capMs);
}

// Module-level bridge so files that cannot see the activate() closure
// (planning.ts) can register jobs. Set once during activate.
let _tracker: JobTracker | undefined;
export function setGlobalJobTracker(t: JobTracker | undefined): void {
  _tracker = t;
}
export function globalJobTracker(): JobTracker | undefined {
  return _tracker;
}
