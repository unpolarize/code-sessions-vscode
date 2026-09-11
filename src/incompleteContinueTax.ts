// Incomplete-continue tax card (KP ideas/csv-say-the-word-incomplete-continue-tax-card-de).
// Pure module — no vscode / db imports — so detector + binder + renderer
// are fixture-testable.
//
// Claude/Codex/Grok agents often finish ~80% of a fix, then stop with
// “say the word / let me know if you want me to continue / the rest would
// be a separate task.” That fake handoff burns another human turn (and
// often another rate-limit slice) for work already in context.
//
// v1 heuristic: known phrases on assistant text AFTER ≥1 successful
// Write/Edit in the same turn. Precision over recall; no LLM judge.
// Distinct from wait-reason (permission vs thinking) and rejection digest
// (failed tools / reverts). Does not auto-send continue — the binder is
// copy-only.

import { extractAcceptanceBullets } from "./compactionFidelity";

export const INCOMPLETE_CONTINUE_TAX_SCHEMA =
  "code-sessions/incomplete-continue-tax@1";

export const COPY_CONTINUE_BINDER_COMMAND = "codeSessions.copyIncompleteContinueBinder";

/** Click-through examples listed on the card. */
export const DEFAULT_EXAMPLES = 8;

/** Clamp pathological idle gaps (session resumed days later). */
export const MAX_IDLE_MS = 7 * 24 * 3600 * 1000;

/**
 * Write/Edit-class tools (lowercased). Presence of ≥1 successful call in
 * the turn is required before a phrase can fire — talking about “continue”
 * with no edits is not a soft-abandon.
 */
export const WRITE_EDIT_TOOLS = new Set([
  "write",
  "edit",
  "strreplace",
  "notebookedit",
  "apply_patch",
  "applypatch",
  "search_replace",
  "write_file",
  "edit_file",
  "fs/write_text_file",
  "fs.write_text_file",
]);

/** Precision-first phrase table. Ids are stable for tests + binder copy. */
export const SOFT_ABANDON_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "say-the-word", re: /\bsay the word\b/i },
  { id: "let-me-know-continue", re: /\blet me know if you (?:want|would like) me to continue\b/i },
  { id: "want-me-to-continue", re: /\b(?:want|would like) me to continue\b/i },
  { id: "if-youd-like-continue", re: /\bif you(?:'d| would) like me to continue\b/i },
  { id: "should-i-continue", re: /\bshould i continue\b/i },
  { id: "happy-to-continue", re: /\bhappy to continue\b/i },
  { id: "rest-separate-task", re: /\b(?:the rest|the remainder|the leftover work) would be a separate (?:task|session|pr)\b/i },
  { id: "treat-as-separate", re: /\b(?:treat(?:ing)?|leave|save) (?:the rest|this|that) as a separate (?:task|session)\b/i },
];

/** Permission-wait copy is wait-reason, not a soft-abandon. */
const PERMISSION_WAIT_RE =
  /\b(?:need|waiting for|ask(?:ing)? for) (?:your )?permission\b/i;

export interface TaxToolCall {
  name: string;
  /** When true, the call failed. Undefined (store CSV) is treated as success. */
  resultIsError?: boolean;
  filePath?: string | null;
  input?: unknown;
}

export interface TaxTurn {
  assistantText: string;
  userText?: string;
  toolCalls: TaxToolCall[];
  /** Wall-clock end of assistant/tools in this turn. */
  turnEndMs?: number | null;
  /** Following turn's user timestamp (idle until human reply). */
  nextUserMs?: number | null;
  nextUserText?: string | null;
}

export interface TaxSessionInput {
  sessionId: string;
  source?: string | null;
  label?: string | null;
  goal?: string | null;
  acceptance?: string[];
  planningRefs?: string[];
  turns: TaxTurn[];
}

export type IdleKind = "continue-reply" | "next-user" | "still-open";

export interface SoftAbandonHit {
  sessionId: string;
  source: string;
  label: string;
  turnIndex: number;
  phrases: string[];
  writeCount: number;
  openFiles: string[];
  idleMinutes: number;
  idleKind: IdleKind;
  turnEndMs: number | null;
  binder: string;
}

export interface IncompleteContinueTaxCard {
  schema: typeof INCOMPLETE_CONTINUE_TAX_SCHEMA;
  abandonCount: number;
  sessionCount: number;
  idleMinutes: number;
  todayCount: number;
  todayIdleMinutes: number;
  examples: SoftAbandonHit[];
}

export interface TaxComputeOptions {
  nowMs?: number;
  examples?: number;
  openSessionCommand?: string;
  copyBinderCommand?: string;
}

export interface TaxSessionRow {
  session_id?: string | null;
  session?: string | null;
  source?: string | null;
  title?: string | null;
  first_user_msg?: string | null;
  extras_json?: string | null;
  tool_count?: number | null;
}

export interface TaxStoreTurn {
  user_text?: string | null;
  assistant_excerpt?: string | null;
  assistant_full?: string | null;
  tool_names_csv?: string | null;
  started_at?: number | null;
  ended_at?: number | null;
  turn_index?: number | null;
}

// --------------------------------------------------------------------------- //
// Heuristic
// --------------------------------------------------------------------------- //

export function normalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/\\/g, "/");
}

