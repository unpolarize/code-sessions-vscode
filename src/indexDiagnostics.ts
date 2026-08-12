// Indexing diagnostics: surface per-file parse failures to the "Code Sessions"
// Output channel and toast once per *changed* error count. Pure (vscode-free)
// so unit tests can drive it without the extension host.
//
// Contract (kp: tasks/csv-fixture-tests-for-claude-grok-git-indexers-s):
//   - path + reason logged per failure (deduped across quiet re-syncs)
//   - non-modal warning when total errors > 0, only when the count changes
//   - zero behavior change when errors === 0 (no toast, no channel spam)

export interface IndexErrorDetail {
  path: string;
  reason: string;
}

export interface IndexSyncStatsLike {
  errors: number;
  error_details?: IndexErrorDetail[];
}

/** Minimal OutputChannel / toast seams — matches vscode shapes we use. */
export interface IndexDiagnosticsLog {
  appendLine(line: string): void;
  show?(preserveFocus?: boolean): void;
}

export type IndexWarningToast = (
  message: string,
  ...items: string[]
) => Thenable<string | undefined> | PromiseLike<string | undefined> | undefined;

function fingerprint(source: string, details: IndexErrorDetail[]): string {
  if (details.length === 0) return `${source}:0`;
  const parts = details
    .map((d) => `${d.path}\0${d.reason}`)
    .sort();
  return `${source}:${details.length}:${parts.join("\n")}`;
}

export class IndexDiagnostics {
  /** Last error count we toasted for; null = never toasted. */
  private lastToastedCount: number | null = null;
  /** Last logged fingerprint per source — skip identical re-logs on quiet ticks. */
  private lastLogged = new Map<string, string>();

  constructor(
    private readonly log: IndexDiagnosticsLog,
    private readonly showWarning: IndexWarningToast,
  ) {}

  /**
   * Log path+reason lines for one indexer source when the failure set changed.
   * Returns the error count so callers can sum across sources.
   */
  reportSource(source: string, stats: IndexSyncStatsLike): number {
    const details = stats.error_details ?? [];
    const key = fingerprint(source, details);
    const prev = this.lastLogged.get(source);

    if (stats.errors === 0) {
      // Clear so a future failure re-logs even with the same path/reason.
      if (prev !== undefined && prev !== `${source}:0`) {
        this.lastLogged.set(source, `${source}:0`);
      } else {
        this.lastLogged.set(source, `${source}:0`);
      }
      return 0;
    }

    if (prev === key) {
      // Same failures as last pass — no channel spam on the 10s tick.
      return stats.errors;
    }
    this.lastLogged.set(source, key);

    for (const d of details) {
      this.log.appendLine(`[index:${source}] FAIL ${d.path}: ${d.reason}`);
    }
    this.log.appendLine(
      `[index:${source}] ${stats.errors} session file(s) failed to index` +
        (details.length !== stats.errors ? ` (${details.length} detail(s) recorded)` : ""),
    );
    return stats.errors;
  }

  /**
   * After a multi-source sync pass: toast if total errors > 0 and the count
   * differs from the last toast. "Show log" opens the Output channel.
   * When totalErrors === 0, records the zero so a later non-zero re-toasts.
   */
  maybeToast(totalErrors: number): void {
    if (totalErrors <= 0) {
      // Track recovery to zero so a future failure count will toast again
      // even if it matches a pre-recovery count.
      this.lastToastedCount = 0;
      return;
    }
    if (this.lastToastedCount === totalErrors) return;
    this.lastToastedCount = totalErrors;
    const msg =
      totalErrors === 1
        ? "1 session file failed to index"
        : `${totalErrors} session file(s) failed to index`;
    const result = this.showWarning(msg, "Show log");
    if (result && typeof (result as PromiseLike<string | undefined>).then === "function") {
      void Promise.resolve(result).then((sel) => {
        if (sel === "Show log") this.log.show?.(true);
      });
    }
  }

  /** Test seam: last toasted count (null if never). */
  get lastCount(): number | null {
    return this.lastToastedCount;
  }
}
