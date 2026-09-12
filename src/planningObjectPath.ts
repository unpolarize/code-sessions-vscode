import * as path from "node:path";

/** Resolve a KP object id to the markdown file under the configured store root.
 *
 * Ids are store-relative without the `.md` suffix (`tasks/csv-foo`). Snapshot
 * `path` / `kp show` `relpath` may already include `.md`. Never uses a hardcoded
 * `~/docs` — callers pass `codeSessions.planning.storeRoot`.
 */
export function resolveObjectMarkdown(opts: {
  storeRoot: string;
  id: string;
  relpath?: string | null;
}): { relpath: string; absPath: string } | null {
  const storeRoot = String(opts.storeRoot || "").trim();
  if (!storeRoot) return null;
  const fromKnown = normalizeRel(opts.relpath, storeRoot);
  const rel = fromKnown || relpathFromId(opts.id);
  if (!rel) return null;
  return { relpath: rel, absPath: path.join(storeRoot, ...rel.split("/")) };
}

export function objectOpenMessage(id: string): { type: "action"; action: "openFile"; id: string } {
  return { type: "action", action: "openFile", id };
}

export function objectCopyPathMessage(id: string): { type: "action"; action: "copyPath"; id: string } {
  return { type: "action", action: "copyPath", id };
}

function relpathFromId(id: string): string | null {
  const clean = String(id || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\.md$/i, "");
  if (!clean || hasDotDot(clean)) return null;
  return `${clean}.md`;
}

function normalizeRel(raw: string | null | undefined, storeRoot: string): string | null {
  let rel = String(raw || "")
    .trim()
    .replace(/\\/g, "/");
  if (!rel) return null;
  if (path.isAbsolute(rel) || /^[a-zA-Z]:\//.test(rel)) {
    const fromStore = path.relative(storeRoot, rel).replace(/\\/g, "/");
    if (!fromStore || hasDotDot(fromStore) || path.isAbsolute(fromStore)) return null;
    rel = fromStore;
  }
  rel = rel.replace(/^\.?\//, "");
  if (!rel.endsWith(".md")) rel = `${rel.replace(/\.md$/i, "")}.md`;
  if (!rel || hasDotDot(rel) || path.isAbsolute(rel)) return null;
  return rel;
}

function hasDotDot(p: string): boolean {
  return p.split("/").includes("..");
}
