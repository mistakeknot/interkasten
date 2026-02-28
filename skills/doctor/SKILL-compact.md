# interkasten:doctor (compact)

Self-diagnosis and health check for interkasten — cascading checklist verifying installation and operation.

## When to Invoke

"check interkasten", "interkasten health", "is interkasten working", "diagnose interkasten", or `/interkasten:doctor`.

## Workflow

Run checks in order. If an early check fails, skip dependent checks and show remediation.

1. **Config file** — `interkasten_config_get`. Fail = skip all remaining.
2. **Notion token** — Call `interkasten_health`. If token missing: guide user to create integration at notion.so/profile/integrations, save token to `~/.interkasten/.env`, `chmod 600`. If MCP unreachable: skip checks 4-7.
3. **MCP server status** — From health response: version, uptime, PID, memory (warn >200MB)
4. **SQLite database** — `sqlite.connected` from health response
5. **Notion connection** — Circuit state (closed=healthy, open=failing), consecutive failures (>5=error)
6. **Workspace & projects** — `interkasten_list_projects`. 0 projects = warn, check for orphans
7. **WAL status** — `wal.pending_entries` from health. >0 = warn "run interkasten_sync"
8. **Hooks** — Report hook count from `hooks/hooks.json` (informational only)

## Output Format

```
interkasten doctor
 Config file         ~/.interkasten/config.yaml found
 Notion token        Set (INTERKASTEN_NOTION_TOKEN)
 MCP server          Running (v0.3.12, PID 12345, uptime 4h, 45MB)
...
8/8 checks passed.
```

Status indicators: checkmark (pass), warning (warn), cross (fail), `--` (skipped).

If failures: end with numbered remediation steps.

---
*For detailed check logic and error handling, read SKILL.md.*
