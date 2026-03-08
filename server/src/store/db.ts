import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { resolve } from "path";
import { existsSync, mkdirSync } from "fs";
import * as schema from "./schema.js";

export type DB = BetterSQLite3Database<typeof schema>;

/**
 * SQL statements to create the schema.
 * We use raw SQL migrations instead of drizzle-kit for simplicity —
 * the schema is small and versioned with the code.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS base_content (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entity_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_path TEXT NOT NULL UNIQUE,
  notion_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  tier TEXT,
  last_local_hash TEXT,
  last_notion_hash TEXT,
  last_notion_ver TEXT,
  base_content_id INTEGER REFERENCES base_content(id),
  last_sync_ts TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_map_id INTEGER REFERENCES entity_map(id),
  operation TEXT NOT NULL,
  direction TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_wal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_map_id INTEGER NOT NULL REFERENCES entity_map(id),
  operation TEXT NOT NULL,
  state TEXT NOT NULL,
  old_base_id INTEGER REFERENCES base_content(id),
  new_content TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_entity_map_local_path ON entity_map(local_path);
CREATE INDEX IF NOT EXISTS idx_entity_map_notion_id ON entity_map(notion_id);
CREATE INDEX IF NOT EXISTS idx_entity_map_deleted ON entity_map(deleted);
CREATE INDEX IF NOT EXISTS idx_sync_log_entity ON sync_log(entity_map_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_created ON sync_log(created_at);
CREATE INDEX IF NOT EXISTS idx_sync_wal_state ON sync_wal(state);
`;

/**
 * Open or create the SQLite database with WAL mode and schema migrations.
 */
