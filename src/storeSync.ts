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
// when the local backlog is small; a large local ahead (session-store
// thousands-of-commits case) merges instead — rebasing that backlog is what
// leaves a corrupt `.git/rebase-merge` (missing head-name). A rebase already
// in progress — ours or a crashed cron — is aborted, or the marker dir is
// deleted if it is already corrupt. Multiple VS Code windows share a
// per-repo lock so they never run git concurrently. A conflicted repo is
// left clean and untouched, and the next sync retries once the diverge is
// resolved elsewhere.

import * as path from "path";
import * as vscode from "vscode";
import { syncRepoOnce } from "./storeSyncGit";
import { startSpan } from "./hostTrace";
import { BOOT_STORE_SYNC_MS } from "./bootIndex";

export interface StoreSyncOptions {
  /** Absolute repo paths to sync, in order. Non-git / remoteless dirs are skipped. */
  repos: () => string[];
  /** Called after a sync pass that changed any repo's HEAD, so views reload. */
  onChanged: (changedRepos: string[]) => void;
  log?: vscode.OutputChannel;
  /** Per-repo sync implementation — injectable for unit tests (defaults to syncRepoOnce). */
  syncRepo?: typeof syncRepoOnce;
}

/** Overall state of the most recent (or in-flight) sync pass, for status UI. */
export type SyncPassStatus =
  | "idle"
  | "syncing"
  | "ok"
  | "unchanged"
  | "conflict"
  | "push-failed"
  | "error"
  | "offline";

export interface SyncStatus {
  /** Current/last overall status. */
  status: SyncPassStatus;
  /** Epoch ms of the last completed pass (0 if none yet). */
  lastSyncAt: number;
  /** Repos whose HEAD advanced in the last pass. */
  lastChanged: string[];
  /** One-line detail for conflict/error/offline. */
  detail?: string;
  /** Whether the aggressive (user-active) cadence is currently armed. */
  active: boolean;
  /** Reason string of the last pass (activation/poll/turn-complete/manual/active). */
  reason?: string;
}

/** Decouples the dashboard (registered at activation) from the sync manager
 *  (created later in activate()). The manager registers itself here; the
 *  planning dashboard reads it lazily by the time a panel is opened. */
export interface SyncBridge {
  noteActivity(): void;
  getStatus(): SyncStatus;
  onDidSync: vscode.Event<SyncStatus>;
}
let _bridge: SyncBridge | undefined;
export function setSyncBridge(b: SyncBridge | undefined): void {
  _bridge = b;
}
export function syncBridge(): SyncBridge | undefined {
  return _bridge;
}

export class StoreSyncManager {
  private timer: NodeJS.Timeout | undefined;
  private activeTimer: NodeJS.Timeout | undefined;
  private turnWatcher: vscode.FileSystemWatcher | undefined;
  private turnDebounce: NodeJS.Timeout | undefined;
  private running = false;
  private queued = false;
  private disposed = false;
  private warnedConflict = new Set<string>();
  private warnedPushFail = new Set<string>();
  private activeUntil = 0; // epoch ms — aggressive polling armed until this time

  private readonly _onDidSync = new vscode.EventEmitter<SyncStatus>();
  /** Fires at the start and end of every sync pass with the current status. */
  readonly onDidSync = this._onDidSync.event;
  private state: SyncStatus = { status: "idle", lastSyncAt: 0, lastChanged: [], active: false };

  constructor(private readonly opts: StoreSyncOptions) {}

  getStatus(): SyncStatus {
    return { ...this.state, active: Date.now() < this.activeUntil };
  }

  private emit(): void {
    this.state.active = Date.now() < this.activeUntil;
    try {
      this._onDidSync.fire(this.getStatus());
    } catch {
      /* listeners are best-effort */
    }
  }

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

    // After CB hydrate (webview.ready was blocked 31 s by overlapping git).
    const bootTimer = setTimeout(() => void this.sync("activation"), BOOT_STORE_SYNC_MS);

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
        if (this.activeTimer) clearInterval(this.activeTimer);
        if (this.turnDebounce) clearTimeout(this.turnDebounce);
        this.turnWatcher?.dispose();
        cfgSub.dispose();
        this._onDidSync.dispose();
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

