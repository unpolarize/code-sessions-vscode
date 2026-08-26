/**
 * Cross-laptop session inventory for the Planning dashboard fleet board.
 *
 * Live status is derived from envelope / turn content timestamps and from
 * the local live-monitor window (native JSONL mtime). Git-store file mtime
 * is intentionally ignored — a `git pull` of ~/.sessions rewrites mtime and
 * would make yesterday's sessions look like they started seconds ago.
 */

export const LIVE_LOCAL_MS = 2 * 60 * 1000;
export const LIVE_REMOTE_MS = 15 * 60 * 1000;

export type SessionStatus = "live-local" | "active-remote" | "open" | "ended";

export interface FleetSession {
  uuid: string;
  title?: string;
  agent?: string;
  host?: string;
  project?: string;
  projectPath?: string;
  source: "claude" | "grok" | "git" | "codex";
  startedAt: number;
  mtime: number;
  lastActivity: number;
  endedAt?: number | null;
  open: boolean;
  turns?: number;
  cost?: number;
  planningRefs: string[];
  labels: string[];
  intent?: string;
  firstUserMsg?: string;
  status: SessionStatus;
  linked: boolean;
  /** Suite automation (cron / night-loop / fleet / non-interactive). */
  automated: boolean;
}

export function shortHost(h: string | undefined): string {
  return (h ?? "").replace(/\.(local|lan)$/i, "") || "unknown";
}

export function parseIntent(labels: string[] | undefined): string | undefined {
  const hit = (labels ?? []).find((l) => l.startsWith("intent:"));
  return hit ? hit.slice("intent:".length).trim() || undefined : undefined;
}

export function parseExtras(json: string | null | undefined): {
  host?: string;
  labels: string[];
  open?: boolean;
  planning_refs: string[];
} {
  if (!json) return { labels: [], planning_refs: [] };
  try {
    const o = JSON.parse(json) as {
      host?: string;
      labels?: string[];
      open?: boolean;
      planning_refs?: string[];
    };
    return {
      host: typeof o.host === "string" ? o.host : undefined,
      labels: Array.isArray(o.labels) ? o.labels.map(String) : [],
      open: o.open === true,
      planning_refs: Array.isArray(o.planning_refs) ? o.planning_refs.map(String) : [],
    };
  } catch {
    return { labels: [], planning_refs: [] };
  }
}

export function classifyStatus(opts: {
  host?: string;
  localHost: string;
  open: boolean;
  lastActivity: number;
  now: number;
  localLive?: boolean;
}): SessionStatus {
  if (opts.localLive) return "live-local";
  if (!opts.open) return "ended";
  const age = opts.now - opts.lastActivity;
  const recent = opts.lastActivity > 0 && age >= 0 && age < LIVE_REMOTE_MS;
  const same = shortHost(opts.host) === shortHost(opts.localHost);
  if (recent) return same ? "live-local" : "active-remote";
  return "open";
}

export function toFleetSession(
  raw: {
    uuid: string;
    title?: string;
    agent?: string;
    host?: string;
    project?: string;
    projectPath?: string;
    source: "claude" | "grok" | "git" | "codex";
    startedAt: number;
    mtime: number;
    lastActivity?: number;
    endedAt?: number | null;
    open?: boolean;
    turns?: number;
    cost?: number;
    planningRefs?: string[];
    labels?: string[];
    firstUserMsg?: string;
    automated?: boolean;
  },
  opts: { now: number; localHost: string; localLiveIds?: Set<string> },
): FleetSession {
  const open = raw.open ?? (raw.endedAt == null || raw.endedAt === 0);
  // Prefer content timestamps. Fall back to startedAt. Never use git mtime
  // as lastActivity — callers must pass lastActivity from turn/envelope ts.
  const lastActivity = raw.lastActivity && raw.lastActivity > 0 ? raw.lastActivity : raw.startedAt || 0;
  const labels = raw.labels ?? [];
  const status = classifyStatus({
    host: raw.host,
    localHost: opts.localHost,
    open,
    lastActivity,
    now: opts.now,
    localLive: opts.localLiveIds?.has(raw.uuid) === true,
  });
  const refs = raw.planningRefs ?? [];
  return {
    uuid: raw.uuid,
    title: raw.title,
    agent: raw.agent,
    host: shortHost(raw.host),
    project: raw.project,
    projectPath: raw.projectPath,
    source: raw.source,
    startedAt: raw.startedAt,
    mtime: raw.mtime,
    lastActivity,
    endedAt: raw.endedAt,
    open,
    turns: raw.turns,
    cost: raw.cost,
    planningRefs: refs,
    labels,
    intent: parseIntent(labels),
    firstUserMsg: raw.firstUserMsg,
    status,
    linked: refs.length > 0,
    automated: raw.automated === true,
  };
}

/** Merge SQLite-index rows with git-store rows by uuid. Git-only rows are
 * other-laptop sessions that never had a native transcript here. */
export function mergeFleetSessions(parts: FleetSession[]): FleetSession[] {
  const map = new Map<string, FleetSession>();
  for (const s of parts) {
    const prev = map.get(s.uuid);
    if (!prev) {
      map.set(s.uuid, s);
      continue;
    }
    map.set(s.uuid, {
      ...prev,
      ...s,
      title: s.title || prev.title,
      host: s.host && s.host !== "unknown" ? s.host : prev.host,
      labels: s.labels.length ? s.labels : prev.labels,
      intent: s.intent || prev.intent,
      planningRefs: [...new Set([...prev.planningRefs, ...s.planningRefs])],
      linked: prev.linked || s.linked,
      firstUserMsg: s.firstUserMsg || prev.firstUserMsg,
      automated: prev.automated || s.automated,
      lastActivity: Math.max(prev.lastActivity, s.lastActivity),
      status:
        s.status === "live-local" || prev.status === "live-local"
          ? "live-local"
          : s.status === "active-remote" || prev.status === "active-remote"
            ? "active-remote"
            : s.status === "open" || prev.status === "open"
              ? "open"
              : "ended",
    });
  }
  return [...map.values()].sort((a, b) => b.lastActivity - a.lastActivity);
}

export function groupFleetByHost(rows: FleetSession[]): { host: string; live: number; rows: FleetSession[] }[] {
  const map = new Map<string, FleetSession[]>();
  for (const r of rows) {
    const h = shortHost(r.host);
    const list = map.get(h) ?? [];
    list.push(r);
    map.set(h, list);
  }
  return [...map.entries()]
    .map(([host, list]) => ({
      host,
      live: list.filter((x) => x.status === "live-local" || x.status === "active-remote").length,
      rows: list.sort((a, b) => b.lastActivity - a.lastActivity),
    }))
    .sort((a, b) => b.live - a.live || a.host.localeCompare(b.host));
}

export function localLiveIds(
  rows: Array<{ session_id: string; mtime_ns: number; source?: string }>,
  now: number,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    // Native jsonl mtime is trustworthy (not git). Git-store paths are not.
    if (r.source === "git") continue;
    if (now - r.mtime_ns / 1e6 < LIVE_LOCAL_MS) out.add(r.session_id);
  }
  return out;
}
