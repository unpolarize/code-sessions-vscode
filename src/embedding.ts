// Session embedding: Ollama if reachable + has the model, otherwise a
// deterministic hashed-bag-of-words vector as a no-dep fallback.
//
// We deliberately do NOT pull in Transformers.js here — that would bloat the
// extension by ~80 MB on first run. The fallback is good enough for clustering
// by project name + tool mix + simple keyword overlap.
//
// Invariant: never persist a vector under a model id whose dimension differs
// from that model's native size. Per-item Ollama failures are retried then
// skipped (left unembedded for the next pass) — never replaced with the
// 256-dim hash-BoW under an `ollama/*` tag (that poisons UMAP geometry).

import * as http from "http";

export interface EmbedConfig {
  preferred: "ollama" | "transformersjs" | "fallback";
  ollamaUrl: string;
  ollamaModel: string;
}

export interface EmbedResult {
  embedding: Float32Array;
  model: string;
}

const FALLBACK_DIM = 256;

/** Max retries after the first failed Ollama call for one item (total attempts = 1 + max). */
const OLLAMA_MAX_RETRIES = 2;
/** Base backoff between Ollama retries (ms); doubles each attempt. */
const OLLAMA_RETRY_BASE_MS = 200;

/**
 * Probe the Ollama daemon, return true if reachable AND the requested model is
 * available. 2 s timeout — Electron's first call on cold start can spend a
 * couple hundred ms in process setup; 250 ms was too tight and produced
 * false-negatives (the agent graph silently fell back to hashed-BoW).
 */
export async function probeOllama(cfg: EmbedConfig): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const u = new URL("/api/tags", cfg.ollamaUrl);
      const req = http.get(
        { hostname: u.hostname, port: u.port || 80, path: u.pathname, timeout: 2000 },
        (res) => {
          let body = "";
          res.setEncoding("utf-8");
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              const obj = JSON.parse(body);
              const models: string[] = (obj?.models ?? []).map((m: any) => String(m?.name ?? ""));
              const wanted = cfg.ollamaModel.toLowerCase();
              const ok = models.some((m) => m.toLowerCase().startsWith(wanted));
              resolve(ok);
            } catch {
              resolve(false);
            }
          });
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

/** Get one embedding via Ollama's /api/embeddings. Throws on HTTP failure. */
async function embedOllamaOne(text: string, cfg: EmbedConfig): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const u = new URL("/api/embeddings", cfg.ollamaUrl);
    const payload = JSON.stringify({ model: cfg.ollamaModel, prompt: text });
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        method: "POST",
        timeout: 30_000,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const obj = JSON.parse(body);
            if (!Array.isArray(obj?.embedding)) return reject(new Error("no embedding in response"));
            resolve(Float32Array.from(obj.embedding));
          } catch (e: any) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("ollama timeout"));
    });
    req.write(payload);
    req.end();
  });
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "of", "to", "in", "on", "for",
  "with", "by", "at", "from", "as", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "have", "has", "had", "will", "would", "should", "can", "could",
  "this", "that", "it", "its", "they", "them", "their", "i", "you", "we", "my", "your",
  "me", "us", "him", "her", "he", "she", "what", "which", "who", "why", "how", "when",
  "where", "all", "no", "not", "so", "very", "just", "too",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-/.]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && t.length <= 32 && !STOPWORDS.has(t));
}

