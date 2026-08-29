// Unit fixtures for the untested-write surface (pure module, no webview).
// Covers the acceptance list on the KP item: paired clear; unpaired listed;
// unrelated test touch does not clear; docs excluded; Codex V4A multi-file;
// Go testdata; lone foo_test.go; Rust caveat; Grok target_file read; missing
// transcript → unavailable.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  computeFromTouches,
  computeWriteSurface,
  extractClaudeTouches,
  extractCodexTouches,
  extractGrokTouches,
  isExcludedWrite,
  isTestPath,
  pairsWith,
  writePathsFromV4A,
} from "../../src/writeSurface";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "write-surface-"));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeJsonl(name: string, lines: unknown[]): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

const claudeUser = { type: "user", timestamp: "2026-08-27T01:00:00Z", message: { content: "do it" } };
function claudeAssistant(toolUses: { name: string; input: any }[]) {
  return {
    type: "assistant",
    timestamp: "2026-08-27T01:00:05Z",
    message: {
      content: toolUses.map((t, i) => ({ type: "tool_use", id: `t${i}`, name: t.name, input: t.input })),
    },
  };
}

describe("isTestPath", () => {
  it("recognizes JS/TS test patterns and __tests__", () => {
    expect(isTestPath("/p/src/foo.test.ts")).toBe(true);
    expect(isTestPath("/p/src/foo.spec.tsx")).toBe(true);
    expect(isTestPath("/p/src/__tests__/foo.ts")).toBe(true);
    expect(isTestPath("/p/src/foo.ts")).toBe(false);
  });
  it("never matches on bare 'test' substrings", () => {
    expect(isTestPath("/p/src/contest.ts")).toBe(false);
    expect(isTestPath("/p/src/testimonial.tsx")).toBe(false);
  });
  it("python: prefix/suffix/conftest/tests dir", () => {
    expect(isTestPath("/p/tests/test_foo.py")).toBe(true);
    expect(isTestPath("/p/pkg/foo_test.py")).toBe(true);
    expect(isTestPath("/p/tests/conftest.py")).toBe(true);
    expect(isTestPath("/p/pkg/foo.py")).toBe(false);
  });
  it("go: only *_test.go; testdata is fixtures, not tests", () => {
    expect(isTestPath("/p/pkg/foo_test.go")).toBe(true);
    expect(isTestPath("/p/pkg/testdata/foo_test.go")).toBe(false);
    expect(isTestPath("/p/pkg/testdata/input.go")).toBe(false);
  });
  it("rust: tests/ dir only", () => {
    expect(isTestPath("/crate/tests/foo.rs")).toBe(true);
    expect(isTestPath("/crate/src/foo.rs")).toBe(false);
  });
});

describe("isExcludedWrite", () => {
  it("excludes docs, config, lockfiles, generated, fixtures", () => {
    expect(isExcludedWrite("/p/README.md")).toBe(true);
    expect(isExcludedWrite("/p/docs/guide.html")).toBe(true);
    expect(isExcludedWrite("/p/package.json")).toBe(true);
    expect(isExcludedWrite("/p/tsconfig.build.json")).toBe(true);
    expect(isExcludedWrite("/p/Cargo.toml")).toBe(true);
    expect(isExcludedWrite("/p/yarn.lock")).toBe(true);
    expect(isExcludedWrite("/p/dist/index.js")).toBe(true);
    expect(isExcludedWrite("/p/api.generated.ts")).toBe(true);
    expect(isExcludedWrite("/p/types.d.ts")).toBe(true);
    expect(isExcludedWrite("/p/pkg/testdata/input.go")).toBe(true);
    expect(isExcludedWrite("/p/__snapshots__/foo.snap")).toBe(true);
  });
  it("keeps ordinary production files", () => {
    expect(isExcludedWrite("/p/src/foo.ts")).toBe(false);
    expect(isExcludedWrite("/p/pkg/foo.go")).toBe(false);
  });
});

