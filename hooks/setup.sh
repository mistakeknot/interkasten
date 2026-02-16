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

# Check for Notion token — guide agent to ask user
ENV_FILE="${HOME}/.interkasten/.env"
if [ -z "${INTERKASTEN_NOTION_TOKEN:-}" ]; then
    if [ -f "$ENV_FILE" ] && grep -q 'INTERKASTEN_NOTION_TOKEN=' "$ENV_FILE" 2>/dev/null; then
        : # Token exists in .env, will be loaded by start-mcp.sh
    else
        echo ""
        echo "interkasten: Notion token not configured. To set up, create an integration at https://www.notion.so/profile/integrations and paste the token here — I'll save it for you."
    fi
fi