export function isWriteEditTool(name: string): boolean {
  const n = normalizeToolName(name);
  if (WRITE_EDIT_TOOLS.has(n)) return true;
  // ACP-style "fs/write_text_file" already in the set; also match suffix.
  if (n.endsWith("/write_text_file") || n.endsWith("/write")) return true;
  return false;
}

export function successfulWriteEdits(tools: TaxToolCall[]): TaxToolCall[] {
  return tools.filter((t) => isWriteEditTool(t.name) && t.resultIsError !== true);
}

export function matchSoftAbandonPhrases(text: string): string[] {
  const raw = text ?? "";
  if (!raw.trim()) return [];
  const ids: string[] = [];
  for (const p of SOFT_ABANDON_PATTERNS) {
    if (p.re.test(raw)) ids.push(p.id);
  }
  if (ids.length === 0) return [];
  // Permission-wait alone is wait-reason, not a fake handoff after progress.
  if (PERMISSION_WAIT_RE.test(raw) && !ids.includes("say-the-word") && !ids.includes("rest-separate-task")) {
    const continueIds = ids.filter((id) => id !== "want-me-to-continue" && id !== "should-i-continue");
    if (continueIds.length === 0) return [];
  }
  return ids;
}

/** Short human “continue” replies that close the idle window. */
export function looksLikeContinueReply(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return /^(?:yes|yep|yeah|ok|okay|sure|continue|please continue|go ahead|do it|keep going|finish (?:it|this)|say the word)\b/i.test(
    t,
  );
}