describe("pairsWith", () => {
  it("stem match across test affixes", () => {
    expect(pairsWith("/p/src/foo.ts", "/p/src/foo.test.ts")).toBe(true);
    expect(pairsWith("/p/src/foo.ts", "/p/src/__tests__/foo.spec.ts")).toBe(true);
    expect(pairsWith("/p/src/pkg/foo.py", "/p/tests/pkg/test_foo.py")).toBe(true);
    expect(pairsWith("/p/pkg/foo.go", "/p/pkg/foo_test.go")).toBe(true);
  });
  it("unrelated test file does not pair", () => {
    expect(pairsWith("/p/src/foo.ts", "/p/src/bar.test.ts")).toBe(false);
  });
  it("same-stem test in a different monorepo package does not pair", () => {
    expect(pairsWith("/repo/apps/web/src/foo.ts", "/repo/apps/api/tests/foo.test.ts")).toBe(false);
    expect(pairsWith("/repo/apps/web/src/foo.ts", "/repo/apps/web/tests/foo.test.ts")).toBe(true);
  });
  it("non-test touch never pairs", () => {
    expect(pairsWith("/p/src/foo.ts", "/p/src/foo.ts")).toBe(false);
  });
});

describe("computeFromTouches", () => {
  it("(a) write + companion test read → not listed", () => {
    const s = computeFromTouches({ writes: ["/p/src/foo.ts"], reads: ["/p/src/foo.test.ts"] });
    expect(s.untestedWrites).toEqual([]);
    expect(s.writes).toEqual(["/p/src/foo.ts"]);
    expect(s.status).toBe("ok");
  });
  it("(b) write only → listed", () => {
    const s = computeFromTouches({ writes: ["/p/src/foo.ts"], reads: [] });
    expect(s.untestedWrites).toEqual([{ path: "/p/src/foo.ts", note: null }]);
  });
  it("(c) unrelated bar.test.ts does not clear foo.ts", () => {
    const s = computeFromTouches({
      writes: ["/p/src/foo.ts", "/p/src/bar.test.ts"],
      reads: [],
    });
    expect(s.untestedWrites.map((u) => u.path)).toEqual(["/p/src/foo.ts"]);
  });
  it("(d) README/docs writes excluded", () => {
    const s = computeFromTouches({ writes: ["/p/README.md", "/p/docs/x.html"], reads: [] });
    expect(s.writes).toEqual([]);
    expect(s.untestedWrites).toEqual([]);
  });
  it("(f) lone foo_test.go write is a companion, never listed", () => {
    const s = computeFromTouches({ writes: ["/p/pkg/foo_test.go"], reads: [] });
    expect(s.writes).toEqual([]);
    expect(s.untestedWrites).toEqual([]);
  });
  it("go testdata/ touch does not clear a write", () => {
    const s = computeFromTouches({
      writes: ["/p/pkg/foo.go"],
      reads: ["/p/pkg/testdata/foo_test.go"],
    });
    expect(s.untestedWrites.map((u) => u.path)).toEqual(["/p/pkg/foo.go"]);
  });
  it("(g) .rs write without tests/ → listed with Rust caveat note", () => {
    const s = computeFromTouches({ writes: ["/crate/src/foo.rs"], reads: [] });
    expect(s.untestedWrites).toHaveLength(1);
    expect(s.untestedWrites[0].note).toMatch(/cfg\(test\)/);
  });
  it("unknown language tagged 'no test heuristic'", () => {
    const s = computeFromTouches({ writes: ["/p/src/main.java"], reads: [] });
    expect(s.untestedWrites[0].note).toMatch(/no test-path heuristic/);
  });
});

