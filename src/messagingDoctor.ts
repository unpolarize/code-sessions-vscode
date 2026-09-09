// messagingDoctor.ts — pure core for the privacy-env messaging-disable doctor.
//
// Claude Code's cross-session messaging (`ListAgents` / `SendMessage`) is on
// by default, but four unrelated privacy/telemetry env vars silently disable
// it. Users who harden privacy then wonder why peer messaging / agent-team
// coordination "just doesn't work" — the only in-product symptom is
// `/list-agents` being unrecognized. This module joins the host process env
// into disable reasons plus a copy-paste remediation snippet.
//
// Read-only probe: it inspects env values it was handed, never mutates the
// user's shell profile, makes no network calls, and reads no secrets beyond
// the four known key names. Claude-first: other backends are out of scope
// here — callers should show "n/a", not false alarms.

// ---------------------------------------------------------------------------
// Known disabling env vars
// ---------------------------------------------------------------------------

export interface KnownEnvVar {
  name: string;
  /** Why a privacy-minded user would have set this — shown so the card
   * explains the collateral damage instead of just naming the var. */
  purpose: string;
  /** How Claude Code reads the var: `presence` vars disable on ANY non-empty
   * value (even `0`/`false`); `boolean` vars disable only on truthy-style
   * spellings. Getting this wrong produces false all-clears. */
  semantics: "presence" | "boolean";
}

export const MESSAGING_DISABLE_ENV_VARS: readonly KnownEnvVar[] = [
  {
    name: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    purpose: "umbrella opt-out of non-essential network traffic",
    semantics: "presence",
  },
  { name: "DISABLE_TELEMETRY", purpose: "opt out of Statsig telemetry", semantics: "presence" },
  { name: "DO_NOT_TRACK", purpose: "ecosystem-wide tracking opt-out", semantics: "boolean" },
  {
    name: "DISABLE_GROWTHBOOK",
    purpose: "opt out of GrowthBook feature flags",
    semantics: "boolean",
  },
];

/** Per-var disable check. `presence` vars (Claude's umbrella/telemetry
 * opt-outs) disable on any non-empty value — `DISABLE_TELEMETRY=0` still
 * disables. `boolean` vars honor explicit-off spellings (`0`/`false`/
 * `no`/`off`). */
export function isDisablingValue(
  value: string | undefined,
  semantics: "presence" | "boolean" = "boolean"
): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  if (v === "") return false;
  if (semantics === "presence") return true;
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

export interface DisableReason {
  envVar: string;
  /** The literal value seen (env values here are flags, not secrets). */
  value: string;
  purpose: string;
}

/** Pure resolver: env snapshot → which known vars are set to disabling
 * values. Order follows MESSAGING_DISABLE_ENV_VARS, not the env object. */