export function filePathFromTool(tc: TaxToolCall): string | null {
  if (typeof tc.filePath === "string" && tc.filePath.trim()) return tc.filePath.trim();
  const input = tc.input;
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  for (const k of ["file_path", "filePath", "path", "target_file"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function idleMinutesForTurn(
  turn: TaxTurn,
  nowMs: number,
): { minutes: number; kind: IdleKind } {
  const end = turn.turnEndMs ?? null;
  if (end == null || !Number.isFinite(end)) return { minutes: 0, kind: "still-open" };
  const next = turn.nextUserMs;
  if (next != null && Number.isFinite(next) && next >= end) {
    const gap = Math.min(MAX_IDLE_MS, Math.max(0, next - end));
    const kind: IdleKind = looksLikeContinueReply(turn.nextUserText) ? "continue-reply" : "next-user";
    return { minutes: gap / 60_000, kind };
  }
  const gap = Math.min(MAX_IDLE_MS, Math.max(0, nowMs - end));
  return { minutes: gap / 60_000, kind: "still-open" };
}

export function detectSoftAbandon(turn: TaxTurn, nowMs: number = Date.now()): Omit<
  SoftAbandonHit,
  "sessionId" | "source" | "label" | "turnIndex" | "binder"
> | null {
  const writes = successfulWriteEdits(turn.toolCalls ?? []);
  if (writes.length < 1) return null;
  const phrases = matchSoftAbandonPhrases(turn.assistantText ?? "");
  if (phrases.length === 0) return null;
  const idle = idleMinutesForTurn(turn, nowMs);
  const files: string[] = [];
  const seen = new Set<string>();
  for (const w of writes) {
    const p = filePathFromTool(w);
    if (p && !seen.has(p)) {
      seen.add(p);
      files.push(p);
    }
  }
  return {
    phrases,
    writeCount: writes.length,
    openFiles: files,
    idleMinutes: idle.minutes,
    idleKind: idle.kind,
    turnEndMs: turn.turnEndMs ?? null,
  };
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + "…";
}

/**
 * KP-primed continue prompt. Always non-empty. Copy-only — never auto-sent.
 */
export function buildContinueBinder(
  session: Pick<TaxSessionInput, "sessionId" | "goal" | "label" | "acceptance" | "planningRefs">,
  hit: { phrases: string[]; openFiles: string[] },
): string {
  const goal =
    clip(session.goal || session.label || "", 500) ||
    `(resume session ${session.sessionId})`;
  const files = (hit.openFiles ?? []).filter(Boolean).slice(0, 8);
  const acceptance = (session.acceptance ?? [])
    .map((b) => b.trim())
    .filter(Boolean)
    .slice(0, 6);
  const refs = (session.planningRefs ?? []).filter(Boolean).slice(0, 4);
  const lines: string[] = [
    "Continue. Do not stop for a new human turn — finish the remaining work already in context.",
    "",
    `Goal: ${goal}`,
  ];
  if (refs.length) {
    lines.push(`KP: ${refs.join(", ")}`);
  }
  if (files.length) {
    lines.push("", "Open files:");
    for (const f of files) lines.push(`- ${f}`);
  }
  if (acceptance.length) {
    lines.push("", "Acceptance:");
    for (const b of acceptance) lines.push(`- ${b}`);
  }
  const phrase = hit.phrases[0] || "soft-abandon";
  lines.push(
    "",
    `The previous assistant turn offered to continue after substantial progress (${phrase}). Pick up where it left off.`,
  );
  return lines.join("\n");
}

function startOfDayMs(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function backendOf(source: string | null | undefined): string {
  const s = (source || "claude").trim().toLowerCase();
  return s || "claude";
}

function sessionIdOf(r: TaxSessionRow): string {
  return (r.session_id || r.session || "").trim();
}

function parseExtrasObject(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const o = JSON.parse(json);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(String).map((s) => s.trim()).filter(Boolean);
}

/** Lift indexed store turns into detector turns (next-user wired from i+1). */
export function turnsFromStoreRows(rows: TaxStoreTurn[]): TaxTurn[] {
  const ordered = rows
    .slice()
    .sort((a, b) => (a.turn_index ?? 0) - (b.turn_index ?? 0));
  return ordered.map((r, i) => {
    const next = ordered[i + 1];
    const tools = String(r.tool_names_csv ?? "")
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean)
      .map((name) => ({ name }));
    const assistant = (r.assistant_full || r.assistant_excerpt || "").trim();
    return {
      assistantText: assistant,
      userText: r.user_text ?? "",
      toolCalls: tools,
      turnEndMs: r.ended_at ?? r.started_at ?? null,
      nextUserMs: next?.started_at ?? null,
      nextUserText: next?.user_text ?? null,
    };
  });
}

/**
 * Join session rows with pre-fetched turns. Missing turns → skipped (not a
 * fake zero). Callers cap how many sessions they fetch.
 */
export function sessionsFromStoreRows(
  rows: TaxSessionRow[],
  turnsBySession: Map<string, TaxTurn[]>,
  opts: { acceptanceByKpId?: Map<string, string[]> } = {},
): TaxSessionInput[] {
  const out: TaxSessionInput[] = [];
  for (const r of rows) {
    const sid = sessionIdOf(r);
    if (!sid) continue;
    const turns = turnsBySession.get(sid);
    if (!turns || turns.length === 0) continue;
    const extras = parseExtrasObject(r.extras_json);
    const planningRefs = stringList(extras.planning_refs);
    let acceptance = stringList(extras.acceptance);
    if (acceptance.length === 0) {
      for (const id of planningRefs) {
        const bullets = opts.acceptanceByKpId?.get(id);
        if (bullets) acceptance.push(...bullets);
      }
    }
    if (acceptance.length === 0) {
      acceptance = extractAcceptanceBullets(r.first_user_msg ?? "");
    }
    const goal = (r.first_user_msg || r.title || "").trim();
    out.push({
      sessionId: sid,
      source: backendOf(r.source),
      label: (r.title || goal || sid).trim().slice(0, 70),
      goal: goal.slice(0, 2000),
      acceptance,
      planningRefs,
      turns,
    });
  }
  return out;
}

/**
 * Scan sessions for soft-abandons. Always returns a card (counts may be 0).
 * Empty corpus does not invent hits.
 */
export function computeIncompleteContinueTax(
  sessions: TaxSessionInput[],
  opts: TaxComputeOptions = {},
): IncompleteContinueTaxCard {
  const nowMs = opts.nowMs ?? Date.now();
  const examplesCap = Math.max(1, opts.examples ?? DEFAULT_EXAMPLES);
  const midnight = startOfDayMs(nowMs);
  const hits: SoftAbandonHit[] = [];

  for (const session of sessions) {
    const turns = session.turns ?? [];
    for (let i = 0; i < turns.length; i++) {
      const detected = detectSoftAbandon(turns[i], nowMs);
      if (!detected) continue;
      const hit: SoftAbandonHit = {
        sessionId: session.sessionId,
        source: backendOf(session.source),
        label: (session.label || session.sessionId).slice(0, 70),
        turnIndex: i,
        ...detected,
        binder: buildContinueBinder(session, detected),
      };
      hits.push(hit);
    }
  }

  hits.sort((a, b) => {
    if (a.idleMinutes !== b.idleMinutes) return b.idleMinutes - a.idleMinutes;
    return a.sessionId.localeCompare(b.sessionId);
  });

  const today = hits.filter((h) => (h.turnEndMs ?? 0) >= midnight);
  const uniqueSessions = new Set(hits.map((h) => h.sessionId));
  const sumIdle = (xs: SoftAbandonHit[]) => xs.reduce((n, h) => n + h.idleMinutes, 0);

  return {
    schema: INCOMPLETE_CONTINUE_TAX_SCHEMA,
    abandonCount: hits.length,
    sessionCount: uniqueSessions.size,
    idleMinutes: sumIdle(hits),
    todayCount: today.length,
    todayIdleMinutes: sumIdle(today),
    examples: hits.slice(0, examplesCap),
  };
}

export function formatIdleMinutes(mins: number): string {
  if (!Number.isFinite(mins) || mins < 0) return "—";
  if (mins < 1) return `${Math.round(mins * 60)}s`;
  if (mins < 60) return `${mins < 10 ? mins.toFixed(1) : Math.round(mins)}m`;
  const h = mins / 60;
  return `${h < 10 ? h.toFixed(1) : Math.round(h)}h`;
}

// --------------------------------------------------------------------------- //
// HTML
// --------------------------------------------------------------------------- //

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function commandHref(command: string, args: unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

/** Insights section ("" when nothing scored — empty corpus does not fake a tax). */
export function renderIncompleteContinueTaxHtml(
  card: IncompleteContinueTaxCard,
  opts: Pick<TaxComputeOptions, "openSessionCommand" | "copyBinderCommand"> = {},
): string {
  if (card.abandonCount === 0) return "";
  const cmd = opts.openSessionCommand ?? "codeSessions.openSession";
  const copyCmd = opts.copyBinderCommand ?? COPY_CONTINUE_BINDER_COMMAND;

  const rows = card.examples
    .map((ex) => {
      const href = commandHref(cmd, [ex.sessionId]);
      const binderHref = commandHref(copyCmd, [ex.binder]);
      const phrases = ex.phrases.map((p) => esc(p)).join(", ");
      return `<tr>
        <td class="ict-backend">${esc(ex.source)}</td>
        <td class="ict-session"><a class="ict-link" href="${esc(href)}" title="${esc(ex.sessionId)}">${esc(ex.label.slice(0, 40))}</a></td>
        <td class="ict-phrases">${phrases}</td>
        <td class="num">${esc(formatIdleMinutes(ex.idleMinutes))}</td>
        <td class="num">${ex.writeCount}</td>
        <td><a class="ict-binder" href="${esc(binderHref)}" title="Copy continue binder (does not send)">Continue binder</a></td>
      </tr>`;
    })
    .join("");

  return `<section class="ict-card" data-schema="${esc(INCOMPLETE_CONTINUE_TAX_SCHEMA)}">
  <div class="ict-head"><span class="ict-title">Incomplete-continue tax</span>
    <span class="ict-chip" title="Soft-abandons after Write/Edit: say-the-word / continue-offer / rest-is-a-separate-task">${card.abandonCount} abandon${card.abandonCount === 1 ? "" : "s"} · ${esc(formatIdleMinutes(card.idleMinutes))} idle</span>
    <span class="ict-chip ict-today" title="Soft-abandons whose assistant turn ended today (local)">${card.todayCount} today · ${esc(formatIdleMinutes(card.todayIdleMinutes))}</span>
  </div>
  <div class="ict-sub">${card.abandonCount} soft-abandon${card.abandonCount === 1 ? "" : "s"} across ${card.sessionCount} session${card.sessionCount === 1 ? "" : "s"}. Idle is the gap from the offering turn until a human “continue” (or the next user message / still-open). Copy the binder — it is never auto-sent.</div>
  <table class="ict-table"><tr><th>backend</th><th>session</th><th>phrase</th><th>idle</th><th>edits</th><th></th></tr>${rows}</table>
  <div class="ict-help">v1 heuristic: known phrases on assistant text after ≥1 successful Write/Edit in the same turn (Claude Write/Edit, Grok write/search_replace, Codex apply_patch). Precision over recall; no LLM judge. Distinct from wait-reason (permission vs thinking) and rejection digest (failed tools).</div>
  <div class="ict-disclaimer">Copy-only continue binder (goal + open files + last acceptance). Does not auto-send. Store-indexed turns without per-tool errors treat listed Write/Edit names as success.</div>
</section>`;
}

/** CSS for Insights — keep in sync with `.ict-*` markup above. */
export const INCOMPLETE_CONTINUE_TAX_CARD_CSS = `
.ict-card { background: var(--card-bg, var(--vscode-editorWidget-background, #1e1e1e)); border: 1px solid var(--border, var(--vscode-panel-border, #333)); border-radius: 6px; padding: 12px 14px; margin-top: 8px; }
.ict-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; flex-wrap: wrap; }
.ict-title { font-size: 11px; text-transform: uppercase; color: var(--muted, var(--vscode-descriptionForeground, #999)); letter-spacing: 0.5px; font-weight: 600; }
.ict-chip { display: inline-block; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; color: var(--vscode-inputValidation-warningForeground, #e8a838); border: 1px solid var(--vscode-inputValidation-warningForeground, #e8a838); border-radius: 8px; padding: 1px 7px; vertical-align: middle; }
.ict-today { color: var(--vscode-charts-orange, #ff9c3a); border-color: var(--vscode-charts-orange, #ff9c3a); }
.ict-sub { font-size: 12px; color: var(--muted, var(--vscode-descriptionForeground, #999)); line-height: 1.45; margin-bottom: 8px; }
.ict-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 2px; }
.ict-table th, .ict-table td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--border, var(--vscode-panel-border, #333)); vertical-align: top; }
.ict-table th { color: var(--muted, var(--vscode-descriptionForeground, #999)); font-weight: 500; font-size: 10px; text-transform: uppercase; }
.ict-table td.num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.ict-table th:nth-child(4), .ict-table th:nth-child(5) { text-align: right; }
.ict-backend { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; }
.ict-session { font-size: 12px; }
.ict-link { color: var(--accent, var(--vscode-textLink-foreground, #4af)); text-decoration: none; }
.ict-link:hover { text-decoration: underline; }
.ict-phrases { font-size: 11px; color: var(--muted, var(--vscode-descriptionForeground, #999)); }
.ict-binder { font-size: 11px; color: var(--accent, var(--vscode-textLink-foreground, #4af)); text-decoration: none; font-weight: 500; white-space: nowrap; }
.ict-binder:hover { text-decoration: underline; }
.ict-help { font-size: 11px; color: var(--muted, var(--vscode-descriptionForeground, #999)); margin-top: 8px; line-height: 1.45; }
.ict-disclaimer { font-size: 11px; color: var(--muted, var(--vscode-descriptionForeground, #999)); margin-top: 8px; line-height: 1.45; border-top: 1px solid var(--border, var(--vscode-panel-border, #333)); padding-top: 8px; }
`;