describe("extractClaudeTouches", () => {
  it("Write/Edit → writes, Read → reads; subagent/MultiEdit caveats", () => {
    const p = writeJsonl("claude.jsonl", [
      claudeUser,
      claudeAssistant([
        { name: "Write", input: { file_path: "/p/src/foo.ts", content: "x" } },
        { name: "Edit", input: { file_path: "/p/src/bar.ts", old_string: "a", new_string: "b" } },
        { name: "Read", input: { file_path: "/p/src/foo.test.ts" } },
        { name: "Task", input: { subagent_type: "claude", description: "d", prompt: "p" } },
        { name: "MultiEdit", input: { file_path: "/p/src/baz.ts", edits: [] } },
      ]),
    ]);
    const { touches, caveats } = extractClaudeTouches(p);
    expect(touches.writes).toEqual(["/p/src/foo.ts", "/p/src/bar.ts"]);
    expect(touches.reads).toEqual(["/p/src/foo.test.ts"]);
    expect(caveats.join(" ")).toMatch(/subagent/);
    expect(caveats.join(" ")).toMatch(/MultiEdit/);
  });
});

describe("extractGrokTouches", () => {
  it("(i) write/search_replace → writes; read_file.target_file clears the write", () => {
    const p = writeJsonl("grok.jsonl", [
      { type: "user", content: "go" },
      {
        type: "assistant",
        content: [{ type: "text", text: "ok" }],
        tool_calls: [
          { name: "write", arguments: JSON.stringify({ filePath: "/p/src/foo.ts", content: "x" }) },
          { name: "read_file", arguments: JSON.stringify({ target_file: "/p/src/foo.test.ts" }) },
        ],
      },
    ]);
    const { touches } = extractGrokTouches(p);
    expect(touches.writes).toEqual(["/p/src/foo.ts"]);
    expect(touches.reads).toEqual(["/p/src/foo.test.ts"]);
    const s = computeFromTouches(touches);
    expect(s.untestedWrites).toEqual([]);
  });
  it("spawn_subagent surfaces a caveat → status partial end-to-end", () => {
    const p = writeJsonl("grok-subagent.jsonl", [
      { type: "user", content: "go" },
      {
        type: "assistant",
        content: [],
        tool_calls: [{ name: "spawn_subagent", arguments: JSON.stringify({ prompt: "x" }) }],
      },
    ]);
    const { caveats } = extractGrokTouches(p);
    expect(caveats.join(" ")).toMatch(/spawn_subagent/);
    expect(computeWriteSurface({ source: "grok", jsonl_path: p }).status).toBe("partial");
  });
  it("read_file legacy file_path key also accepted", () => {
    const p = writeJsonl("grok-legacy.jsonl", [
      { type: "user", content: "go" },
      {
        type: "assistant",
        content: [],
        tool_calls: [
          { name: "read_file", arguments: JSON.stringify({ file_path: "/p/src/a.ts" }) },
          { name: "search_replace", arguments: JSON.stringify({ file_path: "/p/src/a.ts", old_str: "x", new_str: "y" }) },
        ],
      },
    ]);
    const { touches } = extractGrokTouches(p);
    expect(touches.reads).toEqual(["/p/src/a.ts"]);
    expect(touches.writes).toEqual(["/p/src/a.ts"]);
  });
});

describe("codex V4A + rollout extraction", () => {
  it("(e) V4A multi-file: Add + Update both extracted; Delete ignored; Move-to is the write", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const a = 1;",
      "*** Update File: src/old.ts",
      "*** Move to: src/renamed.ts",
      "@@",
      "-a",
      "+b",
      "*** Delete File: src/gone.ts",
      "*** Update File: src/plain.ts",
      "@@",
      "*** End Patch",
    ].join("\n");
    expect(writePathsFromV4A(patch)).toEqual(["src/new.ts", "src/renamed.ts", "src/plain.ts"]);
  });
  it("rollout function_call arguments: V4A and structured operation.path", () => {
    const patch = "*** Begin Patch\n*** Add File: src/a.ts\n+x\n*** End Patch";
    const p = writeJsonl("rollout.jsonl", [
      { timestamp: "t", type: "session_meta", payload: { id: "s1" } },
      {
        timestamp: "t",
        type: "response_item",
        payload: { type: "function_call", name: "apply_patch", arguments: JSON.stringify({ input: patch }) },
      },
      {
        timestamp: "t",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "apply_patch",
          arguments: JSON.stringify({ operation: { type: "update_file", path: "src/b.ts" } }),
        },
      },
      {
        timestamp: "t",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "apply_patch",
          arguments: JSON.stringify({ operation: { type: "delete_file", path: "src/c.ts" } }),
        },
      },
      {
        timestamp: "t",
        type: "response_item",
        payload: {
          type: "local_shell_call",
          arguments: JSON.stringify({ command: ["apply_patch", "*** Begin Patch\n*** Update File: src/d.ts\n@@\n*** End Patch"] }),
        },
      },
    ]);
    const { touches, caveats } = extractCodexTouches(p);
    expect(touches.writes).toEqual(["src/a.ts", "src/b.ts", "src/d.ts"]);
    expect(caveats.join(" ")).toMatch(/shell writes/);
  });
});

