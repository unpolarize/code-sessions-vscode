// Memory inventory view.
//
// Discovers agent-memory sources across the user's machine and shows
// them in the activity-bar tree alongside Sessions / KB / Projects /
// Tasks. Per the memory-map spec at
// knowledge/tech/agents/memory-map-spec.md, v1 sources are:
//
//   - workspace CLAUDE.md / AGENTS.md / MEMORY.md (project scope)
//   - workspace `.claude/CLAUDE.md` + `.claude/rules/*.md`
//   - workspace `.claude/commands/*.md` (skills/commands directory)
//   - ~/.claude/CLAUDE.md (global)
//   - ~/.claude/MEMORY.md (global auto-memory aggregate)
//   - ~/.claude/projects/<encoded-cwd>/memory/MEMORY.md (per-repo auto)
//   - ~/.codex/AGENTS.md + ~/.codex/memories/ (Codex)
//   - ~/.grok/AGENTS.md (Grok)
//
// "Entry count" = number of H2 sections inside the file when it looks
// like a structured markdown memory; whole-file 1 when it's flat
// prose. Cheap to compute (one read per file, no external process).
// No write-back here — pure inventory + click-to-open.

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

interface MemorySource {
  /** Stable id used for tree expand-state and refresh. */
  id: string;
  /** Display label in the tree. */
  label: string;
  /** Hover description in the tree. */
  description: string;
  /** Absolute path of the file (or directory, for codex memories). */
  absPath: string;
  /** Scope grouping shown in the tree level above this entry. */
  scope: "workspace" | "project" | "user" | "global";
  /** Provider grouping (claude / codex / grok / shared / auto). */
  provider: "claude" | "codex" | "grok" | "auto" | "shared";
  /** Number of memory entries the file (or directory) contributes.
   * Heuristic: count `^## ` H2 headings for markdown files; count
   * file entries for codex memories directory. */
  entryCount: number;
  /** True when the file exists on disk; false rows surface candidate
   * paths the user could create if they want to start that scope. */
  exists: boolean;
  /** True when the file exists but was empty / unreadable / contained
   * no recognisable entries. Helps distinguish "scope is set up but
   * the agent hasn't written anything yet" from "scope is missing". */
  empty?: boolean;
}

/** Count H2 sections in a markdown file. Fenced code blocks are
 * respected (a literal `## ` line inside a ``` fence is NOT counted).
 * Returns 0 for files that look like prose (no H2s found). */
function countH2Sections(text: string): number {
  const lines = text.split("\n");
  let inFence = false;
  let count = 0;
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^##\s+\S/.test(line)) count += 1;
  }
  return count;
}

/** Read a file, return its content + count, or null when missing /
 * unreadable. Caps file size at 2 MB to defend against accidental
 * binary symlinks. */
function readEntries(absPath: string): { content: string; count: number } | null {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return null;
    if (stat.size > 2 * 1024 * 1024) return { content: "", count: 1 };
    const content = fs.readFileSync(absPath, "utf8");
    const h2 = countH2Sections(content);
    // If no H2s but the file has substantive content (>200 chars),
    // treat the whole file as one entry — matches how the
    // memory-map spec scores flat prose files.
    const count = h2 > 0 ? h2 : content.trim().length > 200 ? 1 : 0;
    return { content, count };
  } catch {
    return null;
  }
}

/** Walk the codex memories directory and count flat top-level entries.
 * Each `.md` file under `~/.codex/memories/` is one entry; nested
 * subdirs are counted recursively (one per leaf file). */
function countCodexMemoriesDir(dir: string): number {
  let total = 0;
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return 0;
    const walk = (cur: string) => {
      for (const name of fs.readdirSync(cur)) {
        const p = path.join(cur, name);
        try {
          const s = fs.statSync(p);
          if (s.isDirectory()) walk(p);
          else if (s.isFile() && /\.(md|markdown|txt)$/i.test(name)) total += 1;
        } catch {
          /* skip */
        }
      }
    };
    walk(dir);
  } catch {
    /* ignore */
  }
  return total;
}

/** URL-encode a workspace path the way claude code dash-encodes its
 * per-project memory directory: `/Users/me/docs` →
 * `-Users-me-docs`. (Same algorithm used by code-sessions's
 * jsonlIndexer for the projects directory.) */
