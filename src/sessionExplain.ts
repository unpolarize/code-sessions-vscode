/**
 * On-demand session explain / ask. Builds a cs-label-session JSON prompt
 * (or a freeform question) from a transcript excerpt. The host invokes
 * `claude -p` (subscription CLI, never ANTHROPIC_API_KEY).
 */

import { execFile } from "node:child_process";

export const INTENTS = [
  "feature",
  "bugfix",
  "refactor",
  "research",
  "docs",
  "ops",
  "review",
  "chore",
  "other",
] as const;

export interface SessionLabel {
  topic: string;
  intent: (typeof INTENTS)[number] | string;
  tags: string[];
  projects: string[];
  summary: string;
  suggestedLinks?: string[];
}

export interface ExplainInput {
  uuid: string;
  title?: string;
  host?: string;
  agent?: string;
  project?: string;
  firstUserMsg?: string;
  excerpt?: string;
  question?: string;
  candidateItems?: Array<{ id: string; title: string; type: string }>;
}

const LABEL_PROMPT = `You are labeling a coding-agent session for the code-sessions store and knowledge-planning board.

Read the session excerpt and emit ONLY a single JSON object — no prose, no code fence:

{
  "topic": "3-6 word summary of what the session was about",
  "intent": "one of: feature | bugfix | refactor | research | docs | ops | review | chore | other",
  "tags": ["short", "themes"],
  "projects": ["repo-or-dir-names-touched"],
  "summary": "one sentence",
  "suggestedLinks": ["optional planning object ids from the candidate list that this session advanced"]
}

intent = what the user wanted. projects = repos actually edited. suggestedLinks only from the candidate list.`;

export function buildExplainPrompt(input: ExplainInput): string {
  const candidates = (input.candidateItems ?? [])
    .slice(0, 30)
    .map((c) => `- ${c.id}  (${c.type}) ${c.title}`)
    .join("\n");
  const body = [
    `uuid: ${input.uuid}`,
    input.title ? `title: ${input.title}` : "",
    input.host ? `host: ${input.host}` : "",
    input.agent ? `agent: ${input.agent}` : "",
    input.project ? `project: ${input.project}` : "",
    input.firstUserMsg ? `first user message:\n${input.firstUserMsg.slice(0, 1500)}` : "",
    input.excerpt ? `excerpt:\n${input.excerpt.slice(0, 6000)}` : "",
    candidates ? `candidate planning items:\n${candidates}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (input.question && input.question.trim()) {
    return `You are answering a question about one coding session. Use only the excerpt. Be terse.\n\n${body}\n\nQuestion: ${input.question.trim()}\n\nAnswer in 5-12 sentences. If you are unsure, say so.`;
  }
  return `${LABEL_PROMPT}\n\n${body}`;
}

export function parseLabelJson(raw: string): SessionLabel | null {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fence ? fence[1].trim() : trimmed;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as Partial<SessionLabel>;
    if (!o.topic && !o.summary && !o.intent) return null;
    return {
      topic: String(o.topic ?? "").slice(0, 80),
      intent: String(o.intent ?? "other"),
      tags: Array.isArray(o.tags) ? o.tags.map(String).slice(0, 8) : [],
      projects: Array.isArray(o.projects) ? o.projects.map(String).slice(0, 8) : [],
      summary: String(o.summary ?? "").slice(0, 280),
      suggestedLinks: Array.isArray(o.suggestedLinks) ? o.suggestedLinks.map(String).slice(0, 8) : [],
    };
  } catch {
    return null;
  }
}

export function invokeClaudeP(
  prompt: string,
  opts: { claudeBin?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const bin = opts.claudeBin || "claude";
  const timeoutMs = opts.timeoutMs ?? 90_000;
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      ["-p", prompt, "--output-format", "text"],
      {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, ANTHROPIC_API_KEY: "" },
      },
      (err, stdout, stderr) => {
        const code = err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
    child.on("error", () => resolve({ stdout: "", stderr: `failed to spawn ${bin}`, code: 1 }));
  });
}
