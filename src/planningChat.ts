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
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail?: string }
  | { kind: "result"; text: string; costUsd?: number; isError?: boolean }
  | { kind: "error"; message: string }
  | { kind: "busy"; busy: boolean };

export type SeqChatEvent = ChatEvent & { seq?: number };

export const PLANNING_CHAT_SYSTEM_PROMPT = [
  "You are the planning assistant embedded in the Code Sessions Planning Dashboard.",
  "The knowledge base lives in this repository; planning objects (ideas, tasks, plans, projects, insights) are managed with the `kp` CLI — prefer it over editing planning/*.md directly.",
  "Useful commands: `kp export --date today`, `kp search <query>`, `kp show <id>`, `kp create <type> --title ... --body -`, `kp set-status <id> <status>`, `kp link-session <id> <session-uuid>`, `kp link <id> <other-id>`.",
  "Session history: the code-sessions store is at ~/.sessions (envelopes under hosts/<host>/<month>/<uuid>/session.json); a SQLite cache with per-session aggregates may exist in the VS Code global storage. Recent transcripts are also under ~/.claude/projects and ~/.grok/sessions.",
  "Typical requests: identify all ideas for today; find and connect sessions to ideas (kp link-session); review sessions and identify which ideas are missing; create ideas from a list, checking for existing duplicates first (kp search before kp create).",
  "Rules: never run `git commit` or `git push`; never delete files; before creating an object, search for duplicates and say when you found one instead of creating it.",
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
  /** Opt-in (codeSessions.planning.chat.fullAccess): skip the permission
   * system entirely. Default is a kp-only Bash allowlist — an enforced
   * boundary, not a system-prompt suggestion (review finding #3). */
  fullAccess?: boolean;
}): string[] {
  const args = [
    "-p",
    opts.prompt,
    "--model",
    opts.model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    String(opts.maxTurns ?? 30)
  ];
  if (opts.fullAccess) args.push("--dangerously-skip-permissions");
  else args.push("--allowedTools", CHAT_ALLOWED_TOOLS, "--disallowedTools", CHAT_DENIED_TOOLS);
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

export interface PlanningChatDeps {
  /** Working directory for the agent — the docs/KB repo root. */
  cwd: string;
  /** Extra env (PATH with homebrew bins, KP_ROOT) — reuse kpInvocation(). */
  env: Record<string, string>;
  model: () => string;
  fullAccess?: () => boolean;
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
  private resumeId: string | undefined;
  private firstTurn = true;
  private cancelled = false;
  private seq = 0;

  constructor(private readonly deps: PlanningChatDeps) {}

  history(): ChatEvent[] {
    return [...this.transcript];
  }

  get busy(): boolean {
    return this.child !== undefined;
  }

  private emit(ev: ChatEvent): void {
    let out: SeqChatEvent = ev;
    if (ev.kind !== "busy" && ev.kind !== "status") {
      out = { ...ev, seq: ++this.seq };
      this.transcript.push(out);
      if (this.transcript.length > 400) this.transcript.splice(0, this.transcript.length - 400);
    }
    this.emitter.fire(out);
  }

  send(text: string): void {
    const prompt = text.trim();
    if (!prompt) return;
    if (this.child) {
      this.emit({ kind: "error", message: "A turn is still running — Stop it first or wait." });
      return;
    }
    this.emit({ kind: "user", text: prompt });
    this.emit({ kind: "busy", busy: true });
    this.emit({ kind: "status", text: this.resumeId ? "thinking…" : "starting planning agent…" });
    globalJobTracker()?.start("planning-chat", "planning chat turn");

    this.cancelled = false;
    const args = chatArgv({
      prompt,
      model: this.deps.model(),
      resumeId: this.resumeId,
      systemPrompt: this.firstTurn ? PLANNING_CHAT_SYSTEM_PROMPT : undefined,
      fullAccess: this.deps.fullAccess?.() === true
    });
    const bin = this.deps.bin ?? "claude";
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
    this.firstTurn = false;
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
        const { events, sessionId } = foldStreamLine(line);
        if (sessionId) this.resumeId = sessionId;
        for (const ev of events) {
          if (ev.kind === "result") sawResult = true;
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
