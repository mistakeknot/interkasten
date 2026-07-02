#!/usr/bin/env bash
set -euo pipefail

# Full IdeaGUI sync pipeline: Notion → markdown → JSON → git push
#
# Usage: ./scripts/sync-ideagui.sh
#   Requires INTERKASTEN_NOTION_TOKEN in env or ~/.interkasten/.env

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IDEAGUI_DIR="${HOME}/projects/transfer/ideagui"

# Load token from .env if not already set
if [ -z "${INTERKASTEN_NOTION_TOKEN:-}" ] && [ -f "${HOME}/.interkasten/.env" ]; then
  set -a
  . "${HOME}/.interkasten/.env"
  set +a
fi

if [ -z "${INTERKASTEN_NOTION_TOKEN:-}" ]; then
  echo "error: INTERKASTEN_NOTION_TOKEN not set" >&2
  exit 1
fi

# 1. Pull from Notion → markdown files
echo "==> Pulling from Notion..."
node "${SCRIPT_DIR}/track-ideagui.mjs" "${IDEAGUI_DIR}"

# 2. Transform markdown → ideagui.json
echo "==> Generating ideagui.json..."
node "${SCRIPT_DIR}/ideagui-to-json.mjs" "${IDEAGUI_DIR}" "${IDEAGUI_DIR}/ideagui.json"

# 3. Commit and push if there are changes
cd "${IDEAGUI_DIR}"
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "==> No changes to commit"
else
  git add -A
  ROWS=$(ls -1 *.md 2>/dev/null | grep -cv '^_index\.md$' || echo 0)
  git commit -m "sync: ${ROWS} sessions from Notion ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  git push
  echo "==> Pushed to origin/main"
fi

echo "==> Done"
