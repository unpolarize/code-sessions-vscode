// Settings-driven "is this session automated?" predicate.
//
// The DB `is_automated` flag only covers Claude entrypoints the indexer
// already understands. Night loops, fleet, digests, and git-store mirrors
// use `sdk-cli` (same as Code Build) or have `is_automated=0`, so they leak
// into the Sessions tree. Matching title / first-user-msg / extras.labels
// catches the suite's own KP/CSV/CS jobs without hiding interactive CB
// sessions in those same repos.

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
];

export interface AutomationMatchInput {
  is_automated?: boolean | null;
  entrypoint?: string | null;
  title?: string | null;
  first_user_msg?: string | null;
  extras_json?: string | null;
  kind?: string | null;
}

export interface AutomationConfig {
  honorDbFlag: boolean;
  extraEntrypoints: string[];
  titlePatterns: string[];
  extraLabels: string[];
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

function labelsFromExtras(extras_json?: string | null): string[] {
  if (!extras_json) return [];
  try {
    const o = JSON.parse(extras_json);
    if (!Array.isArray(o?.labels)) return [];
    return o.labels.map((x: unknown) => String(x));
  } catch {
    return [];
  }
}

function haystack(row: AutomationMatchInput): string {
  return `${row.title ?? ""}\n${row.first_user_msg ?? ""}`.toLowerCase();
}

export function isAutomatedSession(
  row: AutomationMatchInput,
  config?: Partial<AutomationConfig>,
): boolean {
  const cfg = resolveAutomationConfig(config);
  if (cfg.honorDbFlag && row.is_automated) return true;
  const kind = row.kind ?? "session";
  if (kind && kind !== "session") return true;
  const ep = (row.entrypoint ?? "").trim().toLowerCase();
  if (ep && cfg.extraEntrypoints.some((x) => x.toLowerCase() === ep)) return true;
  if (ep && !INTERACTIVE_ENTRYPOINTS.has(ep)) return true;
  const text = haystack(row);
  if (text && cfg.titlePatterns.some((p) => p && text.includes(p.toLowerCase()))) return true;
  const labels = labelsFromExtras(row.extras_json).map((l) => l.toLowerCase());
  if (labels.some((l) => cfg.extraLabels.some((x) => x.toLowerCase() === l))) return true;
  return false;
}
