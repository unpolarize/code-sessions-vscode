// Background-session lifecycle matrix (KP ideas/csv-background-session-lifecycle-matrix-card-att).
// Pure module — no vscode / db / child_process imports — so the capability
// classifier + renderer are fixture-testable.
//
// Claude Code 2.1.251 documented first-class background-session CLI verbs
// (attach / logs / stop / respawn / rm). Dual-stack operators still treat
// Codex/Grok background work as opaque PIDs. This card is a capability ×
// action matrix: each cell is native ACP/CLI, CB host shim, or unsupported,
// sourced from a probe (advertised methods / CLI verbs / CLI version / host
// shims) — never from "source === claude" optimism.
//
// v1 is read-only. No action buttons. Distinct from CB session/stop
// force-teardown (kill path only) and ghost-teammate rehydrate (team mailbox).

export const BACKGROUND_SESSION_LIFECYCLE_SCHEMA =
  "code-sessions/background-session-lifecycle@1";

/** Claude Code changelog documenting the 2.1.251 background-session verbs. */
export const CLAUDE_LIFECYCLE_DOCS_URL = "https://code.claude.com/docs/en/changelog";

/** Floor version at which Claude documented attach/logs/stop/respawn/rm. */
export const CLAUDE_BG_VERBS_SINCE = "2.1.251";

export const LIFECYCLE_VERBS = ["attach", "logs", "stop", "respawn", "rm"] as const;
export type LifecycleVerb = (typeof LIFECYCLE_VERBS)[number];

export type CapabilityClass = "native" | "shim" | "unsupported";

/** Max rows on the Insights card. */
export const DEFAULT_MAX_ROWS = 12;

/** "Open" = last activity within this window (default 30 min). */
export const DEFAULT_OPEN_WINDOW_MS = 30 * 60 * 1000;

/**
 * ACP method aliases per lifecycle verb (lowercased).
 * `session/load` is the documented ACP resume/attach path; `session/stop`
 * and `session/close` are the rare stop advertisements (CB registry: ~1/32).
 */
export const ACP_METHOD_ALIASES: Record<LifecycleVerb, readonly string[]> = {
  attach: ["session/load", "session/attach", "session/resume"],
  logs: ["session/logs", "session/log"],
  stop: ["session/stop", "session/close"],
  respawn: ["session/respawn"],
  rm: ["session/rm", "session/delete", "session/remove"],
};

/** Claude 2.1.251 CLI forms. Shown only when the probe says native. */
export const CLAUDE_CLI_VERBS: Record<LifecycleVerb, string> = {
  attach: "claude attach",
  logs: "claude logs",
  stop: "claude stop",
  respawn: "claude respawn",
  rm: "claude rm",
};

export interface LifecycleProbe {
  /** Advertised ACP methods (session/stop, session/load, …). */
  acpMethods?: string[] | null;
  /** agentCapabilities.sessionCapabilities from initialize. */
  sessionCapabilities?: {
    stop?: unknown;
    close?: unknown;
    load?: unknown;
    [k: string]: unknown;
  } | null;
  /** CLI verbs from a help/version probe (attach, logs, stop, respawn, rm). */
  cliVerbs?: string[] | null;
  /** Host shims the CSV/CB host can perform (typically only "stop"). */
  hostShims?: string[] | null;
  /** Probed CLI version (e.g. "2.1.251"). Required to unlock Claude's verb set. */
  cliVersion?: string | null;
  /** True when the probe is the Claude CLI (not merely source=claude). */
  claudeCli?: boolean | null;
}

export interface LifecycleSessionInput {
  sessionId: string;
  source?: string | null;
  label?: string | null;
  kind?: string | null;
  title?: string | null;
  entrypoint?: string | null;
  isAutomated?: boolean | null;
  endedAt?: number | null;
  lastActivityMs?: number | null;
  extras?: Record<string, unknown> | null;
  extras_json?: string | null;
  /** Per-session probe; merged over backend probe + extras. */
  probe?: LifecycleProbe | null;
}

