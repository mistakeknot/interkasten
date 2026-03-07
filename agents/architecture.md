# Architecture

## Source Tree

```
interkasten/
├── .claude-plugin/plugin.json  # Claude Code plugin manifest (v0.4.0)
├── server/
│   ├── package.json            # Node >=20, ESM, vitest
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts            # MCP entry point, startup sequence
│       ├── config/
│       │   ├── schema.ts       # Zod config schema
│       │   ├── defaults.ts     # Default config values
│       │   └── loader.ts       # YAML config loader (~/.interkasten/config.yaml)
│       ├── store/
│       │   ├── db.ts           # SQLite via better-sqlite3 + drizzle-orm
│       │   ├── schema.ts       # 5 tables: entity_map, base_content, sync_log, sync_wal, beads_snapshot
│       │   ├── entities.ts     # Entity CRUD, conflict tracking, soft-delete
│       │   ├── wal.ts          # WAL state machine: pending → target_written → committed → delete
│       │   └── sync-log.ts     # Append-only operation log
│       ├── sync/
│       │   ├── engine.ts       # Core sync engine (push, pull, merge orchestration)
│       │   ├── watcher.ts      # Chokidar file watcher for local changes
│       │   ├── queue.ts        # Sync operation queue with dedup
│       │   ├── translator.ts   # Markdown ↔ Notion block conversion
│       │   ├── notion-client.ts # Notion API wrapper with circuit breaker
│       │   ├── notion-poller.ts # 60s polling for Notion-side changes
│       │   ├── merge.ts        # Three-way merge via node-diff3
│       │   ├── beads-sync.ts   # Beads ↔ Notion issue sync (diff-based, snapshot tracking)
│       │   ├── linked-refs.ts  # T2 summary cards for linked references
│       │   ├── entity-map.ts   # Entity registration, lookup, hierarchy helpers
│       │   ├── key-docs.ts     # Key doc URL columns in Notion
│       │   └── triage.ts       # Legacy tier classification (prefer gather_signals)
│       └── daemon/
│           ├── context.ts      # Shared DaemonContext (db, config, notion, engine)
│           └── tools/
│               ├── health.ts   # Liveness probe
│               ├── config.ts   # Config get/set
│               ├── version.ts  # Version info
│               ├── init.ts     # Setup wizard + project discovery
│               ├── projects.ts # Project CRUD
│               ├── sync.ts     # Sync trigger + status + log
│               ├── issues.ts   # Beads ↔ Notion issue listing
│               ├── signals.ts  # Raw filesystem/git signals + file scanning
│               ├── hierarchy.ts # Scan preview, parent/tags CRUD, database properties
│               └── triage.ts   # Legacy tier tool
├── skills/
│   ├── layout/SKILL.md         # Interactive project discovery + hierarchy registration
│   ├── onboard/SKILL.md        # Classification, doc generation, drift baselines, sync
│   └── doctor/SKILL.md         # Self-diagnosis: config, token, MCP, database, sync health
├── commands/
│   ├── onboard.md              # /interkasten:onboard
│   └── doctor.md               # /interkasten:interkasten-doctor
├── hooks/
│   ├── hooks.json              # Hook registry (Setup, SessionStart, Stop)
│   ├── setup.sh                # Auto-build MCP server on install
│   ├── session-status.sh       # Print project count, pending WAL, conflicts
│   └── session-end-warn.sh     # Warn about pending sync operations
├── scripts/
│   └── start-mcp.sh            # Bootstrap: npm install if needed, then start
└── docs/
    ├── brainstorms/
    ├── plans/
    └── prds/
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server framework |
| `@notionhq/client` v5 | Notion API (data source model) |
| `@tryfabric/martian` | Markdown → Notion blocks |
| `notion-to-md` | Notion blocks → markdown |
| `better-sqlite3` | SQLite (native addon, can't bundle) |
| `drizzle-orm` | Type-safe ORM over SQLite |
| `node-diff3` | Three-way merge algorithm |
| `diff-match-patch-es` | Patch generation for conflict files |
| `chokidar` | Filesystem watching |
| `p-queue` | Concurrency-limited sync queue |
| `yaml` | Config file parsing |
| `zod` | Schema validation |

## Build Process

- Bootstrap script approach (not esbuild) — `tsc` only, `start-mcp.sh` handles `npm install`
- SQLite via better-sqlite3 + drizzle-orm (native addon, can't bundle)
