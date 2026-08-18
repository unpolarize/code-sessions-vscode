// Background re-embed job (semantic search PR3): hash-based stale detection,
// single-flight dedupe, probe-fail cooldown, cancellation, and the force
// drop-all path. Fixture store + injected embed deps; no network, no vscode.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionStore, SessionRow, TurnRow } from "../../src/db";
import { EmbedConfig } from "../../src/embedding";
import { embedTextHash, taggedEmbeddingModel } from "../../src/embedText";
import {
  buildEmbedTexts,
  selectReembedTargets,
  kickReembed,
  reembedInFlight,
  resetReembedStateForTests,
  PROBE_FAIL_COOLDOWN_MS,
} from "../../src/reembedJob";

const CFG: EmbedConfig = {
  preferred: "ollama",
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaModel: "nomic-embed-text",
};
const TAG = taggedEmbeddingModel(`ollama/${CFG.ollamaModel}`);

function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  const sid = overrides.session_id ?? "11111111-1111-4111-8111-111111111111";
  return {
    session_id: sid,
    source: "claude",
    project_path: "/Users/tester/projects/demo",
    project_id: "demo",
    projects_touched: ["demo"],
    jsonl_path: `/Users/tester/.claude/projects/demo/${sid}.jsonl`,
    mtime_ns: 1_700_000_000_000_000,
    size_bytes: 2048,
    started_at: Date.parse("2026-07-01T10:00:00.000Z"),
    ended_at: Date.parse("2026-07-01T10:30:00.000Z"),
    message_count: 4,
    tool_count: 1,
    subagent_count: 0,
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0.1,
    model: "claude-fable-5",
    title: "fixture session",
    first_user_msg: "list the files in src",
    entrypoint: null,
    is_automated: false,
    indexed_at: Date.parse("2026-07-01T11:00:00.000Z"),
    last_assistant_text_at: null,
    extras_json: null,
    kind: "session",
    parent_session_id: null,
    workflow_id: null,
    ...overrides,
  };
}

function turnRow(sessionId: string, overrides: Partial<TurnRow> = {}): TurnRow {
  return {
    turn_uuid: `${sessionId}-t0`,
    session_id: sessionId,
    turn_index: 0,
    started_at: Date.parse("2026-07-01T10:00:00.000Z"),
    ended_at: Date.parse("2026-07-01T10:00:07.000Z"),
    duration_ms: 7000,
    user_text: "list the files in src",
    assistant_excerpt: "There are two files",
    assistant_full: null,
    tool_names_csv: "Bash",
    tool_count: 1,
    has_subagent: false,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0.01,
    ...overrides,
  };
}

/** Deterministic fake embedder: 4-dim, counts calls, records texts. */
function fakeEmbedder() {
  const calls: string[] = [];
  return {
    calls,
    embedOllama: async (text: string) => {
      calls.push(text);
      return Float32Array.from([1, 0, 0, text.length % 7]);
    },
  };
}

let dir: string;
let store: SessionStore;

