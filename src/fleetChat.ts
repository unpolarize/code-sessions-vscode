/**
 * Fleet-view chat: one prompt over the *currently visible* session list
 * (today / live / host / hide-automated / …). The model returns prose plus
 * a structured action list the host can apply (tag, create task/idea, link).
 */

import type { FleetSession } from "./sessionFleet";

export type FleetActionKind = "tag" | "create-task" | "create-idea" | "link";

export interface FleetAction {
  kind: FleetActionKind;
  uuid: string;
  tags?: string[];
  intent?: string;
  topic?: string;
  summary?: string;
  title?: string;
  project?: string;
  objectId?: string;
}

export interface FleetChatView {
  window: string;
  host: string;
  unlinked: boolean;
  hideAutomated: boolean;
  search: string;
}

export interface FleetChatResult {
  answer: string;
  actions: FleetAction[];
}

const KINDS = new Set<FleetActionKind>(["tag", "create-task", "create-idea", "link"]);

export function summarizeFleetSession(s: FleetSession): Record<string, unknown> {
  return {
    uuid: s.uuid,
    title: (s.title || "").slice(0, 120),
    host: s.host,
    agent: s.agent,
    project: s.project,
    status: s.status,
    intent: s.intent,
    labels: (s.labels || []).slice(0, 8),
    linked: s.linked,
    automated: !!s.automated,
    turns: s.turns,
    first: (s.firstUserMsg || "").slice(0, 280),
  };
}

export function buildFleetChatPrompt(opts: {
  view: FleetChatView;
  sessions: FleetSession[];
  projects: Array<{ id: string; title: string }>;
  openItems: Array<{ id: string; title: string; type: string; project?: string }>;
  question: string;
}): string {
  const sessions = opts.sessions.slice(0, 80).map(summarizeFleetSession);
  const autoN = opts.sessions.filter((s) => s.automated).length;
  const unlinkedN = opts.sessions.filter((s) => !s.linked).length;
  const viewLine = [
    `window=${opts.view.window}`,
    `host=${opts.view.host}`,
    opts.view.hideAutomated ? "automated=hidden" : "automated=shown",
    opts.view.unlinked ? "unlinked-only" : "",
    opts.view.search ? `search=${opts.view.search}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `You are the Fleet board agent for a multi-laptop coding-session inventory.

The user is looking at THIS view only — do not invent sessions outside the JSON.

View: ${viewLine}
Counts: ${opts.sessions.length} sessions, ${autoN} already flagged automated, ${unlinkedN} unlinked to planning.

Sessions JSON:
${JSON.stringify(sessions, null, 0)}

Open planning items (link targets):
${opts.openItems
  .slice(0, 40)
  .map((o) => `- ${o.id}  (${o.type}${o.project ? " · " + o.project : ""}) ${o.title}`)
  .join("\n") || "(none)"}

Projects:
${opts.projects.slice(0, 30).map((p) => `- ${p.id}  ${p.title}`).join("\n") || "(none)"}

Question: ${opts.question.trim()}

Respond with ONLY a JSON object (no fences, no preamble):
{
  "answer": "short prose: what you found and what you recommend (markdown ok)",
  "actions": [
    {"kind":"tag","uuid":"<session uuid>","tags":["automated"],"intent":"ops","topic":"optional","summary":"optional"},
    {"kind":"create-task","uuid":"<session uuid>","title":"short task title","project":"optional-project-id-or-slug"},
    {"kind":"create-idea","uuid":"<session uuid>","title":"short idea title","project":"optional"},
    {"kind":"link","uuid":"<session uuid>","objectId":"tasks/existing-id"}
  ]
}

Rules:
- Only emit actions the user asked for (or that clearly follow from the question).
- uuid MUST be copied from the sessions JSON. objectId MUST be from the open items list (or omitted).
- Tagging automation: use tags:["automated"] on sessions where automated=true, or where the title/first prompt is clearly cron/night-loop/fleet/headless. Do not tag interactive coding as automated.
- create-task only when the session has no linked planning item AND it looks like real work (not automated).
- Prefer link over create when an open item already matches.
- Empty actions[] is fine when the question is informational.
- Cap actions at 40.`;
}

export function parseFleetChatResult(raw: string): FleetChatResult | null {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fence ? fence[1].trim() : trimmed;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as {
      answer?: unknown;
      actions?: unknown;
    };
    const answer = typeof o.answer === "string" ? o.answer.trim() : "";
    const actions = Array.isArray(o.actions)
      ? o.actions.map(normalizeAction).filter((a): a is FleetAction => a != null).slice(0, 40)
      : [];
    if (!answer && !actions.length) return null;
    return { answer: answer || (actions.length ? `${actions.length} suggested action(s).` : ""), actions };
  } catch {
    return null;
  }
}

function normalizeAction(raw: unknown): FleetAction | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind = String(o.kind || "") as FleetActionKind;
  const uuid = String(o.uuid || "").trim();
  if (!KINDS.has(kind) || !uuid) return null;
  const tags = Array.isArray(o.tags) ? o.tags.map(String).map((t) => t.trim()).filter(Boolean).slice(0, 8) : [];
  const title = typeof o.title === "string" ? o.title.trim().slice(0, 160) : undefined;
  const objectId = typeof o.objectId === "string" ? o.objectId.trim() : undefined;
  if (kind === "tag" && !tags.length && !o.intent) return null;
  if ((kind === "create-task" || kind === "create-idea") && !title) return null;
  if (kind === "link" && !objectId) return null;
  return {
    kind,
    uuid,
    tags: tags.length ? tags : undefined,
    intent: typeof o.intent === "string" ? o.intent.trim() : undefined,
    topic: typeof o.topic === "string" ? o.topic.trim().slice(0, 80) : undefined,
    summary: typeof o.summary === "string" ? o.summary.trim().slice(0, 200) : undefined,
    title,
    project: typeof o.project === "string" ? o.project.trim() : undefined,
    objectId,
  };
}

export function actionLabel(a: FleetAction): string {
  const short = a.uuid.slice(0, 8);
  if (a.kind === "tag") return `Tag ${short}…  ${(a.tags || []).join(", ")}${a.intent ? " · " + a.intent : ""}`;
  if (a.kind === "create-task") return `Task ← ${short}…  ${a.title}`;
  if (a.kind === "create-idea") return `Idea ← ${short}…  ${a.title}`;
  return `Link ${short}… → ${a.objectId}`;
}
