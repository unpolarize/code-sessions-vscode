/** Coding-pipeline host helpers — lane moves, kick vs claim, default route.
 *
 * Pure (no vscode) so unit tests can pin:
 *   - drop on in_progress claims (task@in_progress / idea@plan) and does not kick
 *   - drop on implementation still kicks
 *   - empty remembered route → Grok · grok-4.6 · high
 * Per-item implement_backend/implement_model still win at the call site.
 */

export type ImplRoute = { backend?: string; model?: string; effort?: string };

export const DEFAULT_IMPL_ROUTE: Required<ImplRoute> = {
  backend: "grok",
  model: "grok-4.6",
  effort: "high",
};

function cleanRoute(r?: ImplRoute | null): ImplRoute | null {
  if (!r) return null;
  const backend = r.backend && r.backend !== "-" ? String(r.backend) : "";
  const model = r.model && r.model !== "-" ? String(r.model) : "";
  const effort = r.effort && r.effort !== "-" ? String(r.effort) : "";
  if (!backend && !model && !effort) return null;
  return { backend, model, effort };
}

/** Board override, then remembered `kp.implRoute.last`, then Grok · grok-4.6 · high. */
export function resolveImplRoute(override?: ImplRoute | null, remembered?: ImplRoute | null): ImplRoute {
  return cleanRoute(override) || cleanRoute(remembered) || { ...DEFAULT_IMPL_ROUTE };
}

/** Only the Implementation lane starts a builder; In progress never does. */
export function pipelineMoveKicks(lane: string, opts?: { kick?: boolean }): boolean {
  return lane === "implementation" && opts?.kick !== false;
}

/** Status the host writes for a pipeline lane. `approved` is a separate path. */
export function pipelineStatusForLane(type: string, lane: string): string | null {
  if (lane === "inbox") return type === "task" ? "inbox" : "capture";
  if (lane === "in_progress" || lane === "implementation") return type === "task" ? "in_progress" : "plan";
  if (lane === "done") return "done";
  return null;
}

/** Minimal session shape resolveOpenCbTarget needs (structural — FleetSession fits). */
export type OpenCbSession = {
  uuid: string;
  source: string;
  projectPath?: string;
  mtime?: number;
  title?: string;
};

export type OpenCbTarget =
  | { mode: "resume"; uuid: string; source: string; cwd: string; title?: string }
  | { mode: "new" };

/** Item-view "Open in Code Build": resume the item's linked session when one is
 * resumable locally (codeBuild.openExternalSession needs a source + cwd, so
 * git-store-only rows don't qualify); otherwise open a new seeded conversation. */
export function resolveOpenCbTarget(
  linked: readonly string[] | undefined,
  sessions: readonly OpenCbSession[],
): OpenCbTarget {
  const ids = new Set((linked ?? []).filter(Boolean));
  if (ids.size === 0) return { mode: "new" };
  const hit = sessions
    .filter((s) => ids.has(s.uuid) && s.source !== "git" && !!s.projectPath)
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))[0];
  if (!hit) return { mode: "new" };
  return { mode: "resume", uuid: hit.uuid, source: hit.source, cwd: decodeSessionCwd(hit.projectPath!), title: hit.title };
}

/** Claude rows carry the `~/.claude/projects/-Users-...` store dir, not the cwd;
 * CB re-encodes whatever cwd it is handed to find the transcript, so the raw
 * form must be decoded here (same dash-basename heuristic as SessionsProvider.
 * decodeClaudeProjectDir). Grok / already-decoded paths pass through. */
function decodeSessionCwd(projectPath: string): string {
  const base = projectPath.split("/").filter(Boolean).pop() ?? "";
  if (!base.startsWith("-")) return projectPath;
  return "/" + base.replace(/^-/, "").replace(/-/g, "/");
}
