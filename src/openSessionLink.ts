import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import type { SessionStore } from "./db";
import { gitSessionsRoot } from "./gitIndexer";
import { locateStoreTurns } from "./storeTranscript";
import { openConversationViewer } from "./conversationView";
import {
  formatSessionMarkdown,
  formatSessionUri,
  type SessionLink,
} from "./sessionLink";

export interface SessionLinkTarget {
  session: string;
  title: string;
}

export function linkTargetFromArg(arg: unknown): SessionLinkTarget | null {
  if (!arg || typeof arg !== "object") return null;
  const o = arg as { row?: { session?: string; title?: string }; session?: string; title?: string };
  const session = o.row?.session || o.session;
  if (!session || typeof session !== "string") return null;
  const title = o.row?.title || o.title || session;
  return { session, title: String(title) };
}

export async function copySessionLinkToClipboard(target: SessionLinkTarget, view: "csv" | "cb" = "csv"): Promise<string> {
  const md = formatSessionMarkdown(target.title, { session: target.session, view });
  const uri = formatSessionUri({ session: target.session, view });
  await vscode.env.clipboard.writeText(`${md}\n${uri}`);
  return uri;
}

function runGit(dir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: dir, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({
        code: err ? ((err as { code?: number }).code ?? 1) : 0,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim(),
      });
    });
  });
}

async function pullSessionsStore(): Promise<boolean> {
  const root = gitSessionsRoot();
  const pull = await runGit(root, ["pull", "--ff-only"]);
  return pull.code === 0;
}

async function remoteSessionsUrl(sessionId: string): Promise<string | null> {
  const root = gitSessionsRoot();
  const rem = await runGit(root, ["remote", "get-url", "origin"]);
  if (rem.code !== 0 || !rem.stdout) return null;
  let url = rem.stdout;
  if (url.startsWith("git@")) {
    url = url.replace(/^git@([^:]+):/, "https://$1/");
  }
  url = url.replace(/\.git$/, "");
  return `${url}`;
}

export async function openSessionFromLink(opts: {
  ctx: vscode.ExtensionContext;
  store: SessionStore | null;
  openViewerPanels: Map<string, vscode.WebviewPanel>;
  link: SessionLink;
}): Promise<void> {
  const { ctx, store, openViewerPanels, link } = opts;
  const existing = openViewerPanels.get(link.session);
  if (existing && link.view === "csv") {
    existing.reveal();
    return;
  }

  let title = store?.getById(link.session)?.title || link.session;
  let found = !!store?.getById(link.session) || !!locateStoreTurns(link.session);

  if (!found) {
    const pulled = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Fetching sessions store…" },
      () => pullSessionsStore(),
    );
    if (pulled) {
      found = !!locateStoreTurns(link.session) || !!store?.getById(link.session);
      title = store?.getById(link.session)?.title || title;
    }
  }

  if (!found) {
    const remote = await remoteSessionsUrl(link.session);
    const pick = await vscode.window.showWarningMessage(
      `Session not found on this machine (${link.session.slice(0, 8)}…). Pull the sessions remote or open it in the browser.`,
      remote ? "Open remote in browser" : "OK",
    );
    if (pick === "Open remote in browser" && remote) {
      await vscode.env.openExternal(vscode.Uri.parse(remote));
    }
    return;
  }

  if (link.view === "cb") {
    const dbRow = store?.getById(link.session);
    const cwd = dbRow?.project_path
      ? path.resolve(dbRow.project_path.startsWith("~")
        ? dbRow.project_path.replace(/^~/, os.homedir())
        : dbRow.project_path)
      : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const source = (dbRow?.source === "grok" ? "grok" : dbRow?.source === "git" ? "codebuild" : "claude") as
      | "claude"
      | "grok"
      | "codebuild";
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes("codeBuild.openExternalSession") && cwd) {
      const ext = vscode.extensions.getExtension("zhirafovod.code-build-vscode");
      if (ext && !ext.isActive) await ext.activate();
      await vscode.commands.executeCommand("codeBuild.openExternalSession", {
        source,
        sessionId: link.session,
        cwd,
        title,
      });
      return;
    }
    await vscode.commands.executeCommand("codeSessions.resume", {
      session: link.session,
      title,
      source: dbRow?.source || "claude",
      project_path: dbRow?.project_path ?? null,
    });
    return;
  }

  const jsonl = store?.getById(link.session)?.jsonl_path ?? null;
  const panel = openConversationViewer(ctx, jsonl, link.session, title, store);
  openViewerPanels.set(link.session, panel);
  panel.onDidDispose(() => {
    if (openViewerPanels.get(link.session) === panel) openViewerPanels.delete(link.session);
  });
}
