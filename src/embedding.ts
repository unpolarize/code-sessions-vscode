// Session embedding: Ollama if reachable + has the model, otherwise a
// deterministic hashed-bag-of-words vector as a no-dep fallback.
//
// We deliberately do NOT pull in Transformers.js here — that would bloat the
// extension by ~80 MB on first run. The fallback is good enough for clustering
// by project name + tool mix + simple keyword overlap.

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

/**
 * Probe the Ollama daemon, return true if reachable AND the requested model is
 * available. 250 ms timeout — we don't want to hang the user's session.
 */
export async function probeOllama(cfg: EmbedConfig): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const u = new URL("/api/tags", cfg.ollamaUrl);
      const req = http.get(
        { hostname: u.hostname, port: u.port || 80, path: u.pathname, timeout: 250 },
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

/**
 * Embed many sessions. Tries Ollama first if preferred==='ollama' and probe
 * succeeded; otherwise uses the deterministic fallback. The actual model id
 * is returned so we can persist it.
 */
export async function embedMany(
  reqs: EmbedRequest[],
  cfg: EmbedConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<{ model: string; results: Array<{ session_id: string; embedding: Float32Array }> }> {
  const useOllama = cfg.preferred === "ollama" && (await probeOllama(cfg));
  const model = useOllama ? `ollama/${cfg.ollamaModel}` : `fallback/hash-bow-${FALLBACK_DIM}`;
  const results: Array<{ session_id: string; embedding: Float32Array }> = [];
  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i];
    let embedding: Float32Array;
    if (useOllama) {
      try {
        embedding = await embedOllamaOne(r.text, cfg);
      } catch {
        // First failure: drop to fallback for THIS item to avoid stalling the
        // whole pass. Real fix is to surface the error and retry.
        embedding = fallbackEmbed(r.text);
      }
    } else {
      embedding = fallbackEmbed(r.text);
    }
    results.push({ session_id: r.session_id, embedding });
    if (onProgress) onProgress(i + 1, reqs.length);
  }
  return { model, results };
}
