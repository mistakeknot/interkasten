# Database Schema (5 tables)

## entity_map

Maps local filesystem entities to Notion page IDs. Each row = one synced entity.

| Column | Type | Description |
|--------|------|-------------|
| `local_path` | text, unique | Filesystem path |
| `notion_id` | text, unique | Notion page/database ID |
| `entity_type` | text | `project`, `doc`, `ref`, `issue` |
| `tier` | text | `T1` (full sync) or `T2` (summary card) |
| `doc_tier` | text | `Product`, `Tool`, `Inactive` (project-level triage) |
| `parent_id` | integer FK | Self-referential hierarchy (null = top-level) |
| `tags` | text | JSON array of tag strings |
| `last_local_hash` | text | SHA-256 of local content |
| `last_notion_hash` | text | SHA-256 of Notion content |
| `last_notion_ver` | text | Notion `last_edited_time` (polling fast-path) |
| `base_content_id` | integer FK | → base_content (merge ancestor) |
| `conflict_*` | various | Conflict tracking (detected_at, local/notion content IDs) |
| `deleted` / `deleted_at` | boolean/text | Soft-delete (30-day retention) |

## base_content

Content-addressed store for three-way merge base snapshots.

## sync_log

Append-only operation log. Operations: `push`, `pull`, `merge`, `conflict`, `error`. Directions: `local_to_notion`, `notion_to_local`.

## sync_wal

Write-ahead log for crash recovery. States: `pending` → `target_written` → `committed` → `rolled_back`.

## beads_snapshot

Snapshot of beads issue state for diff-based sync. Tracks last-known state to detect changes.
