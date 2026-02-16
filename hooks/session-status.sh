#!/bin/bash
# interkasten SessionStart hook — print brief status if configured
#
# Input: Notification JSON on stdin (SessionStart event)
# Output: JSON with additionalContext if interkasten is configured
set -euo pipefail

CONFIG_FILE="${HOME}/.interkasten/config.yaml"
DB_FILE="${HOME}/.interkasten/interkasten.db"

# Quick exit if interkasten isn't configured
[[ -f "$CONFIG_FILE" ]] || exit 0

# Build status parts
parts=()

# Check if database exists and count projects
if [[ -f "$DB_FILE" ]] && command -v sqlite3 &>/dev/null; then
    project_count=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM entity_map WHERE entity_type='project' AND deleted_at IS NULL;" 2>/dev/null || echo "?")
    wal_count=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM sync_wal;" 2>/dev/null || echo "0")
    conflict_count=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM entity_map WHERE conflict_detected_at IS NOT NULL AND deleted = 0;" 2>/dev/null || echo "0")
    parts+=("${project_count} projects")
    if [[ "$wal_count" != "0" ]]; then
        parts+=("${wal_count} pending sync ops")
    fi
    if [[ "$conflict_count" != "0" ]]; then
        parts+=("⚠️ ${conflict_count} unresolved conflicts")
    fi
else
    parts+=("configured")
fi

# Check Notion token
if [[ -z "${INTERKASTEN_NOTION_TOKEN:-}" ]]; then
    parts+=("token not set")
fi

# Join parts
status=$(IFS=", "; echo "${parts[*]}")

# Output as additionalContext
cat <<EOF
{"additionalContext": "interkasten: ${status}"}
EOF
