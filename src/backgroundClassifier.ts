// Background classifier daemon — runs topic classification across the whole
// session catalog without user interaction.
//
// - On activation, scans for sessions with unclassified turns and enqueues
//   them. Subsequent indexer syncs re-trigger the scan so newly-arrived turns
//   are picked up automatically.
// - The worker processes one session at a time so we don't blast the local
//   Ollama daemon (or the Claude CLI) with parallel calls.
// - Only runs when `claudeSessions.classify.backend = ollama` by default —
//   we don't want to burn subscription tokens behind the user's back.
// - Per-turn caching is already enforced by `classifySession`, which skips
//   any turn that already has a `turn_topic` row — so re-runs on a fully
//   classified session are effectively free.

import * as vscode from "vscode";
import { SessionStore } from "./db";
import { classifySession, ClassifyBackend } from "./topicClassifier";

const DISCOVERY_INTERVAL_MS = 60_000; // re-scan for new unclassified sessions
const WORKER_TICK_MS = 1500;          // throttle between classify calls
const STATUS_BAR_PRIORITY = 99;        // just left of the existing Claude · Live item

export class BackgroundClassifier {
  private queue: string[] = [];
  private inQueue = new Set<string>();
  private busy = false;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private workerTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private statusItem: vscode.StatusBarItem | null = null;
  private classifiedThisRun = 0;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: SessionStore,
  ) {}

  start(): void {
    if (this.stopped) return;
    if (!this.isEnabled()) return;

    // A tiny status-bar tile so the user can see something is happening (and
    // tell whether the daemon got stuck). Hidden when idle and queue empty.
    this.statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      STATUS_BAR_PRIORITY,
    );
    this.statusItem.name = "Claude · auto-classify";
    this.ctx.subscriptions.push(this.statusItem);
    this.renderStatus();

    // Re-enable on settings flip; cheap to no-op.
    this.ctx.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("claudeSessions.classify.autoBackground") ||
          e.affectsConfiguration("claudeSessions.classify.backend")
        ) {
          if (this.isEnabled()) this.discoveryTick();
          else this.queue = [];
          this.renderStatus();
        }
      }),
    );

    // Kick off an immediate discovery pass + periodic re-scans.
    this.discoveryTick();
    this.discoveryTimer = setInterval(() => this.discoveryTick(), DISCOVERY_INTERVAL_MS);
    this.workerTimer = setInterval(() => this.workerTick(), WORKER_TICK_MS);

    this.ctx.subscriptions.push({
      dispose: () => this.stop(),
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.discoveryTimer) { clearInterval(this.discoveryTimer); this.discoveryTimer = null; }
    if (this.workerTimer) { clearInterval(this.workerTimer); this.workerTimer = null; }
    this.statusItem?.dispose();
  }

  /** Called by the sessions auto-refresh tick after each syncToStore — gives
   * the daemon a chance to pick up turns that just landed. */
  notifySyncCompleted(): void {
    if (!this.isEnabled()) return;
    this.discoveryTick();
  }

  // ----- internals -----

  private isEnabled(): boolean {
    const cfg = vscode.workspace.getConfiguration("claudeSessions");
    if (!cfg.get<boolean>("classify.autoBackground", true)) return false;
    // Default to refusing claude-p auto-classify so we don't quietly burn
    // subscription tokens. The user can flip the override if they actively
    // want it.
    const backend = cfg.get<ClassifyBackend>("classify.backend", "ollama");
    if (backend === "claude-p") {
      return cfg.get<boolean>("classify.allowAutoBackgroundClaude", false);
    }
    return true;
  }

  private discoveryTick(): void {
    if (this.stopped || !this.isEnabled()) return;
    try {
      const ids = this.store.sessionsWithUnclassifiedTurns(500);
      let added = 0;
      for (const id of ids) {
        if (this.inQueue.has(id)) continue;
        this.inQueue.add(id);
        this.queue.push(id);
        added += 1;
      }
      if (added > 0) this.renderStatus();
    } catch {
      // ignore — DB might be locked while a sync is running
    }
  }

  private async workerTick(): Promise<void> {
    if (this.stopped || this.busy || !this.isEnabled()) return;
    const id = this.queue.shift();
    if (!id) {
      this.renderStatus();
      return;
    }
    this.inQueue.delete(id);
    this.busy = true;
    this.renderStatus();

    const cfg = vscode.workspace.getConfiguration("claudeSessions");
    const backend = cfg.get<ClassifyBackend>("classify.backend", "ollama");
    const model = cfg.get<string>("classify.model", "llama3.2:3b");
    const batchSize = cfg.get<number>("classify.batchSize", 20);
    const claudeBin = cfg.get<string>("classify.claudeBin", "") || undefined;
    const ollamaUrl = cfg.get<string>("embedding.ollamaUrl", "http://127.0.0.1:11434");

    try {
      const res = await classifySession(this.store, id, {
        backend,
        model,
        batchSize,
        claudeBin,
        ollamaUrl,
      });
      this.classifiedThisRun += res.classified;
      // If we got rate-limited / capped, pause discovery for a while.
      if (res.errors.some((e) => /rate.?limit|usage.?cap/i.test(e))) {
        this.queue = []; // drop everything; another discovery tick will refill
      }
    } catch {
      // swallow; the worker just moves on to the next session
    } finally {
      this.busy = false;
      this.renderStatus();
    }
  }

  private renderStatus(): void {
    if (!this.statusItem) return;
    if (!this.isEnabled()) {
      this.statusItem.hide();
      return;
    }
    if (this.queue.length === 0 && !this.busy) {
      // Idle — show a brief "✓ N classified" only if we did work this session.
      if (this.classifiedThisRun > 0) {
        this.statusItem.text = `$(check) ${this.classifiedThisRun} turns classified`;
        this.statusItem.tooltip = "Background topic classification idle — caught up.";
        this.statusItem.show();
      } else {
        this.statusItem.hide();
      }
      return;
    }
    const pending = this.queue.length + (this.busy ? 1 : 0);
    this.statusItem.text = `$(sync~spin) Classifying · ${pending} session${pending === 1 ? "" : "s"} queued`;
    this.statusItem.tooltip = new vscode.MarkdownString(
      `**Background topic classification**\n\n` +
        `${pending} session(s) pending · ${this.classifiedThisRun} turns classified this run\n\n` +
        `_Toggle via setting:_ \`claudeSessions.classify.autoBackground\`.`,
    );
    this.statusItem.show();
  }
}
