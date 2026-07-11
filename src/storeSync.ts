// Store git sync — owned by the CSV extension lifecycle.
//
// The viewer pulls the shared git stores so it always shows fresh cross-machine
// data: KB `~/docs` (which contains Planning under planning/) and the Sessions
// store `~/.sessions`. Sync runs ONLY while the extension is active — on
// activation, on a periodic poll, and when a coding turn completes (a commit
// lands under ~/.sessions/hosts). Nothing runs when the viewer is closed
// (every timer/watcher is a disposable), which is the whole point: sync is
// gated on the viewer being open, not an always-on daemon or cron.
//
// Conflict philosophy: recover, never wedge. We use `pull --rebase --autostash`
// (git re-applies the autostash on abort), and if a rebase is already in
// progress — ours or one a crashed cron left behind — we abort it back to a
// clean HEAD and surface a warning rather than looping or invoking a merge
// agent. A conflicted repo is left clean and untouched, and the next sync
// retries once the remote/local diverge is resolved elsewhere.

import * as path from "path";
import * as vscode from "vscode";
import { syncRepoOnce } from "./storeSyncGit";

export interface StoreSyncOptions {
  /** Absolute repo paths to sync, in order. Non-git / remoteless dirs are skipped. */
  repos: () => string[];
  /** Called after a sync pass that changed any repo's HEAD, so views reload. */
  onChanged: (changedRepos: string[]) => void;
  log?: vscode.OutputChannel;
}

export class StoreSyncManager {
  private timer: NodeJS.Timeout | undefined;
  private turnWatcher: vscode.FileSystemWatcher | undefined;
  private turnDebounce: NodeJS.Timeout | undefined;
  private running = false;
  private queued = false;
  private disposed = false;
  private warnedConflict = new Set<string>();

  constructor(private readonly opts: StoreSyncOptions) {}

  private cfg() {
    return vscode.workspace.getConfiguration("codeSessions.sync");
  }

  private log(msg: string): void {
    this.opts.log?.appendLine(`[store-sync] ${msg}`);
  }

  /** Wire up the initial sync, the poll timer, the turn-completion watcher, and
   * a config listener. Returns a disposable that stops all of them. */
  start(sessionsRoot: string): vscode.Disposable {
    if (!this.cfg().get<boolean>("enabled", true)) {
      this.log("disabled via codeSessions.sync.enabled");
      return { dispose: () => {} };
    }

    // Initial pull shortly after activation (let the window settle first).
    const bootTimer = setTimeout(() => void this.sync("activation"), 1500);

    this.armPoll();

    // Turn-completion signal: the CS capture daemon commits under
    // ~/.sessions/hosts/** on Stop / SubagentStop / SessionEnd, so a change
    // there means a coding turn just landed. Debounce so a burst of writes
    // collapses into one sync.
    if (this.cfg().get<boolean>("onTurnComplete", true)) {
      try {
        this.turnWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(path.join(sessionsRoot, "hosts")), "**"),
        );
        const onTurn = () => {
          if (this.turnDebounce) clearTimeout(this.turnDebounce);
          this.turnDebounce = setTimeout(() => void this.sync("turn-complete"), 4000);
        };
        this.turnWatcher.onDidChange(onTurn);
        this.turnWatcher.onDidCreate(onTurn);
      } catch (e) {
        this.log(`turn watcher unavailable: ${String(e)}`);
      }
    }

    // Re-arm the poll if the interval setting changes.
    const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codeSessions.sync.intervalMinutes")) this.armPoll();
    });

    return {
      dispose: () => {
        this.disposed = true;
        clearTimeout(bootTimer);
        if (this.timer) clearInterval(this.timer);
        if (this.turnDebounce) clearTimeout(this.turnDebounce);
        this.turnWatcher?.dispose();
        cfgSub.dispose();
      },
    };
  }

  private armPoll(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const minutes = this.cfg().get<number>("intervalMinutes", 5);
    if (minutes > 0) {
      this.timer = setInterval(() => void this.sync("poll"), minutes * 60_000);
      this.log(`polling every ${minutes}m`);
    }
  }

  /** Public manual trigger (command palette). */
  syncNow(): Promise<void> {
    return this.sync("manual");
  }

  /** One serialized sync pass over all repos. Overlapping triggers coalesce:
   * a call while one is running sets a `queued` flag so exactly one more runs
   * after — no pile-up, no concurrent git in the same repo. Never throws. */
  private async sync(reason: string): Promise<void> {
    if (this.disposed) return;
    if (this.running) {
      this.queued = true;
      return;
    }
    this.running = true;
    try {
      const push = this.cfg().get<boolean>("push", true);
      const changed: string[] = [];
      for (const repo of this.opts.repos()) {
        if (this.disposed) break;
        const res = await syncRepoOnce(repo, { push });
        if (res.status === "ok") changed.push(repo);
        else if (res.status === "conflict") this.warnConflictOnce(repo, res.detail ?? "");
        else if (res.detail && res.status !== "unchanged") this.log(`${path.basename(repo)}: ${res.status} — ${res.detail}`);
      }
      if (changed.length) {
        this.log(`${reason}: updated ${changed.map((r) => path.basename(r)).join(", ")}`);
        try {
          this.opts.onChanged(changed);
        } catch (e) {
          this.log(`onChanged handler error: ${String(e)}`);
        }
      }
    } finally {
      this.running = false;
      if (this.queued && !this.disposed) {
        this.queued = false;
        void this.sync("coalesced");
      }
    }
  }

  private warnConflictOnce(dir: string, detail: string): void {
    const name = path.basename(dir);
    this.log(`${name}: pull --rebase hit a conflict — aborted and left HEAD clean. ${detail.split("\n")[0]}`);
    if (!this.warnedConflict.has(dir)) {
      this.warnedConflict.add(dir);
      void vscode.window.showWarningMessage(
        `Code Sessions: couldn't auto-sync ${name} — local and remote diverged with conflicts. ` +
          `The repo was left clean (rebase aborted); resolve manually, then it will sync again.`,
      );
    }
  }
}
