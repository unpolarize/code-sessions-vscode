import { describe, expect, it } from "vitest";
import { compareVersions, newerWriterActive } from "../../src/writerGuard";

describe("writer guard", () => {
  it("compares dotted versions numerically", () => {
    expect(compareVersions("1.49.5", "1.49.10")).toBe(-1);
    expect(compareVersions("1.50.0", "1.49.10")).toBe(1);
    expect(compareVersions("1.49.5", "1.49.5")).toBe(0);
  });

  it("an older build yields to a newer writer seen recently", () => {
    const now = 1_000_000;
    const rows = [
      { name: "writer:1.49.3", applied_at: now - 1_000 },
      { name: "writer:1.49.5", applied_at: now - 30_000 },
      { name: "import_from_claude_sessions_v1", applied_at: 1 },
    ];
    expect(newerWriterActive("1.49.3", rows, now)).toBe("1.49.5");
    // The newest build never yields.
    expect(newerWriterActive("1.49.5", rows, now)).toBeNull();
    expect(newerWriterActive("1.49.6", rows, now)).toBeNull();
  });

  it("ignores stale stamps outside the window", () => {
    const now = 1_000_000;
    const rows = [{ name: "writer:1.49.5", applied_at: now - 11 * 60_000 }];
    expect(newerWriterActive("1.49.3", rows, now)).toBeNull();
  });
});
