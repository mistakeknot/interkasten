# Interkasten

Claude Code plugin + MCP server for bidirectional Notion sync with adaptive AI documentation.

## Quick Start

```bash
cd server && npm install && npm run build
npm test  # 62 tests
```

## Architecture

```
server/src/
├── index.ts              # MCP entry point (startup sequence)
├── config/               # Zod schemas, YAML loader, defaults
├── store/                # SQLite via Drizzle ORM (entity_map, base_content, sync_log, sync_wal)
├── sync/                 # Watcher, queue, translator, engine, NotionClient, triage
└── daemon/
    ├── context.ts        # Shared DaemonContext passed to all tools
    └── tools/            # MCP tool handlers (health, config, version, init, projects, sync, triage)
```

## MCP Tools (13 registered)

| Tool | Description |
|------|-------------|
| `interkasten_health` | Liveness probe: uptime, SQLite, Notion, circuit breaker, WAL |
| `interkasten_config_get` | Read config (full or by key path) |
| `interkasten_config_set` | Update config value |
| `interkasten_version` | Daemon + schema version |
| `interkasten_init` | First-time setup wizard (now with triage) |
| `interkasten_list_projects` | List registered projects (tier-aware) |
| `interkasten_get_project` | Project detail with docs and tier gaps |
| `interkasten_register_project` | Manually register a project |
| `interkasten_unregister_project` | Stop tracking (preserves Notion pages) |
| `interkasten_triage` | Classify projects into doc tiers (Product/Tool/Inactive) |
| `interkasten_sync` | Trigger sync (one project or all) |
| `interkasten_sync_status` | Pending ops, errors, circuit breaker state |
| `interkasten_sync_log` | Query sync history |

## Key Patterns

- **WAL protocol**: pending → target_written → committed → delete (crash recovery)
- **Circuit breaker**: closed → open (after N failures) → half-open → closed
- **Content hashing**: SHA-256 of normalized markdown (whitespace, line endings, blank lines)
- **Roundtrip base**: After push, pull-back content stored as merge base
- **Doc tiers**: Product (5 docs) / Tool (2 docs) / Inactive (none) — auto-classified from project signals

## Config

`~/.interkasten/config.yaml` — see `docs/PRD-MVP.md §11` for full reference.

## Environment

```bash
export INTERKASTEN_NOTION_TOKEN="ntn_..."  # Required for Notion sync
```

## Current Status

- **Phases 0-2 complete**: Scaffold, foundation (config/store/NotionClient), push sync
- **Phase 3+ deferred**: Pull sync, merge, plugin hooks/commands/skills, pagent engine
