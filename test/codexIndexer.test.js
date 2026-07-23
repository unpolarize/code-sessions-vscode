// Fixture tests for the codex rollout indexer (pure parse/build layer —
// no SQLite needed). Covers the acceptance list on the KP item:
//   - modern happy path (session_meta + event_msg + turn_context + token_count)
//   - truncated last line while codex is live-appending
//   - legacy/flat garbage lines soft-parsed (counted, no crash)
//   - meta-only rollouts skipped (no user_message, no assistant)
//   - synthetic response_item user/developer lines never title the session
//   - discovery: only rollout-*.jsonl, CODEX_HOME-style root override
//
// Run: npm run compile && node test/codexIndexer.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  listAllCodexSessions,
  buildCodexRows,
  parseCodexRollout,
} = require("../out/codexIndexer.js");

const UUID = "019ee5a5-6e34-7433-b6a9-7d073e243eda";

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-idx-"));
  const day = path.join(root, "2026", "06", "20");
  fs.mkdirSync(day, { recursive: true });
  return { root, day };
}

function writeRollout(day, lines, uuid = UUID) {
  const p = path.join(day, `rollout-2026-06-20T08-28-04-${uuid}.jsonl`);
  fs.writeFileSync(p, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return p;
}

const META = {
  timestamp: "2026-06-20T15:28:04.750Z",
  type: "session_meta",
  payload: {
    id: UUID,
    timestamp: "2026-06-20T15:28:04.692Z",
    cwd: "/Users/zhirafovod/projects/unpolarize/code-sessions",
    originator: "codex_exec",
    cli_version: "0.141.0",
    source: "exec",
    git: { branch: "main" },
  },
};
const TURN_CTX = { timestamp: "2026-06-20T15:28:05.000Z", type: "turn_context", payload: { model: "gpt-5.5", cwd: "/Users/zhirafovod/projects/unpolarize/code-sessions" } };
const ENV_CTX = { timestamp: "2026-06-20T15:28:05.100Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>...</environment_context>" }] } };
const DEV_MSG = { timestamp: "2026-06-20T15:28:05.200Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "AGENTS.md scaffolding" }] } };
const USER = { timestamp: "2026-06-20T15:28:06.000Z", type: "event_msg", payload: { type: "user_message", message: "Reply with exactly: hello from codex" } };
const TOOL = { timestamp: "2026-06-20T15:28:06.500Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{\"command\":[\"ls\"]}" } };
const AGENT = { timestamp: "2026-06-20T15:28:07.000Z", type: "event_msg", payload: { type: "agent_message", message: "hello from codex" } };
const TOKENS = { timestamp: "2026-06-20T15:28:07.500Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 3000, cached_input_tokens: 1000, output_tokens: 42, total_tokens: 3042 } } } };

let passed = 0;
function t(name, fn) {
  try {
    fn();
    console.log("  ok -", name);
    passed++;
  } catch (e) {
    console.error("  FAIL -", name, "\n", e && e.stack ? e.stack : e);
    process.exit(1);
  }
}

// 1. Modern happy path.
t("happy path: id/model/tokens/title/entrypoint/turns all mapped", () => {
  const { root, day } = makeRoot();
  const p = writeRollout(day, [META, TURN_CTX, ENV_CTX, DEV_MSG, USER, TOOL, AGENT, TOKENS]);
  const infos = listAllCodexSessions(root);
  assert.strictEqual(infos.length, 1);
  const rows = buildCodexRows(infos[0]);
  assert.ok(rows, "expected rows");
  const s = rows.session;
  assert.strictEqual(s.session_id, UUID);
  assert.strictEqual(s.source, "codex");
  assert.strictEqual(s.model, "gpt-5.5");
  assert.strictEqual(s.title, "Reply with exactly: hello from codex");
  assert.strictEqual(s.first_user_msg, "Reply with exactly: hello from codex");
  assert.strictEqual(s.input_tokens, 3000);
  assert.strictEqual(s.output_tokens, 42);
  assert.strictEqual(s.cache_read_tokens, 1000);
  assert.strictEqual(s.cost_usd, 0);
  assert.strictEqual(s.entrypoint, "exec");
  assert.strictEqual(s.is_automated, true);
  assert.strictEqual(s.jsonl_path, p);
  const extras = JSON.parse(s.extras_json);
  assert.strictEqual(extras.cli_version, "0.141.0");
  assert.strictEqual(extras.originator, "codex_exec");
  assert.ok(s.last_assistant_text_at > 0);
  assert.strictEqual(rows.turns.length, 1);
  assert.strictEqual(rows.turns[0].user_text, "Reply with exactly: hello from codex");
  assert.strictEqual(rows.turns[0].assistant_excerpt, "hello from codex");
  assert.strictEqual(rows.turns[0].tool_names_csv, "shell");
});

// 2. Truncated last line (live-append) is skipped, rest parses.
t("truncated last line: skipped without crash, counted in badLines", () => {
  const { root, day } = makeRoot();
  writeRollout(day, [META, USER, AGENT, '{"timestamp":"2026-06-20T15:28:09.000Z","type":"event_msg","payload":{"type":"agent_mess']);
  const infos = listAllCodexSessions(root);
  const parsed = parseCodexRollout(infos[0].path);
  assert.strictEqual(parsed.badLines, 1);
  assert.strictEqual(parsed.turns.length, 1);
  const rows = buildCodexRows(infos[0]);
  assert.ok(rows);
  assert.strictEqual(JSON.parse(rows.session.extras_json).bad_lines, 1);
});

// 3. Legacy flat / garbage lines don't crash and don't create turns.
t("legacy flat lines: soft-ignored, no crash", () => {
  const { root, day } = makeRoot();
  writeRollout(day, [
    '{"record_type":"state","role":"user","content":"old flat format"}',
    "not json at all {{{",
    META,
    USER,
    AGENT,
  ]);
  const rows = buildCodexRows(listAllCodexSessions(root)[0]);
  assert.ok(rows);
  assert.strictEqual(rows.turns.length, 1);
  assert.strictEqual(rows.session.title, "Reply with exactly: hello from codex");
});

// 4. Meta-only rollout (no user_message, no assistant) is skipped.
t("meta-only rollout: buildCodexRows returns null", () => {
  const { root, day } = makeRoot();
  writeRollout(day, [META, TURN_CTX, ENV_CTX, DEV_MSG]);
  assert.strictEqual(buildCodexRows(listAllCodexSessions(root)[0]), null);
});

// 5. Synthetic response_item user lines never become the title.
t("synthetic env-context user line never titles the session", () => {
  const { root, day } = makeRoot();
  writeRollout(day, [META, ENV_CTX, AGENT]);
  const rows = buildCodexRows(listAllCodexSessions(root)[0]);
  assert.ok(rows, "assistant-only session still surfaces");
  assert.ok(!rows.session.title.includes("environment_context"));
  assert.strictEqual(rows.session.first_user_msg, "");
});

// 6. Discovery: history.jsonl and non-rollout files are ignored; nested
//    YYYY/MM/DD layout is walked; missing root yields [].
t("discovery: only rollout-*.jsonl under the (overridable) root", () => {
  const { root, day } = makeRoot();
  fs.writeFileSync(path.join(root, "history.jsonl"), "{}\n");
  fs.writeFileSync(path.join(day, "notes.txt"), "x");
  writeRollout(day, [META, USER, AGENT]);
  const infos = listAllCodexSessions(root);
  assert.strictEqual(infos.length, 1);
  assert.ok(infos[0].path.endsWith(".jsonl"));
  assert.strictEqual(infos[0].fileUuid, UUID);
  assert.deepStrictEqual(listAllCodexSessions(path.join(root, "does-not-exist")), []);
});

// 7. Model: last non-null turn_context wins over earlier ones.
t("model: last non-null turn_context.payload.model wins", () => {
  const { root, day } = makeRoot();
  const ctx2 = { ...TURN_CTX, timestamp: "2026-06-20T15:29:00.000Z", payload: { ...TURN_CTX.payload, model: "gpt-5.5-codex" } };
  writeRollout(day, [META, TURN_CTX, USER, AGENT, ctx2]);
  const rows = buildCodexRows(listAllCodexSessions(root)[0]);
  assert.strictEqual(rows.session.model, "gpt-5.5-codex");
});

console.log(`codexIndexer: ${passed} tests passed`);