export function resolveDisableReasons(
  env: Record<string, string | undefined>
): DisableReason[] {
  const out: DisableReason[] = [];
  for (const known of MESSAGING_DISABLE_ENV_VARS) {
    const value = env[known.name];
    if (isDisablingValue(value, known.semantics)) {
      out.push({ envVar: known.name, value: value as string, purpose: known.purpose });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transcript evidence (ListAgents-absence probe)
// ---------------------------------------------------------------------------
//
// The extension-host env can be clean while the shell that launches `claude`
// has one of the vars set (or `~/.claude/settings.json` sets it) — env alone
// gives a false all-clear. The strongest transcript signal is a failed
// attempt: the user typed `/list-agents` in a recent Claude session but the
// `ListAgents` tool never ran anywhere in the lookback window. A user who
// simply never uses messaging is "no-signal", not a warn — otherwise the
// card would cry wolf for everyone.

export interface EvidenceTurn {
  userText: string | null;
  toolNamesCsv: string | null;
}

export interface TranscriptEvidence {
  sessionsScanned: number;
  /** Turns where the user invoked `/list-agents`. */
  attemptTurns: number;
  /** True when ListAgents or SendMessage actually ran in any scanned turn. */
  toolSeen: boolean;
}

export type TranscriptEvidenceVerdict = "seen" | "attempted-absent" | "no-signal";

// Invocation form only (line-start): a bare mention of /list-agents in prose
// ("why does /list-agents fail?") is not an attempt — counting it would warn
// on sessions *about* this feature. Slash commands are typed on their own line.
const ATTEMPT_RE = /^\s*\/list-agents\b/im;
const MESSAGING_TOOL_NAMES = new Set(["ListAgents", "SendMessage"]);

/** Cap on total turns scanned across all sessions (rulesDoctor uses the same
 * order of magnitude) — Insights builds synchronously on the extension host,
 * and long transcripts must not stall it. */
const MAX_EVIDENCE_TURNS = 3000;

/** Pure: recent Claude sessions' turns → evidence counters. */
export function resolveTranscriptEvidence(sessions: EvidenceTurn[][]): TranscriptEvidence {
  let attemptTurns = 0;
  let toolSeen = false;
  for (const turns of sessions) {
    for (const t of turns) {
      if (t.userText && ATTEMPT_RE.test(t.userText)) attemptTurns++;
      if (!toolSeen && t.toolNamesCsv) {
        for (const name of t.toolNamesCsv.split(",")) {
          if (MESSAGING_TOOL_NAMES.has(name.trim())) {
            toolSeen = true;
            break;
          }
        }
      }
    }
  }
  return { sessionsScanned: sessions.length, attemptTurns, toolSeen };
}

export function transcriptEvidenceVerdict(
  evidence: TranscriptEvidence | undefined
): TranscriptEvidenceVerdict {
  if (!evidence || evidence.sessionsScanned === 0) return "no-signal";
  if (evidence.toolSeen) return "seen";
  if (evidence.attemptTurns > 0) return "attempted-absent";
  return "no-signal";
}

/** Minimal store surface the probe needs — SessionStore satisfies this
 * (same pattern as rulesDoctor's DoctorTurnSource; keeps this module free
 * of vscode/db imports and unit-testable with a fake). */
export interface TranscriptEvidenceSource {
  listRecent(
    limit: number,
    includeAutomated: boolean
  ): Array<{ session_id: string; source?: string }>;
  turnsForSession(
    sessionId: string
  ): Array<{ user_text: string | null; tool_names_csv: string | null }>;
}

/** Scan the most recent Claude-backend sessions (other backends are out of
 * scope — scanning them would manufacture false "absent" evidence). */
export function collectTranscriptEvidence(
  store: TranscriptEvidenceSource,
  maxSessions = 20
): TranscriptEvidence {
  // Wide pool before the source filter: on a machine where grok/codex
  // sessions dominate the recency window, a thin pool would under-sample
  // Claude and manufacture false attempted-absent verdicts.
  const claude = store
    .listRecent(maxSessions * 10, true)
    .filter((s) => (s.source ?? "claude") === "claude")
    .slice(0, maxSessions);
  const sessions: EvidenceTurn[][] = [];
  let turnBudget = MAX_EVIDENCE_TURNS;
  for (const s of claude) {
    if (turnBudget <= 0) break;
    const turns = store.turnsForSession(s.session_id).slice(0, turnBudget);
    turnBudget -= turns.length;
    sessions.push(turns.map((t) => ({ userText: t.user_text, toolNamesCsv: t.tool_names_csv })));
  }
  return resolveTranscriptEvidence(sessions);
}

// ---------------------------------------------------------------------------
// Remediation
// ---------------------------------------------------------------------------

/** Copy-paste snippet: unset each offending var for the current shell, with a
 * comment pointing at the profile line to hunt down for a permanent fix.
 * Deliberately does NOT edit any profile itself. */
export function buildRemediationSnippet(reasons: DisableReason[]): string {
  if (reasons.length === 0) return "";
  const lines: string[] = [
    "# Cross-session messaging (ListAgents/SendMessage) is disabled by these env vars.",
    "# Unset for this shell, then restart Claude Code from it:",
  ];
  for (const r of reasons) {
    lines.push(`unset ${r.envVar}`);
  }
  lines.push(
    "# Permanent fix: remove the export line(s) from your shell profile",
    `#   grep -n -E '${reasons.map((r) => r.envVar).join("|")}' ~/.zshrc ~/.zprofile ~/.bashrc ~/.bash_profile 2>/dev/null`,
    '# Also check the "env" block in ~/.claude/settings.json (and project',
    "# .claude/settings.json) — settings env overrides the shell, so unset",
    "# alone won't fix vars set there."
  );
  return lines.join("\n") + "\n";
}

/** Snippet for the evidence-only warn (env clean here, but `/list-agents`
 * failed in recent transcripts): there is nothing to unset in THIS process,
 * so hand the user the hunt commands for where the var actually lives. */
export function buildInvestigationSnippet(): string {
  const names = MESSAGING_DISABLE_ENV_VARS.map((k) => k.name).join("|");
  return [
    "# /list-agents was tried in recent Claude sessions but the ListAgents tool never ran.",
    "# This VS Code process's env looks clean — check the shell that launches claude:",
    `env | grep -E '${names}'`,
    "# …and the \"env\" block in Claude settings (settings env overrides the shell):",
    `grep -n -E '${names}' ~/.claude/settings.json .claude/settings.json .claude/settings.local.json 2>/dev/null`,
    "# …and your shell profile:",
    `grep -n -E '${names}' ~/.zshrc ~/.zprofile ~/.bashrc ~/.bash_profile 2>/dev/null`,
  ].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Doctor result
// ---------------------------------------------------------------------------

export type MessagingDoctorSeverity = "ok" | "warn";

export interface MessagingDoctorResult {
  reasons: DisableReason[];
  severity: MessagingDoctorSeverity;
  remediation: string;
  /** Transcript probe, when the caller had a session store to scan. */
  evidence?: TranscriptEvidence;
  evidenceVerdict: TranscriptEvidenceVerdict;
}

/** Env snapshot (+ optional transcript evidence) → doctor verdict. `warn`
 * iff at least one known var is set to a disabling value OR the transcripts
 * show a failed `/list-agents` attempt with no messaging tool ever running.
 * The caller decides whether to render anything on `ok` (the Insights card
 * hides itself). */
export function runMessagingDoctor(
  env: Record<string, string | undefined>,
  evidence?: TranscriptEvidence
): MessagingDoctorResult {
  const reasons = resolveDisableReasons(env);
  const evidenceVerdict = transcriptEvidenceVerdict(evidence);
  const warn = reasons.length > 0 || evidenceVerdict === "attempted-absent";
  return {
    reasons,
    severity: warn ? "warn" : "ok",
    remediation:
      reasons.length > 0
        ? buildRemediationSnippet(reasons)
        : evidenceVerdict === "attempted-absent"
          ? buildInvestigationSnippet()
          : "",
    evidence,
    evidenceVerdict,
  };
}

// ---------------------------------------------------------------------------
// Live-monitor strip stat (ops surface)
// ---------------------------------------------------------------------------

export interface MessagingStripStat {
  /** Short value for the summary strip, e.g. "⚠ 2 vars" or "⚠ evidence". */
  value: string;
  /** Hover text: what tripped, Claude-only scope ("n/a" for other backends),
   * and the click action. Plain text — goes into a title attribute. */
  tooltip: string;
  /** Exact snippet a click-to-copy should put on the clipboard (matches what
   * the Insights card would offer for the same verdict). */
  snippet: string;
}

/** Doctor verdict → compact stat for the live-monitor summary strip, or null
 * on ok (the strip shows nothing rather than a green tick — messaging being
 * healthy is the default, not news). Pure and render-agnostic so the strip
 * logic is unit-testable without a webview. */
export function summarizeForStrip(result: MessagingDoctorResult): MessagingStripStat | null {
  if (result.severity === "ok") return null;
  const n = result.reasons.length;
  const value = n > 0 ? `⚠ ${n} var${n === 1 ? "" : "s"}` : "⚠ evidence";
  const lines: string[] = [];
  if (n > 0) {
    lines.push(
      `Cross-session messaging (ListAgents/SendMessage) is likely disabled by: ${result.reasons
        .map((r) => `${r.envVar}=${r.value}`)
        .join(", ")}.`
    );
    if (result.evidenceVerdict === "attempted-absent") {
      lines.push("Corroborated by transcripts: /list-agents was tried but the tool never ran.");
    } else if (result.evidenceVerdict === "seen") {
      lines.push("Note: the messaging tools did run recently — may still be working.");
    }
  } else {
    const ev = result.evidence;
    lines.push(
      `/list-agents was tried in ${ev?.attemptTurns ?? 0} recent turn(s) but the ListAgents tool never ran — messaging is likely disabled by env outside this process.`
    );
  }
  lines.push("Claude backend only; other backends: n/a.");
  lines.push("Click to copy the fix snippet. Details: Insights → Messaging doctor.");
  return { value, tooltip: lines.join(" "), snippet: result.remediation };
}

// ---------------------------------------------------------------------------
// Insights card HTML (script-free; command URI for the copy action)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface MessagingDoctorCardOpts {
  /** When false, omit command: links (tests / non-webview). Default true. */
  commandUris?: boolean;
}

/** Card for the Insights dashboard. Returns "" when severity is ok — the
 * card only exists when there is something to warn about. */
export function renderMessagingDoctorCardHtml(
  result: MessagingDoctorResult,
  opts?: MessagingDoctorCardOpts
): string {
  if (result.severity === "ok") return "";
  const commandUris = opts?.commandUris !== false;
  const copyBtn = commandUris
    ? `<a class="doctor-action" href="command:codeSessions.copyMessagingDoctorFix?${encodeURIComponent(
        JSON.stringify([result.remediation])
      )}">Copy fix</a>`
    : "";
  const rows = result.reasons
    .map(
      (r) =>
        `<div class="doctor-row"><code>${escapeHtml(r.envVar)}=${escapeHtml(
          r.value
        )}</code> <span class="muted">— ${escapeHtml(r.purpose)}</span></div>`
    )
    .join("");
  const ev = result.evidence;
  const attemptedAbsent = result.evidenceVerdict === "attempted-absent";
  const subtitle =
    result.reasons.length > 0
      ? `These privacy/telemetry env vars are set in this VS Code process. Each one silently turns off
    Claude Code's feature-flag fetch, which disables <code>ListAgents</code> / <code>SendMessage</code>
    cross-machine messaging and Remote Control (same-machine peer messaging may still work):`
      : `No disabling env vars are visible in this VS Code process, but <code>/list-agents</code> was
    tried in ${ev?.attemptTurns ?? 0} turn(s) across the last ${ev?.sessionsScanned ?? 0} Claude
    session(s) and the <code>ListAgents</code> tool never ran — messaging is likely disabled by an
    env var set in the shell that launches <code>claude</code>, or by the <code>env</code> block in
    <code>~/.claude/settings.json</code>. "Copy fix" puts the hunt commands on the clipboard.`;
  let evidenceLine = "";
  if (result.reasons.length > 0 && attemptedAbsent) {
    evidenceLine = `<div class="doctor-row"><span class="muted">Corroborated by transcripts:
      <code>/list-agents</code> tried in ${ev!.attemptTurns} turn(s) across the last
      ${ev!.sessionsScanned} Claude session(s); the tool never ran.</span></div>`;
  } else if (result.reasons.length > 0 && result.evidenceVerdict === "seen") {
    evidenceLine = `<div class="doctor-row"><span class="muted">Note: <code>ListAgents</code> /
      <code>SendMessage</code> did run in recent Claude sessions — messaging may still be working
      despite these vars.</span></div>`;
  }
  return `<div class="card">
  <div class="card-title">⚠ Cross-session messaging likely disabled ${copyBtn}</div>
  <div class="subtitle">${subtitle}</div>
  ${rows}
  ${evidenceLine}
  <div class="doctor-disclaimer">
    Heuristic: this probes the VS Code process env${
      ev && ev.sessionsScanned > 0 ? " and recent Claude session transcripts" : ""
    }, which can differ from the shell that launches
    <code>claude</code> — treat as "likely", not proof. Claude backend only; other backends are
    unaffected. Read-only: never edits your shell profile. "Copy fix" puts ${
      result.reasons.length > 0 ? "an unset snippet" : "the hunt commands"
    } on the
    clipboard; restart Claude Code from a shell where the vars are unset to re-enable messaging.
  </div>
</div>`;
}