export interface LifecycleCell {
  verb: LifecycleVerb;
  klass: CapabilityClass;
  reason: string;
  /** Documented Claude CLI form when native + Claude 2.1.251 probe. */
  claudeVerb?: string | null;
  docsUrl?: string | null;
}

export interface LifecycleRow {
  sessionId: string;
  source: string;
  label: string;
  cells: Record<LifecycleVerb, LifecycleCell>;
}

export interface BackgroundSessionLifecycleCard {
  schema: typeof BACKGROUND_SESSION_LIFECYCLE_SCHEMA;
  rows: LifecycleRow[];
  nativeCells: number;
  shimCells: number;
  unsupportedCells: number;
  skippedClosed: number;
  skippedNotBackground: number;
}

export interface LifecycleComputeOptions {
  nowMs?: number;
  openWindowMs?: number;
  maxRows?: number;
  /** Backend-level probe (merged under per-session probe + extras). */
  probesByBackend?: Record<string, LifecycleProbe> | Map<string, LifecycleProbe> | null;
  openSessionCommand?: string;
}

export interface LifecycleStoreRow {
  session_id?: string | null;
  session?: string | null;
  source?: string | null;
  title?: string | null;
  first_user_msg?: string | null;
  extras_json?: string | null;
  kind?: string | null;
  entrypoint?: string | null;
  is_automated?: boolean | null;
  ended_at?: number | null;
  last_assistant_text_at?: number | null;
  started_at?: number | null;
  mtime_ns?: number | null;
  mtime_epoch?: number | null;
}

// --------------------------------------------------------------------------- //
// Probe / extras
// --------------------------------------------------------------------------- //

function presentCap(v: unknown): boolean {
  if (v === true || v === 1 || v === "true") return true;
  if (v && typeof v === "object") return true;
  return false;
}

