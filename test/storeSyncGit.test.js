// Tests for the store-sync git reconciliation against REAL temp git repos.
// Proves the load-bearing property: a pull is applied when clean, and a
// conflict / pre-existing wedged rebase leaves the repo CLEAN (never mid-rebase),
// so the viewer never wedges a store.
//
// Run: npm run compile && node test/storeSyncGit.test.js
const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { syncRepoOnce, rebaseInProgress } = require("../out/storeSyncGit.js");

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, env: ENV, encoding: "utf8" }).trim();
}
function write(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
}
function head(dir) {
  return git(dir, "rev-parse", "HEAD");
}

/** A bare "remote" + a clone that has it as origin/main. Returns {remote, clone}. */
function makeRepoPair() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "css-sync-"));
  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  fs.mkdirSync(remote);
  git(remote, "init", "--bare", "-b", "main");
  git(base, "clone", remote, seed);
  write(seed, "a.txt", "1\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "seed");
  git(seed, "push", "-u", "origin", "main");
  const clone = path.join(base, "clone");
  git(base, "clone", remote, clone);
  return { base, remote, seed, clone };
}

let passed = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log("  ok -", name);
    passed++;
  } catch (e) {
    console.error("  FAIL -", name, "\n", e && e.stack ? e.stack : e);
    process.exit(1);
  }
}

(async () => {
  // 1. Clean fast-forward pull → "ok", HEAD advances.
  await t("clean pull applies remote commits (status ok, HEAD advances)", async () => {
    const { seed, clone } = makeRepoPair();
    write(seed, "b.txt", "new\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-m", "remote change");
    git(seed, "push", "origin", "main");
    const before = head(clone);
    const res = await syncRepoOnce(clone, { push: false });
    assert.equal(res.status, "ok", res.detail);
    assert.notEqual(head(clone), before);
    assert.ok(fs.existsSync(path.join(clone, "b.txt")), "pulled file present");
  });

  // 2. Nothing to pull → "unchanged".
  await t("no remote change → unchanged", async () => {
    const { clone } = makeRepoPair();
    const res = await syncRepoOnce(clone, { push: false });
    assert.equal(res.status, "unchanged", res.detail);
  });

  // 3. Diverged with a real conflict → aborts, leaves HEAD CLEAN (no rebase in
  //    progress, no conflict markers), reports "conflict".
  await t("conflicting divergence → conflict, repo left clean (not wedged)", async () => {
    const { seed, clone } = makeRepoPair();
    // remote edits a.txt
    write(seed, "a.txt", "remote-edit\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-m", "remote edits a");
    git(seed, "push", "origin", "main");
    // local edits the SAME line, committed → rebase will conflict
    write(clone, "a.txt", "local-edit\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-m", "local edits a");
    const localHead = head(clone);

    const res = await syncRepoOnce(clone, { push: false });
    assert.equal(res.status, "conflict", `expected conflict, got ${res.status} ${res.detail}`);
    assert.equal(await rebaseInProgress(clone), false, "must NOT be left mid-rebase");
    assert.equal(head(clone), localHead, "HEAD restored to the local commit");
    assert.equal(git(clone, "status", "--porcelain"), "", "working tree clean (no conflict markers)");
  });

  // 4a. A pre-existing wedged rebase (e.g. a crashed cron) is recovered — the
  //     repo is left clean and NOT mid-rebase, whatever the underlying diverge.
  await t("pre-existing wedged rebase is recovered (not wedged, clean tree)", async () => {
    const { seed, clone } = makeRepoPair();
    write(seed, "a.txt", "remote\n");
    git(seed, "add", "-A"); git(seed, "commit", "-m", "r"); git(seed, "push", "origin", "main");
    write(clone, "a.txt", "local\n");
    git(clone, "add", "-A"); git(clone, "commit", "-m", "l");
    git(clone, "fetch", "origin", "main");
    try { git(clone, "rebase", "origin/main"); } catch (_) { /* stops on conflict */ }
    assert.equal(await rebaseInProgress(clone), true, "set up: rebase is wedged");

    await syncRepoOnce(clone, { push: false });
    assert.equal(await rebaseInProgress(clone), false, "wedged rebase recovered — no longer mid-rebase");
    assert.equal(git(clone, "status", "--porcelain"), "", "clean tree after recovery");
  });

  // 4b. After recovering a stale rebase, a NON-conflicting remote change pulls
  //     cleanly on the next pass (the wedge doesn't poison future syncs).
  await t("recovered repo pulls cleanly once the divergence is gone", async () => {
    const { seed, clone } = makeRepoPair();
    // wedge with a conflict, then drop the local conflicting commit so the repo
    // is a plain follower again (simulating the user resolving locally).
    write(seed, "a.txt", "remote\n");
    git(seed, "add", "-A"); git(seed, "commit", "-m", "r"); git(seed, "push", "origin", "main");
    write(clone, "a.txt", "local\n");
    git(clone, "add", "-A"); git(clone, "commit", "-m", "l");
    git(clone, "fetch", "origin", "main");
    try { git(clone, "rebase", "origin/main"); } catch (_) {}
    // first sync recovers the wedge (and conflicts on the local edit → aborts clean)
    await syncRepoOnce(clone, { push: false });
    git(clone, "reset", "--hard", "origin/main"); // user drops the local edit
    // now a fresh, non-conflicting remote commit must pull cleanly
    write(seed, "c.txt", "c\n");
    git(seed, "add", "-A"); git(seed, "commit", "-m", "c"); git(seed, "push", "origin", "main");
    const res = await syncRepoOnce(clone, { push: false });
    assert.equal(res.status, "ok", `clean pull after recovery, got ${res.status} ${res.detail}`);
    assert.ok(fs.existsSync(path.join(clone, "c.txt")));
  });

  // 5. push:true sends local commits to the remote after rebasing.
  await t("push:true pushes local commits after rebase", async () => {
    const { remote, clone } = makeRepoPair();
    write(clone, "local.txt", "x\n");
    git(clone, "add", "-A"); git(clone, "commit", "-m", "local only");
    const res = await syncRepoOnce(clone, { push: true });
    assert.ok(["ok", "unchanged"].includes(res.status), res.detail);
    // the bare remote now has the file in its tree
    const remoteFiles = git(remote, "ls-tree", "--name-only", "main");
    assert.ok(remoteFiles.split("\n").includes("local.txt"), "local commit reached the remote");
  });

  // 6. Non-git / remoteless dirs are skipped, not errored.
  await t("non-git dir → skipped", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "css-nogit-"));
    const res = await syncRepoOnce(dir, { push: false });
    assert.equal(res.status, "skipped");
  });

  console.log(`\nstoreSyncGit: ${passed} passed`);
})();
