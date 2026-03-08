# Sync Engine

## Bidirectional Sync (v0.4.0)

- **Push**: local file change → chokidar detects → queue → translate to Notion blocks → API write
- **Pull**: NotionPoller (60s, configurable) → content hash check → translate to markdown → write local file
- **Merge**: when both sides changed since base, three-way merge via `node-diff3`
- **Conflict strategies**: `three-way-merge` (default), `local-wins`, `notion-wins`, `conflict-file`
- **Roundtrip normalization**: after push, pull-back content stored as base (prevents phantom conflicts)

## WAL Protocol (crash recovery)

Every sync operation follows: `pending` → `target_written` → `committed` → delete WAL entry. If process crashes mid-sync, WAL entries survive and are replayed on restart.

### WAL Detail

- States: pending → target_written → committed → delete
- **Every write path** must participate — not just the clean pull path
- Conflict resolution, error recovery, and cleanup paths need WAL too
- WAL entry lifetime = first mutation → last side effect (push to Notion)
- See `docs/guides/data-integrity-patterns.md` for the full pattern

## Multi-Workspace Token Resolution (v0.4.20)

Supports multiple Notion workspaces via named token aliases in config. Each unique token gets its own `NotionClient` instance with independent rate limiter and circuit breaker.

- **Resolution chain**: explicit tool param → stored `token_alias` → `notion.database_tokens[id]` → `notion.project_tokens[path]` → global `INTERKASTEN_NOTION_TOKEN`
- **Client pool**: keyed by resolved token value (not alias), so identical tokens share rate limits
- **Token alias persistence**: stored in `database_schemas.token_alias` on first track, used automatically on refresh
- **Config**: `notion.tokens` (alias → `${ENV_VAR}`), `notion.database_tokens` (database_id → alias), `notion.project_tokens` (path → alias)

## Circuit Breaker

Notion API errors tracked; after N consecutive failures, circuit opens (stops API calls). Half-open after cooldown allows a probe request. Prevents cascading failures.

- States: closed → open (10 failures) → half-open → closed

## Content Hashing

SHA-256 of normalized markdown. Used for change detection (skip no-op syncs) and base content dedup.

## Queue Dedup

By (side, entityKey), latest operation wins.

## Beads Issue Sync

Diff-based: snapshot current beads state, compare against last-known state, sync deltas to Notion Issues database per project. Uses `execFileSync` (not `execSync`) to prevent shell injection.
