#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/../server" && pwd)"

# Auto-install dependencies if missing
if [ ! -d "$SERVER_DIR/node_modules" ]; then
  echo "Installing interkasten-server dependencies..." >&2
  cd "$SERVER_DIR"
  npm install --no-fund --no-audit 2>&1 | tail -5 >&2
fi

# Auto-build if dist is missing or stale
if [ ! -f "$SERVER_DIR/dist/index.js" ]; then
  echo "Building interkasten-server..." >&2
  cd "$SERVER_DIR"
  npx tsc 2>&1 | tail -5 >&2
fi

exec node "$SERVER_DIR/dist/index.js" "$@"
