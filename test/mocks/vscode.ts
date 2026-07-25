// Minimal `vscode` stub for unit tests (aliased in vitest.config.ts).
//
// Deliberately tiny: export ONLY symbols a module under test actually imports.
// If a new test fails with "X is not exported from vscode", add just that
// symbol here — never paste in a full API surface.

export const Uri = {
  file: (p: string) => ({ fsPath: p, scheme: "file", path: p, toString: () => p }),
  parse: (s: string) => ({ fsPath: s, scheme: "file", path: s, toString: () => s }),
};

export const window = {
  showInformationMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
  createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
};

export const workspace = {
  getConfiguration: () => ({ get: () => undefined, update: async () => {} }),
  workspaceFolders: undefined as undefined,
};

export class EventEmitter<T> {
  event = () => ({ dispose() {} });
  fire(_?: T) {}
  dispose() {}
}

export const commands = {
  registerCommand: () => ({ dispose() {} }),
  executeCommand: async () => {},
};

export default { Uri, window, workspace, EventEmitter, commands };
