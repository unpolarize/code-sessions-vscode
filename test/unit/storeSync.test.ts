// StoreSyncManager pass-status mapping and push-failure warnings, with the
// per-repo sync injected via StoreSyncOptions.syncRepo — zero git, zero timers
// (start() is never called; passes are driven through syncNow()).
import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import { StoreSyncManager } from "../../src/storeSync";
import { RepoSyncResult } from "../../src/storeSyncGit";

afterEach(() => vi.restoreAllMocks());

function manager(results: RepoSyncResult[], onChanged: (r: string[]) => void = () => {}) {
  let pass = -1;
  return new StoreSyncManager({
    repos: () => ["/tmp/store-a"],
    onChanged,
    syncRepo: async () => results[(pass = Math.min(pass + 1, results.length - 1))],
  });
}

describe("StoreSyncManager push-failed handling", () => {
  it("maps a push-failed repo to a degraded pass status (not green)", async () => {
    const m = manager([{ status: "push-failed", detail: "pulled ok; push failed: auth" }]);
    await m.syncNow();
    const s = m.getStatus();
    expect(s.status).toBe("push-failed");
    expect(s.detail).toBe("pulled ok; push failed: auth");
  });

  it("warns once per repo per failure streak; success resets the streak", async () => {
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const m = manager([
      { status: "push-failed", detail: "push failed: auth" },
      { status: "push-failed", detail: "push failed: auth" },
      { status: "unchanged" }, // push works again → streak over
      { status: "push-failed", detail: "push failed: auth" }, // new streak → warn again
    ]);
    await m.syncNow();
    await m.syncNow();
    expect(warn).toHaveBeenCalledTimes(1);
    await m.syncNow();
    expect(m.getStatus().status).toBe("unchanged");
    await m.syncNow();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(m.getStatus().status).toBe("push-failed");
  });

  it("push-failed with changed:true still reloads views via onChanged", async () => {
    const seen: string[][] = [];
    const m = manager(
      [{ status: "push-failed", detail: "push failed", changed: true }],
      (r) => seen.push(r),
    );
    await m.syncNow();
    expect(seen).toEqual([["/tmp/store-a"]]);
  });

  it("push-failed outranks ok but not conflict/error in worst-status", async () => {
    let call = 0;
    const per: RepoSyncResult[] = [
      { status: "ok" },
      { status: "push-failed", detail: "push failed" },
      { status: "conflict", detail: "CONFLICT" },
    ];
    const m = new StoreSyncManager({
      repos: () => ["/tmp/a", "/tmp/b", "/tmp/c"],
      onChanged: () => {},
      syncRepo: async () => per[call++],
    });
    await m.syncNow();
    expect(m.getStatus().status).toBe("conflict");
  });
});
