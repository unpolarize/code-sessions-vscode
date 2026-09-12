// As-if-API Grok cost estimates (USD per 1M tokens).
//
// Grok Build on SuperGrok is a subscription — the CLI does not persist a
// billed `cost_usd`. CSV still wants a Claude-comparable dollar so day-group
// totals can include [G] sessions. Source of truth is index-time
// `session.cost_usd` (same column Claude writes), computed from envelope
// token counts × this table. Display/aggregation just sum that column.
//
// List prices: xAI short-context Text API (docs.x.ai/developers/pricing,
// 2026-09). Cache-write is unpublished; we use 1.25× input (Claude's ratio)
// so a cache-creation row is not silently $0. Override the table at the
// function argument — never scatter literals at call sites.

export interface GrokModelRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface GrokTokenUsage {
  /** Uncached prompt tokens (cache reads are a separate bucket). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Built-in USD / 1M-token table. Keys are model-id prefixes. */
export const GROK_API_PRICES: Record<string, GrokModelRates> = {
  "grok-4.6": { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2.5 },
  "grok-4.5": { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 2.5 },
};

export const GROK_DEFAULT_MODEL_KEY = "grok-4.6";

export type GrokCostTokenSource = "usage.json" | "signals.contextTokensUsed" | "none";

/** Process-local override (VS Code `codeSessions.grokApiPrices`, tests). */
let grokPriceOverrides: Record<string, Partial<GrokModelRates>> | null = null;

export function setGrokPriceOverrides(
  overrides: Record<string, Partial<GrokModelRates>> | null | undefined,
): void {
  grokPriceOverrides =
    overrides && Object.keys(overrides).length > 0 ? overrides : null;
}

export function activeGrokPriceTable(): Record<string, GrokModelRates> {
  return mergeGrokPriceTable(grokPriceOverrides);
}

export function mergeGrokPriceTable(
  overrides?: Record<string, Partial<GrokModelRates>> | null,
): Record<string, GrokModelRates> {
  if (!overrides || Object.keys(overrides).length === 0) return GROK_API_PRICES;
  const out: Record<string, GrokModelRates> = { ...GROK_API_PRICES };
  for (const [key, partial] of Object.entries(overrides)) {
    const k = key.toLowerCase();
    const base = out[k] ?? GROK_API_PRICES[GROK_DEFAULT_MODEL_KEY]!;
    out[k] = {
      input: numOr(partial.input, base.input),
      output: numOr(partial.output, base.output),
      cacheRead: numOr(partial.cacheRead, base.cacheRead),
      cacheWrite: numOr(partial.cacheWrite, base.cacheWrite),
    };
  }
  return out;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Pick rates for a grok model id. Unknown / missing → grok-4.6 (not $0). */
export function grokRatesForModel(
  model: string | null | undefined,
  table: Record<string, GrokModelRates> = activeGrokPriceTable(),
): { rates: GrokModelRates; family: string; key: string } {
  const m = (model ?? "").toLowerCase();
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (m.includes(key)) {
      return { rates: table[key]!, family: key, key };
    }
  }
  const fallback = table[GROK_DEFAULT_MODEL_KEY] ?? GROK_API_PRICES[GROK_DEFAULT_MODEL_KEY]!;
  return { rates: fallback, family: `${GROK_DEFAULT_MODEL_KEY} (default)`, key: GROK_DEFAULT_MODEL_KEY };
}

/**
 * Grok `usage.json` `inputTokens` is a full-prompt sum (cache reads included),
 * matching ACP PromptUsage. Store uncached input separately so the Claude-shaped
 * columns (input / cache_read / cache_write / output) stay exclusive.
 */
export function splitGrokPromptTokens(
  inputIncludingCache: number,
  cacheReadTokens: number,
): { uncached: number; cacheRead: number } {
  const inT = Math.max(0, inputIncludingCache || 0);
  const cr = Math.max(0, cacheReadTokens || 0);
  return { uncached: Math.max(0, inT - cr), cacheRead: cr };
}

/** USD = sum(tokens × $/M) / 1e6, rounded to 4 dp (matches Claude indexer). */
export function estimateGrokCostUsd(
  usage: GrokTokenUsage,
  model?: string | null,
  table: Record<string, GrokModelRates> = activeGrokPriceTable(),
): number {
  const { rates } = grokRatesForModel(model, table);
  const dollars =
    (Math.max(0, usage.inputTokens) * rates.input +
      Math.max(0, usage.outputTokens) * rates.output +
      Math.max(0, usage.cacheReadTokens) * rates.cacheRead +
      Math.max(0, usage.cacheWriteTokens) * rates.cacheWrite) /
    1_000_000;
  return Number(dollars.toFixed(4));
}

/** True when extras already carry a grok cost stamp (skip one-shot reindex). */
export function grokCostStampPresent(extrasJson: string | null | undefined): boolean {
  if (!extrasJson) return false;
  try {
    const o = JSON.parse(extrasJson);
    return typeof o?.cost_token_source === "string";
  } catch {
    return false;
  }
}

/** Pull session-level token totals out of grok's `usage.json` blob. */
export function grokUsageFromBlob(blob: unknown): {
  usage: GrokTokenUsage;
  reasoningTokens: number | null;
  model: string | null;
} | null {
  if (!blob || typeof blob !== "object" || Array.isArray(blob)) return null;
  const session = (blob as { session?: unknown }).session;
  const src =
    session && typeof session === "object" && !Array.isArray(session)
      ? (session as Record<string, unknown>)
      : (blob as Record<string, unknown>);
  const input = asNonNegInt(src.inputTokens ?? src.input_tokens);
  const output = asNonNegInt(src.outputTokens ?? src.output_tokens);
  const cacheRead = asNonNegInt(src.cachedReadTokens ?? src.cache_read_tokens ?? src.cacheReadTokens);
  const cacheWrite = asNonNegInt(
    src.cacheCreationTokens ?? src.cache_write_tokens ?? src.cacheWriteTokens,
  );
  if (input == null && output == null && cacheRead == null && cacheWrite == null) return null;
  const split = splitGrokPromptTokens(input ?? 0, cacheRead ?? 0);
  const reasoning = asNonNegInt(src.reasoningTokens ?? src.reasoning_tokens);
  const modelRaw = src.primaryModelId ?? src.primary_model_id ?? src.model;
  const model = typeof modelRaw === "string" && modelRaw.trim() ? modelRaw : null;
  return {
    usage: {
      inputTokens: split.uncached,
      outputTokens: output ?? 0,
      cacheReadTokens: split.cacheRead,
      cacheWriteTokens: cacheWrite ?? 0,
    },
    reasoningTokens: reasoning,
    model,
  };
}

function asNonNegInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.max(0, Math.round(v));
}
