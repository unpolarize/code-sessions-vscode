// Regression test: node-sqlite3-wasm leaks WASM linear memory for every
// prepared statement that is not finalized (it has no FinalizationRegistry).
// db.ts uses the better-sqlite3 idiom `db.prepare(sql).all()` at 50+ call sites
// on every tree refresh and indexer pass; without finalization the WASM heap
// climbs toward its 2 GB ceiling until prepare/step returns SQLITE_NOMEM,
// surfaced to the user as "SQLite read failed: out of memory".
//
// The wrapper must keep prepared-statement memory bounded (prepare-cache +
// finalize on close/evict). This test fails on the un-fixed wrapper.
//
// Run: node --expose-gc test/wasm-stmt-leak.test.js
const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert");

const { Database } = require(path.join(__dirname, "..", "out", "sqlite.js"));

if (!global.gc) {
  console.error("FAIL: run with `node --expose-gc` so the JS heap can be collected and only the WASM leak remains.");
  process.exit(2);
}

const TMP = path.join(os.tmpdir(), "cs-wasm-stmt-leak.db");
for (const p of [TMP, TMP + ".lock", TMP + "-journal", TMP + "-wal"]) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

const db = new Database(TMP);
db.exec(`CREATE TABLE session (
  session_id TEXT PRIMARY KEY, mtime_ns INTEGER, is_automated INTEGER,
  kind TEXT, parent_session_id TEXT, cost_usd REAL, title TEXT);`);
const seed = db.prepare(
  "INSERT INTO session (session_id, mtime_ns, is_automated, kind, parent_session_id, cost_usd) VALUES (@id,@m,@a,@k,@p,@c)",
);
for (let i = 0; i < 300; i++) {
  seed.run({ id: "s" + i, m: i, a: 0, k: i % 3 === 0 ? "workflow" : "session", p: i % 3 === 0 ? "s" + (i - 1) : null, c: 0.01 });
}

// Mirror the read fast-path: several distinct one-shot `prepare(sql).all()`
// calls — exactly the idiom that leaks one WASM statement per call.
function refresh() {
  db.prepare("SELECT * FROM session WHERE (1 OR is_automated=0) ORDER BY mtime_ns DESC LIMIT 100").all();
  db.prepare("SELECT parent_session_id, SUM(cost_usd) c, COUNT(*) n FROM session WHERE kind IN ('subagent','workflow') AND parent_session_id IS NOT NULL GROUP BY parent_session_id").all();
  db.prepare("SELECT session_id FROM session WHERE kind = 'session'").all();
}

const CYCLES = 12000;
for (let i = 0; i < 2000; i++) refresh(); // warm up allocator/JIT
global.gc();
const baseMB = process.memoryUsage().rss / 1048576;
for (let i = 0; i < CYCLES; i++) refresh();
global.gc();
const afterMB = process.memoryUsage().rss / 1048576;
const grewMB = afterMB - baseMB;

db.close();
console.log(`prepared ${CYCLES * 3} statements after warmup: rss ${baseMB.toFixed(0)}MB -> ${afterMB.toFixed(0)}MB (grew ${grewMB.toFixed(0)}MB)`);

const LIMIT_MB = 40;
assert(
  grewMB < LIMIT_MB,
  `WASM statement leak: rss grew ${grewMB.toFixed(0)}MB over ${CYCLES * 3} prepare() calls (limit ${LIMIT_MB}MB). ` +
    `node-sqlite3-wasm statements are not being finalized — the WASM heap will reach its 2GB ceiling and throw "out of memory".`,
);
console.log("PASS: prepared-statement memory stays bounded");
