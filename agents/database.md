# Database Schema (7 tables)

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

## database_schemas

Stores Notion database schemas for tracked databases. Used to convert between frontmatter keys and Notion property names/types.

| Column | Type | Description |
|--------|------|-------------|
| `notion_database_id` | text, unique | Notion database/data source ID |
| `data_source_id` | text | Resolved Notion data source ID |
| `title` | text | Database title |
| `schema_json` | text | JSON-serialized property schema |
| `output_dir` | text | Local directory for row files |
| `token_alias` | text | Named token alias from config (null = default token) |
| `last_fetched_at` | text | Last fetch timestamp |

## page_tracking

Stores tracked Notion page roots for page-level sync. Child pages stored in entity_map with `page_child` type.

| Column | Type | Description |
|--------|------|-------------|
| `notion_page_id` | text, unique | Notion page ID |
| `title` | text | Page title |
| `output_dir` | text | Local directory for page files |
| `token_alias` | text | Named token alias (null = default token) |
| `recursive` | boolean | Pull child pages (default: true) |
| `max_depth` | integer | Max recursion depth (default: 3) |
| `last_fetched_at` | text | Last fetch timestamp |

## beads_snapshot

Snapshot of beads issue state for diff-based sync. Tracks last-known state to detect changes.
