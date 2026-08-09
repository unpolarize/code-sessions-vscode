// Serialized async runner for the knowledge-planning `kp` CLI.
//
// Every CLI invocation goes through one promise-chain queue so mutations never
// interleave (the KP store is plain markdown — two concurrent `kp edit`s could
// race), and the extension host never blocks: this replaces the old spawnSync
// path in planning.ts. Deliberately vscode-free so unit tests can drive it with
// a stubbed execFile.

import { execFile, type ChildProcess } from "node:child_process";

export interface KpResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Resolved per run (settings can change between calls). */
export interface KpInvocation {
  node: string;
  cli: string;
  env: Record<string, string>;
}

export interface KpClientOptions {
  resolve: () => KpInvocation;
  /** kill a hung child after this long; the queue moves on (default 60s) */
  timeoutMs?: number;
  log?: (line: string) => void;
  /** test seam */
  execFileImpl?: typeof execFile;
}

const MAX_BUFFER = 32 * 1024 * 1024;

export class KpClient {
  private queue: Promise<unknown> = Promise.resolve();
  private depth = 0;
  private disposed = false;
  private current: ChildProcess | undefined;

  constructor(private opts: KpClientOptions) {}

  get queueDepth(): number {
    return this.depth;
  }

  /** Enqueue one CLI call. `input` is piped to stdin (kp edit --body -). */
  run(args: string[], input?: string): Promise<KpResult> {
    if (this.disposed) return Promise.resolve({ ok: false, stdout: "", stderr: "kp client disposed" });
    this.depth++;
    if (this.depth > 1) this.opts.log?.(`[planning] kp queue depth=${this.depth} (${args[0]})`);
    const job = this.queue.then(() => (this.disposed ? { ok: false, stdout: "", stderr: "kp client disposed" } : this.exec(args, input)));
    // the chain must survive a failed job; errors surface via the KpResult
    this.queue = job.catch(() => {}).then(() => {
      this.depth--;
    });
    return job;
  }

  private exec(args: string[], input?: string): Promise<KpResult> {
    return new Promise<KpResult>((resolve) => {
      let inv: KpInvocation;
      try {
        inv = this.opts.resolve();
      } catch (e) {
        resolve({ ok: false, stdout: "", stderr: `kp resolve failed: ${(e as Error).message}` });
        return;
      }
      const ef = this.opts.execFileImpl ?? execFile;
      const child = ef(
        inv.node,
        [inv.cli, ...args],
        { encoding: "utf8", env: inv.env, maxBuffer: MAX_BUFFER, timeout: this.opts.timeoutMs ?? 60_000, killSignal: "SIGKILL" },
        (err, stdout, stderr) => {
          if (this.current === child) this.current = undefined;
          resolve({
            ok: !err,
            stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
            stderr: (typeof stderr === "string" ? stderr : String(stderr ?? "")) || (err ? err.message : ""),
          });
        },
      );
      this.current = child;
      if (input !== undefined && child.stdin) {
        // execFile has no spawnSync-style `input`: write + end explicitly, and
        // swallow EPIPE if the child exits before reading (error still lands
        // via the callback above).
        child.stdin.on("error", () => {});
        child.stdin.end(input, "utf8");
      } else {
        child.stdin?.end();
      }
    });
  }

  /** Kill any in-flight child and refuse new work (deactivate / reload window). */
  dispose(): void {
    this.disposed = true;
    try {
      this.current?.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    this.current = undefined;
  }
}
