// Embedded Planning-Dashboard chat: a headless `claude -p` session that can
// read AND modify the knowledge/planning store through the `kp` CLI (and the
// sessions cache) from a chat drawer inside the board. Multi-turn context via
// `--resume <session_id>`; every turn is a visible job (spec R2/R4) and the
// board reloads after a turn that may have written the store.
//
// Pure parts (argv builder, stream-json folding) are exported for unit tests;
// the class only wires child-process + events.

import { spawn, type ChildProcess } from "node:child_process";
import * as vscode from "vscode";
import { globalJobTracker } from "./jobs";

export type ChatEvent =
  | { kind: "user"; text: string }
  // seq is stamped on transcript-worthy events so a re-hydrating webview can
  // dedupe live events it already painted (review finding #2).
  | { kind: "status"; text: string }
  | { kind: "text"; text: string; append?: boolean }
  | { kind: "board"; cmd: BoardCommand }
  | { kind: "tool"; name: string; detail?: string }
  | { kind: "result"; text: string; costUsd?: number; isError?: boolean }
  | { kind: "error"; message: string }
  | { kind: "busy"; busy: boolean };

export type SeqChatEvent = ChatEvent & { seq?: number };

/** Board control the agent can request by printing `@@board {json}` on its
 * own line. Stripped from the visible reply and routed to the dashboard. */
export interface BoardCommand {
  view?: string;
  lane?: string;
  search?: string;
  /** Alias for search (agents say "filter"). */
  filter?: string;
  item?: string;
}

const DIRECTIVE = "@@board";

/**
 * Streaming filter: passes normal text through, swallows complete
 * `@@board {json}` lines into commands. Chunk boundaries can split the
 * marker or the JSON (grok streams word-level deltas), so a possible
 * marker prefix / an open directive line is held until resolvable.
 */
export class DirectiveFilter {
  private buf = "";

  push(delta: string): { text: string; cmds: BoardCommand[] } {
    this.buf += delta;
    let out = "";
    const cmds: BoardCommand[] = [];
    for (;;) {
      const idx = this.buf.indexOf(DIRECTIVE);
      if (idx < 0) {
        // Emit everything except a tail that could still become the marker.
        let keep = 0;
        for (let k = Math.min(DIRECTIVE.length - 1, this.buf.length); k > 0; k--) {
          if (this.buf.endsWith(DIRECTIVE.slice(0, k))) {
            keep = k;
            break;
          }
        }
        out += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        break;
      }
      out += this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx);
      const nl = this.buf.indexOf("\n");
      if (nl < 0) break; // directive line still streaming
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const cmd = parseDirective(line);
      if (cmd) cmds.push(cmd);
      else out += line + "\n"; // malformed — show it rather than eat it
    }
    return { text: out, cmds };
  }

  flush(): { text: string; cmds: BoardCommand[] } {
    const rest = this.buf;
    this.buf = "";
    if (rest.startsWith(DIRECTIVE)) {
      const cmd = parseDirective(rest);
      if (cmd) return { text: "", cmds: [cmd] };
    }
    return { text: rest, cmds: [] };
  }
}

export function parseDirective(line: string): BoardCommand | null {
  const j = line.indexOf("{");
  if (j < 0) return null;
  try {
    const cmd = JSON.parse(line.slice(j)) as BoardCommand;
    if (!cmd || typeof cmd !== "object") return null;
    if (cmd.filter && !cmd.search) cmd.search = cmd.filter;
    if (cmd.lane === "ideas") cmd.lane = "idea";
    if (cmd.lane === "tasks") cmd.lane = "task";
    if (cmd.lane === "plans") cmd.lane = "plan";
    if (cmd.lane === "thoughts") cmd.lane = "thought";
    if (cmd.view === "fleet") cmd.view = "sessions";
    if (cmd.view === "ideas") {
      cmd.view = "board";
      cmd.lane = cmd.lane || "idea";
    }
    return cmd;
  } catch {
    /* fall through */
  }
  return null;
}

/** CB-style runtime controls, chosen per message in the drawer. */
export interface ChatRuntime {
  provider: "claude" | "grok";
  model: string;
  effort: string;
  access: "kp" | "full";
}

