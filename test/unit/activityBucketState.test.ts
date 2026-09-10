// Matrix tests for Sessions Activity bucket collapsible-state decision.
// KP tasks/sessions-activity-re-expands-on-every-refresh:
//   persisted user gesture wins; running / hasError never force Expanded.

import { describe, expect, it } from "vitest";
import {
  ACTIVITY_BUCKET_EXPANDED_KEY,
  ACTIVITY_BUCKET_TREE_ID,
  activityBucketCollapsibleState,
  parseActivityBucketPersisted,
  type ActivityBucketPersisted,
} from "../../src/activityBucketState";

describe("activityBucket persistence constants", () => {
  it("exports the workspaceState key read at construct / written on fold", () => {
    expect(ACTIVITY_BUCKET_EXPANDED_KEY).toBe("codeSessions.activityBucket.expanded");
  });

  it("exports a stable TreeItem id so refreshes match the same node", () => {
    expect(ACTIVITY_BUCKET_TREE_ID).toBe("codeSessions.activityBucket");
  });
});

describe("parseActivityBucketPersisted", () => {
  it("accepts expanded / collapsed", () => {
    expect(parseActivityBucketPersisted("expanded")).toBe("expanded");
    expect(parseActivityBucketPersisted("collapsed")).toBe("collapsed");
  });

  it("treats unset and junk as undefined (fresh workspace)", () => {
    expect(parseActivityBucketPersisted(undefined)).toBeUndefined();
    expect(parseActivityBucketPersisted(null)).toBeUndefined();
    expect(parseActivityBucketPersisted(true)).toBeUndefined();
    expect(parseActivityBucketPersisted("Expanded")).toBeUndefined();
    expect(parseActivityBucketPersisted("")).toBeUndefined();
  });
});

describe("activityBucketCollapsibleState matrix", () => {
  const persisteds: ActivityBucketPersisted[] = [undefined, "collapsed", "expanded"];
  const runnings = [0, 1, 3];
  const errors = [false, true];

  for (const persisted of persisteds) {
    for (const running of runnings) {
      for (const hasError of errors) {
        const want = persisted === "expanded" ? "expanded" : "collapsed";
        const label = `persisted=${String(persisted)} running=${running} hasError=${hasError} → ${want}`;
        it(label, () => {
          expect(activityBucketCollapsibleState(persisted, running, hasError)).toBe(want);
        });
      }
    }
  }

  it("fresh workspace with running jobs stays collapsed (status bar is the surface)", () => {
    expect(activityBucketCollapsibleState(undefined, 2, false)).toBe("collapsed");
    expect(activityBucketCollapsibleState(undefined, 2, true)).toBe("collapsed");
  });

  it("user expand is sticky regardless of job ticks", () => {
    expect(activityBucketCollapsibleState("expanded", 0, false)).toBe("expanded");
    expect(activityBucketCollapsibleState("expanded", 4, true)).toBe("expanded");
  });

  it("user collapse is sticky even when a job errors", () => {
    expect(activityBucketCollapsibleState("collapsed", 0, true)).toBe("collapsed");
    expect(activityBucketCollapsibleState("collapsed", 1, true)).toBe("collapsed");
  });
});
