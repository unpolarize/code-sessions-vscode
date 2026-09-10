// Sessions sidebar Activity bucket: user-gesture collapse state.
// Pure module — no vscode — so the decision is fixture-testable.
//
// Bug: ActivityBucketItem used to pass TreeItemCollapsibleState.Expanded
// whenever running > 0 || hasError. Each job tick allocates a new item, so
// VS Code cannot keep a user fold. The status-bar activity icon is the
// collapsed-mode surface; expanding Activity is a user gesture only.
//
// KP: tasks/sessions-activity-re-expands-on-every-refresh

/** workspaceState key: "expanded" | "collapsed". Unset = never gestured. */
export const ACTIVITY_BUCKET_EXPANDED_KEY = "codeSessions.activityBucket.expanded";

/** Stable TreeItem.id so VS Code can match the node across refreshes. */
export const ACTIVITY_BUCKET_TREE_ID = "codeSessions.activityBucket";

export type ActivityBucketPersisted = "expanded" | "collapsed" | undefined;

export type ActivityBucketCollapsible = "expanded" | "collapsed";

/** Coerce a workspaceState value (or anything) into the persisted union. */
export function parseActivityBucketPersisted(raw: unknown): ActivityBucketPersisted {
  if (raw === "expanded" || raw === "collapsed") return raw;
  return undefined;
}

/**
 * Desired collapsible state for the Sessions Activity bucket.
 *
 * `persisted` is the last user gesture (workspaceState). `running` and
 * `hasError` affect the label/icon only — they never force Expanded.
 * Fresh workspace (persisted unset) starts Collapsed even with jobs running.
 */
export function activityBucketCollapsibleState(
  persisted: ActivityBucketPersisted,
  _running: number,
  _hasError: boolean,
): ActivityBucketCollapsible {
  return persisted === "expanded" ? "expanded" : "collapsed";
}