export const DEFAULT_RUNTIME: ChatRuntime = { provider: "claude", model: "default", effort: "default", access: "kp" };

/** Same sets CB's header offers (backendRegistry.ts is the source of truth). */
export const CHAT_PROVIDERS: Record<ChatRuntime["provider"], { label: string; models: string[] }> = {
  claude: { label: "Claude Code", models: ["default", "fable", "opus", "sonnet", "haiku"] },
  grok: { label: "Grok Build", models: ["default", "grok-4.6", "grok-4.5", "grok-code-fast-1"] }
};
export const CHAT_EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"];

/** kpPath: absolute path of the kp shim — aliases/profile PATH cannot shadow it. */
export function buildChatSystemPrompt(kpPath?: string): string {
  const kp = kpPath ?? "kp";
  return PLANNING_CHAT_SYSTEM_PROMPT.replace(/\bkp /g, `${kp} `).replace("the `kp` CLI", `the planning CLI at \`${kp}\``);
}

export const PLANNING_CHAT_SYSTEM_PROMPT = [
  "You are the planning assistant embedded in the Code Sessions Planning Dashboard.",
  "The knowledge base lives in this repository; planning objects (ideas, tasks, plans, projects, insights) are managed with the `kp` CLI — prefer it over editing planning/*.md directly.",
  "Useful commands: `kp export --date today`, `kp search <query>`, `kp show <id>`, `kp create <type> --title ... --body -`, `kp set-status <id> <status>`, `kp link-session <id> <session-uuid>`, `kp link <id> <other-id>`.",
  "Session history: the code-sessions store is at ~/.sessions (envelopes under hosts/<host>/<month>/<uuid>/session.json); a SQLite cache with per-session aggregates may exist in the VS Code global storage. Recent transcripts are also under ~/.claude/projects and ~/.grok/sessions.",
  "Typical requests: identify all ideas for today; find and connect sessions to ideas (kp link-session); review sessions and identify which ideas are missing; create ideas from a list, checking for existing duplicates first (kp search before kp create).",
  "Rules: never run `git commit` or `git push`; never delete files; before creating an object, search for duplicates and say when you found one instead of creating it.",
  "You can drive the Planning board UI by printing a directive on its own line: @@board {\"search\":\"stale\"} filters the board; @@board {\"lane\":\"idea\"} switches the card type (task|idea|plan|thought); @@board {\"view\":\"inbox\"} switches the view (board|inbox|projects|sessions|calendar|graph|autonomous); @@board {\"item\":\"tasks/some-id\"} opens one item. Combine keys in one JSON object. The directive is hidden from the user — also SAY what you did to the board.",
  "Your reply renders as markdown (headings, **bold**, `code`, lists).",
  "Keep answers short: what you found, what you changed (with kp ids), what you skipped and why. The dashboard reloads automatically after your turn."
].join("\n");

/** argv for one headless turn. Exported for tests. */
/** Default enforced tool boundary: the plan is modified through kp only. */
export const CHAT_ALLOWED_TOOLS = "Bash(kp:*),Read,Grep,Glob,LS";

/** Deny beats allow in Claude Code's permission system — these hold even when
 * broad user/project settings would otherwise allow Bash. Not applied in
 * fullAccess mode (skip-permissions bypasses the permission system). */
export const CHAT_DENIED_TOOLS = "Bash(git commit:*),Bash(git push:*),Bash(rm:*),Bash(sudo:*)";

