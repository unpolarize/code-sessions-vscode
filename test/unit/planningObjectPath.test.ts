import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  objectCopyPathMessage,
  objectOpenMessage,
  resolveObjectMarkdown,
} from "../../src/planningObjectPath";

const STORE = "/opt/kp-store";

describe("resolveObjectMarkdown", () => {
  it("maps a KP id to {type}/{slug}.md under the configured store root", () => {
    expect(resolveObjectMarkdown({ storeRoot: STORE, id: "tasks/csv-foo-bar" })).toEqual({
      relpath: "tasks/csv-foo-bar.md",
      absPath: path.join(STORE, "tasks", "csv-foo-bar.md"),
    });
  });

  it("does not hardcode ~/docs — a custom store root wins", () => {
    const root = "/Users/dev/alt-planning";
    const got = resolveObjectMarkdown({ storeRoot: root, id: "ideas/night-build" });
    expect(got?.absPath).toBe(path.join(root, "ideas", "night-build.md"));
    expect(got?.absPath).not.toContain("docs/planning");
  });

  it("prefers a known relative path (snapshot path / kp show relpath)", () => {
    expect(
      resolveObjectMarkdown({
        storeRoot: STORE,
        id: "tasks/csv-foo",
        relpath: "tasks/csv-foo.md",
      }),
    ).toEqual({
      relpath: "tasks/csv-foo.md",
      absPath: path.join(STORE, "tasks", "csv-foo.md"),
    });
  });

  it("rewrites an absolute path that already lives under the store root", () => {
    expect(
      resolveObjectMarkdown({
        storeRoot: STORE,
        id: "plans/big",
        relpath: path.join(STORE, "plans", "big.md"),
      }),
    ).toEqual({
      relpath: "plans/big.md",
      absPath: path.join(STORE, "plans", "big.md"),
    });
  });

  it("ignores an absolute path outside the store and falls back to the id", () => {
    expect(
      resolveObjectMarkdown({
        storeRoot: STORE,
        id: "tasks/inside",
        relpath: "/etc/passwd",
      }),
    ).toEqual({
      relpath: "tasks/inside.md",
      absPath: path.join(STORE, "tasks", "inside.md"),
    });
  });

  it("rejects empty ids, missing store root, and .. segments", () => {
    expect(resolveObjectMarkdown({ storeRoot: "", id: "tasks/x" })).toBeNull();
    expect(resolveObjectMarkdown({ storeRoot: STORE, id: "" })).toBeNull();
    expect(resolveObjectMarkdown({ storeRoot: STORE, id: "tasks/../secrets" })).toBeNull();
    expect(resolveObjectMarkdown({ storeRoot: STORE, id: "ok", relpath: "../escape.md" })).toEqual({
      relpath: "ok.md",
      absPath: path.join(STORE, "ok.md"),
    });
  });

  it("does not double the .md suffix", () => {
    expect(resolveObjectMarkdown({ storeRoot: STORE, id: "thoughts/note.md" })?.relpath).toBe("thoughts/note.md");
  });
});

describe("open / copy message wiring", () => {
  it("openFile posts the object id for the host to resolve against storeRoot", () => {
    expect(objectOpenMessage("tasks/csv-foo")).toEqual({
      type: "action",
      action: "openFile",
      id: "tasks/csv-foo",
    });
  });

  it("copyPath posts the same id so the host copies the resolved abs path", () => {
    expect(objectCopyPathMessage("ideas/bar")).toEqual({
      type: "action",
      action: "copyPath",
      id: "ideas/bar",
    });
  });
});
