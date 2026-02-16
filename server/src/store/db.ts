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
  notion_id TEXT NOT NULL UNIQUE,
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

  // Beads snapshot table for issue sync state tracking (v0.4.x)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS beads_snapshot (
      project_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id)
    )
  `);

  const db = drizzle(sqlite, { schema });

  return { db, sqlite };
}

/**
 * Close the database connection cleanly.
 */
export function closeDatabase(sqlite: Database.Database): void {
  sqlite.close();
}
