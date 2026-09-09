// Cross-vendor quota-reset wall-clock: joins per-backend quota/limit reset
// signals (Claude 5h session cap, Codex rolling-window rate limits + banked
// credits; Cursor when telemetry lands) into one "when can I work next?"
// answer. Pure module — no vscode, no fs, injected `now` — per house rules.
//
// v1 is read-only over signals already present in local transcript tails:
//   - Codex rollouts: `event_msg` / `token_count` payloads carry
//     `rate_limits.{primary,secondary}` with `used_percent`, `window_minutes`
//     and `resets_at` (epoch seconds), plus an optional `credits` block.
//   - Claude Code: on a 5h-cap hit the transcript records a synthetic
//     "…usage limit reached|<epoch>" message (pipe-delimited reset epoch).
// A backend with no visible signal is simply omitted — we never invent times.

export type QuotaBackendId = "claude" | "codex" | "cursor" | string;

export interface QuotaResetSignal {
  backend: QuotaBackendId;
  /** Human window label: "5h", "7d", "30d", "banked". */
  label: string;
  /** Epoch ms when this window resets; null for signals with no clock
   * (e.g. a banked-credit balance). */
  resetAt: number | null;
  /** 0–100 percent of the window consumed, when the backend reports it. */
  usedPct: number | null;
  /** True when the window is spent — this backend is unusable until resetAt. */
  exhausted: boolean;
  /** Epoch ms the signal was observed (transcript event timestamp). */
  observedAt: number;
  /** Optional extra (e.g. banked-credit balance). */
  detail?: string;
}

export interface QuotaResetCard {
  /** Deduped (latest observation per backend+label), soonest reset first;
   * clock-less rows last. */
  rows: QuotaResetSignal[];
  /** Earliest reset among currently-exhausted backends — the "next workable
   * window". Null when nothing is exhausted (workable right now). */
  nextWorkableAt: number | null;
}

/** "5h" / "7d" style label for a rolling window length in minutes. */
function windowLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "window";
  if (minutes < 90) return `${Math.round(minutes)}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/** Parse a Codex rollout JSONL tail for the most recent `rate_limits` block.
 * Scans backwards (same idiom as contextTokensFromTail); malformed lines are
 * skipped. Returns [] when no rate_limits event is visible in the tail. */
export function extractCodexQuotaSignals(tail: string): QuotaResetSignal[] {
  const lines = tail.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj: any;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue; // partial / non-JSON line
    }
    const rl = obj?.payload?.rate_limits;
    if (!rl || typeof rl !== "object") continue;
    const observedAt = Date.parse(obj.timestamp ?? "") || 0;
    const out: QuotaResetSignal[] = [];
    for (const key of ["primary", "secondary"] as const) {
      const win = rl[key];
      if (!win || typeof win.window_minutes !== "number") continue;
      const usedPct = typeof win.used_percent === "number" ? win.used_percent : null;
      out.push({
        backend: "codex",
        label: windowLabel(win.window_minutes),
        resetAt: typeof win.resets_at === "number" ? win.resets_at * 1000 : null,
        usedPct,
        // rate_limit_reached_type names which window tripped — only that
        // window is exhausted, not both.
        exhausted: (usedPct !== null && usedPct >= 100) || rl.rate_limit_reached_type === key,
        observedAt,
      });
    }
    const credits = rl.credits;
    if (credits && credits.has_credits === true && credits.unlimited !== true) {
      out.push({
        backend: "codex",
        label: "banked",
        resetAt: null,
        usedPct: null,
        exhausted: false,
        observedAt,
        detail: credits.balance != null ? `balance ${credits.balance}` : undefined,
      });
    }
    if (out.length > 0) return out;
  }
  return [];
}

// Claude Code writes "Claude AI usage limit reached|<epoch-seconds>" (older
// builds) or "…usage limit reached|<epoch-ms>" into the transcript when the
// 5h session cap trips. The pipe-delimited epoch is the reset time.
const CLAUDE_LIMIT_RE = /usage limit reached\|(\d{10,13})/gi;

/** Parse a Claude Code JSONL tail for the most recent 5h-cap marker. */
export function extractClaudeQuotaSignals(tail: string, observedAt: number): QuotaResetSignal[] {
  let last: number | null = null;
  for (const m of tail.matchAll(CLAUDE_LIMIT_RE)) {
    const raw = Number(m[1]);
    last = raw < 1e12 ? raw * 1000 : raw; // 10-digit → seconds, 13-digit → ms
  }
  if (last === null) return [];
  return [
    {
      backend: "claude",
      label: "5h",
      resetAt: last,
      usedPct: 100,
      exhausted: true,
      observedAt,
    },
  ];
}

/** Join per-backend signals into one card. Dedupes to the latest observation
 * per backend+label, drops rows whose reset is already in the past (the
 * window has re-opened — a stale "exhausted" must not park the chip), and
 * picks the earliest reset among exhausted backends as the next workable
 * window. Returns null when no live signal survives — the chip is omitted
 * entirely rather than rendered empty. */
export function buildQuotaResetCard(
  signals: QuotaResetSignal[],
  now: number,
): QuotaResetCard | null {
  const latest = new Map<string, QuotaResetSignal>();
  for (const s of signals) {
    const key = `${s.backend}|${s.label}`;
    const prev = latest.get(key);
    if (!prev || s.observedAt >= prev.observedAt) latest.set(key, s);
  }
  const rows = [...latest.values()]
    .filter((s) => s.resetAt === null || s.resetAt > now)
    .sort((a, b) => (a.resetAt ?? Infinity) - (b.resetAt ?? Infinity));
  if (rows.length === 0) return null;
  let nextWorkableAt: number | null = null;
  for (const s of rows) {
    if (s.exhausted && s.resetAt !== null) {
      nextWorkableAt = nextWorkableAt === null ? s.resetAt : Math.min(nextWorkableAt, s.resetAt);
    }
  }
  return { rows, nextWorkableAt };
}

/** Wall-clock text for a reset epoch: "14:05" today, "Tue 14:05" otherwise. */
export function fmtWallClock(ms: number, now: number): string {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const a = new Date(ms);
  const b = new Date(now);
  const sameDay =
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay) return hm;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  return `${wd} ${hm}`;
}

/** Chip strings for the live-monitor summary strip. `value` is the headline
 * ("open" when nothing is exhausted, else the next workable wall-clock);
 * `title` is the tooltip: one line per backend window plus the
 * multi-subscription intent. Null passes the omit through. */
export function formatQuotaResetChip(
  card: QuotaResetCard | null,
  now: number,
): { value: string; title: string } | null {
  if (!card) return null;
  const lines = card.rows.map((s) => {
    const when = s.resetAt !== null ? `resets ${fmtWallClock(s.resetAt, now)}` : (s.detail ?? "no clock");
    const pct = s.usedPct !== null ? ` · ${Math.round(s.usedPct)}%` : "";
    return `${s.backend} ${s.label} — ${when}${pct}${s.exhausted ? " · exhausted" : ""}`;
  });
  const value =
    card.nextWorkableAt !== null ? `⏳ ${fmtWallClock(card.nextWorkableAt, now)}` : "open";
  const title =
    lines.join("\n") +
    "\n\nWhen can I work next across all subscriptions (Claude 5h/weekly, Codex windows/banked, Cursor pool)? " +
    "Earliest reset among exhausted backends; backends with no visible reset signal are omitted.";
  return { value, title };
}
