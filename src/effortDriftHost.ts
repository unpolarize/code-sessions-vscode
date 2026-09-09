// Host-side helpers for the effort-semantics drift canary.
// Keeps fs / home-dir I/O out of the pure effortDriftCanary core.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  detectEffortDriftFromSessions,
  effortLookupFromCodeBuildIndex,
  renderEffortDriftSectionHtml,
  type DriftCardHtmlOpts,
  type EffortDriftCard,
  type SessionEffortInput,
} from "./effortDriftCanary";

const DEFAULT_CB_INDEX = path.join(os.homedir(), ".codebuild", "index.json");

/** Read ~/.codebuild/index.json → backendSessionId → effort. Empty on miss/error. */
export function loadCodeBuildEffortLookup(indexPath: string = DEFAULT_CB_INDEX): Map<string, string> {
  try {
    if (!fs.existsSync(indexPath)) return new Map();
    const raw = fs.readFileSync(indexPath, "utf8");
    return effortLookupFromCodeBuildIndex(JSON.parse(raw));
  } catch {
    return new Map();
  }
}

export interface ComputeEffortDriftOpts {
  now?: number;
  effortBySessionId?: ReadonlyMap<string, string>;
  /** When true (default), load CB index if no map was passed. */
  loadCodeBuildLookup?: boolean;
  codeBuildIndexPath?: string;
  openSessionCommand?: string;
}

/** Sessions DB rows → advisory cards (cold-start / no-effort rows stay silent). */
export function computeEffortDriftCards(
  rows: SessionEffortInput[],
  opts: ComputeEffortDriftOpts = {},
): EffortDriftCard[] {
  const effortBySessionId =
    opts.effortBySessionId ??
    (opts.loadCodeBuildLookup === false
      ? undefined
      : loadCodeBuildEffortLookup(opts.codeBuildIndexPath));
  return detectEffortDriftFromSessions(rows, {
    now: opts.now,
    effortBySessionId,
  });
}

/** HTML section for Insights ("" when no watch/drift cards). */
export function computeEffortDriftHtml(
  rows: SessionEffortInput[],
  opts: ComputeEffortDriftOpts & DriftCardHtmlOpts = {},
): string {
  const cards = computeEffortDriftCards(rows, opts);
  return renderEffortDriftSectionHtml(cards, {
    commandUris: opts.commandUris,
    openSessionCommand: opts.openSessionCommand ?? "codeSessions.openSession",
  });
}
