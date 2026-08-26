// Boot the dashboard script in a minimal DOM and deliver a snapshot *while
// the script is still initializing* (VS Code flushes queued webview messages
// when addEventListener('message') is registered). That is the
// "Cannot access 'blockedSet' before initialization" race.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const src = readFileSync(resolve(__dirname, "../../media/planning-dashboard.js"), "utf8");

type El = {
  tagName: string;
  id: string;
  className: string;
  children: El[];
  parent: El | null;
  dataset: Record<string, string>;
  style: Record<string, string>;
  textContent: string;
  value: string;
  title: string;
  innerHTML: string;
  classList: { add: (...c: string[]) => void; remove: (...c: string[]) => void; toggle: (c: string, on?: boolean) => void; contains: (c: string) => boolean };
  appendChild: (c: El) => El;
  insertBefore: (c: El, ref: El | null) => El;
  addEventListener: (t: string, fn: (...a: unknown[]) => void) => void;
  querySelector: (sel: string) => El | null;
  querySelectorAll: (sel: string) => El[];
  closest: (sel: string) => El | null;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
};

function miniDom() {
  const byId = new Map<string, El>();
  const messageListeners: Array<(e: { data: unknown }) => void> = [];

  function matches(el: El, sel: string): boolean {
    const s = sel.trim();
    if (s.startsWith("#")) return el.id === s.slice(1);
    if (s.startsWith(".")) return el.className.split(/\s+/).includes(s.slice(1));
    return el.tagName === s.toUpperCase();
  }
  function walk(el: El, acc: El[] = []): El[] {
    acc.push(el);
    for (const c of el.children) walk(c, acc);
    return acc;
  }

  function create(tag: string): El {
    const el: El = {
      tagName: tag.toUpperCase(),
      id: "",
      className: "",
      children: [],
      parent: null,
      dataset: {},
      style: {},
      textContent: "",
      value: "",
      title: "",
      innerHTML: "",
      classList: {
        add: (...c: string[]) => {
          el.className = [...new Set((el.className || "").split(/\s+/).filter(Boolean).concat(c))].join(" ");
        },
        remove: (...c: string[]) => {
          el.className = (el.className || "").split(/\s+/).filter((x) => x && !c.includes(x)).join(" ");
        },
        toggle: (c: string, on?: boolean) => {
          const has = el.classList.contains(c);
          const should = on === undefined ? !has : on;
          if (should) el.classList.add(c);
          else el.classList.remove(c);
        },
        contains: (c: string) => (el.className || "").split(/\s+/).includes(c),
      },
      appendChild(c: El) {
        c.parent = el;
        el.children.push(c);
        if (c.id) byId.set(c.id, c);
        return c;
      },
      insertBefore(c: El, ref: El | null) {
        c.parent = el;
        const i = ref ? el.children.indexOf(ref) : -1;
        if (i >= 0) el.children.splice(i, 0, c);
        else el.children.push(c);
        if (c.id) byId.set(c.id, c);
        return c;
      },
      addEventListener() {},
      querySelector(sel: string) {
        return el.querySelectorAll(sel)[0] || null;
      },
      querySelectorAll(sel: string) {
        const parts = sel.trim().split(/\s+/);
        return walk(el).slice(1).filter((n) => {
          let node: El | null = n;
          for (let i = parts.length - 1; i >= 0; i--) {
            while (node && !matches(node, parts[i])) {
              if (i === parts.length - 1) return false;
              node = node.parent;
            }
            if (!node) return false;
            if (i > 0) node = node.parent;
          }
          return true;
        });
      },
      closest(sel: string) {
        let n: El | null = el;
        while (n) {
          if (matches(n, sel)) return n;
          n = n.parent;
        }
        return null;
      },
      setAttribute(k: string, v: string) {
        if (k === "id") {
          el.id = v;
          byId.set(v, el);
        }
        if (k === "class") el.className = v;
      },
      getAttribute(k: string) {
        if (k === "id") return el.id || null;
        if (k === "class") return el.className || null;
        return null;
      },
    };
    Object.defineProperty(el, "innerHTML", {
      get() {
        return (el as unknown as { _html?: string })._html || "";
      },
      set(html: string) {
        (el as unknown as { _html?: string })._html = html;
        el.children = [];
        const re = /<([a-zA-Z0-9]+)([^>]*)>/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html))) {
          const child = create(m[1]);
          const id = /id="([^"]+)"/.exec(m[2]);
          const cls = /class="([^"]+)"/.exec(m[2]);
          if (id) {
            child.id = id[1];
            byId.set(id[1], child);
          }
          if (cls) child.className = cls[1];
          el.appendChild(child);
        }
      },
    });
    return el;
  }

  const body = create("body");
  const ids = [
    "board", "counts", "overduePill", "inboxPill", "loadOverlay", "loadTitle", "loadDetail",
    "loadTime", "loadRetry", "loadSpin", "viewSeg", "laneSeg", "calModeSeg", "groupBy",
    "sortBy", "addLaneBtn", "inbox", "autonomous", "projects", "sessions", "social",
    "calendar", "graph", "gfilters", "canvas", "backdrop", "drawer", "drawerInner",
    "resmodal", "resTitle", "resSub", "resNote", "resSave", "resSkip", "resCancel",
    "resX", "search", "syncPill", "captureBtn", "refreshBtn", "syncBtn", "topbar", "main",
  ];
  for (const id of ids) {
    const el = create("div");
    el.id = id;
    if (id === "board") el.className = "view";
    if (["inbox", "autonomous", "projects", "sessions", "social", "calendar", "graph", "gfilters", "canvas", "drawer", "backdrop", "resmodal"].includes(id)) {
      el.className = "view hidden";
    }
    body.appendChild(el);
    byId.set(id, el);
  }

  const document = {
    body,
    createElement: (tag: string) => create(tag),
    getElementById: (id: string) => byId.get(id) || null,
    querySelector: (sel: string) => {
      const s = sel.trim();
      if (/^#[\w-]+$/.test(s)) return byId.get(s.slice(1)) || null;
      return body.querySelector(s);
    },
    querySelectorAll: (sel: string) => {
      const s = sel.trim();
      if (/^#[\w-]+$/.test(s)) {
        const n = byId.get(s.slice(1));
        return n ? [n] : [];
      }
      return body.querySelectorAll(s);
    },
    addEventListener: (type: string, fn: (...a: unknown[]) => void) => {
      if (type === "message") messageListeners.push(fn as (e: { data: unknown }) => void);
    },
  };

  const snapshot = {
    objects: [
      { id: "t-inbox", type: "task", status: "inbox", title: "Inbox item", priority: "p1" },
      { id: "t-today", type: "task", status: "today", title: "Today item", priority: "p0" },
      { id: "t-wip", type: "task", status: "in_progress", title: "WIP" },
      { id: "t-done", type: "task", status: "done", title: "Done", updated: "2026-08-26" },
      { id: "t-def", type: "task", status: "deferred", title: "Later" },
      { id: "t-out", type: "task", status: "outdated", title: "Old" },
      { id: "t-over", type: "task", status: "inbox", title: "Overdue", due: "2020-01-01" },
    ],
    counts: { task: 7 },
    blocked: [{ id: "t-wip", status: "open" }],
    board: { date: "2026-08-26" },
  };

  const windowObj: Record<string, unknown> = {
    __paintTried: false,
    addEventListener: (type: string, fn: (...a: unknown[]) => void) => {
      if (type !== "message") return;
      messageListeners.push(fn as (e: { data: unknown }) => void);
      // Synchronous flush — reproduces VS Code delivering a queued snapshot
      // the moment the webview script subscribes.
      fn({ data: { type: "snapshot", data: snapshot } });
      fn({
        data: {
          type: "loadStatus",
          data: { phase: "ready", detail: "7 objects in 10ms", objectCount: 7, startedAt: Date.now(), queueDepth: 0 },
        },
      });
    },
  };

  return { document, windowObj, byId, snapshot };
}

