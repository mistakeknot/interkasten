#!/bin/bash
# interkasten Setup Hook — ensure MCP server is built
# Runs once when the plugin is installed or updated.
# Must complete within 30s (Claude Code setup hook timeout).

set +e  # Never fail the hook

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/../server" && pwd)"

# Auto-install dependencies if missing
if [ ! -d "$SERVER_DIR/node_modules" ]; then
    echo "interkasten: installing server dependencies..."
    (cd "$SERVER_DIR" && npm install --no-fund --no-audit 2>&1 | tail -3) >&2
fi

# Auto-build if dist is missing
if [ ! -f "$SERVER_DIR/dist/index.js" ]; then
    echo "interkasten: building MCP server..."
    (cd "$SERVER_DIR" && npx tsc 2>&1 | tail -3) >&2
fi

# Verify build succeeded
if [ -f "$SERVER_DIR/dist/index.js" ]; then
    echo "interkasten: MCP server ready"
else
    echo "interkasten: WARNING — MCP server build failed. Run: cd server && npm install && npx tsc"
fi
