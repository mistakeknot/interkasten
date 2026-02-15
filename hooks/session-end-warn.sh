#!/bin/bash
# interkasten Stop hook — warn if pending WAL entries exist
#
# Input: Notification JSON on stdin (Stop event)
# Output: JSON with additionalContext if there are pending operations
set -euo pipefail

DB_FILE="${HOME}/.interkasten/interkasten.db"

# Quick exit if no database
[[ -f "$DB_FILE" ]] || exit 0

# Check for pending WAL entries
if command -v sqlite3 &>/dev/null; then
    wal_count=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM sync_wal;" 2>/dev/null || echo "0")
    if [[ "$wal_count" != "0" && "$wal_count" != "?" ]]; then
        cat <<EOF
{"additionalContext": "interkasten: ${wal_count} pending sync operations. Run interkasten_sync to flush before closing."}
EOF
        exit 0
    fi
fi

# Nothing to report
exit 0
