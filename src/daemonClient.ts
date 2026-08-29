import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_SOCK = join(homedir(), ".sessions", ".daemon", "daemon.sock");

export interface DaemonSessionRow {
  id: string;
  host: string;
  agent: string;
  cwd: string;
  title?: string;
  backend?: string;
  hasContent: boolean;
  startedAt?: string;
  turnCount: number;
  eventSeq: number;
}

let up = false;
let cached: DaemonSessionRow[] = [];

export function daemonIsUp(): boolean {
  return up;
}

export function cachedDaemonSessions(): DaemonSessionRow[] {
  return cached;
}

function rpcCall(method: string, params?: unknown, timeoutMs = 2500): Promise<unknown> {
  const socketPath = process.env.CODE_SESSIONS_SOCKET || DEFAULT_SOCK;
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = "";
    let settled = false;
    const done = (err: Error | null, result?: unknown) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      if (err) reject(err);
      else resolve(result);
    };
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => {
      sock.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
    });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const msg = JSON.parse(buf.slice(0, nl)) as { result?: unknown; error?: { message: string } };
        if (msg.error) done(new Error(msg.error.message));
        else done(null, msg.result);
      } catch (e) {
        done(e as Error);
      }
    });
    sock.on("timeout", () => done(new Error("daemon rpc timeout")));
    sock.on("error", (e) => done(e));
  });
}

export async function refreshDaemonSessions(): Promise<boolean> {
  try {
    const hello = (await rpcCall("hello")) as { protocol: number };
    if (!hello || typeof hello.protocol !== "number") {
      up = false;
      return false;
    }
    const listed = (await rpcCall("session.list", { limit: 400 })) as { sessions: DaemonSessionRow[] };
    cached = listed.sessions ?? [];
    up = true;
    return true;
  } catch {
    up = false;
    cached = [];
    return false;
  }
}
