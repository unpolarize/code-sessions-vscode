/**
 * Post-activate index schedule.
 *
 * CSV and CB share the VS Code extension host. A wasm grok/git pass on
 * `setTimeout(0)` (or even 200 ms) races the restored-chat deserializer:
 * `cb.deserialize` cannot `setHtml` / process `webview.ready` until the
 * host is free, so the chat stays blank until the CSV sidebar finishes.
 *
 * Keep the first wasm pass after restore has had time to paint. Live grok
 * updates stay on the `onlyPaths` watcher (~40 ms), not a full rescan.
 */

export const BOOT_INDEX_CLAUDE_MS = 2_000;
export const BOOT_INDEX_GROK_MS = 120_000;
export const BOOT_STORE_SYNC_MS = 20_000;

export type BootIndexPass = {
  includeGit: boolean;
  includeClaude: boolean;
  includeGrok: boolean;
  includeCodex: boolean;
};

/** First pass: cheap Claude jsonl so the Sessions tree has today's rows. */
export function claudeOnlyIndexOpts(): BootIndexPass {
  return {
    includeGit: false,
    includeClaude: true,
    includeGrok: false,
    includeCodex: false,
  };
}

/** One catch-up after the UI is up. Watcher covers live grok after this. */
export function grokCatchupIndexOpts(): BootIndexPass {
  return {
    includeGit: false,
    includeClaude: false,
    includeGrok: true,
    includeCodex: true,
  };
}

/** 60 s timer — never full grok (6 s wasm). Claude + codex are tens of ms. */
export function periodicIndexOpts(): BootIndexPass {
  return {
    includeGit: false,
    includeClaude: true,
    includeGrok: false,
    includeCodex: true,
  };
}
