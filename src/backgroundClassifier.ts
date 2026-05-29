// Background classifier daemon — runs topic classification across the whole
// session catalog without user interaction.
//
// - On activation, scans for sessions with unclassified turns and enqueues
//   them. Subsequent indexer syncs re-trigger the scan so newly-arrived turns
//   are picked up automatically.
// - The worker processes one session at a time so we don't blast the local
//   Ollama daemon (or the Claude CLI) with parallel calls.
// - Only runs when `coderSessions.classify.backend = ollama` by default —
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

// Persistence keys (ctx.globalState). Keeping them as module-scope constants
// so a typo in one of the mutators can't drift from the hydrator.
const STATE_KEY_PAUSED = "coderSessions.classifier.paused";
const STATE_KEY_FAILED = "coderSessions.classifier.failedIds";

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
  // User-facing controls
  private paused = false;
  // Session ids that hit any error this run — retry-failed re-enqueues them.
  private failedIds = new Set<string>();
  // For ETA calculations.
  private runStartedAt = Date.now();

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: SessionStore,
  ) {}

  start(): void {
    if (this.stopped) return;
    if (!this.isEnabled()) return;

    // Hydrate persisted state BEFORE any discovery so we honor the previous
    // paused flag and the previous failed list from the first tick.
    this.hydratePersistedState();

    // A tiny status-bar tile so the user can see something is happening (and
    // tell whether the daemon got stuck). Hidden when idle and queue empty.
    this.statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      STATUS_BAR_PRIORITY,
    );
    this.statusItem.name = "Claude · auto-classify";
    // Click → Quick Pick with Pause/Resume/Retry.
    this.statusItem.command = "coderSessions.classifyControls";
    this.ctx.subscriptions.push(this.statusItem);
    this.renderStatus();

    // Re-enable on settings flip; cheap to no-op.
    this.ctx.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("coderSessions.classify.autoBackground") ||
          e.affectsConfiguration("coderSessions.classify.backend")
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

  /** True if the worker is currently paused. */
  isPaused(): boolean { return this.paused; }

  /** Number of sessions that have hit at least one error this run. */
  failedCount(): number { return this.failedIds.size; }

  /** Toggle the paused flag. The discovery loop keeps running so the queue
   * is up-to-date when the user resumes. Persists so a paused daemon stays
   * paused across window reloads. */
  togglePause(): void {
    this.paused = !this.paused;
    this.persistPaused();
    this.renderStatus();
  }

  setPaused(p: boolean): void {
    if (this.paused === p) return;
    this.paused = p;
    this.persistPaused();
    this.renderStatus();
  }

  /** Move every session that errored back into the queue. The persistent
   * fail-list is cleared too, so retried-then-still-failed sessions get
   * a clean record. */
  retryFailed(): number {
    const ids = [...this.failedIds];
    this.failedIds.clear();
    this.persistFailedIds();
    let added = 0;
    for (const id of ids) {
      if (this.inQueue.has(id)) continue;
      this.inQueue.add(id);
      this.queue.push(id);
      added += 1;
    }
    if (added > 0) {
      const total = this.queue.length + (this.busy ? 1 : 0);
      if (total > this.peakQueue) this.peakQueue = total;
    }
    this.renderStatus();
    return added;
  }

  // ----- persistence -----

  /** Load failedIds + paused from ctx.globalState. Prunes failedIds that no
   * longer correspond to a session with unclassified turns (e.g. they got
   * classified through some other path), so the "N failed" tooltip stays
   * truthful. Safe to call multiple times. */
  private hydratePersistedState(): void {
    try {
      this.paused = this.ctx.globalState.get<boolean>(STATE_KEY_PAUSED, false);
    } catch { /* default false */ }

    const persisted = (() => {
      try { return this.ctx.globalState.get<string[]>(STATE_KEY_FAILED, []) ?? []; }
      catch { return []; }
    })();
    if (persisted.length === 0) return;

    let pending: Set<string> | null = null;
    try {
      pending = new Set(this.store.sessionsWithUnclassifiedTurns(10_000));
    } catch { /* fall back to keeping everything */ }

    let pruned = false;
    for (const id of persisted) {
      if (pending && !pending.has(id)) { pruned = true; continue; }
      this.failedIds.add(id);
    }
    if (pruned) this.persistFailedIds();
  }

  private persistFailedIds(): void {
    void this.ctx.globalState.update(STATE_KEY_FAILED, [...this.failedIds]);
  }

  private persistPaused(): void {
    void this.ctx.globalState.update(STATE_KEY_PAUSED, this.paused);
  }

  // ----- internals -----

  private isEnabled(): boolean {
    const cfg = vscode.workspace.getConfiguration("coderSessions");
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
        // Skip sessions that have already failed this run. Without this
        // check the worker grinds the same failures forever, because each
        // failed session still has unclassified turns and the next
        // discovery tick re-enqueues it. User can clear the block via the
        // "Retry failed sessions" control on the status-bar tile.
        if (this.failedIds.has(id)) continue;
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
    if (this.stopped || this.busy || !this.isEnabled() || this.paused) return;
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

    const cfg = vscode.workspace.getConfiguration("coderSessions");
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
        this.failedIds.add(id);
        this.persistFailedIds();
      }
      // If we got rate-limited / capped, pause discovery for a while.
      if (res.errors.some((e) => /rate.?limit|usage.?cap/i.test(e))) {
        this.queue = []; // drop everything; another discovery tick will refill
      }
    } catch (e: any) {
      this.lastError = String(e?.message ?? e).slice(0, 200);
      this.lastErrorAt = Date.now();
      this.failedIds.add(id);
      this.persistFailedIds();
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

  /** Pull the cheap aggregate counts from the DB so the tooltip can show
   * real progress, not just per-run worker activity. */
  private overview(): {
    totalSessions: number;
    classifiedSessions: number;
    sessionsWithPending: number;
    classifiedTurns: number;
    totalEligibleTurns: number;
  } {
    try {
      const o = this.store.classificationOverview();
      return {
        totalSessions: o.totalSessions,
        sessionsWithPending: o.sessionsWithPending,
        classifiedSessions: Math.max(0, o.totalSessions - o.sessionsWithPending),
        classifiedTurns: o.classifiedTurns,
        totalEligibleTurns: o.totalEligibleTurns,
      };
    } catch {
      return { totalSessions: 0, classifiedSessions: 0, sessionsWithPending: 0, classifiedTurns: 0, totalEligibleTurns: 0 };
    }
  }

  private etaString(turnsRemaining: number): string {
    // Estimate from this run's throughput: turns per second since start.
    const runMs = Date.now() - this.runStartedAt;
    if (this.classifiedThisRun < 10 || runMs < 5000) return "—";
    const rate = (this.classifiedThisRun / runMs) * 1000; // turns/sec
    if (rate <= 0) return "—";
    const secs = Math.floor(turnsRemaining / rate);
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
    return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
  }

  private renderStatus(): void {
    if (!this.statusItem) return;
    if (!this.isEnabled()) {
      this.statusItem.hide();
      return;
    }

    const ov = this.overview();
    const pending = this.queue.length + (this.busy ? 1 : 0);
    const idx = this.sessionsStarted;
    const tot = Math.max(this.peakQueue, idx);
    const failed = this.failedIds.size;
    const turnsRemaining = Math.max(0, ov.totalEligibleTurns - ov.classifiedTurns);
    const pctTurns = ov.totalEligibleTurns > 0 ? Math.floor((ov.classifiedTurns / ov.totalEligibleTurns) * 100) : 100;
    const pctSessions = ov.totalSessions > 0 ? Math.floor((ov.classifiedSessions / ov.totalSessions) * 100) : 100;

    // Overview block — same for every state.
    const overviewMd = (md: vscode.MarkdownString) => {
      md.appendMarkdown(`---\n\n**Overall progress**\n\n`);
      md.appendMarkdown(`Sessions: **${ov.classifiedSessions.toLocaleString()} / ${ov.totalSessions.toLocaleString()}** classified (${pctSessions}%)`);
      if (ov.sessionsWithPending > 0) md.appendMarkdown(` · ${ov.sessionsWithPending.toLocaleString()} still need work`);
      md.appendMarkdown(`\n\n`);
      md.appendMarkdown(`Turns: **${ov.classifiedTurns.toLocaleString()} / ${ov.totalEligibleTurns.toLocaleString()}** classified (${pctTurns}%) · ${turnsRemaining.toLocaleString()} remaining\n\n`);
      const eta = this.etaString(turnsRemaining);
      if (eta !== "—") md.appendMarkdown(`ETA: **${eta}** at current rate (${this.classifiedThisRun} turn(s) this run).\n\n`);
    };

    // ---- Paused state ----
    if (this.paused) {
      this.statusItem.text = `$(debug-pause) Paused · ${pending} queued${failed ? ` · ${failed} failed` : ""}`;
      const md = new vscode.MarkdownString();
      md.isTrusted = true;
      md.appendMarkdown(`**Background topic classification — paused**\n\n`);
      md.appendMarkdown(`${pending} session(s) waiting.\n`);
      if (failed) md.appendMarkdown(`${failed} session(s) errored this run.\n`);
      overviewMd(md);
      md.appendMarkdown(`_Click to resume / retry failed._`);
      this.statusItem.tooltip = md;
      this.statusItem.show();
      return;
    }

    // ---- Idle (caught up) ----
    if (pending === 0 && !this.busy) {
      if (this.classifiedThisRun > 0 || failed > 0 || ov.sessionsWithPending > 0) {
        this.statusItem.text = failed > 0
          ? `$(warning) ${pctSessions}% · ${failed} failed`
          : ov.sessionsWithPending > 0
            ? `$(circle-large-outline) ${pctSessions}% classified`
            : `$(check) all ${ov.totalSessions} sessions classified`;
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.appendMarkdown(`**Background topic classification — idle**\n\n`);
        md.appendMarkdown(`${this.classifiedThisRun} turn(s) classified across ${this.sessionsStarted} session pass(es) this run.\n\n`);
        if (failed > 0) md.appendMarkdown(`${failed} session(s) errored and are blocked from re-queue. _Click → Retry failed._\n\n`);
        overviewMd(md);
        if (this.lastError) md.appendMarkdown(`_Last error:_ ${escMd(this.lastError)}\n`);
        this.statusItem.tooltip = md;
        this.statusItem.show();
      } else {
        this.statusItem.hide();
      }
      return;
    }

    // ---- Running ----
    let text: string;
    if (this.busy && this.currentTitle) {
      const turnPart = this.currentTotal > 0 ? ` · ${this.currentDone}/${this.currentTotal}` : "";
      text = `$(sync~spin) ${pctTurns}% · ${truncate(this.currentTitle, 24)}${turnPart}`;
    } else {
      text = `$(sync~spin) ${pctTurns}% · ${pending} queued`;
    }
    if (failed > 0) text += ` · ${failed} failed`;
    this.statusItem.text = text;

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`**Background topic classification**\n\n`);
    md.appendMarkdown(`This pass: session ${idx} (${pending} queued)`);
    if (failed > 0) md.appendMarkdown(` · **${failed} failed** (blocked)`);
    md.appendMarkdown(`\n\n`);
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
    overviewMd(md);
    if (failed > 0) md.appendMarkdown(`_Click to pause or retry ${failed} failed sessions._\n`);
    if (this.lastError) {
      const ageSec = Math.max(0, Math.floor((Date.now() - this.lastErrorAt) / 1000));
      md.appendMarkdown(`\n_Last error (${ageSec}s ago):_ ${escMd(this.lastError)}\n`);
    }
    md.appendMarkdown(`\n_Toggle via setting:_ \`coderSessions.classify.autoBackground\`.`);
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