function dashEncodeWorkspace(cwd: string): string {
  return cwd.replace(/\//g, "-").replace(/^-/, "-").replace(/\.$/, "");
}

/** Build the full inventory of memory sources visible on this
 * machine. Synchronous + cheap — one stat() + readFile() per
 * candidate path. */
export function scanMemorySources(workspaceRoots: string[]): MemorySource[] {
  const home = os.homedir();
  const sources: MemorySource[] = [];

  // ---- Workspace / project scope ----
  for (const ws of workspaceRoots) {
    const wsName = path.basename(ws);
    const candidates: Array<{
      file: string;
      label: string;
      provider: MemorySource["provider"];
    }> = [
      { file: "CLAUDE.md", label: "CLAUDE.md", provider: "claude" },
      { file: "CLAUDE.local.md", label: "CLAUDE.local.md", provider: "claude" },
      { file: "AGENTS.md", label: "AGENTS.md", provider: "shared" },
      { file: "MEMORY.md", label: "MEMORY.md", provider: "shared" },
      { file: ".claude/CLAUDE.md", label: ".claude/CLAUDE.md", provider: "claude" },
    ];
    for (const c of candidates) {
      const abs = path.join(ws, c.file);
      const read = readEntries(abs);
      sources.push({
        id: `ws:${ws}:${c.file}`,
        label: `${c.label}`,
        description: `${wsName} · ${c.provider}`,
        absPath: abs,
        scope: "workspace",
        provider: c.provider,
        entryCount: read?.count ?? 0,
        exists: read !== null,
        empty: read !== null && read.count === 0,
      });
    }
    // .claude/rules/*.md and .claude/commands/*.md
    const dotClaude = path.join(ws, ".claude");
    for (const sub of ["rules", "commands"]) {
      const subDir = path.join(dotClaude, sub);
      try {
        if (fs.existsSync(subDir) && fs.statSync(subDir).isDirectory()) {
          const entries = fs.readdirSync(subDir).filter((n) => /\.(md|markdown)$/i.test(n));
          sources.push({
            id: `ws:${ws}:.claude/${sub}`,
            label: `.claude/${sub}/`,
            description: `${wsName} · ${entries.length} file${entries.length === 1 ? "" : "s"}`,
            absPath: subDir,
            scope: "workspace",
            provider: "claude",
            entryCount: entries.length,
            exists: true,
            empty: entries.length === 0,
          });
        }
      } catch {
        /* ignore */
      }
    }
    // ~/.claude/projects/<encoded-cwd>/memory/MEMORY.md (auto)
    const autoPath = path.join(
      home,
      ".claude",
      "projects",
      dashEncodeWorkspace(ws),
      "memory",
      "MEMORY.md",
    );
    const autoRead = readEntries(autoPath);
    if (autoRead !== null) {
      sources.push({
        id: `auto:${ws}`,
        label: "auto-memory (~/.claude/projects)",
        description: `${wsName} · auto · ${autoRead.count} entr${autoRead.count === 1 ? "y" : "ies"}`,
        absPath: autoPath,
        scope: "project",
        provider: "auto",
        entryCount: autoRead.count,
        exists: true,
        empty: autoRead.count === 0,
      });
    }
  }

  // ---- User / global scope ----
  const userCandidates: Array<{
    file: string;
    label: string;
    provider: MemorySource["provider"];
    scope: MemorySource["scope"];
  }> = [
    { file: path.join(home, ".claude", "CLAUDE.md"), label: "~/.claude/CLAUDE.md", provider: "claude", scope: "user" },
    { file: path.join(home, ".claude", "MEMORY.md"), label: "~/.claude/MEMORY.md", provider: "claude", scope: "user" },
    { file: path.join(home, ".codex", "AGENTS.md"), label: "~/.codex/AGENTS.md", provider: "codex", scope: "user" },
    { file: path.join(home, ".grok", "AGENTS.md"), label: "~/.grok/AGENTS.md", provider: "grok", scope: "user" },
  ];
  for (const c of userCandidates) {
    const read = readEntries(c.file);
    sources.push({
      id: `user:${c.file}`,
      label: c.label,
      description: c.provider,
      absPath: c.file,
      scope: c.scope,
      provider: c.provider,
      entryCount: read?.count ?? 0,
      exists: read !== null,
      empty: read !== null && read.count === 0,
    });
  }
  // ~/.codex/memories/ — directory-based
  const codexMemDir = path.join(home, ".codex", "memories");
  const codexCount = countCodexMemoriesDir(codexMemDir);
  if (codexCount > 0 || fs.existsSync(codexMemDir)) {
    sources.push({
      id: `user:codex-memories`,
      label: "~/.codex/memories/",
      description: `codex · ${codexCount} file${codexCount === 1 ? "" : "s"}`,
      absPath: codexMemDir,
      scope: "user",
      provider: "codex",
      entryCount: codexCount,
      exists: true,
      empty: codexCount === 0,
    });
  }

  return sources;
}

/** Aggregate counters across the inventory — used by the live monitor
 * + insights tile. */
export interface MemoryTotals {
  totalEntries: number;
  totalFiles: number;
  byProvider: Record<string, number>;
  byScope: Record<string, number>;
}
export function summariseSources(sources: MemorySource[]): MemoryTotals {
  const t: MemoryTotals = {
    totalEntries: 0,
    totalFiles: 0,
    byProvider: {},
    byScope: {},
  };
  for (const s of sources) {
    if (!s.exists) continue;
    t.totalFiles += 1;
    t.totalEntries += s.entryCount;
    t.byProvider[s.provider] = (t.byProvider[s.provider] ?? 0) + s.entryCount;
    t.byScope[s.scope] = (t.byScope[s.scope] ?? 0) + s.entryCount;
  }
  return t;
}

/** Tree provider mounted at the `codeMemory` view. */
export class MemoryProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private sources: MemorySource[] = [];

  refresh(): void {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    this.sources = scanMemorySources(roots);
    this._onDidChange.fire();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(parent?: vscode.TreeItem): vscode.TreeItem[] {
    if (this.sources.length === 0) this.refresh();
    if (!parent) {
      // Roots: a totals bar + one node per scope group with sources.
      const totals = summariseSources(this.sources);
      const summary = new vscode.TreeItem(
        `${totals.totalEntries} entr${totals.totalEntries === 1 ? "y" : "ies"} · ${totals.totalFiles} file${totals.totalFiles === 1 ? "" : "s"}`,
        vscode.TreeItemCollapsibleState.None,
      );
      summary.iconPath = new vscode.ThemeIcon("database");
      summary.description = Object.entries(totals.byProvider)
        .map(([k, v]) => `${k}:${v}`)
        .join(" · ");
      summary.contextValue = "memorySummary";
      summary.tooltip = `Memory entries discovered across ${totals.totalFiles} source file(s).\n\nBy provider: ${JSON.stringify(totals.byProvider)}\nBy scope: ${JSON.stringify(totals.byScope)}`;

      // Group sources by scope; render a node per non-empty scope.
      const scopes: Array<MemorySource["scope"]> = [
        "workspace",
        "project",
        "user",
        "global",
      ];
      const children: vscode.TreeItem[] = [summary];
      for (const scope of scopes) {
        const inScope = this.sources.filter((s) => s.scope === scope);
        if (inScope.length === 0) continue;
        const visibleCount = inScope.filter((s) => s.exists).length;
        const totalEntriesInScope = inScope
          .filter((s) => s.exists)
          .reduce((a, b) => a + b.entryCount, 0);
        const label =
          scope === "workspace"
            ? "Workspace"
            : scope === "project"
              ? "Project (auto-memory)"
              : scope === "user"
                ? "User (global)"
                : "Shared";
        const node = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
        node.description = `${totalEntriesInScope} entr${totalEntriesInScope === 1 ? "y" : "ies"} · ${visibleCount}/${inScope.length} file${inScope.length === 1 ? "" : "s"}`;
        node.iconPath = new vscode.ThemeIcon(
          scope === "workspace" ? "folder-active" : scope === "user" ? "person" : "folder",
        );
        node.contextValue = `memoryScope:${scope}`;
        node.id = `scope:${scope}`;
        children.push(node);
      }
      return children;
    }
    // Child: one row per source in the scope.
    const scope = (parent.id ?? "").replace(/^scope:/, "");
    const inScope = this.sources.filter((s) => s.scope === scope);
    return inScope.map((s) => {
      const item = new vscode.TreeItem(s.label, vscode.TreeItemCollapsibleState.None);
      if (s.exists) {
        item.description = `${s.entryCount} entr${s.entryCount === 1 ? "y" : "ies"}${s.empty ? " · empty" : ""}`;
        item.iconPath = new vscode.ThemeIcon(s.empty ? "note" : "file-text");
        item.tooltip = `${s.absPath}\n${s.entryCount} memory entr${s.entryCount === 1 ? "y" : "ies"} from ${s.provider}\nScope: ${s.scope}\nClick to open the file in the editor.`;
        item.command = {
          command: "codeMemory.openFile",
          title: "Open",
          arguments: [s.absPath],
        };
      } else {
        item.description = `(not present) · ${s.provider}`;
        item.iconPath = new vscode.ThemeIcon("circle-slash");
        item.tooltip = `${s.absPath}\nNot present on disk yet. The agent will create it when it first writes a memory under this scope.`;
      }
      item.contextValue = `memorySource:${s.provider}`;
      return item;
    });
  }
}
