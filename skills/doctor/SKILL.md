# interkasten:doctor — Self-Diagnosis & Health Check

Run a cascading diagnostic checklist to verify interkasten is correctly installed and operating.

## Trigger

Use when: user says "check interkasten", "interkasten health", "is interkasten working", "diagnose interkasten", or invokes `/interkasten:doctor`.

## Workflow

Run checks in order. If an early check fails, skip dependent checks and show remediation.

### Check 1: Config File

Check if `~/.interkasten/config.yaml` exists by calling `interkasten_config_get`.

- **Pass**: Config loaded successfully
- **Fail**: "Config file missing. Run `interkasten_init` to create it, or create `~/.interkasten/config.yaml` manually."

If this check fails, skip to the summary — without config, nothing else works.

### Check 2: Notion Token

Check if `INTERKASTEN_NOTION_TOKEN` environment variable is set. You can infer this from the `interkasten_health` response or `interkasten_init` behavior.

Call `interkasten_health` to get the full status. If the call succeeds, the MCP server is running (Check 3 passes implicitly).

- **Pass**: Token is set and MCP server responded
- **Fail (token missing)**: Show setup instructions:
  1. Go to https://www.notion.so/my-integrations
  2. Create a "interkasten" integration
  3. Copy the Internal Integration Secret (starts with `ntn_`)
  4. `export INTERKASTEN_NOTION_TOKEN='ntn_...'`
  5. Add to `.bashrc`/`.zshrc` for persistence
  6. Restart Claude Code
- **Fail (MCP unreachable)**: "MCP server not responding. Check that the interkasten plugin is installed (`claude plugins list`) and the server process is running."

If MCP is unreachable, mark checks 4-7 as "skipped (MCP unavailable)".

### Check 3: MCP Server Status

Parsed from the `interkasten_health` response (already called in Check 2):

- **Version**: Report daemon version
- **Uptime**: Report uptime
- **PID**: Report process ID
- **Memory**: Report RSS in MB (warn if >200MB)

### Check 4: SQLite Database

From the health response:

- **Pass**: `sqlite.connected` is true
- **Fail**: "SQLite database not connected. Path: {sqlite.path}. Try restarting the MCP server."

### Check 5: Notion Connection

From the health response:

- **Circuit state**: closed = healthy, open = failing, half-open = recovering
- **Last success**: When was the last successful API call
- **Consecutive failures**: 0 = good, >0 = warn, >5 = error
- **Pass**: Circuit closed, consecutive failures = 0
- **Warn**: Circuit half-open or 1-4 consecutive failures
- **Fail**: Circuit open or 5+ failures — "Notion API is failing. Check your token permissions and Notion's status page."

### Check 6: Workspace & Projects

Call `interkasten_list_projects`:

- Report total project count
- Report breakdown by doc tier (Product/Tool/Inactive) if available
- If 0 projects: warn "No projects registered. Run `/interkasten:layout` to discover and register projects."
- Check for orphaned projects (registered but local path doesn't exist) — warn for each

### Check 7: WAL Status

From the health response:

- **Pass**: `wal.pending_entries` = 0 — "Clean (no pending operations)"
- **Warn**: `wal.pending_entries` > 0 — "N pending sync operations. Run `interkasten_sync` to flush."

### Check 8: Hooks

Report whether hooks are defined in `hooks/hooks.json`. This is informational — empty hooks is not an error.

- **Info**: "N hooks defined" or "No hooks defined (status notifications disabled)"

## Output Format

Present results as a formatted checklist:

```
interkasten doctor

 Config file         ~/.interkasten/config.yaml found
 Notion token        Set (INTERKASTEN_NOTION_TOKEN)
 MCP server          Running (v0.3.12, PID 12345, uptime 4h, 45MB)
 SQLite              Connected
 Notion connection   Healthy (circuit closed, last success 5m ago)
 Projects            18 registered (12 Product, 4 Tool, 2 Inactive)
 WAL                 Clean (0 pending)
 Hooks               2 hooks defined (SessionStart, Stop)

8/8 checks passed.
```

Use these status indicators:
- ` ` (checkmark) for pass
- ` ` (warning) for warn
- ` ` (cross) for fail
- `--` for skipped

If any checks failed, end with remediation summary:

```
5/8 checks passed. 1 failed. 2 skipped.

To fix:
1. Set INTERKASTEN_NOTION_TOKEN (see above for instructions)
2. Skipped checks will pass once the Notion token is configured
```

## Error Handling

- If `interkasten_health` tool is not available at all (not in tool list), the MCP server plugin is not installed. Tell the user: "interkasten MCP server not found. Install the plugin: `claude plugins install https://github.com/mistakeknot/interkasten`"
- If any individual check throws an unexpected error, catch it, report as fail with the error message, and continue to the next check.