export function chatArgv(opts: {
  prompt: string;
  model: string;
  resumeId?: string;
  systemPrompt?: string;
  maxTurns?: number;
  effort?: string;
  /** Absolute kp shim path — adds a path-scoped allow rule. */
  kpPath?: string;
  /** Opt-in (codeSessions.planning.chat.fullAccess): skip the permission
   * system entirely. Default is a kp-only Bash allowlist — an enforced
   * boundary, not a system-prompt suggestion (review finding #3). */
  fullAccess?: boolean;
}): string[] {
  const args = ["-p", opts.prompt, "--output-format", "stream-json", "--verbose", "--max-turns", String(opts.maxTurns ?? 30)];
  if (opts.model && opts.model !== "default") args.push("--model", opts.model);
  // claude effort levels: low/medium/high/xhigh/max; `default` omits the flag
  // (same mapping as CB's backendRegistry).
  if (opts.effort && opts.effort !== "default") args.push("--effort", opts.effort);
  if (opts.fullAccess) args.push("--dangerously-skip-permissions");
  else {
    const allowed = opts.kpPath ? `Bash(${opts.kpPath}:*),${CHAT_ALLOWED_TOOLS}` : CHAT_ALLOWED_TOOLS;
    args.push("--allowedTools", allowed, "--disallowedTools", CHAT_DENIED_TOOLS);
  }
  if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);
  if (opts.resumeId) args.push("--resume", opts.resumeId);
  return args;
}

/** Outcome of a finished child: null = clean. Pure for tests (finding #1). */
export function exitOutcome(
  code: number | null,
  sawResult: boolean,
  cancelled: boolean,
  errBuf: string
): string | null {
  if (cancelled) return null;
  if (sawResult || code === 0) return null;
  return `agent exited with code ${code}: ${errBuf.trim().slice(0, 300)}`;
}

/** Fold one claude stream-json line into chat events. Exported for tests. */
export function foldStreamLine(
  line: string
): { events: ChatEvent[]; sessionId?: string } {
  let rec: any;
  try {
    rec = JSON.parse(line);
  } catch {
    return { events: [] };
  }
  if (!rec || typeof rec !== "object") return { events: [] };
  if (rec.type === "system" && rec.subtype === "init") {
    return { events: [], sessionId: typeof rec.session_id === "string" ? rec.session_id : undefined };
  }
  if (rec.type === "assistant" && rec.message && Array.isArray(rec.message.content)) {
    const events: ChatEvent[] = [];
    for (const block of rec.message.content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        events.push({ kind: "text", text: block.text });
      } else if (block?.type === "tool_use" && typeof block.name === "string") {
        let detail = "";
        const input = block.input ?? {};
        if (typeof input.command === "string") detail = input.command;
        else if (typeof input.file_path === "string") detail = input.file_path;
        else if (typeof input.query === "string") detail = input.query;
        events.push({ kind: "tool", name: block.name, detail: detail.slice(0, 160) });
      }
    }
    return { events };
  }
  if (rec.type === "result") {
    const text = typeof rec.result === "string" ? rec.result : rec.subtype === "success" ? "" : String(rec.subtype ?? "done");
    return {
      events: [
        {
          kind: "result",
          text,
          costUsd: typeof rec.total_cost_usd === "number" ? rec.total_cost_usd : undefined,
          isError: rec.is_error === true || rec.subtype !== "success"
        }
      ],
      sessionId: typeof rec.session_id === "string" ? rec.session_id : undefined
    };
  }
  return { events: [] };
}

/** argv for one headless Grok Build turn (`grok -p`, streaming-json). */
export function grokChatArgv(opts: {
  prompt: string;
  model: string;
  effort?: string;
  resumeId?: string;
  systemPrompt?: string;
  maxTurns?: number;
  kpPath?: string;
  fullAccess?: boolean;
}): string[] {
  const args = ["-p", opts.prompt, "--output-format", "streaming-json", "--max-turns", String(opts.maxTurns ?? 30)];
  if (opts.model && opts.model !== "default") args.push("-m", opts.model);
  // grok rejects `max`; its ceiling is xhigh (same mapping CB uses).
  if (opts.effort && opts.effort !== "default") args.push("--reasoning-effort", opts.effort === "max" ? "xhigh" : opts.effort);
  if (opts.resumeId) args.push("--resume", opts.resumeId);
  if (opts.fullAccess) args.push("--always-approve");
  else {
    const allowed = (opts.kpPath ? [`Bash(${opts.kpPath}:*)`] : []).concat(CHAT_ALLOWED_TOOLS.split(","));
    for (const r of allowed) args.push("--allow", r);
    for (const r of CHAT_DENIED_TOOLS.split(",")) args.push("--deny", r);
  }
  if (opts.systemPrompt) args.push("--rules", opts.systemPrompt);
  return args;
}

