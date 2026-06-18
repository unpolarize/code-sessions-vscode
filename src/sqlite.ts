// Thin better-sqlite3-compatible shim over node-sqlite3-wasm.
//
// Why this exists: better-sqlite3 is a native module compiled against a single
// Node/Electron ABI. VS Code bumps its bundled Electron on most releases, which
// invalidates the prebuilt `better_sqlite3.node` and drops the extension into
// shell-script fallback mode (and recent Electron V8 changes mean better-sqlite3
// can't even be recompiled until upstream catches up). node-sqlite3-wasm is pure
// WebAssembly: no ABI, no native build step, immune to Electron upgrades.
//
// This shim exposes just the slice of the better-sqlite3 API that db.ts uses
// (`prepare`, `exec`, `pragma`, `transaction`, `close` + statement `get`/`all`/
// `run`) and papers over the contract differences confirmed by probing:
//   - named parameters: better-sqlite3 binds bare keys (`{name}`) against any of
//     `@name` / `$name` / `:name`; node-sqlite3-wasm requires the prefix in the
//     key. We scan the SQL for parameter tokens and translate bare -> prefixed.
//   - extra object keys: better-sqlite3 ignores them, node-sqlite3-wasm throws.
//     We filter the bind object down to the params the statement declares (this
//     is what lets call sites pass a whole row object with spread).
//   - positional params: better-sqlite3 takes variadic args, node-sqlite3-wasm
//     takes a single array. We collect args into an array.
//   - `.pragma()` / `.transaction()`: not present on node-sqlite3-wasm; emulated
//     with `PRAGMA` statements and BEGIN/COMMIT (SAVEPOINT when nested).

import { Database as WasmDatabase, Statement as WasmStatement } from "node-sqlite3-wasm";

type BindArg = any;

const PARAM_TOKEN = /[@:$][A-Za-z_][A-Za-z0-9_]*/g;

/** A bind value is "named" when it's a single plain object — not an array and
 * not a Buffer/Uint8Array (BLOBs are bound positionally). */
function isNamedBind(args: BindArg[]): boolean {
  if (args.length !== 1) return false;
  const a = args[0];
  return (
    a !== null &&
    typeof a === "object" &&
    !Array.isArray(a) &&
    !(a instanceof Uint8Array)
  );
}

class CompatStatement {
  private readonly stmt: WasmStatement;
  /** full parameter tokens declared in the SQL, e.g. "@name", "$limit" */
  private readonly declared: Set<string>;
  /** bare name (no prefix) -> full token, for translating better-sqlite3-style
   * bare-keyed bind objects. First occurrence wins. */
  private readonly byBare: Map<string, string>;

  constructor(raw: WasmDatabase, sql: string) {
    this.stmt = raw.prepare(sql);
    this.declared = new Set();
    this.byBare = new Map();
    const tokens = sql.match(PARAM_TOKEN) ?? [];
    for (const tok of tokens) {
      this.declared.add(tok);
      const bare = tok.slice(1);
      if (!this.byBare.has(bare)) this.byBare.set(bare, tok);
    }
  }

  /** Translate better-sqlite3 call-style args into node-sqlite3-wasm BindValues. */
  private bind(args: BindArg[]): any {
    if (args.length === 0) return undefined;
    if (isNamedBind(args)) {
      const input = args[0] as Record<string, any>;
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(input)) {
        // Already-prefixed key, or a bare key we can map to a declared token.
        const token =
          this.declared.has(k) ? k : this.byBare.get(k);
        if (token && this.declared.has(token)) out[token] = v;
      }
      return out;
    }
    // Positional: either spread variadic args, or a single array argument.
    if (args.length === 1 && Array.isArray(args[0])) return args[0];
    return args;
  }

  get(...args: BindArg[]): any {
    const b = this.bind(args);
    const row = b === undefined ? this.stmt.get() : this.stmt.get(b);
    // node-sqlite3-wasm's get() steps to the first row but does NOT reset the
    // statement (its row generator is abandoned, not exhausted), so a shared
    // read lock lingers on the database. That's invisible for normal single-DB
    // reads but breaks `DETACH DATABASE` after a get() against an attached DB.
    // better-sqlite3's get() always resets after returning one row — replicate
    // that here so locks are released promptly. (`_reset` is internal; guard it.)
    const s = this.stmt as unknown as { _reset?: () => void };
    if (typeof s._reset === "function") s._reset();
    return row;
  }

  all(...args: BindArg[]): any[] {
    const b = this.bind(args);
    return (b === undefined ? this.stmt.all() : this.stmt.all(b)) as any[];
  }

  run(...args: BindArg[]): { changes: number; lastInsertRowid: number | bigint } {
    const b = this.bind(args);
    return b === undefined ? this.stmt.run() : this.stmt.run(b);
  }
}

export class Database {
  /** Underlying node-sqlite3-wasm handle. Exposed for parity with code that
   * referenced `store.db` as a better-sqlite3 Database, but all real access
   * goes through the methods below. */
  readonly raw: WasmDatabase;
  private txDepth = 0;

  constructor(filename: string) {
    this.raw = new WasmDatabase(filename);
  }

  prepare(sql: string): CompatStatement {
    return new CompatStatement(this.raw, sql);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** better-sqlite3 `.pragma()`. A source containing `=` is a write (executed);
   * otherwise it's a read. `{ simple: true }` returns the single scalar value. */
  pragma(source: string, opts?: { simple?: boolean }): any {
    const s = String(source).trim();
    if (s.includes("=")) {
      this.raw.exec("PRAGMA " + s);
      return undefined;
    }
    const row = this.raw.get("PRAGMA " + s) as Record<string, any> | null;
    if (opts?.simple) return row ? Object.values(row)[0] : undefined;
    return row ? [row] : [];
  }

  /** better-sqlite3 `.transaction(fn)` -> a callable that wraps fn in a
   * transaction. Nests via SAVEPOINT so an inner call inside an outer
   * transaction rolls back independently, matching better-sqlite3 semantics. */
  transaction<T extends (...a: any[]) => any>(fn: T): T {
    const self = this;
    const wrapped = function (this: any, ...args: any[]) {
      const nested = self.txDepth > 0;
      const sp = `_tx_sp_${self.txDepth}`;
      if (nested) self.raw.exec(`SAVEPOINT ${sp}`);
      else self.raw.exec("BEGIN");
      self.txDepth++;
      try {
        const result = fn.apply(this, args);
        self.txDepth--;
        if (nested) self.raw.exec(`RELEASE ${sp}`);
        else self.raw.exec("COMMIT");
        return result;
      } catch (e) {
        self.txDepth--;
        if (nested) {
          self.raw.exec(`ROLLBACK TO ${sp}`);
          self.raw.exec(`RELEASE ${sp}`);
        } else {
          self.raw.exec("ROLLBACK");
        }
        throw e;
      }
    };
    return wrapped as unknown as T;
  }

  close(): void {
    this.raw.close();
  }
}

export default Database;