export function openDatabase(dbPath?: string): { db: DB; sqlite: Database.Database } {
  const resolvedPath = dbPath ?? resolve(process.env.HOME ?? "~", ".interkasten", "state.db");

  // Ensure directory exists
  const dir = resolve(resolvedPath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(resolvedPath);

  // Enable WAL mode for crash safety and concurrent reads
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");

  // Run schema migrations
  sqlite.exec(SCHEMA_SQL);

  // Conditional column migrations (ALTER TABLE doesn't support IF NOT EXISTS)
  const entityMapCols = sqlite.pragma("table_info(entity_map)") as Array<{ name: string }>;
  const colNames = new Set(entityMapCols.map((c) => c.name));

  if (!colNames.has("doc_tier")) {
    sqlite.exec("ALTER TABLE entity_map ADD COLUMN doc_tier TEXT");
  }

  if (!colNames.has("parent_id")) {
    sqlite.exec("ALTER TABLE entity_map ADD COLUMN parent_id INTEGER REFERENCES entity_map(id)");
  }

  if (!colNames.has("tags")) {
    sqlite.exec("ALTER TABLE entity_map ADD COLUMN tags TEXT DEFAULT '[]'");
  }

  // Index for hierarchy lookups
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_entity_map_parent_id ON entity_map(parent_id)");

  // Conflict tracking columns (v0.4.x — bidirectional sync)
  if (!colNames.has("conflict_detected_at")) {
    sqlite.exec("ALTER TABLE entity_map ADD COLUMN conflict_detected_at TEXT");
    sqlite.exec(
      "ALTER TABLE entity_map ADD COLUMN conflict_local_content_id INTEGER REFERENCES base_content(id)",
    );
    sqlite.exec(
      "ALTER TABLE entity_map ADD COLUMN conflict_notion_content_id INTEGER REFERENCES base_content(id)",
    );
  }

  // Database schemas table for tracked databases (v0.5.x — database row sync)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS database_schemas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notion_database_id TEXT NOT NULL UNIQUE,
      data_source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      schema_json TEXT NOT NULL,
      output_dir TEXT,
      last_fetched_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Multi-token support: token_alias column (v0.6.x)
  const dbSchemaCols = sqlite.pragma("table_info(database_schemas)") as Array<{ name: string }>;
  const dbSchemaColNames = new Set(dbSchemaCols.map((c) => c.name));
  if (!dbSchemaColNames.has("token_alias")) {
    sqlite.exec("ALTER TABLE database_schemas ADD COLUMN token_alias TEXT");
  }

  // Beads snapshot table for issue sync state tracking (v0.4.x)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS beads_snapshot (
      project_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id)
    )
  `);

  // Migration: drop UNIQUE constraint on notion_id, fix self-referential FK
  // A single Notion page can be tracked as both a project entity (directory container)
  // and a doc entity (content sync target). The UNIQUE constraint blocked this.
  //
  // Also fixes databases where a previous migration left the parent_id FK pointing
  // at a stale table name (entity_map_new, entity_map_fixed) — ALTER TABLE RENAME
  // does NOT update FK references in the stored CREATE TABLE SQL.
  //
  // Strategy: backup data to a temp table, drop entity_map, recreate with final
  // name (so FK says REFERENCES entity_map(id)), restore data.
  const needsMigration = (() => {
    // Check 1: UNIQUE autoindex on notion_id still exists
    const hasUniqueNotionId = (sqlite.pragma("index_list(entity_map)") as Array<{ name: string; unique: number }>)
      .some((idx) => idx.name === "sqlite_autoindex_entity_map_2" && idx.unique === 1);
    if (hasUniqueNotionId) return true;

    // Check 2: parent_id FK points to wrong table (from broken previous migration)
    const createSql = (sqlite.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='entity_map'"
    ).get() as { sql: string } | undefined)?.sql ?? "";
    if (createSql.includes("REFERENCES entity_map_new") ||
        createSql.includes("REFERENCES entity_map_fixed")) {
      return true;
    }

    return false;
  })();

  if (needsMigration) {
    sqlite.exec("PRAGMA foreign_keys = OFF");
    sqlite.exec(`DROP TABLE IF EXISTS entity_map_new`);
    sqlite.exec(`DROP TABLE IF EXISTS entity_map_fixed`);
    sqlite.exec(`DROP TABLE IF EXISTS entity_map_backup`);
    sqlite.exec(`
      CREATE TABLE entity_map_backup AS SELECT * FROM entity_map;
      DROP TABLE entity_map;
      CREATE TABLE entity_map (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        local_path TEXT NOT NULL UNIQUE,
        notion_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        tier TEXT,
        doc_tier TEXT,
        parent_id INTEGER REFERENCES entity_map(id),
        tags TEXT DEFAULT '[]',
        last_local_hash TEXT,
        last_notion_hash TEXT,
        last_notion_ver TEXT,
        base_content_id INTEGER REFERENCES base_content(id),
        last_sync_ts TEXT NOT NULL,
        conflict_detected_at TEXT,
        conflict_local_content_id INTEGER REFERENCES base_content(id),
        conflict_notion_content_id INTEGER REFERENCES base_content(id),
        deleted INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO entity_map (
        id, local_path, notion_id, entity_type, tier, doc_tier,
        parent_id, tags, last_local_hash, last_notion_hash,
        last_notion_ver, base_content_id, last_sync_ts,
        conflict_detected_at, conflict_local_content_id,
        conflict_notion_content_id, deleted, deleted_at, created_at
      ) SELECT
        id, local_path, notion_id, entity_type, tier, doc_tier,
        parent_id, tags, last_local_hash, last_notion_hash,
        last_notion_ver, base_content_id, last_sync_ts,
        conflict_detected_at, conflict_local_content_id,
        conflict_notion_content_id, deleted, deleted_at, created_at
      FROM entity_map_backup;
      DROP TABLE entity_map_backup;
      CREATE INDEX IF NOT EXISTS idx_entity_map_local_path ON entity_map(local_path);
      CREATE INDEX IF NOT EXISTS idx_entity_map_notion_id ON entity_map(notion_id);
      CREATE INDEX IF NOT EXISTS idx_entity_map_deleted ON entity_map(deleted);
      CREATE INDEX IF NOT EXISTS idx_entity_map_parent_id ON entity_map(parent_id);
    `);
    sqlite.exec("PRAGMA foreign_keys = ON");
  }

  const db = drizzle(sqlite, { schema });

  return { db, sqlite };
}

/**
 * Close the database connection cleanly.
 */
export function closeDatabase(sqlite: Database.Database): void {
  sqlite.close();
}