/** Fold one grok streaming-json line (text/thought/tool/end shapes). */
export function foldGrokStreamLine(line: string): { events: ChatEvent[]; sessionId?: string; done?: boolean } {
  let rec: any;
  try {
    rec = JSON.parse(line);
  } catch {
    return { events: [] };
  }
  if (!rec || typeof rec !== "object") return { events: [] };
  if (rec.type === "text" && typeof rec.data === "string" && rec.data.trim()) {
    return { events: [{ kind: "text", text: rec.data }] };
  }
  if ((rec.type === "tool_call" || rec.type === "tool") && rec.data) {
    const name = String(rec.data.name ?? rec.data.tool ?? rec.type);
    const detail = typeof rec.data.command === "string" ? rec.data.command : typeof rec.data.args === "string" ? rec.data.args : "";
    return { events: [{ kind: "tool", name, detail: detail.slice(0, 160) }] };
  }
  if (rec.type === "end") {
    return {
      events: [{ kind: "result", text: "", isError: rec.stopReason === "error" }],
      sessionId: typeof rec.sessionId === "string" ? rec.sessionId : undefined,
      done: true
    };
  }
  return { events: [] };
}

export interface PlanningChatDeps {
  /** Working directory for the agent — the docs/KB repo root. */
  cwd: string;
  /** Extra env (PATH with homebrew bins, KP_ROOT) — reuse kpInvocation(). */
  env: Record<string, string>;
  model: () => string;
  fullAccess?: () => boolean;
  /** Absolute path of the kp shim written by planning.ts. */
  kpPath?: string;
  bin?: string;
  log?: (line: string) => void;
  /** Called after a turn finishes so the board can reload the snapshot. */
  onTurnDone?: () => void;
  timeoutMs?: number;
}

export class PlanningChat {
  private readonly emitter = new vscode.EventEmitter<ChatEvent>();
  readonly onEvent = this.emitter.event;
  private readonly transcript: ChatEvent[] = [];
  private child: ChildProcess | undefined;
  private readonly resumeIds: Partial<Record<ChatRuntime["provider"], string>> = {};
  private readonly primed: Partial<Record<ChatRuntime["provider"], boolean>> = {};
  private lastProvider: ChatRuntime["provider"] | undefined;
  private cancelled = false;
  private seq = 0;
  private dir = new DirectiveFilter();

  constructor(private readonly deps: PlanningChatDeps) {}

  history(): ChatEvent[] {
    return [...this.transcript];
  }

  get busy(): boolean {
    return this.child !== undefined;
  }

  private emit(ev: ChatEvent): void {
    let out: SeqChatEvent = ev;
    // Board commands are live-only — replaying history must not yank the UI.
    if (ev.kind !== "busy" && ev.kind !== "status" && ev.kind !== "board") {
      out = { ...ev, seq: ++this.seq };
      this.transcript.push(out);
      if (this.transcript.length > 400) this.transcript.splice(0, this.transcript.length - 400);
    }
    this.emitter.fire(out);
  }

  private emitTextThroughFilter(delta: string): void {
    const { text, cmds } = this.dir.push(delta);
    for (const cmd of cmds) this.emit({ kind: "board", cmd });
    if (text) this.emit({ kind: "text", text, append: true });
  }

