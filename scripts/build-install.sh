#!/usr/bin/env bash
# Build the extension and install it into VS Code.
#
# Steps:
#   1. npm install (only if node_modules is missing)
#   2. Compile TypeScript → out/
#   3. Package into a .vsix via vsce
#   4. code --install-extension --force
#
# Re-run safely. Pass --no-install to skip the final install step.

set -euo pipefail

# Locate the repo root (this script lives in scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT}"

INSTALL=1
for arg in "$@"; do
  case "$arg" in
    --no-install) INSTALL=0 ;;
    -h|--help)
      sed -n '1,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

if [ ! -d node_modules ]; then
  echo "==> npm install"
  npm install
fi

echo "==> npm run compile"
npm run compile

# (No native rebuild step anymore — we migrated off better-sqlite3 to the
# pure-WASM node-sqlite3-wasm in v1.0.2, so the .vsix is portable across
# Electron versions.)

# Package WITH dependencies. `--no-dependencies` was the previous bug — it
# produced a slim .vsix that could not require its runtime deps, so
# activate() threw and no tree-data providers ever registered.
echo "==> packaging"
npx --yes @vscode/vsce package --allow-missing-repository >/dev/null

VSIX="$(ls -t code-sessions-*.vsix 2>/dev/null | head -n 1)"
if [ -z "${VSIX}" ]; then
  echo "No .vsix produced — did vsce package fail?" >&2
  exit 1
fi
echo "==> built ${VSIX}"

if [ "${INSTALL}" -eq 1 ]; then
  if ! command -v code >/dev/null 2>&1; then
    echo "'code' CLI not on PATH; skipping install. Install via VS Code → Command Palette → 'Shell Command: Install code in PATH'." >&2
    exit 0
  fi
  echo "==> code --install-extension ${VSIX}"
  code --install-extension "${VSIX}" --force
  echo
  echo "Installed. Reload VS Code (Cmd+Shift+P → 'Developer: Reload Window')."
fi