/** Hash-based bag-of-words: deterministic FALLBACK_DIM-vector. */
function fallbackEmbed(text: string): Float32Array {
  const v = new Float32Array(FALLBACK_DIM);
  for (const tok of tokenize(text)) {
    // Two-hash trick (rolling) to reduce collisions
    let h1 = 5381;
    let h2 = 0x1505;
    for (let i = 0; i < tok.length; i++) {
      const c = tok.charCodeAt(i);
      h1 = ((h1 << 5) + h1 + c) | 0;
      h2 = (h2 * 33) ^ c;
    }
    const i1 = (h1 >>> 0) % FALLBACK_DIM;
    const i2 = (h2 >>> 0) % FALLBACK_DIM;
    v[i1] += 1;
    v[i2] += 1;
  }
  // L2-normalize
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

export interface EmbedRequest {
  session_id: string;
  text: string;
}

/** Injectable seams for unit tests (default = real HTTP + setTimeout). */
export interface EmbedManyDeps {
  probe?: (cfg: EmbedConfig) => Promise<boolean>;
  embedOllama?: (text: string, cfg: EmbedConfig) => Promise<Float32Array>;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call Ollama for one text with short exponential backoff. Returns null after
 * the final failure so the caller can skip (never substitute a different dim).
 */
async function embedOllamaWithRetry(
  text: string,
  cfg: EmbedConfig,
  embedOne: (text: string, cfg: EmbedConfig) => Promise<Float32Array>,
  sleep: (ms: number) => Promise<void>,
): Promise<Float32Array | null> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= OLLAMA_MAX_RETRIES; attempt++) {
    try {
      return await embedOne(text, cfg);
    } catch (e) {
      lastErr = e;
      if (attempt < OLLAMA_MAX_RETRIES) {
        await sleep(OLLAMA_RETRY_BASE_MS * 2 ** attempt);
      }
    }
  }
  void lastErr;
  return null;
}

/**
 * Keep rows whose embedding length equals the modal dimension in the batch.
 * Mixed-dim rows (e.g. legacy 256-dim poison under an ollama model tag) are
 * dropped so UMAP always receives a rectangular matrix.
 */
export function filterSameDimEmbeddings<T extends { embedding: Float32Array }>(
  rows: T[],
): { kept: T[]; dropped: T[]; dim: number | null } {
  if (rows.length === 0) return { kept: [], dropped: [], dim: null };
  const counts = new Map<number, number>();
  for (const r of rows) {
    const d = r.embedding.length;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let dim = 0;
  let best = -1;
  for (const [d, n] of counts) {
    if (n > best || (n === best && d > dim)) {
      best = n;
      dim = d;
    }
  }
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const r of rows) {
    if (r.embedding.length === dim) kept.push(r);
    else dropped.push(r);
  }
  return { kept, dropped, dim };
}

/**
 * Embed many sessions. Tries Ollama first if preferred==='ollama' and probe
 * succeeded; otherwise uses the deterministic fallback. The actual model id
 * is returned so we can persist it.
 *
 * When the batch is Ollama-tagged, per-item failures are retried then **skipped**
 * (omitted from `results`, listed in `skipped`) so a different-dimension
 * fallback vector is never stored under `ollama/*`. Callers leave those
 * sessions unembedded so `sessionsMissingEmbedding` retries next pass.
 */
export async function embedMany(
  reqs: EmbedRequest[],
  cfg: EmbedConfig,
  onProgress?: (done: number, total: number) => void,
  deps: EmbedManyDeps = {},
): Promise<{
  model: string;
  results: Array<{ session_id: string; embedding: Float32Array }>;
  skipped: string[];
}> {
  const probe = deps.probe ?? probeOllama;
  const embedOne = deps.embedOllama ?? embedOllamaOne;
  const sleep = deps.sleep ?? defaultSleep;

  const useOllama = cfg.preferred === "ollama" && (await probe(cfg));
  const model = useOllama ? `ollama/${cfg.ollamaModel}` : `fallback/hash-bow-${FALLBACK_DIM}`;
  const results: Array<{ session_id: string; embedding: Float32Array }> = [];
  const skipped: string[] = [];

  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i];
    if (useOllama) {
      const embedding = await embedOllamaWithRetry(r.text, cfg, embedOne, sleep);
      if (embedding) {
        results.push({ session_id: r.session_id, embedding });
      } else {
        // Leave unembedded under this model id so the next index pass retries.
        skipped.push(r.session_id);
      }
    } else {
      results.push({ session_id: r.session_id, embedding: fallbackEmbed(r.text) });
    }
    if (onProgress) onProgress(i + 1, reqs.length);
  }
  return { model, results, skipped };
}
