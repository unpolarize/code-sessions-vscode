/** Screenshot-evidence policy — which items should be nagged for an
 * implementation screenshot.
 *
 * The red "missing" chip on done cards and the done-without-screenshot nudge
 * only make sense where the deliverable has a UI to screenshot. That is a
 * per-repo signal, not per-item: items targeting CLI-only repos (e.g.
 * knowledge-planning) can never have a meaningful UI screenshot, and a
 * permanent red chip there trains the eye to ignore real missing-evidence
 * signals on UI repos.
 *
 * Pure module (no vscode import) so the classifier stays unit-testable; the
 * host reads the `codeSessions.planning.uiRepos` setting and passes it in.
 */

/** Repos whose deliverable is a UI — screenshot evidence applies. Zero-config
 * default; overridable via the `codeSessions.planning.uiRepos` setting. */
export const DEFAULT_UI_REPOS: readonly string[] = ["code-sessions-vscode", "code-build-vscode"];

/** Whether screenshot evidence applies to an item with this target_repo.
 *
 * - no / empty target_repo → true (non-coding items keep today's behavior);
 * - matches either the full value or its basename ("owner/repo" → "repo"),
 *   since target_repo is sometimes recorded as a path/slug.
 */
export function screenshotApplies(targetRepo: unknown, uiRepos: readonly string[] = DEFAULT_UI_REPOS): boolean {
  const raw = typeof targetRepo === "string" ? targetRepo.trim() : "";
  if (!raw) return true;
  const base = raw.split("/").pop() || raw;
  return uiRepos.includes(raw) || uiRepos.includes(base);
}
