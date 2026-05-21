#!/usr/bin/env bash
# Bootstrap Ollama for claude-sessions-vscode.
#
# Steps (idempotent — re-run anytime):
#   1. Install Ollama if missing (brew on macOS, install.sh on Linux).
#   2. Start the daemon (brew services on macOS, systemd / background on Linux).
#   3. Pull the models the extension uses:
#        - llama3.2:3b         (topic classifier)
#        - nomic-embed-text    (agent-graph embeddings)
#   4. Sanity-check the API at OLLAMA_HOST (default 127.0.0.1:11434).
#
# Override the models with env vars:
#   CLASSIFY_MODEL=qwen2.5:3b EMBED_MODEL=mxbai-embed-large ./scripts/ollama-setup.sh

set -euo pipefail

CLASSIFY_MODEL="${CLASSIFY_MODEL:-llama3.2:3b}"
EMBED_MODEL="${EMBED_MODEL:-nomic-embed-text}"
OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
OLLAMA_URL="http://${OLLAMA_HOST}"

# ---- 1. install ----
if ! command -v ollama >/dev/null 2>&1; then
  echo "==> Ollama not found; installing"
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        brew install ollama
      else
        echo "Install Homebrew first, or download manually from https://ollama.com/download" >&2
        exit 1
      fi
      ;;
    Linux)
      curl -fsSL https://ollama.com/install.sh | sh
      ;;
    *)
      echo "Unsupported OS '$(uname -s)' — install Ollama manually from https://ollama.com/download" >&2
      exit 1
      ;;
  esac
else
  echo "==> Ollama: $(ollama --version 2>/dev/null | head -n 1) — already installed"
fi

# ---- 2. start daemon ----
api_up() {
  curl -fsS --connect-timeout 2 "${OLLAMA_URL}/api/tags" >/dev/null 2>&1
}

if api_up; then
  echo "==> Ollama API reachable at ${OLLAMA_URL}"
else
  echo "==> starting Ollama daemon"
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1 && brew services list 2>/dev/null | grep -q '^ollama'; then
        brew services start ollama >/dev/null
      else
        # Foreground fallback: spawn detached.
        nohup ollama serve >/tmp/ollama.log 2>&1 &
      fi
      ;;
    Linux)
      if systemctl --user is-enabled ollama >/dev/null 2>&1; then
        systemctl --user start ollama
      elif command -v systemctl >/dev/null 2>&1 && systemctl is-enabled ollama >/dev/null 2>&1; then
        sudo systemctl start ollama
      else
        nohup ollama serve >/tmp/ollama.log 2>&1 &
      fi
      ;;
  esac

  # Wait up to 15 seconds for the API to come up.
  for _ in $(seq 1 30); do
    sleep 0.5
    if api_up; then
      echo "==> Ollama API came up at ${OLLAMA_URL}"
      break
    fi
  done
  if ! api_up; then
    echo "Ollama daemon did not come up at ${OLLAMA_URL}. Check 'ollama serve' or /tmp/ollama.log." >&2
    exit 1
  fi
fi

# ---- 3. pull models ----
pull_if_missing() {
  local model="$1"
  if ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "${model}"; then
    echo "==> ${model} already present"
  else
    echo "==> pulling ${model}"
    ollama pull "${model}"
  fi
}

pull_if_missing "${CLASSIFY_MODEL}"
pull_if_missing "${EMBED_MODEL}"

# ---- 4. sanity check ----
echo
echo "==> models served by Ollama:"
ollama list 2>/dev/null | sed 's/^/    /'

cat <<EOF

Done. The extension defaults match this setup; if you used non-default models,
set them in VS Code:

  claudeSessions.classify.model          = ${CLASSIFY_MODEL}
  claudeSessions.embedding.ollamaModel   = ${EMBED_MODEL}
  claudeSessions.embedding.ollamaUrl     = ${OLLAMA_URL}
EOF
