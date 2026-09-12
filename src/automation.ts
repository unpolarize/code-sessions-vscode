// Settings-driven "is this session automated?" predicate.
//
// The DB `is_automated` flag only covers Claude entrypoints the indexer
// already understands. Night loops, fleet, digests, and git-store mirrors
// use `sdk-cli` (same as Code Build) or have `is_automated=0`, so they leak
// into the Sessions tree. Matching title / first-user-msg / extras.labels
// catches the suite's own KP/CSV/CS jobs without hiding interactive CB
// sessions in those same repos.
//
// Grok Build one-shots (`grok -p`) record entrypoint `grok-build-plan`
// (interactive allow-list) and stash `<user_info>` / `<system-reminder>` as
// turn 0, so the real `# Grok IMPLEMENT` / IDEATE / validate prompt never
// reached this matcher until we unwrap `<user_query>` and skip harness turns.
// Filter hide rule: automated AND NOT human-continued in Code Build.

export const INTERACTIVE_ENTRYPOINTS = new Set([
  "cli",
  "claude-code",
  "claude-vscode",
  "claude-jetbrains",
  "sdk-cli",
  // Grok Build / Code Build interactive sessions (not night-loop cron).
  "grok-build-plan",
  "grok",
  "code-build",
  "acp",
  // Git-store envelope `agent` is the product (claude/codex), not a cron entrypoint.
  "claude",
  "codex",
  "codex-cli",
  "",
]);

/** Distinctive lead-ins from ~/docs/scripts night/cron/fleet prompts. */
export const DEFAULT_TITLE_PATTERNS = [
  "you are an autonomous overnight",
  "you are an autonomous",
  "night implement",
  "night ideate",
  "night-implement",
  "night-ideate",
  "/daily-digest",
  "run /daily-digest",
  "run /grok-gmail-scan",
  "run the /planning-discover",
  "this is running via cron",
  "automated hourly sync",
  "implementation phase, scheduled",
  "ideation phase of a 5-hour",
  "no user interaction",
  "kp implementable",
  "grok-ideate",
  // Grok machine lanes (implement / ideate / email / overnight validate).
  // Matched against title + unwrapped first user_query, not generated work titles.
  "you are grok build running",
  "you are grok build composing",
  "60-minute autonomous implementation",
  "autonomous implementation slot",
  "autonomous ideation slot",
  "# grok implement",
  "# grok ideate",
  "primary queue is kp",
  "you are headless (`grok -p`)",
  "grok-implement-result",
  "validate this kp task",
  "overnight auto-implement",
  "divergent-thinking lane",
];

export const DEFAULT_EXTRA_ENTRYPOINTS = [
  "sdk",
  "routine",
  "headless",
  "cron",
  "launchd",
  "api",
];

export const DEFAULT_AUTO_LABELS = [
  "cron",
  "automated",
  "headless",
  "launchd",
  "fleet",
  "night-loop",
  "night-ideate",
  "night-implement",
  "grok-implement",
  "grok-ideate",
  "grok-email",
  "lane-kick",
  "kp-validate",
];

const HUMAN_CONTINUED_LABELS = new Set([
  "human-continued",
  "continued-in-cb",
  "continued_by_human",
]);

const AUTO_PHASES = new Set([
  "night-ideate",
  "night-implement",
  "night-loop",
  "grok-implement",
  "grok-ideate",
  "grok-email",
  "lane-kick",
  "kp-validate",
  "probe",
]);

const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i;

export interface AutomationMatchInput {
  is_automated?: boolean | null;
  entrypoint?: string | null;
  title?: string | null;
  first_user_msg?: string | null;
  extras_json?: string | null;
  kind?: string | null;
  /** Later real user prompts (after the first meaningful one). Used to detect
   * a human continuing an automated session in Code Build. */
  later_user_msgs?: Array<string | null | undefined> | null;
}

export interface AutomationConfig {
  honorDbFlag: boolean;
  extraEntrypoints: string[];
  titlePatterns: string[];
  extraLabels: string[];
}

export interface AutomationExtras {
  labels: string[];
  automated?: boolean;
  continued_by_human?: boolean;
  phase?: string;
  agent?: string;
}

export function defaultAutomationConfig(): AutomationConfig {
  return {
    honorDbFlag: true,
    extraEntrypoints: [...DEFAULT_EXTRA_ENTRYPOINTS],
    titlePatterns: [...DEFAULT_TITLE_PATTERNS],
    extraLabels: [...DEFAULT_AUTO_LABELS],
  };
}

export function resolveAutomationConfig(partial?: Partial<AutomationConfig>): AutomationConfig {
  const d = defaultAutomationConfig();
  if (!partial) return d;
  return {
    honorDbFlag: partial.honorDbFlag ?? d.honorDbFlag,
    extraEntrypoints: partial.extraEntrypoints ?? d.extraEntrypoints,
    titlePatterns: partial.titlePatterns ?? d.titlePatterns,
    extraLabels: partial.extraLabels ?? d.extraLabels,
  };
}

export function parseAutomationExtras(extras_json?: string | null): AutomationExtras {
  if (!extras_json) return { labels: [] };
  try {
    const o = JSON.parse(extras_json);
    const labels = Array.isArray(o?.labels) ? o.labels.map((x: unknown) => String(x)) : [];
    return {
      labels,
      automated: typeof o?.automated === "boolean" ? o.automated : undefined,
      continued_by_human:
        typeof o?.continued_by_human === "boolean" ? o.continued_by_human : undefined,
      phase: typeof o?.phase === "string" ? o.phase : undefined,
      agent: typeof o?.agent === "string" ? o.agent : undefined,
    };
  } catch {
    return { labels: [] };
  }
}

