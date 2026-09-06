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

// ---------------------------------------------------------------------------
// Doctor result
// ---------------------------------------------------------------------------

export type MessagingDoctorSeverity = "ok" | "warn";

export interface MessagingDoctorResult {
  reasons: DisableReason[];
  severity: MessagingDoctorSeverity;
  remediation: string;
}

/** Env snapshot → doctor verdict. `warn` iff at least one known var is set
 * to a disabling value; the caller decides whether to render anything on
 * `ok` (the Insights card hides itself). */
export function runMessagingDoctor(
  env: Record<string, string | undefined>
): MessagingDoctorResult {
  const reasons = resolveDisableReasons(env);
  return {
    reasons,
    severity: reasons.length > 0 ? "warn" : "ok",
    remediation: buildRemediationSnippet(reasons),
  };
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
        JSON.stringify([])
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
  return `<div class="card">
  <div class="card-title">⚠ Cross-session messaging likely disabled ${copyBtn}</div>
  <div class="subtitle">These privacy/telemetry env vars are set in this VS Code process. Each one silently turns off
    Claude Code's feature-flag fetch, which disables <code>ListAgents</code> / <code>SendMessage</code>
    cross-machine messaging and Remote Control (same-machine peer messaging may still work):</div>
  ${rows}
  <div class="doctor-disclaimer">
    Heuristic: this probes the VS Code process env, which can differ from the shell that launches
    <code>claude</code> — treat as "likely", not proof. Claude backend only; other backends are
    unaffected. Read-only: never edits your shell profile. "Copy fix" puts an unset snippet on the
    clipboard; restart Claude Code from a shell where the vars are unset to re-enable messaging.
  </div>
</div>`;
}
