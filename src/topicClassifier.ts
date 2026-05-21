// Topic classification via `claude -p` (subscription, NOT API).
//
// Phase 1A (this version): on-demand per session. The user clicks
// "Analyze topics" in the conversation viewer; we batch the session's turns
// into one or more `claude -p` invocations and upsert results into
// `turn_topic`.
//
// IMPORTANT: never set ANTHROPIC_API_KEY when spawning `claude`; that would
// switch off subscription billing.

import { execFile } from "child_process";
import * as crypto from "crypto";
import * as http from "http";
import { SessionStore, TurnRow } from "./db";

const PROMPT_REV = 2;

const SYSTEM_PROMPT_CLAUDE = `You classify Claude Code conversation turns into short topic labels (2-5 words, lowercase, dashes between words). For each turn in "turns", output exactly one JSONL line {"id":"<uuid>","topic":"<label>"}. Prefer concrete domain phrases ("opentelemetry-collector-config", "vscode-extension-webview") over vague ones ("coding-help"). Reuse labels across turns when the topic is the same. Output ONLY JSONL, one object per line, no preamble, no markdown fences, no explanation.`;

const SYSTEM_PROMPT_OLLAMA = `You classify Claude Code conversation turns into short topic labels. Each topic is 2-5 words, lowercase, hyphen-separated. Prefer concrete domain phrases ("opentelemetry-collector-config", "vscode-extension-webview") over vague ones ("coding-help"). Reuse the same label across consecutive turns when the topic is unchanged.

Respond with EXACTLY this JSON shape — no preamble, no fences, no commentary:
{"topics":[{"id":"<turn-id>","topic":"<label>"}, ...]}

Include one entry per input turn.`;

export type ClassifyBackend = "claude-p" | "ollama";

export interface ClassifyOpts {
  /** Which backend to dispatch through. */
  backend: ClassifyBackend;
  /** Model id to pass to the backend. For ollama this is e.g. "llama3.2:3b". */
  model: string;
  batchSize: number;
  /** Override the path to the claude CLI (default: 'claude' on PATH). */
  claudeBin?: string;
  /** Ollama base URL (e.g. http://127.0.0.1:11434). */
  ollamaUrl?: string;
  /** Called with (done, total) every batch. */
  onProgress?: (done: number, total: number) => void;
}

export interface ClassifyResult {
  classified: number;
  skipped: number;
  batches: number;
  inputTokens: number;
  outputTokens: number;
  errors: string[];
}

function makeBatchId(): string {
  return crypto.randomBytes(8).toString("hex");
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) : s;
}

/** Build the JSON prompt body for one batch. */
function buildPromptBody(turns: TurnRow[]): string {
  const body = {
    turns: turns.map((t) => ({
      id: t.turn_uuid,
      u: truncate(t.user_text, 800),
      a: truncate(t.assistant_excerpt, 400),
    })),
  };
  return JSON.stringify(body);
}

/** Run claude -p once, returning stdout (raw, possibly JSON-wrapped). */
function invokeClaude(args: string[], input: string, claudeBin: string, timeoutMs = 120_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      claudeBin,
      args,
      {
        maxBuffer: 32 * 1024 * 1024,
        timeout: timeoutMs,
        // CRITICAL: do not pass ANTHROPIC_API_KEY through. We want the user's
        // subscription, not API billing. We pass a curated env explicitly.
        env: {
          PATH: process.env.PATH || "",
          HOME: process.env.HOME || "",
          USER: process.env.USER || "",
          // Intentionally exclude ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN.
        },
      },
      (err, stdout, stderr) => {
        const code = err ? (err as any).code ?? 1 : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
    child.stdin?.end(input);
  });
}