/** Grok/ACP injects these as `type:user` before the real prompt. */
export function isHarnessUserText(text: string): boolean {
  const t = text.trimStart();
  if (!t) return true;
  if (t.startsWith("<user_info>")) return true;
  if (t.startsWith("<system-reminder>")) return true;
  if (t.startsWith("<rules>")) return true;
  if (t.startsWith("<mcp_")) return true;
  return false;
}

/** Prefer the inner `<user_query>` body when Grok wraps the prompt. */
export function unwrapUserQuery(text: string): string {
  if (!text) return text;
  const m = USER_QUERY_RE.exec(text);
  return m ? m[1].trim() : text;
}

/** First real operator prompt: skip harness turns, unwrap `<user_query>`. */
export function firstMeaningfulUserText(
  texts: Array<string | null | undefined> | null | undefined,
): string {
  if (!texts) return "";
  for (const raw of texts) {
    if (!raw) continue;
    const hasQuery = USER_QUERY_RE.test(raw);
    const unwrapped = unwrapUserQuery(raw).trim();
    if (!unwrapped) continue;
    if (hasQuery) return unwrapped;
    if (!isHarnessUserText(unwrapped)) return unwrapped;
  }
  return "";
}

/** Real follow-up prompts after the first meaningful one (harness skipped). */
export function laterMeaningfulUserTexts(
  texts: Array<string | null | undefined> | null | undefined,
): string[] {
  if (!texts) return [];
  const out: string[] = [];
  let seenFirst = false;
  for (const raw of texts) {
    const meaningful = firstMeaningfulUserText([raw]);
    if (!meaningful) continue;
    if (!seenFirst) {
      seenFirst = true;
      continue;
    }
    out.push(meaningful);
  }
  return out;
}

function haystack(row: AutomationMatchInput): string {
  const prompt = firstMeaningfulUserText([row.first_user_msg]) || "";
  return `${row.title ?? ""}\n${prompt}`.toLowerCase();
}

function matchesTitlePatterns(text: string, patterns: string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return patterns.some((p) => p && lower.includes(p.toLowerCase()));
}

export function isAutomatedSession(
  row: AutomationMatchInput,
  config?: Partial<AutomationConfig>,
): boolean {
  const cfg = resolveAutomationConfig(config);
  const extras = parseAutomationExtras(row.extras_json);
  if (cfg.honorDbFlag && row.is_automated) return true;
  if (extras.automated === true) return true;
  const kind = row.kind ?? "session";
  if (kind && kind !== "session") return true;
  const ep = (row.entrypoint ?? "").trim().toLowerCase();
  if (ep && cfg.extraEntrypoints.some((x) => x.toLowerCase() === ep)) return true;
  if (ep && !INTERACTIVE_ENTRYPOINTS.has(ep)) return true;
  const text = haystack(row);
  if (matchesTitlePatterns(text, cfg.titlePatterns)) return true;
  const labels = extras.labels.map((l) => l.toLowerCase());
  if (labels.some((l) => cfg.extraLabels.some((x) => x.toLowerCase() === l))) return true;
  const phase = (extras.phase ?? "").trim().toLowerCase();
  if (phase && AUTO_PHASES.has(phase)) return true;
  return false;
}

/** True only when a person resumed/continued the session in Code Build
 * (a later real user prompt after the machine run) — not merely viewed it. */
export function isHumanContinuedSession(
  row: AutomationMatchInput,
  config?: Partial<AutomationConfig>,
): boolean {
  const extras = parseAutomationExtras(row.extras_json);
  if (extras.continued_by_human === true) return true;
  const labels = extras.labels.map((l) => l.toLowerCase());
  if (labels.some((l) => HUMAN_CONTINUED_LABELS.has(l))) return true;
  // later_user_msgs is already "after the first prompt" — don't drop the first
  // entry the way laterMeaningfulUserTexts does on a full turn list.
  const later = (row.later_user_msgs ?? [])
    .map((m) => firstMeaningfulUserText([m]))
    .filter((m): m is string => m.length > 0);
  if (later.length === 0) return false;
  const cfg = resolveAutomationConfig(config);
  // A later turn that still looks like a machine prompt is not a human continue.
  return later.some((msg) => !matchesTitlePatterns(msg, cfg.titlePatterns));
}

/** Sessions-tree hide rule: automated AND NOT human-continued. */
export function hideAutomatedSession(
  row: AutomationMatchInput,
  config?: Partial<AutomationConfig>,
): boolean {
  return isAutomatedSession(row, config) && !isHumanContinuedSession(row, config);
}

/** Stamp extras_json with automation provenance without dropping existing keys. */
export function mergeAutomationExtras(
  extras_json: string | null | undefined,
  stamp: { automated: boolean; continued_by_human: boolean },
): string {
  let o: Record<string, unknown> = {};
  if (extras_json) {
    try {
      const parsed = JSON.parse(extras_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        o = parsed as Record<string, unknown>;
      }
    } catch {
      o = {};
    }
  }
  o.automated = stamp.automated;
  o.continued_by_human = stamp.continued_by_human;
  return JSON.stringify(o);
}
