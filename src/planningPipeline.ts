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
  /** Git-store / daemon rows keep source "git" and put claude|grok here. */
  agent?: string;
};

export type OpenCbTarget =
  | { mode: "resume"; uuid: string; source: "claude" | "grok"; cwd: string; title?: string }
  | { mode: "missing"; uuid?: string }
  | { mode: "new" };

export type CbBackend = "claude" | "grok";

/** Map a CSV/fleet source (+ optional git-store agent) onto a CB backend.
 * Never return "git" — CB openExternalSession silently no-ops that source. */
export function mapCbBackend(source?: string | null, agent?: string | null): CbBackend | null {
  const s = (source || "").toLowerCase();
  const a = (agent || "").toLowerCase();
  if (s === "grok" || a.includes("grok")) return "grok";
  if (s === "claude" || a.includes("claude")) return "claude";
  if (s === "codex" || a.includes("codex")) return null;
  // Daemon / git-indexer rows. Kick/night-build default is grok.
  if (s === "git") return "grok";
  return null;
}

/** True when jsonl_path is a real claude/grok/codex transcript, not the git
 * store's session.json metadata file (which exists and used to skip the
 * git-store resume path). */
export function isNativeTranscriptPath(p?: string | null): boolean {
  if (!p) return false;
  const n = p.replace(/\\/g, "/");
  if (n.includes("/.sessions/hosts/")) return false;
  return n.endsWith(".jsonl");
}

export type ContinueCbFact = {
  uuid: string;
  source?: string | null;
  agent?: string | null;
  projectPath?: string | null;
  title?: string | null;
  nativeJsonl: boolean;
  storeTurns: boolean;
  storeHost?: string;
};

export type ContinueCbPlan =
  | { action: "native"; source: CbBackend; cwd: string; uuid: string; title?: string }
  | { action: "git-store"; source: CbBackend; cwd: string; uuid: string; title?: string; host?: string }
  | { action: "missing" };

/** Decide how Continue-in-CB should open: local JSONL, git-store hydrate, or
 * explicit missing (never a silent empty chat). */
export function planContinueInCodeBuild(fact: ContinueCbFact, fallbackCwd?: string): ContinueCbPlan {
  const source = mapCbBackend(fact.source, fact.agent) ?? "grok";
  const cwdRaw = fact.projectPath ? decodeSessionCwd(fact.projectPath) : undefined;
  const cwd = cwdRaw || fallbackCwd;
  const title = fact.title || undefined;
  if (fact.nativeJsonl && cwd) return { action: "native", source, cwd, uuid: fact.uuid, title };
  if (fact.storeTurns && cwd) {
    return { action: "git-store", source, cwd, uuid: fact.uuid, title, host: fact.storeHost };
  }
  return { action: "missing" };
}

/** Item-view "Open in Code Build": resume a linked session (including git-store
 * rows with a cwd — CB hydrates from injected records). Linked-but-unresumable
 * is `missing` (toast), not a silent new chat. Nothing linked → new. */
export function resolveOpenCbTarget(
  linked: readonly string[] | undefined,
  sessions: readonly OpenCbSession[],
): OpenCbTarget {
  const ids = new Set((linked ?? []).filter(Boolean));
  if (ids.size === 0) return { mode: "new" };
  const matches = sessions
    .filter((s) => ids.has(s.uuid))
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  const hit = matches.find((s) => !!s.projectPath) ?? matches[0];
  if (!hit) return { mode: "missing" };
  const source = mapCbBackend(hit.source, hit.agent);
  if (!source || !hit.projectPath) return { mode: "missing", uuid: hit.uuid };
  return {
    mode: "resume",
    uuid: hit.uuid,
    source,
    cwd: decodeSessionCwd(hit.projectPath),
    title: hit.title,
  };
}

/** Claude rows carry the `~/.claude/projects/-Users-...` store dir, not the cwd;
 * CB re-encodes whatever cwd it is handed to find the transcript, so the raw
 * form must be decoded here (same dash-basename heuristic as SessionsProvider.
 * decodeClaudeProjectDir). Grok / already-decoded paths pass through. */
export function decodeSessionCwd(projectPath: string): string {
  const base = projectPath.split("/").filter(Boolean).pop() ?? "";
  if (!base.startsWith("-")) return projectPath;
  return "/" + base.replace(/^-/, "").replace(/-/g, "/");
}
