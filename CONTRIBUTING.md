# Contributing

## Local build

```bash
npm install
npx tsc -p .              # → out/extension.js + out/conversation*.js
```

`tsconfig.json` is straightforward CJS targeting ES2022. No bundler, no minifier. The `out/` directory is what ships in the VSIX.

## Run the extension in a dev VS Code window

```bash
code --extensionDevelopmentPath=$(pwd)
```

Open the **Claude Activity** sidebar in the dev window. To reload after a TS change: `Cmd+Shift+P → "Developer: Reload Window"`.

## Package & install

```bash
npx @vscode/vsce package        # → claude-sessions-X.Y.Z.vsix
code --install-extension claude-sessions-X.Y.Z.vsix
```

The extension is **not** published to the marketplace. Distribute the VSIX directly.

## Release flow

1. Update the version in `package.json`.
2. Add a `CHANGELOG.md` entry describing changes (one section per release).
3. `npx tsc -p .` (verify compile).
4. `npx @vscode/vsce package`.
5. `code --install-extension claude-sessions-X.Y.Z.vsix` (reload window to verify).
6. Commit. Tag is optional; the changelog is the source of truth.
7. `git push`.

## Source layout

```
src/
├── extension.ts             # Activation, providers, commands, watcher
├── conversationParser.ts    # JSONL → Turn[] (pure TypeScript, no VS Code deps)
└── conversationView.ts      # Webview HTML/CSS renderer
docs/
└── architecture.md          # Deep dive on data flow + module responsibilities
```

See `docs/architecture.md` for module responsibilities and the JSONL schema.

## Coding conventions

- Prefer `const` and arrow callbacks.
- Avoid runtime dependencies. We ship only what's in `package.json` `devDependencies` — currently `@types/node`, `@types/vscode`, `typescript`. The extension uses only `vscode`, `child_process`, `fs`, `os`, `path` (Node stdlib).
- Helper formatters (`formatRelative`, `formatDurationSec`, `formatTokens`) live in `extension.ts`. If they grow, split into a `src/util.ts`.
- Webview content must escape user-controlled strings. Use the local `escapeHtml()` helper in `conversationView.ts`.
- `enableScripts: false` in webviews. Interactivity is `<details>`-only.

## Adding a new view

If you add a 4th pane:

1. In `package.json`, add a `views.claude-activity[]` entry with a unique `id`.
2. Add a corresponding `activationEvents: "onView:<id>"` line.
3. Implement a `TreeDataProvider` in `extension.ts` (or a new file).
4. Register it in `activate()` with `vscode.window.registerTreeDataProvider`.
5. Add a refresh command + bind to a title-bar menu.
6. Update `README.md` and `docs/architecture.md`.

## Adding a column / field to Sessions

The shape is in two places:

- `~/.claude/skills/sessions/session-center.sh` (the source of truth — emits TSV and JSON).
- `interface SessionRow` in `src/extension.ts`.

To add a field:

1. Extend the `jq -s '...'` aggregation in `session-center.sh`.
2. Pipe the field into the TSV row + the JSON `--limit` block.
3. Add the field to `SessionRow`.
4. Use it in `SessionItem` description / `metricsChildren()` as needed.

## Performance budget

- The script run that backs the Sessions view must stay under ~10 s for ~1500 sessions on a recent Mac. If you add per-session work, pre-filter by mtime first (see `INDEX.top`).
- The conversation parser must handle 1500-turn sessions (~5 MB JSONL) in under 1 s.
- The webview render is a single template-literal pass; avoid making it dependent on async I/O.
