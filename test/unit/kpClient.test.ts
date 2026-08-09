// KpClient serialization, stdin piping, failure isolation, and disposal —
// driven end-to-end through real child processes (node -e), no vscode import.
import { describe, it, expect } from "vitest";
import { KpClient } from "../../src/kpClient";

/** A client whose "cli" is node's -e flag: each run()'s first arg is an inline script. */
function scriptClient(opts: { timeoutMs?: number; log?: (l: string) => void } = {}) {
  return new KpClient({
    resolve: () => ({ node: process.execPath, cli: "-e", env: { ...process.env } as Record<string, string> }),
    timeoutMs: opts.timeoutMs,
    log: opts.log,
  });
}

const ECHO_ARGS = `process.stdout.write(JSON.stringify(process.argv.slice(1)))`;

describe("KpClient", () => {
  it("runs a command and captures stdout", async () => {
    const c = scriptClient();
    const r = await c.run([ECHO_ARGS, "hello", "world"]);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.stdout)).toEqual(["hello", "world"]);
  });

  it("reports failure with stderr", async () => {
    const c = scriptClient();
    const r = await c.run([`console.error("boom"); process.exit(3)`]);
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("boom");
  });

  it("pipes stdin input (multiline, em-dash, emoji round-trip)", async () => {
    const c = scriptClient();
    const body = "line one\nline two — with em-dash\n🚀 emoji\n";
    const r = await c.run(
      [`let d="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>d+=x);process.stdin.on("end",()=>process.stdout.write(d))`],
      body,
    );
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe(body);
  });

  it("serializes concurrent jobs in submit order", async () => {
    const c = scriptClient();
    // each job appends its tag to a shared temp file; sleeps make overlap likely
    // if jobs ever ran concurrently
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const f = path.join(os.tmpdir(), `kpclient-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(f, "");
    const job = (tag: string) =>
      c.run([
        `const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(f)},"<"+${JSON.stringify(tag)});setTimeout(()=>{fs.appendFileSync(${JSON.stringify(f)},${JSON.stringify(tag)}+">")},30)`,
      ]);
    const results = await Promise.all([job("a"), job("b"), job("c"), job("d"), job("e")]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(fs.readFileSync(f, "utf8")).toBe("<aa><bb><cc><dd><ee>");
    fs.unlinkSync(f);
  });

  it("a failed job does not wedge the queue", async () => {
    const c = scriptClient();
    const bad = await c.run([`process.exit(1)`]);
    const good = await c.run([`process.stdout.write("still alive")`]);
    expect(bad.ok).toBe(false);
    expect(good.ok).toBe(true);
    expect(good.stdout).toBe("still alive");
  });

  it("kills a hung child on timeout and the queue moves on", async () => {
    const c = scriptClient({ timeoutMs: 200 });
    const hung = await c.run([`setInterval(()=>{},1000)`]);
    expect(hung.ok).toBe(false);
    const next = await c.run([`process.stdout.write("ok")`]);
    expect(next.ok).toBe(true);
  }, 10_000);

  it("refuses new work after dispose", async () => {
    const c = scriptClient();
    c.dispose();
    const r = await c.run([`process.stdout.write("nope")`]);
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("disposed");
  });

  it("surfaces resolve() failures as a KpResult", async () => {
    const c = new KpClient({
      resolve: () => {
        throw new Error("no node found");
      },
    });
    const r = await c.run(["export"]);
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("no node found");
  });
});