function parseExtrasObject(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const o = JSON.parse(json);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function extrasOf(s: LifecycleSessionInput): Record<string, unknown> {
  if (s.extras && typeof s.extras === "object") return s.extras;
  return parseExtrasObject(s.extras_json);
}

function stringList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(String).map((x) => x.trim()).filter(Boolean);
  }
  if (typeof v === "string" && v.trim()) {
    return v.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function parseDottedVersion(raw: string | null | undefined): [number, number, number] | null {
  if (!raw) return null;
  const m = String(raw).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function versionAtLeast(raw: string | null | undefined, floor: string): boolean {
  const v = parseDottedVersion(raw);
  const f = parseDottedVersion(floor);
  if (!v || !f) return false;
  for (let i = 0; i < 3; i++) {
    if (v[i] > f[i]) return true;
    if (v[i] < f[i]) return false;
  }
  return true;
}

function normalizeVerbToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/^session\//, "").replace(/^claude\s+/, "");
}

function methodsList(probe: LifecycleProbe): string[] {
  return stringList(probe.acpMethods).map((m) => m.trim().toLowerCase());
}

function backendOf(source: string | null | undefined): string {
  const s = (source || "claude").trim().toLowerCase();
  return s || "claude";
}

/**
 * Lift extras / initialize-shaped blobs into a probe. Missing fields stay
 * empty — the classifier then marks unsupported (honest absent).
 */
export function probeFromExtras(extras: Record<string, unknown> | null | undefined): LifecycleProbe {
  const e = extras && typeof extras === "object" ? extras : {};
  const agentCaps = (e.agentCapabilities && typeof e.agentCapabilities === "object"
    ? (e.agentCapabilities as Record<string, unknown>)
    : null);
  const sessionCaps = (e.sessionCapabilities && typeof e.sessionCapabilities === "object"
    ? (e.sessionCapabilities as LifecycleProbe["sessionCapabilities"])
    : agentCaps && typeof agentCaps.sessionCapabilities === "object"
      ? (agentCaps.sessionCapabilities as LifecycleProbe["sessionCapabilities"])
      : null);

  const methods = [
    ...stringList(e.acpMethods),
    ...stringList(e.methods),
    ...stringList((e.capabilities as { methods?: unknown } | undefined)?.methods),
  ];

  const hostShims = stringList(e.hostShims);
  if (presentCap(e.hostShimStop) || presentCap(e.cbHostTeardown) || presentCap(e.hostTeardown)) {
    if (!hostShims.includes("stop")) hostShims.push("stop");
  }

  return {
    acpMethods: methods,
    sessionCapabilities: sessionCaps,
    cliVerbs: stringList(e.cliVerbs),
    hostShims,
    cliVersion: firstString(e.cliVersion, e.claudeVersion, e.claude_cli_version),
    claudeCli: presentCap(e.claudeCli) ? true : null,
  };
}

function mergeProbes(...parts: Array<LifecycleProbe | null | undefined>): LifecycleProbe {
  const out: LifecycleProbe = {
    acpMethods: [],
    sessionCapabilities: {},
    cliVerbs: [],
    hostShims: [],
    cliVersion: null,
    claudeCli: null,
  };
  for (const p of parts) {
    if (!p) continue;
    out.acpMethods = [...(out.acpMethods ?? []), ...stringList(p.acpMethods)];
    if (p.sessionCapabilities && typeof p.sessionCapabilities === "object") {
      out.sessionCapabilities = { ...(out.sessionCapabilities ?? {}), ...p.sessionCapabilities };
    }
    out.cliVerbs = [...(out.cliVerbs ?? []), ...stringList(p.cliVerbs)];
    out.hostShims = [...(out.hostShims ?? []), ...stringList(p.hostShims)];
    if (p.cliVersion) out.cliVersion = p.cliVersion;
    if (p.claudeCli != null) out.claudeCli = p.claudeCli;
  }
  return out;
}

function lookupBackendProbe(
  map: LifecycleComputeOptions["probesByBackend"],
  backend: string,
): LifecycleProbe | null {
  if (!map) return null;
  if (map instanceof Map) return map.get(backend) ?? null;
  return map[backend] ?? null;
}

// --------------------------------------------------------------------------- //
// Background / open
// --------------------------------------------------------------------------- //

function lastActivityMs(s: LifecycleSessionInput): number {
  const n = s.lastActivityMs;
  if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
  const ended = s.endedAt;
  if (typeof ended === "number" && Number.isFinite(ended) && ended > 0) return ended;
  return 0;
}

function looksBackground(s: LifecycleSessionInput): boolean {
  const extras = extrasOf(s);
  if (presentCap(extras.background) || presentCap(extras.detached) || presentCap(extras.backgrounded)) {
    return true;
  }
  const mode = firstString(extras.sessionMode, extras.mode, extras.lifecycle, extras.session_mode);
  if (mode && /^(background|detached|bg)$/i.test(mode)) return true;
  if (typeof extras.backgroundSessionId === "string" && extras.backgroundSessionId.trim()) return true;
  const hay = `${s.title ?? ""} ${s.entrypoint ?? ""} ${s.label ?? ""}`;
  if (/\b(background[- ]session|detached[- ]session)\b/i.test(hay)) return true;
  if ((s.kind || "session") === "subagent") return false;
  if (s.isAutomated) return true;
  return false;
}

function isOpen(s: LifecycleSessionInput, nowMs: number, openWindowMs: number): boolean {
  const extras = extrasOf(s);
  if (presentCap(extras.running) || presentCap(extras.alive) || presentCap(extras.open)) return true;
  const last = lastActivityMs(s);
  if (s.endedAt == null || s.endedAt === 0) {
    // Never ended: still open if we have recent activity, or no clock at all
    // (fixtures that only stamp extras.background).
    if (last <= 0) return true;
    return nowMs - last <= openWindowMs;
  }
  if (last > 0 && nowMs - last <= openWindowMs) return true;
  if (nowMs - s.endedAt <= openWindowMs) return true;
  return false;
}

/** True when the session is an open background/detached attach target. */
export function isBackgroundOrDetached(
  s: LifecycleSessionInput,
  nowMs: number = Date.now(),
  openWindowMs: number = DEFAULT_OPEN_WINDOW_MS,
): boolean {
  if (!looksBackground(s)) return false;
  return isOpen(s, nowMs, openWindowMs);
}

// --------------------------------------------------------------------------- //
// Classifier
// --------------------------------------------------------------------------- //

function claudeVerbSetFromVersion(probe: LifecycleProbe, backend: string): Set<LifecycleVerb> {
  const isClaude = probe.claudeCli === true || backend === "claude";
  if (!isClaude) return new Set();
  if (!versionAtLeast(probe.cliVersion, CLAUDE_BG_VERBS_SINCE)) return new Set();
  return new Set(LIFECYCLE_VERBS);
}

function advertisedNative(verb: LifecycleVerb, probe: LifecycleProbe, backend: string): boolean {
  const methods = methodsList(probe);
  for (const alias of ACP_METHOD_ALIASES[verb]) {
    if (methods.includes(alias)) return true;
  }
  const caps = probe.sessionCapabilities;
  if (verb === "stop") {
    if (presentCap(caps?.stop) || presentCap(caps?.close)) return true;
  }
  if (verb === "attach" && presentCap(caps?.load)) return true;
  const cli = stringList(probe.cliVerbs).map(normalizeVerbToken);
  if (cli.includes(verb)) return true;
  if (claudeVerbSetFromVersion(probe, backend).has(verb)) return true;
  return false;
}

function advertisedShim(verb: LifecycleVerb, probe: LifecycleProbe): boolean {
  const shims = stringList(probe.hostShims).map(normalizeVerbToken);
  return shims.includes(verb);
}

function nativeReason(verb: LifecycleVerb, probe: LifecycleProbe, backend: string): string {
  const methods = methodsList(probe);
  const hit = ACP_METHOD_ALIASES[verb].find((a) => methods.includes(a));
  if (hit) return `native ACP ${hit}`;
  const caps = probe.sessionCapabilities;
  if (verb === "stop" && presentCap(caps?.close)) return "native ACP sessionCapabilities.close";
  if (verb === "stop" && presentCap(caps?.stop)) return "native ACP sessionCapabilities.stop";
  if (verb === "attach" && presentCap(caps?.load)) return "native ACP sessionCapabilities.load";
  const cli = stringList(probe.cliVerbs).map(normalizeVerbToken);
  if (cli.includes(verb)) return `native CLI ${verb}`;
  if (claudeVerbSetFromVersion(probe, backend).has(verb)) {
    return `native Claude CLI ${probe.cliVersion} (≥ ${CLAUDE_BG_VERBS_SINCE})`;
  }
  return "native";
}

/**
 * Classify one verb from a probe. Native wins over shim. Missing probe →
 * unsupported (honest absent — never inferred from backend name alone).
 */
export function classifyLifecycleVerb(
  verb: LifecycleVerb,
  probe: LifecycleProbe | null | undefined,
  backend: string = "claude",
): LifecycleCell {
  const p = probe ?? {};
  const b = backendOf(backend);
  if (advertisedNative(verb, p, b)) {
    const isClaudeNative =
      p.claudeCli === true ||
      (b === "claude" &&
        (claudeVerbSetFromVersion(p, b).has(verb) ||
          stringList(p.cliVerbs).map(normalizeVerbToken).includes(verb)));
    return {
      verb,
      klass: "native",
      reason: nativeReason(verb, p, b),
      claudeVerb: isClaudeNative ? CLAUDE_CLI_VERBS[verb] : null,
      docsUrl: isClaudeNative ? CLAUDE_LIFECYCLE_DOCS_URL : null,
    };
  }
  if (advertisedShim(verb, p)) {
    return {
      verb,
      klass: "shim",
      reason:
        verb === "stop"
          ? "CB host shim (process kill) — not session/stop; no protocol stop claimed"
          : `CB host shim for ${verb}`,
      claudeVerb: null,
      docsUrl: null,
    };
  }
  return {
    verb,
    klass: "unsupported",
    reason: `unsupported — no ACP/CLI advertisement and no host shim for ${verb}`,
    claudeVerb: null,
    docsUrl: null,
  };
}

export function classifySessionLifecycle(
  probe: LifecycleProbe | null | undefined,
  backend: string = "claude",
): Record<LifecycleVerb, LifecycleCell> {
  const cells = {} as Record<LifecycleVerb, LifecycleCell>;
  for (const verb of LIFECYCLE_VERBS) {
    cells[verb] = classifyLifecycleVerb(verb, probe, backend);
  }
  return cells;
}

function sessionIdOf(r: LifecycleStoreRow): string {
  return (r.session_id || r.session || "").trim();
}

function activityFromStore(r: LifecycleStoreRow): number {
  if (typeof r.last_assistant_text_at === "number" && r.last_assistant_text_at > 0) {
    return r.last_assistant_text_at;
  }
  if (typeof r.ended_at === "number" && r.ended_at > 0) return r.ended_at;
  if (typeof r.started_at === "number" && r.started_at > 0) return r.started_at;
  if (typeof r.mtime_ns === "number" && r.mtime_ns > 0) return Math.floor(r.mtime_ns / 1e6);
  if (typeof r.mtime_epoch === "number" && r.mtime_epoch > 0) {
    return r.mtime_epoch > 1e12 ? r.mtime_epoch : r.mtime_epoch * 1000;
  }
  return 0;
}

/** Lift store / Insights rows into classifier inputs. */
export function sessionsFromStoreRows(rows: LifecycleStoreRow[]): LifecycleSessionInput[] {
  const out: LifecycleSessionInput[] = [];
  for (const r of rows) {
    const sid = sessionIdOf(r);
    if (!sid) continue;
    const extras = parseExtrasObject(r.extras_json);
    const goal = (r.title || r.first_user_msg || sid).trim();
    out.push({
      sessionId: sid,
      source: backendOf(r.source),
      label: goal.slice(0, 70),
      kind: (r.kind as string) || "session",
      title: r.title ?? null,
      entrypoint: r.entrypoint ?? null,
      isAutomated: !!r.is_automated,
      endedAt: r.ended_at ?? null,
      lastActivityMs: activityFromStore(r),
      extras,
      extras_json: r.extras_json ?? null,
      probe: probeFromExtras(extras),
    });
  }
  return out;
}

/**
 * Build the matrix. Always returns a card (rows may be empty). Empty corpus
 * does not invent native cells.
 */
export function computeBackgroundSessionLifecycle(
  sessions: LifecycleSessionInput[],
  opts: LifecycleComputeOptions = {},
): BackgroundSessionLifecycleCard {
  const nowMs = opts.nowMs ?? Date.now();
  const openWindowMs = Math.max(0, opts.openWindowMs ?? DEFAULT_OPEN_WINDOW_MS);
  const maxRows = Math.max(1, opts.maxRows ?? DEFAULT_MAX_ROWS);
  let skippedClosed = 0;
  let skippedNotBackground = 0;
  const rows: LifecycleRow[] = [];

  for (const s of sessions) {
    if (!looksBackground(s)) {
      skippedNotBackground += 1;
      continue;
    }
    if (!isOpen(s, nowMs, openWindowMs)) {
      skippedClosed += 1;
      continue;
    }
    const backend = backendOf(s.source);
    const probe = mergeProbes(
      lookupBackendProbe(opts.probesByBackend, backend),
      s.probe,
      probeFromExtras(extrasOf(s)),
    );
    rows.push({
      sessionId: s.sessionId,
      source: backend,
      label: (s.label || s.title || s.sessionId).slice(0, 70),
      cells: classifySessionLifecycle(probe, backend),
    });
  }

  const visible = rows.slice(0, maxRows);
  let nativeCells = 0;
  let shimCells = 0;
  let unsupportedCells = 0;
  for (const r of visible) {
    for (const verb of LIFECYCLE_VERBS) {
      const k = r.cells[verb].klass;
      if (k === "native") nativeCells += 1;
      else if (k === "shim") shimCells += 1;
      else unsupportedCells += 1;
    }
  }

  return {
    schema: BACKGROUND_SESSION_LIFECYCLE_SCHEMA,
    rows: visible,
    nativeCells,
    shimCells,
    unsupportedCells,
    skippedClosed,
    skippedNotBackground,
  };
}

// --------------------------------------------------------------------------- //
// HTML
// --------------------------------------------------------------------------- //

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function commandHref(command: string, args: unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

function cellHtml(cell: LifecycleCell, sessionId: string): string {
  const cls = `bsl-cell bsl-${cell.klass}`;
  if (cell.klass === "native") {
    const verbBits: string[] = [];
    if (cell.claudeVerb) {
      const cmd = `${cell.claudeVerb} ${sessionId}`;
      const href = cell.docsUrl || CLAUDE_LIFECYCLE_DOCS_URL;
      verbBits.push(
        `<a class="bsl-verb" href="${esc(href)}" title="${esc(cmd)}">${esc(cell.claudeVerb)}</a>`,
      );
    }
    return `<td class="${cls}" title="${esc(cell.reason)}"><span class="bsl-dot" aria-label="native"></span> native${verbBits.length ? `<br>${verbBits.join("")}` : ""}</td>`;
  }
  if (cell.klass === "shim") {
    return `<td class="${cls}" title="${esc(cell.reason)}"><span class="bsl-dot" aria-label="shim"></span> shim</td>`;
  }
  return `<td class="${cls}" title="${esc(cell.reason)}"><span class="bsl-dot" aria-label="unsupported"></span> —</td>`;
}

/** Insights section ("" when no open background/detached sessions). */
export function renderBackgroundSessionLifecycleHtml(
  card: BackgroundSessionLifecycleCard,
  opts: Pick<LifecycleComputeOptions, "openSessionCommand"> = {},
): string {
  if (card.rows.length === 0) return "";
  const cmd = opts.openSessionCommand ?? "codeSessions.openSession";

  const rows = card.rows
    .map((r) => {
      const href = commandHref(cmd, [r.sessionId]);
      const cells = LIFECYCLE_VERBS.map((v) => cellHtml(r.cells[v], r.sessionId)).join("");
      return `<tr>
        <td class="bsl-backend">${esc(r.source)}</td>
        <td class="bsl-session"><a class="bsl-link" href="${esc(href)}" title="${esc(r.sessionId)}">${esc(r.label.slice(0, 40))}</a></td>
        ${cells}
      </tr>`;
    })
    .join("");

  return `<section class="bsl-card" data-schema="${esc(BACKGROUND_SESSION_LIFECYCLE_SCHEMA)}">
  <div class="bsl-head"><span class="bsl-title">Background-session lifecycle</span>
    <span class="bsl-chip" title="Traffic-light: native ACP/CLI · CB host shim · unsupported">${card.rows.length} open</span>
    <span class="bsl-chip bsl-native-chip" title="Native ACP or CLI advertisement">${card.nativeCells} native</span>
    <span class="bsl-chip bsl-shim-chip" title="CB host shim (typically process-kill stop)">${card.shimCells} shim</span>
    <span class="bsl-chip bsl-absent-chip" title="No advertisement and no host shim">${card.unsupportedCells} absent</span>
  </div>
  <div class="bsl-sub">Capability × action matrix for open background/detached sessions. Cells are <b>native</b> (ACP/CLI advertised), <b>shim</b> (CB host teardown), or <b>—</b> (unsupported). Probe-sourced — Claude is not assumed to have 2.1.251 verbs without a version/help advertisement. Read-only; no action buttons.</div>
  <div class="bsl-table-wrap"><table class="bsl-table"><tr><th>backend</th><th>session</th><th>attach</th><th>logs</th><th>stop</th><th>respawn</th><th>rm</th></tr>${rows}</table></div>
  <div class="bsl-legend"><span class="bsl-cell bsl-native"><span class="bsl-dot"></span> native ACP/CLI</span>
    <span class="bsl-cell bsl-shim"><span class="bsl-dot"></span> CB host shim</span>
    <span class="bsl-cell bsl-unsupported"><span class="bsl-dot"></span> unsupported</span></div>
  <div class="bsl-help">Claude 2.1.251 verbs (<code>claude attach/logs/stop/respawn/rm</code>) deep-link only when the probe reports CLI ≥ ${CLAUDE_BG_VERBS_SINCE} or lists the verb. ACP <code>session/stop</code> is rare; a Stop shim is host kill, not a protocol stop.</div>
  <div class="bsl-disclaimer">Read-only matrix — does not send attach/stop/rm. Distinct from CB session/stop force-teardown (kill shim only) and ghost-teammate rehydrate (team mailbox). Honest absent &gt; fake Codex/Grok buttons.</div>
</section>`;
}

/** CSS for Insights — keep in sync with `.bsl-*` markup above. */
export const BACKGROUND_SESSION_LIFECYCLE_CARD_CSS = `
.bsl-card { background: var(--card-bg, var(--vscode-editorWidget-background, #1e1e1e)); border: 1px solid var(--border, var(--vscode-panel-border, #333)); border-radius: 6px; padding: 12px 14px; margin-top: 8px; }
.bsl-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; flex-wrap: wrap; }
.bsl-title { font-size: 11px; text-transform: uppercase; color: var(--muted, var(--vscode-descriptionForeground, #999)); letter-spacing: 0.5px; font-weight: 600; }
.bsl-chip { display: inline-block; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; color: var(--vscode-descriptionForeground, #999); border: 1px solid var(--vscode-panel-border, #333); border-radius: 8px; padding: 1px 7px; vertical-align: middle; }
.bsl-native-chip { color: var(--vscode-charts-green, #5eba7d); border-color: var(--vscode-charts-green, #5eba7d); }
.bsl-shim-chip { color: var(--vscode-inputValidation-warningForeground, #e8a838); border-color: var(--vscode-inputValidation-warningForeground, #e8a838); }
.bsl-absent-chip { color: var(--muted, var(--vscode-descriptionForeground, #999)); }
.bsl-sub { font-size: 12px; color: var(--muted, var(--vscode-descriptionForeground, #999)); line-height: 1.45; margin-bottom: 8px; }
.bsl-table-wrap { overflow-x: auto; margin-top: 2px; }
.bsl-table { width: 100%; min-width: 640px; border-collapse: collapse; font-size: 12px; }
.bsl-table th, .bsl-table td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--border, var(--vscode-panel-border, #333)); vertical-align: top; }
.bsl-table th { color: var(--muted, var(--vscode-descriptionForeground, #999)); font-weight: 500; font-size: 10px; text-transform: uppercase; }
.bsl-backend { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; }
.bsl-session { font-size: 12px; }
.bsl-link { color: var(--accent, var(--vscode-textLink-foreground, #4af)); text-decoration: none; }
.bsl-link:hover { text-decoration: underline; }
.bsl-cell { font-size: 11px; white-space: nowrap; }
.bsl-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
.bsl-native .bsl-dot { background: var(--vscode-charts-green, #5eba7d); }
.bsl-shim .bsl-dot { background: var(--vscode-inputValidation-warningForeground, #e8a838); }
.bsl-unsupported .bsl-dot { background: var(--muted, var(--vscode-descriptionForeground, #666)); }
.bsl-native { color: var(--vscode-charts-green, #5eba7d); }
.bsl-shim { color: var(--vscode-inputValidation-warningForeground, #e8a838); }
.bsl-unsupported { color: var(--muted, var(--vscode-descriptionForeground, #999)); }
.bsl-verb { font-size: 10px; color: var(--accent, var(--vscode-textLink-foreground, #4af)); text-decoration: none; font-family: var(--vscode-editor-font-family, monospace); }
.bsl-verb:hover { text-decoration: underline; }
.bsl-legend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 8px; font-size: 11px; color: var(--muted, var(--vscode-descriptionForeground, #999)); }
.bsl-help { font-size: 11px; color: var(--muted, var(--vscode-descriptionForeground, #999)); margin-top: 8px; line-height: 1.45; }
.bsl-help code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; }
.bsl-disclaimer { font-size: 11px; color: var(--muted, var(--vscode-descriptionForeground, #999)); margin-top: 8px; line-height: 1.45; border-top: 1px solid var(--border, var(--vscode-panel-border, #333)); padding-top: 8px; }
`;
