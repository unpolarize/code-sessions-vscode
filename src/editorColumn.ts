// Single source of truth for "where should this new webview panel
// open?" — applied across every createWebviewPanel call in this
// extension (insights / conversation / agent-graph / search /
// trajectory / live-monitor / agent-graph memory-context-explorer).
//
// See the comment on preferredEditorColumn in src/extension.ts for
// the rationale: `ViewColumn.Active` is unreliable when commands are
// invoked from the sidebar tree (e.g. "Resume session", "Open
// Insights"), causing the annoying split-into-new-column behaviour
// reported in notes.md.

import * as vscode from "vscode";

/** Pick a sensible editor column for a new webview panel. */
export function preferredEditorColumn(): vscode.ViewColumn {
  const group = vscode.window.tabGroups?.activeTabGroup;
  if (group?.viewColumn != null && group.viewColumn !== vscode.ViewColumn.Active) {
    return group.viewColumn;
  }
  return vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
}
