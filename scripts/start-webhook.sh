#!/usr/bin/env bash
set -euo pipefail

# Start the interkasten webhook daemon.
# Designed for systemd, pm2, or direct invocation.
#
# Usage:
#   ./scripts/start-webhook.sh              # foreground
#   systemctl start interkasten-webhook     # via systemd

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/../server" && pwd)"

# Load .env if token not already set
if [ -z "${INTERKASTEN_NOTION_TOKEN:-}" ] && [ -f "${HOME}/.interkasten/.env" ]; then
  set -a
  . "${HOME}/.interkasten/.env"
  set +a
fi

# Auto-install dependencies if missing
if [ ! -d "$SERVER_DIR/node_modules" ]; then
  echo "Installing interkasten-server dependencies..." >&2
  cd "$SERVER_DIR"
  npm install --no-fund --no-audit 2>&1 | tail -5 >&2
fi

# Auto-build if missing
if [ ! -f "$SERVER_DIR/dist/webhook-daemon.js" ]; then
  echo "Building interkasten-server..." >&2
  cd "$SERVER_DIR"
  npx tsc 2>&1 | tail -5 >&2
fi

exec node "$SERVER_DIR/dist/webhook-daemon.js" "$@"
