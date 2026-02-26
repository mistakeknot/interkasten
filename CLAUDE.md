# interkasten

Claude Code plugin + MCP server for bidirectional Notion sync with adaptive AI documentation.

## Quick Start

```bash
cd server && npm install && npm run build
npm test  # 130 tests (121 unit + 9 integration, integration skipped without INTERKASTEN_TEST_TOKEN)
```

## Architecture

```
server/src/
├── index.ts              # MCP entry point (startup sequence)
├── config/               # Zod schemas, YAML loader, defaults
├── store/                # SQLite via Drizzle ORM (entity_map, base_content, sync_log, sync_wal, beads_snapshot)
├── sync/                 # Watcher, queue, translator, engine, NotionClient, NotionPoller, merge, beads-sync, triage, entity-map, linked-refs
└── daemon/
    ├── context.ts        # Shared DaemonContext passed to all tools
    └── tools/            # MCP tool handlers
        ├── health.ts     # Liveness probe
        ├── config.ts     # Config get/set
        ├── version.ts    # Version info
        ├── init.ts       # Setup wizard + project discovery (DiscoveredProject tree)
        ├── projects.ts   # CRUD for projects (list, get, register, unregister, refresh key docs)
        ├── sync.ts       # Sync trigger + status + log (push, pull, both directions)
        ├── issues.ts     # Beads ↔ Notion issue sync tool
        ├── triage.ts     # Legacy tier classification (prefer gather_signals)
        ├── signals.ts    # Raw filesystem/git signals + file scanning
        └── hierarchy.ts  # Scan preview, parent/tags CRUD, database property management
```

## Agent-Native Design

Tools expose raw signals and CRUD operations. Intelligence lives in Claude Code skills:

- **No hardcoded classification** — `gather_signals` returns LOC, commits, markers; agent proposes tiers
- **No hardcoded tag vocabulary** — `set_project_tags` accepts any strings
- **No cascade logic** — `unregister_project` handles one entity; agent orchestrates
- **No auto-file-selection** — `scan_files` lists files; agent + user pick what to sync

## MCP Tools (21 registered)

| Tool | Description |
|------|-------------|
| `interkasten_health` | Liveness probe: uptime, SQLite, Notion, circuit breaker, WAL |
| `interkasten_config_get` | Read config (full or by key path) |
| `interkasten_config_set` | Update config value |
| `interkasten_version` | Daemon + schema version |
| `interkasten_init` | First-time setup: validate token, create/find database |
| `interkasten_list_projects` | List projects with hierarchy, tags, key doc status |
| `interkasten_get_project` | Project detail: docs, parent, children, tags, key docs |
| `interkasten_register_project` | Register project with agent-specified Notion properties |
| `interkasten_unregister_project` | Stop tracking (soft-delete, preserves Notion pages) |
| `interkasten_refresh_key_docs` | Update key doc URL columns in Notion |
| `interkasten_gather_signals` | Raw filesystem/git signals for a project |
| `interkasten_scan_files` | Scan project for files matching a pattern |
| `interkasten_scan_preview` | Non-destructive tree discovery with signals (writes nothing) |
| `interkasten_set_project_parent` | Set/change project parent (with Notion relation) |
| `interkasten_set_project_tags` | Set tags (with Notion multi-select) |
| `interkasten_add_database_property` | Add property to Projects database (idempotent) |
| `interkasten_sync` | Trigger sync: push, pull, or both directions |
| `interkasten_sync_status` | Pending ops, errors, circuit breaker state |
| `interkasten_sync_log` | Query sync history |
| `interkasten_conflicts` | List unresolved merge conflicts with content previews |
| `interkasten_list_issues` | List synced beads issues with Notion page IDs |
| `interkasten_triage` | Legacy: hardcoded tier classification (prefer gather_signals) |

## Hierarchy

- `.beads` is the hierarchy marker — nearest ancestor with `.beads` = parent
- `.git` is a project detection marker only (doesn't imply parentage)
- Intermediate directories without markers are transparent (traversed, not registered)
- Symlinks deduplicated via `realpathSync()`
- Parent-child stored as `parent_id` FK in `entity_map`
- Tags stored as JSON text column `tags`

## Key Patterns

- **Bidirectional sync**: push (local → Notion) + pull (Notion → local) with 60s polling
- **Three-way merge**: `node-diff3` with configurable conflict strategy (local-wins default fallback)
- **WAL protocol**: pending → target_written → committed → delete (crash recovery, both directions)
- **Circuit breaker**: closed → open (after N failures) → half-open → closed
- **Content hashing**: SHA-256 of normalized markdown
- **Soft-delete safety**: 30-day retention before GC (aligned with Notion trash)
- **Beads sync**: Diff-based issue sync via `bd` CLI with snapshot tracking
- **Path validation**: `resolve() + startsWith(projectDir + "/")` on all pull operations
- **Doc containment**: `parent_id` FK queries (not path prefix `startsWith`)

## Skills

- `/interkasten:onboard` — Classification, doc generation, drift baselines, sync
- `/interkasten:interkasten-doctor` — Self-diagnosis: config, token, MCP server, database, sync health

**Note:** Layout skill moved to the **intertree** plugin (`/intertree:layout`). Hierarchy MCP tools (`scan_preview`, `set_project_parent`, `set_project_tags`, `gather_signals`, `scan_files`) remain in interkasten for now (require DaemonContext).

## Hooks

- **SessionStart** — Print brief status (project count, pending WAL, unresolved conflicts) if interkasten is configured
- **Stop** — Warn if pending sync operations exist

## Config

`~/.interkasten/config.yaml` — see `docs/PRD-MVP.md §11` for full reference.

## Environment

```bash
export INTERKASTEN_NOTION_TOKEN="ntn_..."  # Required for Notion sync
```
