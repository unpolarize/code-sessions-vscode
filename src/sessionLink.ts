/**
 * Canonical shareable session links.
 *
 * Single authority (not csv:// / cb://): VS Code binds vscode:// URIs to the
 * extension id, so the working authority is `zhirafovod.code-sessions`.
 * CSV owns the handler; `view=cb` forwards into Code Build.
 *
 *   vscode://zhirafovod.code-sessions/open?session=<uuid>[&view=csv|cb][&host=<hostname>]
 */

export const SESSION_LINK_AUTHORITY = "zhirafovod.code-sessions";
export const SESSION_LINK_PATH = "/open";

export const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SessionLinkView = "csv" | "cb";

export interface SessionLink {
  session: string;
  view: SessionLinkView;
  host?: string;
}

export function isSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value.trim());
}

export function formatSessionUri(link: {
  session: string;
  view?: SessionLinkView;
  host?: string;
}): string {
  const session = link.session.trim();
  const params = new URLSearchParams();
  params.set("session", session);
  if (link.view && link.view !== "csv") params.set("view", link.view);
  if (link.host) params.set("host", link.host);
  return `vscode://${SESSION_LINK_AUTHORITY}${SESSION_LINK_PATH}?${params.toString()}`;
}

export function formatSessionMarkdown(
  title: string,
  link: { session: string; view?: SessionLinkView; host?: string },
): string {
  const label = (title || link.session).replace(/[\[\]]/g, "");
  return `[${label}](${formatSessionUri(link)})`;
}

export function parseSessionQuery(query: string): SessionLink | null {
  const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  const session = (params.get("session") || "").trim();
  if (!isSessionId(session)) return null;
  const rawView = (params.get("view") || "csv").toLowerCase();
  const view: SessionLinkView = rawView === "cb" ? "cb" : "csv";
  const host = params.get("host")?.trim() || undefined;
  return host ? { session, view, host } : { session, view };
}

/** Parse a vscode:// URI (string or URL-like). Returns null on mismatch. */
export function parseSessionUri(raw: string | { authority?: string; path?: string; query?: string }): SessionLink | null {
  if (typeof raw === "string") {
    try {
      const u = new URL(raw);
      if (u.protocol !== "vscode:") return null;
      if (u.hostname !== SESSION_LINK_AUTHORITY && u.host !== SESSION_LINK_AUTHORITY) return null;
      const path = u.pathname || "/";
      if (path !== SESSION_LINK_PATH && path !== SESSION_LINK_PATH.slice(1)) return null;
      return parseSessionQuery(u.search);
    } catch {
      return null;
    }
  }
  const authority = raw.authority ?? "";
  if (authority && authority !== SESSION_LINK_AUTHORITY) return null;
  const path = raw.path || "/";
  if (path !== SESSION_LINK_PATH && path !== "/" && path !== "open") return null;
  return parseSessionQuery(raw.query || "");
}