interface ParsedOut {
  topics: Array<{ id: string; topic: string }>;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Parse the output of `claude -p --output-format json`. The structured
 * envelope looks like { result: "<text>", usage: { input_tokens, output_tokens } }.
 * The inner text is supposed to be JSONL of {id, topic} lines.
 */
function parseClaudeOutput(stdout: string): ParsedOut {
  const out: ParsedOut = { topics: [], inputTokens: 0, outputTokens: 0 };
  let inner = stdout;
  // Try to peel the JSON envelope first.
  try {
    const env = JSON.parse(stdout);
    if (env && typeof env === "object") {
      if (typeof env.result === "string") inner = env.result;
      if (env.usage) {
        out.inputTokens = Number(env.usage.input_tokens || 0);
        out.outputTokens = Number(env.usage.output_tokens || 0);
      }
    }
  } catch {
    // not enveloped; treat as raw text
  }
  // Strip markdown fences if Claude got chatty
  inner = inner.replace(/^```(?:json|jsonl)?/im, "").replace(/```\s*$/m, "");
  for (const rawLine of inner.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.id === "string" && typeof obj.topic === "string") {
        out.topics.push({ id: obj.id, topic: obj.topic.trim().slice(0, 80) });
      }
    } catch {
      // skip this line silently; will retry if needed
    }
  }
  return out;
}

