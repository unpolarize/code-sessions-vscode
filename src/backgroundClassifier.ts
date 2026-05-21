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
  // Progress on the session that the worker is currently processing.
  private currentId: string | null = null;
  private currentTitle: string | null = null;
  private currentDone = 0;
  private currentTotal = 0;
  private currentStartedAt = 0;
  // How many sessions we have started this run, so the tooltip can show "X/Y".
  private sessionsStarted = 0;
  private peakQueue = 0;
  // Last error blurb so the user can tell when the daemon is stuck.
  private lastError: string | null = null;
  private lastErrorAt = 0;

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
      if (added > 0) {
        // Track the high-water mark so we can render an X/Y session counter.
        const total = this.queue.length + (this.busy ? 1 : 0);
        if (total > this.peakQueue) this.peakQueue = total;
        this.renderStatus();
      }
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
    this.currentId = id;
    this.currentTitle = this.titleFor(id);
    this.currentDone = 0;
    this.currentTotal = 0;
    this.currentStartedAt = Date.now();
    this.sessionsStarted += 1;
    if (this.queue.length + 1 > this.peakQueue) this.peakQueue = this.queue.length + 1;
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
        onProgress: (done, total) => {
          this.currentDone = done;
          this.currentTotal = total;
          this.renderStatus();
        },
      });
      this.classifiedThisRun += res.classified;
      if (res.errors.length > 0) {
        this.lastError = res.errors[0].slice(0, 200);
        this.lastErrorAt = Date.now();
      }
      // If we got rate-limited / capped, pause discovery for a while.
      if (res.errors.some((e) => /rate.?limit|usage.?cap/i.test(e))) {
        this.queue = []; // drop everything; another discovery tick will refill
      }
    } catch (e: any) {
      this.lastError = String(e?.message ?? e).slice(0, 200);
      this.lastErrorAt = Date.now();
    } finally {
      this.busy = false;
      this.currentId = null;
      this.currentTitle = null;
      this.currentDone = 0;
      this.currentTotal = 0;
      this.currentStartedAt = 0;
      this.renderStatus();
    }
  }

  /** Cheap title lookup so the status-bar tile can show what's being worked
   * on. Falls back to a short session-id if the row is gone. */
  private titleFor(sessionId: string): string {
    try {
      const row = this.store.getById(sessionId);
      const t = row?.title || row?.first_user_msg || "";
      const cleaned = String(t).trim();
      if (cleaned.length === 0) return sessionId.slice(0, 8);
      return cleaned.length > 50 ? cleaned.slice(0, 47) + "…" : cleaned;
    } catch {
      return sessionId.slice(0, 8);
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
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**Background topic classification — idle**\n\n`);
        md.appendMarkdown(`${this.classifiedThisRun} turns classified across ${this.sessionsStarted} session(s) this run.\n`);
        if (this.lastError) md.appendMarkdown(`\n_Last error:_ ${escMd(this.lastError)}\n`);
        this.statusItem.tooltip = md;
        this.statusItem.show();
      } else {
        this.statusItem.hide();
      }
      return;
    }
    const pending = this.queue.length + (this.busy ? 1 : 0);
    const idx = this.sessionsStarted;        // 1-based: this is the n-th session
    const tot = Math.max(this.peakQueue, idx); // best-effort denominator

    // Status-bar text: keep it short but show the live counter so the user
    // can tell it's moving.
    let text: string;
    if (this.busy && this.currentTitle) {
      const turnPart = this.currentTotal > 0 ? ` · ${this.currentDone}/${this.currentTotal} turns` : "";
      text = `$(sync~spin) ${idx}/${tot} · ${truncate(this.currentTitle, 28)}${turnPart}`;
    } else {
      text = `$(sync~spin) Classifying · ${pending} queued`;
    }
    this.statusItem.text = text;

    // Rich tooltip with everything we know.
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`**Background topic classification**\n\n`);
    md.appendMarkdown(`Session **${idx} of ${tot}** · ${pending} pending\n\n`);
    if (this.busy && this.currentTitle) {
      md.appendMarkdown(`Currently: \`${escMd(this.currentTitle)}\``);
      if (this.currentTotal > 0) {
        const pct = Math.floor((this.currentDone / this.currentTotal) * 100);
        md.appendMarkdown(` &nbsp; — **${this.currentDone}/${this.currentTotal}** turns (${pct}%)`);
      } else {
        md.appendMarkdown(` &nbsp; — preparing…`);
      }
      const elapsed = Math.max(0, Math.floor((Date.now() - this.currentStartedAt) / 1000));
      md.appendMarkdown(`\n\nElapsed on this session: ${elapsed}s\n`);
    } else if (pending > 0) {
      md.appendMarkdown(`_Waiting for the next tick to pick up the next session…_\n`);
    }
    md.appendMarkdown(`\n${this.classifiedThisRun} turn(s) classified this run.\n`);
    if (this.lastError) {
      const ageSec = Math.max(0, Math.floor((Date.now() - this.lastErrorAt) / 1000));
      md.appendMarkdown(`\n_Last error (${ageSec}s ago):_ ${escMd(this.lastError)}\n`);
    }
    md.appendMarkdown(`\n_Toggle via setting:_ \`claudeSessions.classify.autoBackground\`.`);
    this.statusItem.tooltip = md;
    this.statusItem.show();
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s;
}

function escMd(s: string): string {
  return String(s).replace(/[`*_]/g, (c) => "\\" + c);
}
