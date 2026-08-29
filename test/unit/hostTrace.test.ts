import { describe, expect, it, beforeEach } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Span,
  formatTraceHuman,
  initTrace,
  recentTraces,
  resetTraceForTests,
  startFileSink,
  getHostTask,
} from "../../src/hostTrace";

describe("hostTrace", () => {
  beforeEach(() => {
    resetTraceForTests();
    initTrace("csv", "1.46.0");
  });

  it("records mark deltas and tags SLOW when over budget", () => {
    let t = 1_000;
    const s = new Span("csv.activate", "abcd", () => t);
    t = 1_400;
    s.mark("store.open");
    t = 3_200;
    const total = s.end();
    expect(total).toBe(2200);
    const done = recentTraces().at(-1);
    expect(done?.t).toBe("end");
    expect(done?.slow).toBe(true);
    expect(formatTraceHuman(done!)).toMatch(/DONE csv.activate 2200ms SLOW/);
    expect(formatTraceHuman(done!)).toMatch(/store.open:400/);
  });

  it("tracks last-started task for lag STALL lines", () => {
    const s = new Span("csv.index", "x", () => 0);
    expect(getHostTask()).toBe("csv.index");
    s.mark("claude");
    expect(getHostTask()).toBe("csv.index.claude");
    s.end();
    expect(getHostTask()).toBe("");
  });

  it("appends JSON to the file sink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "csv-trace-"));
    const path = join(dir, "host-trace.ndjson");
    const stop = startFileSink(path, 1024);
    const s = new Span("csv.activate", "zz", () => 5);
    s.end();
    await new Promise((r) => setTimeout(r, 40));
    const raw = await readFile(path, "utf8");
    expect(raw).toMatch(/"name":"csv.activate"/);
    stop();
  });
});
