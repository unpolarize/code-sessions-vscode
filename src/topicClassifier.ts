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
import { SessionStore, TurnRow } from "./db";

const PROMPT_REV = 1;

const SYSTEM_PROMPT = `You classify Claude Code conversation turns into short topic labels (2-5 words, lowercase, dashes between words). For each turn in "turns", output exactly one JSONL line {"id":"<uuid>","topic":"<label>"}. Prefer concrete domain phrases ("opentelemetry-collector-config", "vscode-extension-webview") over vague ones ("coding-help"). Reuse labels across turns when the topic is the same. Output ONLY JSONL, one object per line, no preamble, no markdown fences, no explanation.`;

export interface ClassifyOpts {
  model: string;
  batchSize: number;
  /** Override the path to the claude CLI (default: 'claude' on PATH). */
  claudeBin?: string;
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

/**
 * Classify all unclassified turns of one session. Idempotent: turns that
 * already have a topic in the DB are skipped.
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

  const claudeBin = opts.claudeBin || "claude";
  const batches = chunk(todo, opts.batchSize);

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const batchId = makeBatchId();
    store.createBatch(batchId, batch.length, opts.model);

    const systemPlusUser =
      SYSTEM_PROMPT + "\n\n" + buildPromptBody(batch);

    // `claude -p --model X --output-format json --max-turns 1` accepts stdin.
    const args = [
      "-p",
      "--model", opts.model,
      "--output-format", "json",
      "--max-turns", "1",
      "--permission-mode", "bypassPermissions",
    ];

    const { stdout, stderr, code } = await invokeClaude(args, systemPlusUser, claudeBin);
    if (code !== 0) {
      const errSnippet = stderr.slice(0, 500);
      result.errors.push(`batch ${batchId}: claude exit ${code}: ${errSnippet}`);
      store.finishBatch(batchId, "failed", errSnippet);
      // Rate limit? Bail rather than burn more quota.
      if (/rate.?limit|429|usage.?cap/i.test(stderr)) {
        result.errors.push("rate-limited; stopping further batches");
        break;
      }
      continue;
    }

    const parsed = parseClaudeOutput(stdout);
    result.inputTokens += parsed.inputTokens;
    result.outputTokens += parsed.outputTokens;
    result.batches += 1;

    // Cross-check: which turn ids did we miss?
    const got = new Set(parsed.topics.map((t) => t.id));
    const missed = batch.filter((t) => !got.has(t.turn_uuid));

    store.upsertTopics(
      parsed.topics.map((p) => ({
        turn_uuid: p.id,
        topic: p.topic,
        model: opts.model,
        prompt_rev: PROMPT_REV,
        batch_id: batchId,
      })),
    );
    result.classified += parsed.topics.length;

    if (missed.length === 0) {
      store.finishBatch(batchId, "ok", undefined, parsed.inputTokens, parsed.outputTokens);
    } else {
      store.finishBatch(
        batchId,
        "partial",
        `${missed.length} turns missing in response`,
        parsed.inputTokens,
        parsed.outputTokens,
      );
      result.errors.push(`batch ${batchId}: ${missed.length}/${batch.length} turns missing`);
      // For Phase 1A we don't retry the missed turns. Phase 2 will binary-split.
    }

    if (opts.onProgress) opts.onProgress(result.classified, todo.length);
  }

  return result;
}
