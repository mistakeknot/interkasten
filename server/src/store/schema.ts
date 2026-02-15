import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * Maps local filesystem entities to Notion page IDs.
 * Each row represents a single synced entity (project, doc, reference, issues DB).
 */
export const entityMap = sqliteTable("entity_map", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  localPath: text("local_path").notNull().unique(),
  notionId: text("notion_id").notNull().unique(),
  entityType: text("entity_type").notNull(), // 'project' | 'doc' | 'ref' | 'issues'
  tier: text("tier"), // 'T1' | 'T2' | null
  docTier: text("doc_tier"), // 'Product' | 'Tool' | 'Inactive' | null (project-level triage)
  parentId: integer("parent_id"), // self-referential FK for project hierarchy (null = top-level)
  tags: text("tags").default("[]"), // JSON array of tag strings
  lastLocalHash: text("last_local_hash"),
  lastNotionHash: text("last_notion_hash"),
  lastNotionVer: text("last_notion_ver"), // Notion last_edited_time for fast-path
  baseContentId: integer("base_content_id").references(() => baseContent.id),
  lastSyncTs: text("last_sync_ts").notNull(),
  deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
  deletedAt: text("deleted_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

/**
 * Base content for three-way merge.
 * Content-addressed: identical content across entities is stored once.
 * Separated from entity_map to keep that table lean.
 */
export const baseContent = sqliteTable("base_content", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  contentHash: text("content_hash").notNull().unique(),
  content: text("content").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

/**
 * Append-only sync operation log.
 * Stored locally (not in Notion) so logging works even when API is unavailable.
 */
export const syncLog = sqliteTable("sync_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entityMapId: integer("entity_map_id").references(() => entityMap.id),
  operation: text("operation").notNull(), // 'push' | 'pull' | 'merge' | 'conflict' | 'error'
  direction: text("direction"), // 'local_to_notion' | 'notion_to_local'
  detail: text("detail"), // JSON: error messages, conflict info, merge stats
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

/**
 * Write-ahead log for crash recovery.
 * Every sync operation is logged here BEFORE execution
 * and removed AFTER both sides are consistent.
 */
export const syncWal = sqliteTable("sync_wal", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entityMapId: integer("entity_map_id")
    .notNull()
    .references(() => entityMap.id),
  operation: text("operation").notNull(), // 'push' | 'pull' | 'merge'
  state: text("state").notNull(), // 'pending' | 'target_written' | 'committed' | 'rolled_back'
  oldBaseId: integer("old_base_id").references(() => baseContent.id),
  newContent: text("new_content"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  completedAt: text("completed_at"),
});

// Type exports
export type EntityMap = typeof entityMap.$inferSelect;
export type NewEntityMap = typeof entityMap.$inferInsert;
export type BaseContent = typeof baseContent.$inferSelect;
export type NewBaseContent = typeof baseContent.$inferInsert;
export type SyncLog = typeof syncLog.$inferSelect;
export type NewSyncLog = typeof syncLog.$inferInsert;
export type SyncWal = typeof syncWal.$inferSelect;
export type NewSyncWal = typeof syncWal.$inferInsert;