beforeEach(() => {
  resetReembedStateForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-reembed-"));
  store = SessionStore.open(dir);
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const SID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("selectReembedTargets", () => {
  it("flags missing rows, NULL-hash rows, and hash mismatches; skips fresh rows", () => {
    const a = sessionRow({ session_id: SID_A });
    const b = sessionRow({ session_id: SID_B, title: "other" });
    store.upsertSession(a);
    store.upsertSession(b);
    const texts = buildEmbedTexts(store, [a, b]);

    // A fresh, B missing.
    store.upsertEmbedding(SID_A, Float32Array.from([1, 0]), TAG, embedTextHash(texts.get(SID_A)!));
    let targets = selectReembedTargets([a, b], texts, store.sessionEmbeddingHashes(TAG));
    expect(targets.map((s) => s.session_id)).toEqual([SID_B]);

    // Pre-v18 row: vector stored without a hash → stale.
    store.upsertEmbedding(SID_B, Float32Array.from([1, 0]), TAG);
    targets = selectReembedTargets([a, b], texts, store.sessionEmbeddingHashes(TAG));
    expect(targets.map((s) => s.session_id)).toEqual([SID_B]);

    // New tool turn changes A's embed text under the same tag → stale.
    store.upsertTurns([turnRow(SID_A, { tool_names_csv: "Bash,Edit" })]);
    const texts2 = buildEmbedTexts(store, [a, b]);
    expect(texts2.get(SID_A)).not.toEqual(texts.get(SID_A));
    targets = selectReembedTargets([a, b], texts2, store.sessionEmbeddingHashes(TAG));
    expect(targets.map((s) => s.session_id).sort()).toEqual([SID_A, SID_B]);
  });
});

describe("kickReembed", () => {
  it("embeds missing sessions under the shared tag and persists the text hash", async () => {
    const a = sessionRow({ session_id: SID_A });
    const b = sessionRow({ session_id: SID_B, title: "other" });
    store.upsertSession(a);
    store.upsertSession(b);
    const embedder = fakeEmbedder();

    const outcome = await kickReembed(store, CFG, {
      deps: { probe: async () => true, embedOllama: embedder.embedOllama },
    });
    expect(outcome).toMatchObject({ ok: true, embedded: 2, skipped: 0, total: 2, cancelled: false });
    expect(embedder.calls.length).toBe(2);
    for (const text of embedder.calls) expect(text.startsWith("search_document: ")).toBe(true);

    const texts = buildEmbedTexts(store, [a, b]);
    const hashes = store.sessionEmbeddingHashes(TAG);
    expect(hashes.get(SID_A)).toBe(embedTextHash(texts.get(SID_A)!));
    expect(hashes.get(SID_B)).toBe(embedTextHash(texts.get(SID_B)!));
    expect(store.sessionEmbeddingCoverage(TAG)).toEqual({ embedded: 2, total: 2 });
  });

  it("re-embeds only stale rows on a later kick; a no-change kick embeds nothing", async () => {
    store.upsertSession(sessionRow({ session_id: SID_A }));
    store.upsertSession(sessionRow({ session_id: SID_B, title: "other" }));
    const first = fakeEmbedder();
    await kickReembed(store, CFG, { deps: { probe: async () => true, embedOllama: first.embedOllama } });
    resetReembedStateForTests();

    // Nothing changed → nothing to embed.
    const idle = fakeEmbedder();
    const none = await kickReembed(store, CFG, { deps: { probe: async () => true, embedOllama: idle.embedOllama } });
    expect(none).toMatchObject({ ok: true, embedded: 0, total: 0 });
    expect(idle.calls.length).toBe(0);
    resetReembedStateForTests();

    // Topics/tools change A's text under the same tag → only A re-embeds.
    store.upsertTurns([turnRow(SID_A, { tool_names_csv: "Bash,Edit,Read" })]);
    const second = fakeEmbedder();
    const outcome = await kickReembed(store, CFG, {
      deps: { probe: async () => true, embedOllama: second.embedOllama },
    });
    expect(outcome).toMatchObject({ ok: true, embedded: 1, total: 1 });
    expect(second.calls.length).toBe(1);
    expect(second.calls[0]).toContain("TOOLS: Bash, Edit, Read");
  });

  it("is single-flight: concurrent kicks share one run", async () => {
    store.upsertSession(sessionRow({ session_id: SID_A }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const deps = {
      probe: async () => true,
      embedOllama: async (text: string) => {
        calls.push(text);
        await gate;
        return Float32Array.from([1, 0]);
      },
    };

    const p1 = kickReembed(store, CFG, { deps });
    const p2 = kickReembed(store, CFG, { deps });
    expect(p2).toBe(p1);
    expect(reembedInFlight()).toBe(true);
    release();
    const outcome = await p1;
    expect(outcome).toMatchObject({ ok: true, embedded: 1 });
    expect(calls.length).toBe(1);
    expect(reembedInFlight()).toBe(false);
  });

  it("fails fast on probe failure and honors the cooldown", async () => {
    store.upsertSession(sessionRow({ session_id: SID_A }));
    let probes = 0;
    let clock = 1_000_000;
    const deps = {
      probe: async () => {
        probes++;
        return false;
      },
      now: () => clock,
    };

    expect(await kickReembed(store, CFG, { deps })).toEqual({ ok: false, reason: "probe" });
    resetInFlightOnly();
    clock += 1000; // inside the cooldown → no second probe
    expect(await kickReembed(store, CFG, { deps })).toEqual({ ok: false, reason: "probe" });
    expect(probes).toBe(1);
    resetInFlightOnly();
    clock += PROBE_FAIL_COOLDOWN_MS; // past the cooldown → probes again
    await kickReembed(store, CFG, { deps });
    expect(probes).toBe(2);

    // The cooldown state is module-level; clear it for later tests.
    resetReembedStateForTests();

    function resetInFlightOnly() {
      // kickReembed clears the in-flight slot itself once settled; nothing to
      // do — this helper just documents that only the cooldown persists.
    }
  });

  it("stops between chunks when cancelled", async () => {
    store.upsertSession(sessionRow({ session_id: SID_A }));
    const embedder = fakeEmbedder();
    const outcome = await kickReembed(store, CFG, {
      isCancelled: () => true,
      deps: { probe: async () => true, embedOllama: embedder.embedOllama },
    });
    expect(outcome).toMatchObject({ ok: true, embedded: 0, cancelled: true, total: 1 });
    expect(embedder.calls.length).toBe(0);
  });
});

describe("force drop-all", () => {
  it("deleteAllSessionEmbeddings clears current-tag rows so the job rebuilds them", async () => {
    store.upsertSession(sessionRow({ session_id: SID_A }));
    const embedder = fakeEmbedder();
    await kickReembed(store, CFG, { deps: { probe: async () => true, embedOllama: embedder.embedOllama } });
    expect(store.sessionEmbeddingCoverage(TAG).embedded).toBe(1);
    resetReembedStateForTests();

    // "Drop stale" can't touch fresh-tag rows — the force path removes them all.
    expect(store.deleteAllSessionEmbeddings()).toBe(1);
    expect(store.sessionEmbeddingCoverage(TAG).embedded).toBe(0);

    const again = fakeEmbedder();
    const outcome = await kickReembed(store, CFG, {
      deps: { probe: async () => true, embedOllama: again.embedOllama },
    });
    expect(outcome).toMatchObject({ ok: true, embedded: 1 });
    expect(store.sessionEmbeddingCoverage(TAG).embedded).toBe(1);
  });
});
