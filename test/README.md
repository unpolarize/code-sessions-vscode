# Tests

Two layers:

- **Legacy node scripts** (`test/*.test.js`) — run directly by `npm test` after
  `tsc` compile. Predate the vitest harness; leave them be.
- **Vitest unit suite** (`test/unit/*.test.ts`) — `npm run test:unit` (or the
  tail of `npm test`). Pure-logic tests only: parsers, sqlite round-trips,
  git-output handling. No VS Code host, no network, no real git, no writes into
  the repo.

## Running

```
npm run test:unit          # vitest only (fast, no tsc)
npm test                   # compile + legacy scripts + vitest
```

Config: `vitest.config.ts` — `environment: 'node'`, `pool: 'forks'`, and a
`vscode` alias pointing at `test/mocks/vscode.ts`.

## The vscode stub

`test/mocks/vscode.ts` exports the minimum surface. The current unit targets
import no `vscode` at all; the alias exists so a transitively-importing module
can still load. If a new test fails with a missing `vscode` export, add **just
that symbol** to the stub — never a full API mock.

## Fixtures

`test/fixtures/transcripts/{claude,codex}/{valid,malformed,truncated}/` —
one fault per fixture, <50 lines each. Every `x.jsonl` has an
`x.expected.json` sidecar:

```json
{ "records": <count>, "errors": [{ "line": <n>, "kind": "<JsonParse|SchemaMiss|Truncated|Empty>" }] }
```

`records` is the expected parsed-turn count; `errors` documents the deliberate
fault (line number + kind from the closed enum above). These are
**characterization** tests: they encode today's edge-case behavior. If you find
a parser bug, file it — don't fix it by editing the sidecar and the parser in
the same change.

## SQLite

`node-sqlite3-wasm` (no native ABI). Tests open stores under
`fs.mkdtempSync(os.tmpdir())`, one dir per test file, removed in
`afterAll`. Never share a DB path across test files — the forks pool runs
files in separate processes.

## Numeric tolerance

Float assertions use `toBeCloseTo(x, 6)` (epsilon 1e-6).
