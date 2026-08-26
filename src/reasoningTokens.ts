/**
 * Cross-backend reasoning/thinking token extraction + share formula.
 *
 * Canonical column: `reasoning_tokens` (NULL = never reported, 0 = reported zero).
 * Share = reasoning / output when reasoning is known and output > 0; else null → UI "n/a".
 *
 * Alias map (vendor → canonical). Subset semantics for Claude/OpenAI/Codex;
 * xAI may report reasoning separate from bare completion — callers normalize
 * inclusive output at ingest when needed.
 */

/** Pull a non-negative integer from a usage-shaped object, or null if absent. */
function asTokenCount(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/**
 * Map known vendor keys onto canonical reasoning_tokens.
 * Returns null when no known key is present (do not invent zeros).
 */
export function extractReasoningTokens(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;

  // Flat aliases (Codex rollout / occasional flat Claude)
  const flat =
    asTokenCount(u.reasoning_output_tokens) ??
    asTokenCount(u.reasoning_tokens) ??
    asTokenCount(u.thinking_tokens);
  if (flat != null) return flat;

  // Nested details objects (API shapes)
  const outDetails = u.output_tokens_details;
  if (outDetails && typeof outDetails === "object") {
    const d = outDetails as Record<string, unknown>;
    const nested =
      asTokenCount(d.reasoning_tokens) ?? asTokenCount(d.thinking_tokens);
    if (nested != null) return nested;
  }
  const completionDetails = u.completion_tokens_details;
  if (completionDetails && typeof completionDetails === "object") {
    const d = completionDetails as Record<string, unknown>;
    const nested = asTokenCount(d.reasoning_tokens);
    if (nested != null) return nested;
  }
  return null;
}

/**
 * Reasoning share in [0, 1], or null → UI "n/a".
 * - NULL reasoning → n/a (never treat missing as 0%)
 * - output <= 0 → n/a
 * - reasoning > output (bad / non-normalized data) → n/a (guard)
 */
export function reasoningShare(
  reasoningTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): number | null {
  if (reasoningTokens == null) return null;
  const out = outputTokens ?? 0;
  if (!(out > 0)) return null;
  if (reasoningTokens < 0) return null;
  if (reasoningTokens > out) return null;
  const share = reasoningTokens / out;
  if (!Number.isFinite(share)) return null;
  return Math.min(1, Math.max(0, share));
}

/** Format for UI: "47.4%" / "50%" / "n/a". */
export function formatReasoningShare(
  reasoningTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): string {
  const share = reasoningShare(reasoningTokens, outputTokens);
  if (share == null) return "n/a";
  return `${(share * 100).toFixed(1).replace(/\.0$/, "")}%`;
}