describe("computeWriteSurface routing", () => {
  it("(j) missing transcript → unavailable, never fake all-paired", () => {
    const s = computeWriteSurface({ source: "claude", jsonl_path: path.join(tmp, "nope.jsonl") });
    expect(s.status).toBe("unavailable");
    expect(s.caveats.length).toBeGreaterThan(0);
    expect(s.untestedWrites).toEqual([]);
  });
  it("null path → unavailable", () => {
    expect(computeWriteSurface({ source: "claude", jsonl_path: null }).status).toBe("unavailable");
  });
  it("null/missing source → unavailable (never misrouted to a parser)", () => {
    const p = writeJsonl("no-source.jsonl", [claudeUser]);
    expect(computeWriteSurface({ jsonl_path: p }).status).toBe("unavailable");
  });
  it("store-fallback source → unavailable", () => {
    const p = writeJsonl("git.jsonl", [claudeUser]);
    const s = computeWriteSurface({ source: "git", jsonl_path: p });
    expect(s.status).toBe("unavailable");
    expect(s.caveats.join(" ")).toMatch(/no tool arguments/);
  });
  it("claude end-to-end: unpaired write listed, status partial when caveats fire", () => {
    const p = writeJsonl("claude-e2e.jsonl", [
      claudeUser,
      claudeAssistant([
        { name: "Write", input: { file_path: "/p/src/foo.ts", content: "x" } },
        { name: "MultiEdit", input: { file_path: "/p/src/z.ts", edits: [] } },
      ]),
    ]);
    const s = computeWriteSurface({ source: "claude", jsonl_path: p });
    expect(s.untestedWrites.map((u) => u.path)).toEqual(["/p/src/foo.ts"]);
    expect(s.status).toBe("partial");
  });
  it("grok end-to-end ok status", () => {
    const p = writeJsonl("grok-e2e.jsonl", [
      { type: "user", content: "go" },
      {
        type: "assistant",
        content: [],
        tool_calls: [{ name: "write", arguments: JSON.stringify({ filePath: "/p/src/foo.ts" }) }],
      },
    ]);
    const s = computeWriteSurface({ source: "grok", jsonl_path: p });
    expect(s.status).toBe("ok");
    expect(s.untestedWrites.map((u) => u.path)).toEqual(["/p/src/foo.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Card renderer (pure HTML, no webview)

import {
  OPEN_ABSOLUTE_FILE_COMMAND,
  WRITE_SURFACE_CAP,
  WRITE_SURFACE_SUBTITLE,
  renderWriteSurfaceCardHtml,
  type WriteSurface,
} from "../../src/writeSurface";

function surfaceWith(partial: Partial<WriteSurface>): WriteSurface {
  return { writes: [], reads: [], untestedWrites: [], status: "ok", caveats: [], ...partial };
}

describe("renderWriteSurfaceCardHtml", () => {
  it("lists unpaired writes as command-URI links with the exact subtitle", () => {
    const html = renderWriteSurfaceCardHtml(
      surfaceWith({
        writes: ["/repo/src/foo.ts", "/repo/src/bar.ts"],
        untestedWrites: [
          { path: "/repo/src/foo.ts", note: null },
          { path: "/repo/src/bar.ts", note: null },
        ],
      }),
    );
    expect(html).toContain("Untested writes (2)");
    expect(html).toContain(WRITE_SURFACE_SUBTITLE);
    expect(WRITE_SURFACE_SUBTITLE).toBe("companion path touch only — not coverage");
    const href = `command:${OPEN_ABSOLUTE_FILE_COMMAND}?${encodeURIComponent(JSON.stringify(["/repo/src/foo.ts"]))}`;
    expect(html).toContain(`href="${href}"`);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("+0 more");
  });

  it("caps at 25 and shows the +K more overflow row", () => {
    const untestedWrites = Array.from({ length: 31 }, (_, i) => ({ path: `/repo/src/f${i}.ts`, note: null }));
    const html = renderWriteSurfaceCardHtml(surfaceWith({ writes: untestedWrites.map((w) => w.path), untestedWrites }));
    expect(html).toContain("Untested writes (31)");
    expect(html).toContain(`+${31 - WRITE_SURFACE_CAP} more`);
    expect(html).toContain("/repo/src/f24.ts");
    expect(html).not.toContain("/repo/src/f25.ts");
    const custom = renderWriteSurfaceCardHtml(surfaceWith({ untestedWrites }), { cap: 5 });
    expect(custom).toContain("+26 more");
    expect(custom).not.toContain("/repo/src/f5.ts");
  });

  it("renders the per-path honesty badge and session caveats", () => {
    const html = renderWriteSurfaceCardHtml(
      surfaceWith({
        status: "partial",
        writes: ["/repo/src/lib.rs"],
        untestedWrites: [{ path: "/repo/src/lib.rs", note: "Rust inline #[cfg(test)] not visible" }],
        caveats: ["Codex shell writes (touch, cat >, heredocs) are not detected"],
      }),
    );
    expect(html).toContain('class="ws-badge"');
    expect(html).toContain("Rust inline #[cfg(test)] not visible");
    expect(html).toContain("partial extraction");
    expect(html).toContain("Codex shell writes (touch, cat &gt;, heredocs) are not detected");
  });

  it("distinguishes no-writes, all-paired and unavailable empty states", () => {
    const none = renderWriteSurfaceCardHtml(surfaceWith({}));
    expect(none).toContain("Untested writes (0)");
    expect(none).toContain("No production writes detected");

    const paired = renderWriteSurfaceCardHtml(surfaceWith({ writes: ["/repo/src/foo.ts"], reads: ["/repo/src/foo.test.ts"] }));
    expect(paired).toContain("Untested writes (0)");
    expect(paired).toContain("No untested writes detected (heuristic) — 1 production write, each with a companion test-path touch.");

    const unavailable = renderWriteSurfaceCardHtml(
      surfaceWith({ status: "unavailable", caveats: ["transcript missing on this device — surface unavailable"] }),
    );
    expect(unavailable).toContain("surface unavailable");
    expect(unavailable).toContain("transcript missing on this device");
    expect(unavailable).not.toContain("Untested writes (0)");
    expect(unavailable).not.toContain("No untested writes");
    expect(unavailable).toContain(WRITE_SURFACE_SUBTITLE);
  });

  it("escapes HTML in paths and can render without command URIs", () => {
    const evil = '/repo/src/<img src=x onerror="alert(1)">.ts';
    const html = renderWriteSurfaceCardHtml(surfaceWith({ untestedWrites: [{ path: evil, note: null }] }), { commandUris: false });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;.ts");
    expect(html).not.toContain("command:");
    expect(html).toContain('<span class="ws-path"');
  });

  it("computeWriteSurface → card round-trip on the store-fallback input reads as unavailable", () => {
    const html = renderWriteSurfaceCardHtml(computeWriteSurface({ source: null, jsonl_path: null }));
    expect(html).toContain("surface unavailable");
    expect(html).toContain("session source unknown");
  });
});
