# interkasten

Claude Code plugin + MCP server for bidirectional Notion sync with adaptive AI documentation.

## Quick Start

```bash
cd server && npm install && npm run build
npm test  # 130 tests (121 unit + 9 integration, integration skipped without INTERKASTEN_TEST_TOKEN)
```

## Architecture

TypeScript MCP server in `server/src/`: config (Zod), store (Drizzle/SQLite), sync engine (bidirectional with WAL), daemon tools (21 MCP handlers). See [AGENTS.md](./AGENTS.md) for full tool listing and source tree.

**Agent-native design:** Tools expose raw signals and CRUD. No hardcoded classification, tag vocabulary, cascade logic, or auto-file-selection — intelligence lives in skills.

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
