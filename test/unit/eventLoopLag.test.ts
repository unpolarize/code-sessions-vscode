import { describe, expect, it } from "vitest";
import { formatLagLine } from "../../src/eventLoopLag";

describe("event-loop lag log line", () => {
  it("tags STALL when p99 is above 200 ms", () => {
    expect(formatLagLine(12.34, 201)).toBe("[lag] p50=12.3ms p99=201.0ms STALL");
  });

  it("omits STALL when p99 is within budget", () => {
    expect(formatLagLine(4, 40)).toBe("[lag] p50=4.0ms p99=40.0ms");
  });
});
