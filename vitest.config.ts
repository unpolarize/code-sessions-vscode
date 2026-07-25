// Unit-test harness for the pure (no-vscode) modules under src/.
//
// - environment 'node', pool 'forks': the sqlite layer is WASM (no native ABI),
//   but forks keeps each test file in its own process so temp DBs never share
//   an engine instance.
// - `vscode` aliases to a minimal hand-written stub so a module that imports it
//   transitively can still load. The current targets import no vscode at all;
//   grow the stub only when a new test import fails (see test/README.md).
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      vscode: resolve(__dirname, "test/mocks/vscode.ts"),
    },
  },
  test: {
    environment: "node",
    pool: "forks",
    include: ["test/unit/**/*.test.ts"],
  },
});