describe("planning dashboard board paint", () => {
  it("paints six task lanes when a snapshot arrives during script boot", () => {
    const { document, windowObj, byId } = miniDom();
    const sandbox = {
      acquireVsCodeApi: () => ({
        postMessage: () => {},
        getState: () => ({}),
        setState: () => {},
      }),
      document,
      window: windowObj,
      setInterval: () => 0,
      setTimeout: (fn: () => void) => {
        fn();
        return 0;
      },
      clearTimeout: () => {},
      clearInterval: () => {},
      Date,
      Set,
      Map,
      JSON,
      Number,
      String,
      Math,
      console,
    };
    (sandbox.window as { document: typeof document }).document = document;
    expect(() => runInNewContext(src, sandbox, { filename: "planning-dashboard.js" })).not.toThrow();

    const overlay = byId.get("loadOverlay")!;
    const board = byId.get("board")!;
    const cols = board.querySelectorAll(".col");
    const viaDoc = document.querySelector("#board .lanes .col");
    const title = byId.get("loadTitle")!.textContent;
    const detail = byId.get("loadDetail")!.textContent;
    expect(cols.length).toBe(6);
    expect(title).not.toMatch(/failed/i);
    expect(detail).not.toMatch(/before initialization/);
    expect(
      overlay.classList.contains("hidden"),
      `overlay="${overlay.className}" title="${title}" detail="${detail}" viaDoc=${!!viaDoc}`,
    ).toBe(true);
  });
});
