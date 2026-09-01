/**
 * Child-process grok parser (spec R1: heavy lifting off the ext-host thread).
 * Forked by extension.ts with IPC. Parent sends { kind: "parse", files } once;
 * this worker emits one { kind: "item" } per file and a final { kind: "done" }.
 * It imports only the pure parse path (type-only db import — no wasm load).
 */
import { buildGrokRows, type GrokSessionInfo } from "./grokIndexer";

export interface WorkerRequest {
  kind: "parse";
  files: GrokSessionInfo[];
}

export type WorkerEvent =
  | { kind: "item"; chatPath: string; rows: ReturnType<typeof buildGrokRows>; error?: string }
  | { kind: "done"; parsed: number; errors: number };

function handle(msg: WorkerRequest, send: (ev: WorkerEvent) => void): void {
  if (!msg || msg.kind !== "parse") return;
  let parsed = 0;
  let errors = 0;
  for (const info of msg.files) {
    try {
      const rows = buildGrokRows(info);
      send({ kind: "item", chatPath: info.chatPath, rows });
      parsed += 1;
    } catch (e: unknown) {
      errors += 1;
      send({ kind: "item", chatPath: info.chatPath, rows: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  send({ kind: "done", parsed, errors });
}

/* c8 ignore start — process wiring; the pure part is handle() above. */
if (process.send) {
  process.on("message", (msg: WorkerRequest) => {
    handle(msg, (ev) => process.send!(ev));
    if (msg && msg.kind === "parse") process.exit(0);
  });
}
/* c8 ignore stop */

export { handle as handleWorkerRequest };
