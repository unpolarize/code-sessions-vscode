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
