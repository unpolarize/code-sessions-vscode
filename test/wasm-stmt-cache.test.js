// Correctness guard for the prepared-statement cache: because prepare(sql) now
// returns a shared, reused CompatStatement, re-running the same SQL with
// different parameters must not bleed bindings or stale results. Also verifies
// the prepare-once / run-in-loop idiom (db.ts lines 964–1187) still works.
//
// Run: node test/wasm-stmt-cache.test.js
const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert");

const { Database } = require(path.join(__dirname, "..", "out", "sqlite.js"));

const TMP = path.join(os.tmpdir(), "cs-wasm-stmt-cache.db");
for (const p of [TMP, TMP + ".lock", TMP + "-journal", TMP + "-wal"]) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

const db = new Database(TMP);
db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n INTEGER);");

// 1) prepare-once / run-in-loop with named binds (mirrors upsert sites).
const ins = db.prepare("INSERT INTO t (id, name, n) VALUES (@id, @name, @n)");
for (let i = 0; i < 100; i++) ins.run({ id: i, name: "row" + i, n: i * 10 });
const count = db.prepare("SELECT COUNT(*) AS c FROM t").get().c;
assert.strictEqual(count, 100, `reuse-loop insert: expected 100 rows, got ${count}`);

// 2) cache hit returns the SAME instance (prepare is reused, not re-created).
const a = db.prepare("SELECT * FROM t WHERE id = @id");
const b = db.prepare("SELECT * FROM t WHERE id = @id");
assert.strictEqual(a, b, "same SQL must return the cached statement instance");

// 3) re-running the cached statement with different params yields correct,
//    non-stale results (no binding bleed).
assert.strictEqual(a.get({ id: 7 }).name, "row7", "first bind");
assert.strictEqual(a.get({ id: 42 }).name, "row42", "second bind must not reuse first result");
assert.strictEqual(a.get({ id: 0 }).n, 0, "third bind");

// 4) .all() then .get() on the same cached SQL both correct.
const sel = "SELECT id FROM t WHERE n >= @min ORDER BY id";
assert.strictEqual(db.prepare(sel).all({ min: 980 }).length, 2, "all(): n>=980 -> ids 98,99");
assert.strictEqual(db.prepare(sel).all({ min: 0 }).length, 100, "all(): n>=0 -> all rows (no stale filter)");

// 5) positional / array binding still works through the cache.
const pos = db.prepare("SELECT name FROM t WHERE id = ?");
assert.strictEqual(pos.get(5).name, "row5", "positional bind");
assert.strictEqual(pos.get([9]).name, "row9", "array bind");

db.close();
console.log("PASS: cached statement reuse preserves correctness");
