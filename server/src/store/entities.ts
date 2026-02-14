import { eq, and, lt } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { type DB } from "./db.js";
import {
  entityMap,
  baseContent,
  type EntityMap,
  type NewEntityMap,
  type BaseContent,
} from "./schema.js";
import { createHash } from "crypto";

/**
 * Compute SHA-256 hash of content.
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Upsert an entity mapping. If local_path exists, update; otherwise insert.
 */
export function upsertEntity(
  db: DB,
  data: Omit<NewEntityMap, "id" | "createdAt" | "deleted" | "deletedAt">
): EntityMap {
  const existing = db
    .select()
    .from(entityMap)
    .where(eq(entityMap.localPath, data.localPath))
    .get();

  if (existing) {
    db.update(entityMap)
      .set({
        notionId: data.notionId,
        entityType: data.entityType,
        tier: data.tier,
        lastLocalHash: data.lastLocalHash,
        lastNotionHash: data.lastNotionHash,
        lastNotionVer: data.lastNotionVer,
        baseContentId: data.baseContentId,
        lastSyncTs: data.lastSyncTs,
        deleted: false,
        deletedAt: null,
      })
      .where(eq(entityMap.id, existing.id))
      .run();

    return db.select().from(entityMap).where(eq(entityMap.id, existing.id)).get()!;
  }

  const result = db.insert(entityMap).values(data).returning().get();
  return result;
}

/**
 * Get entity by local path.
 */
export function getEntityByPath(db: DB, localPath: string): EntityMap | undefined {
  return db
    .select()
    .from(entityMap)
    .where(and(eq(entityMap.localPath, localPath), eq(entityMap.deleted, false)))
    .get();
}

/**
 * Get entity by Notion page ID.
 */
export function getEntityByNotionId(db: DB, notionId: string): EntityMap | undefined {
  return db
    .select()
    .from(entityMap)
    .where(and(eq(entityMap.notionId, notionId), eq(entityMap.deleted, false)))
    .get();
}

/**
 * Get all active entities, optionally filtered by type.
 */
export function listEntities(db: DB, entityType?: string): EntityMap[] {
  if (entityType) {
    return db
      .select()
      .from(entityMap)
      .where(and(eq(entityMap.entityType, entityType), eq(entityMap.deleted, false)))
      .all();
  }
  return db.select().from(entityMap).where(eq(entityMap.deleted, false)).all();
}

/**
 * Soft-delete an entity (mark as deleted, set timestamp).
 */
export function softDeleteEntity(db: DB, id: number): void {
  db.update(entityMap)
    .set({
      deleted: true,
      deletedAt: new Date().toISOString(),
    })
    .where(eq(entityMap.id, id))
    .run();
}

/**
 * Hard-delete soft-deleted entities older than the given date.
 */
export function gcDeletedEntities(db: DB, olderThan: string): number {
  const result = db
    .delete(entityMap)
    .where(
      and(
        eq(entityMap.deleted, true),
        lt(entityMap.deletedAt!, olderThan)
      )
    )
    .run();
  return result.changes;
}

/**
 * Store or retrieve base content by hash (content-addressed).
 * Returns existing row if content hash matches.
 */
export function upsertBaseContent(db: DB, content: string): BaseContent {
  const hash = hashContent(content);

  const existing = db
    .select()
    .from(baseContent)
    .where(eq(baseContent.contentHash, hash))
    .get();

  if (existing) return existing;

  return db
    .insert(baseContent)
    .values({ contentHash: hash, content })
    .returning()
    .get();
}

/**
 * Get base content by ID.
 */
export function getBaseContent(db: DB, id: number): BaseContent | undefined {
  return db.select().from(baseContent).where(eq(baseContent.id, id)).get();
}

/**
 * Garbage-collect orphaned base_content rows (no entity_map references).
 */
export function gcOrphanedBaseContent(db: DB): number {
  const result = db.run(
    sql`DELETE FROM base_content WHERE id NOT IN (SELECT base_content_id FROM entity_map WHERE base_content_id IS NOT NULL)`
  );
  return result.changes;
}

/**
 * Update the doc_tier for an entity (project-level triage classification).
 */
export function updateDocTier(
  db: DB,
  id: number,
  docTier: string | null
): void {
  db.update(entityMap)
    .set({ docTier })
    .where(eq(entityMap.id, id))
    .run();
}

/**
 * Update entity hashes and sync timestamp after a successful sync.
 */
export function updateEntityAfterSync(
  db: DB,
  id: number,
  updates: {
    lastLocalHash?: string;
    lastNotionHash?: string;
    lastNotionVer?: string;
    baseContentId?: number;
    lastSyncTs: string;
  }
): void {
  db.update(entityMap)
    .set({
      ...(updates.lastLocalHash !== undefined && { lastLocalHash: updates.lastLocalHash }),
      ...(updates.lastNotionHash !== undefined && { lastNotionHash: updates.lastNotionHash }),
      ...(updates.lastNotionVer !== undefined && { lastNotionVer: updates.lastNotionVer }),
      ...(updates.baseContentId !== undefined && { baseContentId: updates.baseContentId }),
      lastSyncTs: updates.lastSyncTs,
    })
    .where(eq(entityMap.id, id))
    .run();
}