  /** Called when the user is active on a planning surface: arm an aggressive
   * poll (default 20s) for a bounded window (default 3m of inactivity), then
   * fall back to the normal cadence. Repeated calls extend the window. Also
   * kicks an immediate sync if the last one is stale. */
  noteActivity(): void {
    if (this.disposed || !this.cfg().get<boolean>("enabled", true)) return;
    const windowMin = this.cfg().get<number>("activeWindowMinutes", 3);
    const wasActive = Date.now() < this.activeUntil;
    this.activeUntil = Date.now() + Math.max(0.5, windowMin) * 60_000;
    if (!this.activeTimer) {
      const secs = Math.max(5, this.cfg().get<number>("activeIntervalSeconds", 20));
      this.activeTimer = setInterval(() => {
        if (Date.now() >= this.activeUntil) {
          // window elapsed — stand down to the normal cadence
          if (this.activeTimer) clearInterval(this.activeTimer);
          this.activeTimer = undefined;
          this.log("active window elapsed — back to normal cadence");
          this.emit();
          return;
        }
        void this.sync("active");
      }, secs * 1000);
      this.log(`active: polling every ${secs}s for ${windowMin}m`);
    }
    // an immediate refresh if we haven't synced in the last active interval
    const staleMs = Math.max(5, this.cfg().get<number>("activeIntervalSeconds", 20)) * 1000;
    if (!wasActive || Date.now() - this.state.lastSyncAt > staleMs) void this.sync("active");
    else this.emit();
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
    const span = startSpan("csv.storeSync");
    this.running = true;
    this.state.status = "syncing";
    this.state.reason = reason;
    this.emit();
    try {
      const push = this.cfg().get<boolean>("push", true);
      const changed: string[] = [];
      let worst: SyncPassStatus = "unchanged";
      const rank: Record<string, number> = {
        unchanged: 0,
        ok: 1,
        offline: 2,
        "push-failed": 3,
        conflict: 4,
        error: 5,
      };
      let detail: string | undefined;
      for (const repo of this.opts.repos()) {
        if (this.disposed) break;
        const res = await (this.opts.syncRepo ?? syncRepoOnce)(repo, { push });
        span.mark(path.basename(repo), { status: res.status });
        if (res.status === "ok" || (res.status === "push-failed" && res.changed)) changed.push(repo);
        if (res.status === "conflict") this.warnConflictOnce(repo, res.detail ?? "");
        else if (res.status === "push-failed") this.warnPushFailOnce(repo, res.detail ?? "");
        else {
          // a healthy pass (push worked or nothing to push) ends the failure
          // streak; offline/skipped/conflict passes never attempted a push,
          // so they neither warn nor reset
          if (res.status === "ok" || res.status === "unchanged") this.warnedPushFail.delete(repo);
          if (res.detail && res.status !== "unchanged" && res.status !== "ok")
            this.log(`${path.basename(repo)}: ${res.status} — ${res.detail}`);
        }
        // map a per-repo result into the overall pass status
        const mapped: SyncPassStatus =
          res.status === "ok"
            ? "ok"
            : res.status === "conflict"
              ? "conflict"
              : res.status === "push-failed"
                ? "push-failed"
                : res.status === "error"
                  ? "error"
                  : res.status === "skipped" && /fetch failed|offline/i.test(res.detail ?? "")
                    ? "offline"
                    : "unchanged";
        if ((rank[mapped] ?? 0) >= (rank[worst] ?? 0)) {
          worst = mapped;
          if (mapped !== "ok" && mapped !== "unchanged") detail = res.detail;
        }
      }
      this.state.status = worst;
      this.state.detail = detail;
      this.state.lastChanged = changed.map((r) => path.basename(r));
      this.state.lastSyncAt = Date.now();
      if (changed.length) {
        this.log(`${reason}: updated ${changed.map((r) => path.basename(r)).join(", ")}`);
        try {
          this.opts.onChanged(changed);
        } catch (e) {
          this.log(`onChanged handler error: ${String(e)}`);
        }
      }
    } finally {
      span.end({ reason, status: this.state.status });
      this.running = false;
      this.emit();
      if (this.queued && !this.disposed) {
        this.queued = false;
        void this.sync("coalesced");
      }
    }
  }

  private warnPushFailOnce(dir: string, detail: string): void {
    const name = path.basename(dir);
    this.log(`${name}: ${detail.split("\n")[0]}`);
    if (!this.warnedPushFail.has(dir)) {
      this.warnedPushFail.add(dir);
      void vscode.window.showWarningMessage(
        `Code Sessions: ${name} pulled fine but couldn't push local commits — ` +
          `they'll keep piling up locally until the push works (check auth/upstream). ` +
          `${detail.split("\n")[0]}`,
      );
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
