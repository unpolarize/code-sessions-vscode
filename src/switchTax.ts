// Context-switch tax meter (KP ideas/csv-toxic-flow-context-switch-tax-meter-count-hu).
// Pure module — no vscode imports — so the aggregator is fixture-testable.
//
// The host records a FocusEvent each time a session view gains focus
// (session id + backend only; never keystrokes or content). The aggregator
// collapses same-session refocuses and sub-debounce flickers, then prices
// each remaining switch at a flat research-backed penalty (Mark et al.'s
// ~23 s refocus cost is the v1 constant; callers may override).

export interface FocusEvent {
  sessionId: string;
  backend: string;
  ts: number;
}

export interface SwitchTaxSummary {
  /** Distinct session-to-session focus transitions after debounce/collapse. */
  switchCount: number;
  /** Median seconds spent on a session between switches (closed dwells only);
   * null when no completed dwell exists yet. */
  medianDwellS: number | null;
  /** switchCount × taxSecondsPerSwitch, in minutes. */
  taxMinutes: number;
}

export const DEFAULT_TAX_SECONDS_PER_SWITCH = 23;
export const FLICKER_DEBOUNCE_MS = 300;

export interface AggregateOptions {
  /** Inclusive lower bound on event ts (e.g. local midnight). */
  since?: number;
  /** Exclusive upper bound on event ts; also closes the final dwell. */
  until?: number;
  debounceMs?: number;
  taxSecondsPerSwitch?: number;
  /** Treat the final in-window segment as still open (skip its flicker
   * check). Live "today so far" summaries set this so a switch made moments
   * before `until`=now isn't dropped as a sub-debounce flicker. */
  finalDwellOpen?: boolean;
}

/**
 * Aggregate raw focus events into today's switch economics.
 *
 * A focus segment shorter than debounceMs (the pane flashed past — e.g.
 * VS Code cycling panels during a layout restore) is dropped entirely, so
 * A→B(120ms)→A counts zero switches. Consecutive events for the same
 * session merge into one segment.
 */
export function aggregateSwitchTax(events: FocusEvent[], opts: AggregateOptions = {}): SwitchTaxSummary {
  const debounceMs = opts.debounceMs ?? FLICKER_DEBOUNCE_MS;
  const taxPerSwitchS = opts.taxSecondsPerSwitch ?? DEFAULT_TAX_SECONDS_PER_SWITCH;
  const since = opts.since ?? -Infinity;
  const until = opts.until ?? Infinity;

  const inWindow = events
    .filter((e) => e.ts >= since && e.ts < until)
    .slice()
    .sort((a, b) => a.ts - b.ts);

  // Pass 1: drop flicker segments. A segment's dwell runs from its event to
  // the next event (or `until` for the last one; open-ended = kept).
  const kept: FocusEvent[] = [];
  for (let i = 0; i < inWindow.length; i++) {
    const isLast = i + 1 >= inWindow.length;
    const end = isLast ? until : inWindow[i + 1].ts;
    if (!(isLast && opts.finalDwellOpen) && Number.isFinite(end) && end - inWindow[i].ts < debounceMs) continue;
    kept.push(inWindow[i]);
  }

  // Pass 2: collapse consecutive same-session segments, count switches and
  // collect closed dwell durations (time on a session until the next switch).
  let switchCount = 0;
  const dwellsMs: number[] = [];
  let segStart: number | null = null;
  let segSession: string | null = null;
  for (const e of kept) {
    if (segSession === e.sessionId) continue;
    if (segSession !== null && segStart !== null) {
      switchCount++;
      dwellsMs.push(e.ts - segStart);
    }
    segSession = e.sessionId;
    segStart = e.ts;
  }

  return {
    switchCount,
    medianDwellS: dwellsMs.length ? median(dwellsMs) / 1000 : null,
    taxMinutes: (switchCount * taxPerSwitchS) / 60,
  };
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function startOfDayMs(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const MAX_EVENTS = 5000;
const RETAIN_MS = 48 * 3600_000;

/**
 * In-memory recorder the host feeds from view-focus hooks. Rapid same-session
 * re-records (< debounce) dedupe at write time — slower same-session
 * refocuses still append and the aggregator collapses them. The buffer
 * self-prunes to the last 48 h / 5000 events; state does not survive an
 * extension-host restart (v1 limitation — "today" restarts with the host).
 */
export class SwitchTaxRecorder {
  private events: FocusEvent[] = [];

  record(sessionId: string, backend: string, ts: number = Date.now()): void {
    if (!sessionId) return;
    const last = this.events[this.events.length - 1];
    // Same session regaining focus (alt-tab away to the editor and back) is
    // not a cross-session switch — but a *later* refocus after visiting
    // another session must land as a fresh event, so only adjacent dedupe.
    if (last && last.sessionId === sessionId && ts - last.ts < FLICKER_DEBOUNCE_MS) return;
    this.events.push({ sessionId, backend, ts });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    const cutoff = ts - RETAIN_MS;
    if (this.events.length && this.events[0].ts < cutoff) {
      this.events = this.events.filter((e) => e.ts >= cutoff);
    }
  }

  eventsSnapshot(): FocusEvent[] {
    return this.events.slice();
  }

  summarizeToday(now: number = Date.now(), opts: Omit<AggregateOptions, "since" | "until"> = {}): SwitchTaxSummary {
    return aggregateSwitchTax(this.events, { ...opts, since: startOfDayMs(now), until: now, finalDwellOpen: true });
  }

  clear(): void {
    this.events = [];
  }
}

/** Shared recorder instance for the extension host (tests construct their own). */
export const switchTaxRecorder = new SwitchTaxRecorder();
