/**
 * Multi-window cache safety. Every VS Code window runs its own extension
 * host against the same `sessions-cache.db`. After `code --install-extension`
 * a window that has not reloaded keeps running the OLD build — on 2026-08-30
 * a 1.49.3 window (cross-source eviction bug) kept wiping the grok rows a
 * 1.49.5 window had just indexed. Each pass stamps `writer:<version>`; an
 * older build that sees a newer writer active recently yields (no indexing)
 * instead of fighting it.
 */

export type WriterRow = { name: string; applied_at: number };

export const WRITER_PREFIX = "writer:";
export const WRITER_ACTIVE_WINDOW_MS = 10 * 60_000;

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The newest version (≠ mine) that wrote within the window, or null. */
export function newerWriterActive(
  mine: string,
  rows: WriterRow[],
  now: number,
  windowMs: number = WRITER_ACTIVE_WINDOW_MS,
): string | null {
  let best: string | null = null;
  for (const r of rows) {
    if (!r.name.startsWith(WRITER_PREFIX)) continue;
    const v = r.name.slice(WRITER_PREFIX.length);
    if (now - r.applied_at > windowMs) continue;
    if (compareVersions(v, mine) <= 0) continue;
    if (best === null || compareVersions(v, best) > 0) best = v;
  }
  return best;
}
