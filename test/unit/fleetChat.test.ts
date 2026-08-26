import { describe, it, expect } from "vitest";
import {
  actionLabel,
  buildFleetChatPrompt,
  parseFleetChatResult,
  summarizeFleetSession,
} from "../../src/fleetChat";
import type { FleetSession } from "../../src/sessionFleet";

const sess = (over: Partial<FleetSession> & Pick<FleetSession, "uuid">): FleetSession => ({
  title: "night implement kp",
  agent: "claude",
  host: "air",
  source: "claude",
  startedAt: 1,
  mtime: 1,
  lastActivity: 1,
  open: false,
  planningRefs: [],
  labels: [],
  status: "ended",
  linked: false,
  automated: true,
  firstUserMsg: "You are an autonomous overnight implementer",
  ...over,
});

describe("parseFleetChatResult", () => {
  it("parses answer + mixed actions", () => {
    const r = parseFleetChatResult(
      JSON.stringify({
        answer: "3 night jobs. Tag them automated; one leftover needs a task.",
        actions: [
          { kind: "tag", uuid: "aaaaaaaa-0000-4000-8000-000000000001", tags: ["automated"], intent: "ops" },
          {
            kind: "create-task",
            uuid: "bbbbbbbb-0000-4000-8000-000000000002",
            title: "Finish fleet chat",
            project: "kp",
          },
          { kind: "link", uuid: "cccccccc-0000-4000-8000-000000000003", objectId: "tasks/foo" },
        ],
      }),
    );
    expect(r?.actions).toHaveLength(3);
    expect(r?.actions[0].kind).toBe("tag");
    expect(r?.actions[1].title).toBe("Finish fleet chat");
    expect(r?.actions[2].objectId).toBe("tasks/foo");
  });
  it("strips fences and drops malformed actions", () => {
    const r = parseFleetChatResult(
      'Sure.\n```json\n{"answer":"ok","actions":[{"kind":"tag"},{"kind":"create-task","uuid":"x","title":"T"}]}\n```',
    );
    expect(r?.answer).toBe("ok");
    expect(r?.actions).toHaveLength(1);
    expect(r?.actions[0].kind).toBe("create-task");
  });
  it("returns null on garbage", () => {
    expect(parseFleetChatResult("not json")).toBeNull();
  });
});

describe("buildFleetChatPrompt", () => {
  it("includes view window, automated flag, and the question", () => {
    const p = buildFleetChatPrompt({
      view: { window: "today", host: "all", unlinked: false, hideAutomated: true, search: "" },
      sessions: [sess({ uuid: "aaaaaaaa-0000-4000-8000-000000000001" })],
      projects: [{ id: "projects/kp", title: "KP" }],
      openItems: [{ id: "tasks/foo", title: "Fleet board", type: "task", project: "kp" }],
      question: "identify all automated sessions and tag them",
    });
    expect(p).toContain("window=today");
    expect(p).toContain("automated=hidden");
    expect(p).toContain("identify all automated sessions and tag them");
    expect(p).toContain('"automated":true');
    expect(p).toContain("tasks/foo");
  });
});

describe("summarizeFleetSession / actionLabel", () => {
  it("truncates first prompt", () => {
    const s = summarizeFleetSession(sess({ uuid: "aaaaaaaa-0000-4000-8000-000000000001", firstUserMsg: "x".repeat(500) }));
    expect(String(s.first).length).toBe(280);
  });
  it("labels actions", () => {
    expect(actionLabel({ kind: "tag", uuid: "aaaaaaaa-0000-4000-8000-000000000001", tags: ["automated"] })).toContain(
      "automated",
    );
  });
});
