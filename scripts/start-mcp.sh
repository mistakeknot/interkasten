#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/../server" && pwd)"
PID_FILE="${HOME}/.interkasten/daemon.pid"
STALE_THRESHOLD=120  # seconds — heartbeat older than this means stale

# Load .env if token not already set
if [ -z "${INTERKASTEN_NOTION_TOKEN:-}" ] && [ -f "${HOME}/.interkasten/.env" ]; then
  set -a
  . "${HOME}/.interkasten/.env"
  set +a
fi

# Auto-discover Notion token from Notion MCP plugin config if still unset
if [ -z "${INTERKASTEN_NOTION_TOKEN:-}" ]; then
  for mcp_config in "${HOME}/.claude/.mcp.json" ".mcp.json"; do
    if [ -f "$mcp_config" ]; then
      discovered=$(node -e "
        try {
          const cfg = JSON.parse(require('fs').readFileSync('$mcp_config', 'utf-8'));
          for (const s of Object.values(cfg.mcpServers || {})) {
            const isNotion = (s.command || '').includes('@notionhq/notion-mcp-server') ||
              (s.args || []).some(a => a.includes('@notionhq/notion-mcp-server'));
            if (!isNotion || !s.env?.OPENAPI_MCP_HEADERS) continue;
            const h = JSON.parse(s.env.OPENAPI_MCP_HEADERS);
            const m = (h.Authorization || h.authorization || '').match(/^Bearer\s+(\S+)$/i);
            if (m) { console.log(m[1]); process.exit(0); }
          }
        } catch {}
      " 2>/dev/null || true)
      if [ -n "${discovered:-}" ]; then
        export INTERKASTEN_NOTION_TOKEN="$discovered"
        echo "interkasten: Notion token auto-discovered from $mcp_config" >&2
        break
      fi
    fi
  done
fi

# --- Stale process cleanup ---
# Kill any interkasten MCP server processes with stale heartbeats.
cleanup_stale_processes() {
  local now
  now=$(date +%s)

  # 1. Check PID file for a known stale process
  if [ -f "$PID_FILE" ]; then
    local pid heartbeat heartbeat_epoch age
    pid=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PID_FILE','utf-8')).pid||'')}catch{console.log('')}" 2>/dev/null || true)
    heartbeat=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PID_FILE','utf-8')).heartbeat||'')}catch{console.log('')}" 2>/dev/null || true)

    if [ -n "$pid" ] && [ "$pid" != "$$" ]; then
      if kill -0 "$pid" 2>/dev/null; then
        # Process alive — check heartbeat staleness
        if [ -n "$heartbeat" ]; then
          heartbeat_epoch=$(date -d "$heartbeat" +%s 2>/dev/null || echo "0")
          age=$(( now - heartbeat_epoch ))
          if [ "$age" -gt "$STALE_THRESHOLD" ]; then
            echo "interkasten: killing stale process $pid (heartbeat ${age}s old)" >&2
            kill "$pid" 2>/dev/null || true
            sleep 0.5
            kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
          fi
        else
          # No heartbeat at all — process never wrote one, treat as stale
          echo "interkasten: killing process $pid (no heartbeat)" >&2
          kill "$pid" 2>/dev/null || true
          sleep 0.5
          kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
        fi
      else
        # Process dead — clean up PID file
        rm -f "$PID_FILE"
      fi
    fi
  fi

  # 2. Sweep for any orphaned interkasten node processes not covered by PID file
  local server_entry="$SERVER_DIR/dist/index.js"
  local pids
  pids=$(pgrep -f "node.*${server_entry}" 2>/dev/null || true)
  for p in $pids; do
    # Skip our own shell process
    [ "$p" = "$$" ] && continue
    # Check /proc/<pid>/stat to see if it's actually a node process
    if [ -d "/proc/$p" ]; then
      # Read the process's PID file heartbeat if it matches the PID file
      local file_pid=""
      [ -f "$PID_FILE" ] && file_pid=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PID_FILE','utf-8')).pid||'')}catch{console.log('')}" 2>/dev/null || true)
      if [ "$p" = "$file_pid" ]; then
        continue  # Already handled above
      fi
      echo "interkasten: killing orphaned process $p" >&2
      kill "$p" 2>/dev/null || true
      sleep 0.3
      kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true
    fi
  done
}

cleanup_stale_processes

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