/** Call Ollama's /api/chat with format=json. Returns parsed topics + token usage. */
function invokeOllama(
  url: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs = 180_000,
): Promise<{ ok: boolean; topics: Array<{ id: string; topic: string }>; inputTokens: number; outputTokens: number; error?: string }> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL("/api/chat", url);
    } catch (e: any) {
      return resolve({ ok: false, topics: [], inputTokens: 0, outputTokens: 0, error: `bad url: ${e.message}` });
    }
    const payload = JSON.stringify({
      model,
      stream: false,
      format: "json",
      options: { temperature: 0 },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        method: "POST",
        timeout: timeoutMs,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            return resolve({ ok: false, topics: [], inputTokens: 0, outputTokens: 0, error: `HTTP ${res.statusCode}: ${body.slice(0, 300)}` });
          }
          try {
            const env = JSON.parse(body);
            const content: string = env?.message?.content ?? "";
            const topics: Array<{ id: string; topic: string }> = [];
            try {
              const parsed = JSON.parse(content);
              const arr = Array.isArray(parsed?.topics) ? parsed.topics : Array.isArray(parsed) ? parsed : [];
              for (const item of arr) {
                if (item && typeof item.id === "string" && typeof item.topic === "string") {
                  topics.push({ id: item.id, topic: item.topic.trim().slice(0, 80) });
                }
              }
            } catch (parseErr: any) {
              return resolve({
                ok: false,
                topics: [],
                inputTokens: env?.prompt_eval_count || 0,
                outputTokens: env?.eval_count || 0,
                error: `bad JSON from model: ${parseErr.message}`,
              });
            }
            resolve({
              ok: true,
              topics,
              inputTokens: env?.prompt_eval_count || 0,
              outputTokens: env?.eval_count || 0,
            });
          } catch (e: any) {
            resolve({ ok: false, topics: [], inputTokens: 0, outputTokens: 0, error: e.message });
          }
        });
      },
    );
    req.on("error", (e) => resolve({ ok: false, topics: [], inputTokens: 0, outputTokens: 0, error: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, topics: [], inputTokens: 0, outputTokens: 0, error: "ollama timeout" });
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Classify all unclassified turns of one session. Idempotent: turns that
 * already have a topic (under the current model + prompt_rev) in the DB are
 * skipped. Dispatches to claude-p or ollama based on opts.backend.
 */
export async function classifySession(
  store: SessionStore,
  sessionId: string,
  opts: ClassifyOpts,
): Promise<ClassifyResult> {
  const all = store.turnsForSession(sessionId);
  const existing = store.topicsForSession(sessionId);
  const todo = all.filter(
    (t) => !existing.has(t.turn_uuid) && (t.user_text ?? "").trim().length > 0,
  );

  const result: ClassifyResult = {
    classified: 0,
    skipped: all.length - todo.length,
    batches: 0,
    inputTokens: 0,
    outputTokens: 0,
    errors: [],
  };

  if (todo.length === 0) return result;

  const backend = opts.backend;
  const modelTag = `${backend}/${opts.model}`;
  const claudeBin = opts.claudeBin || "claude";
  const ollamaUrl = opts.ollamaUrl || "http://127.0.0.1:11434";
  const batches = chunk(todo, opts.batchSize);

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const batchId = makeBatchId();
    store.createBatch(batchId, batch.length, modelTag);

    let topics: Array<{ id: string; topic: string }> = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let batchError: string | null = null;
    let rateLimited = false;

    if (backend === "claude-p") {
      const systemPlusUser = SYSTEM_PROMPT_CLAUDE + "\n\n" + buildPromptBody(batch);
      const args = [
        "-p",
        "--model", opts.model,
        "--output-format", "json",
        "--max-turns", "1",
        "--permission-mode", "bypassPermissions",
      ];
      const { stdout, stderr, code } = await invokeClaude(args, systemPlusUser, claudeBin);
      if (code !== 0) {
        batchError = `claude exit ${code}: ${stderr.slice(0, 500)}`;
        if (/rate.?limit|429|usage.?cap/i.test(stderr)) rateLimited = true;
      } else {
        const parsed = parseClaudeOutput(stdout);
        topics = parsed.topics;
        inputTokens = parsed.inputTokens;
        outputTokens = parsed.outputTokens;
      }
    } else {
      const userBody = buildPromptBody(batch);
      const res = await invokeOllama(ollamaUrl, opts.model, SYSTEM_PROMPT_OLLAMA, userBody);
      inputTokens = res.inputTokens;
      outputTokens = res.outputTokens;
      if (!res.ok) {
        batchError = res.error || "ollama call failed";
      } else {
        topics = res.topics;
      }
    }

    result.inputTokens += inputTokens;
    result.outputTokens += outputTokens;

    if (batchError) {
      result.errors.push(`batch ${batchId}: ${batchError}`);
      store.finishBatch(batchId, "failed", batchError, inputTokens, outputTokens);
      if (rateLimited) {
        result.errors.push("rate-limited; stopping further batches");
        break;
      }
      if (opts.onProgress) opts.onProgress(result.classified, todo.length);
      continue;
    }

    result.batches += 1;
    // Defensive filter: drop topics whose id isn't in this batch's turn_uuid
    // set. Local models occasionally hallucinate or truncate ids; inserting
    // them would trip the `turn_topic.turn_uuid REFERENCES turn(turn_uuid)`
    // foreign-key constraint and abort the whole transaction.
    const validIds = new Set(batch.map((t) => t.turn_uuid));
    const accepted = topics.filter((p) => validIds.has(p.id) && p.topic.trim().length > 0);
    const hallucinated = topics.length - accepted.length;
    const got = new Set(accepted.map((t) => t.id));
    const missed = batch.filter((t) => !got.has(t.turn_uuid));

    if (accepted.length > 0) {
      store.upsertTopics(
        accepted.map((p) => ({
          turn_uuid: p.id,
          topic: p.topic,
          model: modelTag,
          prompt_rev: PROMPT_REV,
          batch_id: batchId,
        })),
      );
    }
    result.classified += accepted.length;

    if (missed.length === 0 && hallucinated === 0) {
      store.finishBatch(batchId, "ok", undefined, inputTokens, outputTokens);
    } else {
      const parts: string[] = [];
      if (missed.length > 0) parts.push(`${missed.length} turns missing in response`);
      if (hallucinated > 0) parts.push(`${hallucinated} unknown ids dropped`);
      const msg = parts.join("; ");
      store.finishBatch(batchId, "partial", msg, inputTokens, outputTokens);
      result.errors.push(`batch ${batchId}: ${msg}`);
    }

    if (opts.onProgress) opts.onProgress(result.classified, todo.length);
  }

  return result;
}
