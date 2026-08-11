// DB-level guard for tokenized search (migration v17 + searchTurns/searchTopics
// rewrite): multi-word queries AND their tokens instead of matching one literal
// contiguous substring, and the assistant side searches the full text column
// (assistant_full) rather than the 1 KB excerpt.
//
// Run: node test/wasm-search-tokenize.test.js
const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert");

const { SessionStore } = require(path.join(__dirname, "..", "out", "db.js"));

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cs-search-tokenize-"));

function makeSession(id) {
  return {
    session_id: id,
    source: "claude",
    project_path: "/tmp/proj",
    project_id: "proj",
    projects_touched: ["proj"],
    jsonl_path: path.join(TMP_DIR, id + ".jsonl"),
    mtime_ns: 1,
    size_bytes: 1,
    started_at: 1000,
    ended_at: 2000,
    message_count: 1,
    tool_count: 0,
    subagent_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0,
    model: "claude-sonnet",
    title: id,
    first_user_msg: null,
    entrypoint: null,
    is_automated: false,
    indexed_at: 1,
    last_assistant_text_at: null,
    extras_json: null,
    kind: "session",
    parent_session_id: null,
    workflow_id: null,
  };
}

function makeTurn(sessionId, i, userText, assistantFullText) {
  const excerpt = assistantFullText ? assistantFullText.slice(0, 1024) : null;
  return {
    turn_uuid: `${sessionId}#${i}`,
    session_id: sessionId,
    turn_index: i,
    started_at: 1000 + i,
    ended_at: 2000 + i,
    duration_ms: 1000,
    user_text: userText,
    assistant_excerpt: excerpt,
    assistant_full:
      assistantFullText && assistantFullText.length > 1024 ? assistantFullText : null,
    tool_names_csv: "",
    tool_count: 0,
    has_subagent: false,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0,
  };
}

let store = SessionStore.open(TMP_DIR);
store.upsertSession(makeSession("s1"));
store.upsertTurns([
  // Both words present but non-contiguous, in user text.
  makeTurn("s1", 0, "please make runKp fully async so the tree stops blocking", null),
  // Only one of the two words.
  makeTurn("s1", 1, "async iterators are neat", null),
  // Term appears only past char 2000 of a long assistant answer — the 1 KB
  // excerpt cannot contain it.
  makeTurn("s1", 2, "tell me about the indexer", "x".repeat(2500) + " zanzibar deep-content marker"),
  // Short assistant answer: assistant_full stays NULL, excerpt still searched.
  makeTurn("s1", 3, null, "short answer mentioning quagga only"),
]);
store.upsertTopics([
  { turn_uuid: "s1#0", topic: "Async KP Refactor", model: "m", prompt_rev: 1, batch_id: "b1" },
]);

// 1) Multi-word query matches non-contiguous words (old code required the
//    literal substring "async runkp").
let r = store.searchTurns("async runKp");
assert.strictEqual(r.length, 1, `multi-word AND: expected 1 hit, got ${r.length}`);
assert.strictEqual(r[0].turn_uuid, "s1#0");
assert.strictEqual(r[0].matched, "user");

// 2) Term first appearing past char 2000 of the assistant answer is findable.
r = store.searchTurns("zanzibar");
assert.strictEqual(r.length, 1, `deep assistant text: expected 1 hit, got ${r.length}`);
assert.strictEqual(r[0].turn_uuid, "s1#2");
assert.strictEqual(r[0].matched, "assistant");

// 3) Multi-word across deep assistant text.
r = store.searchTurns("marker zanzibar");
assert.strictEqual(r.length, 1, "multi-word AND within assistant_full");

// 4) Single-word queries behave as before (excerpt fallback when full is NULL).
r = store.searchTurns("quagga");
assert.strictEqual(r.length, 1, "single word over excerpt-only row");
assert.strictEqual(r[0].turn_uuid, "s1#3");

// 5) Tokens must all match on one side: no turn has both words on the same side.
r = store.searchTurns("quagga zanzibar");
assert.strictEqual(r.length, 0, "AND semantics: words split across turns must not match");

// 6) Empty / whitespace-only queries return empty.
assert.strictEqual(store.searchTurns("").length, 0, "empty query");
assert.strictEqual(store.searchTurns("   ").length, 0, "whitespace query");

// 7) searchTopics tokenizes too: "refactor async" (reordered, non-contiguous).
const topics = store.searchTopics("refactor async");
assert.strictEqual(topics.length, 1, `topic multi-word: expected 1, got ${topics.length}`);
assert.strictEqual(topics[0].topic, "Async KP Refactor");
assert.strictEqual(store.searchTopics("refactor nomatch").length, 0, "topic AND semantics");

// 8) Migration idempotency: reopen the existing store (migrate() runs again on
//    a DB already at the latest user_version) — must be a no-op, data intact.
store.close();
store = SessionStore.open(TMP_DIR);
assert.strictEqual(store.count(), 1, "reopen: session survived");
r = store.searchTurns("async runKp");
assert.strictEqual(r.length, 1, "reopen: search still works");
store.close();

fs.rmSync(TMP_DIR, { recursive: true, force: true });
console.log("PASS: tokenized search + assistant_full column");
