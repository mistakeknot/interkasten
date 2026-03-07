# MCP Tools (21 registered)

## Infrastructure (4 tools)

| Tool | Description |
|------|-------------|
| `interkasten_health` | Liveness probe: uptime, SQLite, Notion, circuit breaker, WAL |
| `interkasten_config_get` | Read config (full or by key path) |
| `interkasten_config_set` | Update config value |
| `interkasten_version` | Daemon + schema version |

## Project Management (7 tools)

| Tool | Description |
|------|-------------|
| `interkasten_init` | First-time setup: validate token, create/find database |
| `interkasten_list_projects` | List projects with hierarchy, tags, key doc status |
| `interkasten_get_project` | Project detail: docs, parent, children, tags |
| `interkasten_register_project` | Register project with agent-specified Notion properties |
| `interkasten_unregister_project` | Stop tracking (soft-delete, preserves Notion pages) |
| `interkasten_link` | Link a Notion page to a local directory — no full init required |
| `interkasten_refresh_key_docs` | Update key doc URL columns in Notion |
| `interkasten_add_database_property` | Add property to Projects database (idempotent) |

## Hierarchy & Signals (5 tools)

| Tool | Description |
|------|-------------|
| `interkasten_scan_preview` | Non-destructive tree discovery with signals (writes nothing) |
| `interkasten_gather_signals` | Raw filesystem/git signals for a project |
| `interkasten_scan_files` | Scan project for files matching a pattern |
| `interkasten_set_project_parent` | Set/change project parent (with Notion relation) |
| `interkasten_set_project_tags` | Set tags (with Notion multi-select) |

## Sync Operations (5 tools)

| Tool | Description |
|------|-------------|
| `interkasten_sync` | Trigger sync: push, pull, or both directions |
| `interkasten_sync_status` | Pending ops, errors, circuit breaker state |
| `interkasten_sync_log` | Query sync history |
| `interkasten_conflicts` | List unresolved merge conflicts with content previews |
| `interkasten_list_issues` | List synced beads issues with Notion page IDs |

## Legacy (1 tool)

| Tool | Description |
|------|-------------|
| `interkasten_triage` | Hardcoded tier classification (prefer `gather_signals`) |
