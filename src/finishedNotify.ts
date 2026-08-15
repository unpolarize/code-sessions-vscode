/**
 * "Session finished" toast state machine.
 *
 * A session is finished only once it *leaves the live-monitor board*
 * (mtime older than the active window — the file is no longer being
 * written). Status flipping to `idle` while the card is still on the
 * board is thinking / a long script / a gap between turns — not done.
 *
 * Pending toasts wait `graceMs` so a brief drop off the board (indexer
 * lag, clock skew) does not fire. Reappearance cancels the pending toast.
 */

export interface FinishedPending {
  title: string;
  leftAt: number;
}

export interface FinishedTick {
  fire: Array<{ id: string; title: string }>;
  pending: Map<string, FinishedPending>;
}

export function tickFinished(opts: {
  prevCards: Map<string, string>;
  currentCards: Map<string, string>;
  pending: Map<string, FinishedPending>;
  now: number;
  graceMs: number;
}): FinishedTick {
  const next = new Map(opts.pending);
  for (const id of opts.currentCards.keys()) next.delete(id);
  for (const [id, title] of opts.prevCards) {
    if (!opts.currentCards.has(id) && !next.has(id)) {
      next.set(id, { title, leftAt: opts.now });
    }
  }
  const fire: Array<{ id: string; title: string }> = [];
  for (const [id, p] of [...next]) {
    if (opts.now - p.leftAt < opts.graceMs) continue;
    fire.push({ id, title: p.title });
    next.delete(id);
  }
  return { fire, pending: next };
}