  send(text: string, runtime?: Partial<ChatRuntime>): void {
    const prompt = text.trim();
    if (!prompt) return;
    if (this.child) {
      this.emit({ kind: "error", message: "A turn is still running — Stop it first or wait." });
      return;
    }
    const rt: ChatRuntime = {
      ...DEFAULT_RUNTIME,
      model: this.deps.model(),
      ...(runtime ?? {})
    };
    if (!CHAT_PROVIDERS[rt.provider]) rt.provider = "claude";
    // Full access must be unlocked in settings — the webview cannot grant it.
    let fullAccess = rt.access === "full";
    if (fullAccess && this.deps.fullAccess?.() !== true) {
      fullAccess = false;
      this.emit({
        kind: "error",
        message: "Full access is locked — enable codeSessions.planning.chat.fullAccess in settings first. Running with the kp-only boundary."
      });
    }
    if (this.lastProvider && this.lastProvider !== rt.provider) {
      this.emit({ kind: "status", text: `switched to ${CHAT_PROVIDERS[rt.provider].label} — context is per-provider` });
    }
    this.lastProvider = rt.provider;
    const resumeId = this.resumeIds[rt.provider];
    this.emit({ kind: "user", text: prompt });
    this.emit({ kind: "busy", busy: true });
    this.emit({ kind: "status", text: resumeId ? "thinking…" : `starting ${CHAT_PROVIDERS[rt.provider].label} agent…` });
    globalJobTracker()?.start("planning-chat", `planning chat (${rt.provider}${rt.model !== "default" ? " " + rt.model : ""})`);

    this.cancelled = false;
    this.dir = new DirectiveFilter();
    const systemPrompt = this.primed[rt.provider] ? undefined : buildChatSystemPrompt(this.deps.kpPath);
    const args =
      rt.provider === "grok"
        ? grokChatArgv({ prompt, model: rt.model, effort: rt.effort, resumeId, systemPrompt, kpPath: this.deps.kpPath, fullAccess })
        : chatArgv({ prompt, model: rt.model, effort: rt.effort, resumeId, systemPrompt, fullAccess, kpPath: this.deps.kpPath });
    const bin = rt.provider === "grok" ? "grok" : (this.deps.bin ?? "claude");
    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        cwd: this.deps.cwd,
        env: this.deps.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (e) {
      this.finishTurn({ error: e instanceof Error ? e.message : String(e) });
      return;
    }
    this.child = child;
    this.primed[rt.provider] = true;
    const killTimer = setTimeout(() => {
      this.deps.log?.("[planning-chat] turn timeout — killing agent");
      child.kill("SIGKILL");
    }, this.deps.timeoutMs ?? 10 * 60_000);

    let buf = "";
    let sawResult = false;
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const { events, sessionId } = rt.provider === "grok" ? foldGrokStreamLine(line) : foldStreamLine(line);
        if (sessionId) this.resumeIds[rt.provider] = sessionId;
        for (const ev of events) {
          if (ev.kind === "text") {
            this.emitTextThroughFilter(ev.text);
            continue;
          }
          if (ev.kind === "result") {
            sawResult = true;
            const flushed = this.dir.flush();
            for (const cmd of flushed.cmds) this.emit({ kind: "board", cmd });
            if (flushed.text) this.emit({ kind: "text", text: flushed.text, append: true });
          }
          this.emit(ev);
        }
      }
    });
    let errBuf = "";
    child.stderr?.on("data", (d: Buffer) => {
      errBuf += d.toString("utf8");
      if (errBuf.length > 4000) errBuf = errBuf.slice(-4000);
    });
    child.on("error", (e) => {
      clearTimeout(killTimer);
      this.finishTurn({ error: `failed to spawn ${bin}: ${e.message}` });
    });
    child.on("exit", (code) => {
      clearTimeout(killTimer);
      const error = exitOutcome(code, sawResult, this.cancelled, errBuf);
      this.finishTurn(error ? { error } : {});
    });
  }

  cancel(): void {
    if (!this.child) return;
    this.cancelled = true;
    this.child.kill("SIGKILL");
    this.emit({ kind: "status", text: "stopped" });
  }

  private finishTurn(outcome: { error?: string }): void {
    this.child = undefined;
    const flushed = this.dir.flush();
    for (const cmd of flushed.cmds) this.emit({ kind: "board", cmd });
    if (flushed.text) this.emit({ kind: "text", text: flushed.text, append: true });
    if (outcome.error) this.emit({ kind: "error", message: outcome.error });
    globalJobTracker()?.finish("planning-chat", outcome.error ? { error: outcome.error } : { detail: "turn done" });
    this.emit({ kind: "busy", busy: false });
    try {
      this.deps.onTurnDone?.();
    } catch {
      /* reload failures surface elsewhere */
    }
  }

  dispose(): void {
    this.cancel();
    this.emitter.dispose();
  }
}
