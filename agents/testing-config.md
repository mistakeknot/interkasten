# Testing, Configuration & Operations

## Testing

```bash
cd server && npm test                    # 261 unit tests
INTERKASTEN_TEST_TOKEN=ntn_... npm test  # + 9 integration tests
```

Test structure mirrors source:

- `tests/config/` — config loader tests
- `tests/store/` — entity CRUD, WAL state machine, page tracking tests
- `tests/sync/` — translator, merge, beads-sync, triage, hierarchy, poller, engine, linked-refs, soft-delete, key-docs, token-resolver
- `tests/integration/` — end-to-end Notion API tests (skipped without token)

## Configuration

`~/.interkasten/config.yaml` — key settings:

| Key | Default | Description |
|-----|---------|-------------|
| `projects_dir` | `/root/projects` | Root directory to scan for projects |
| `sync.poll_interval` | `60` | Notion polling interval (seconds) |
| `sync.conflict_strategy` | `three-way-merge` | Merge conflict fallback |
| `project_detection.markers` | `[".beads", ".git"]` | Files that indicate a project |
| `project_detection.max_depth` | `4` | Max scan depth |
| `notion.tokens` | `{}` | Named token aliases for multi-workspace sync |
| `notion.database_tokens` | `{}` | Database ID → token alias overrides |
| `notion.project_tokens` | `{}` | Project path → token alias overrides |

## Environment

```bash
export INTERKASTEN_NOTION_TOKEN="ntn_..."  # Required for Notion sync (default token)
export INTERKASTEN_TEST_TOKEN="ntn_..."    # For integration tests (can be same token)
# Optional: additional tokens for multi-workspace sync
export NOTION_TOKEN_WORK="ntn_..."         # Referenced as ${NOTION_TOKEN_WORK} in config
```

## Common Tasks

### Register a new project

```
1. interkasten_scan_preview → see discovered projects
2. interkasten_register_project → register with Notion
3. interkasten_set_project_parent → place in hierarchy
4. interkasten_set_project_tags → classify
5. interkasten_sync(direction: "push") → initial sync
```

### Debug sync issues

```
1. interkasten_health → check SQLite, Notion, circuit breaker
2. interkasten_sync_status → pending ops, errors
3. interkasten_sync_log → recent operations
4. interkasten_conflicts → unresolved merge conflicts
```

### Diagnose configuration

Run `/interkasten:interkasten-doctor` — checks config file, Notion token, MCP server connectivity, database schema, and sync health.

## Gotchas

- `process.memoryUsage.rss()` not `.rss` — it's a function in newer Node
- `notion-to-md` returns `{ parent: string }` in newer versions, not just string
- Zod from MCP SDK peer dep is sufficient — no need for separate install
- `drizzle-orm` `lt()` on nullable column needs `!` assertion
- `better-sqlite3` is a native addon — can't be bundled with esbuild
- Bootstrap approach: `start-mcp.sh` runs `npm install` if `node_modules` missing

## Status (as of v0.4.20)

- Phases 0-3 complete (scaffold, foundation, push sync, bidirectional sync)
- 27 MCP tools, 261 tests, 3 skills, 2 hooks
- @notionhq/client upgraded from v2 to v5 (data source model)
- Multi-workspace Notion tokens with resolution chain (v0.4.20)
- Next candidates: webhook receiver (P2, deferred to v0.5.x), interphase context integration (P2)
