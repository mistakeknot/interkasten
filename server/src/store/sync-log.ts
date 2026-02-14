import { eq, desc, and, gte, lte } from "drizzle-orm";
import { type DB } from "./db.js";
import { syncLog, type SyncLog } from "./schema.js";

/**
 * Append a sync log entry.
 */
export function appendSyncLog(
  db: DB,
  data: {
    entityMapId?: number;
    operation: string;
    direction?: string;
    detail?: Record<string, unknown>;
  }
): SyncLog {
  return db
    .insert(syncLog)
    .values({
      entityMapId: data.entityMapId ?? null,
      operation: data.operation,
      direction: data.direction ?? null,
      detail: data.detail ? JSON.stringify(data.detail) : null,
    })
    .returning()
    .get();
}

/**
 * Query sync log with filters.
 */
export function querySyncLog(
  db: DB,
  filters?: {
    entityMapId?: number;
    operation?: string;
    since?: string;
    until?: string;
    limit?: number;
  }
): SyncLog[] {
  let query = db.select().from(syncLog);
  const conditions = [];

  if (filters?.entityMapId !== undefined) {
    conditions.push(eq(syncLog.entityMapId, filters.entityMapId));
  }
  if (filters?.operation) {
    conditions.push(eq(syncLog.operation, filters.operation));
  }
  if (filters?.since) {
    conditions.push(gte(syncLog.createdAt, filters.since));
  }
  if (filters?.until) {
    conditions.push(lte(syncLog.createdAt, filters.until));
  }

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  const results = query.orderBy(desc(syncLog.createdAt)).limit(filters?.limit ?? 100).all();
  return results;
}

/**
 * Get the most recent sync log entry for an entity.
 */
export function getLastSyncLogEntry(db: DB, entityMapId: number): SyncLog | undefined {
  return db
    .select()
    .from(syncLog)
    .where(eq(syncLog.entityMapId, entityMapId))
    .orderBy(desc(syncLog.createdAt))
    .limit(1)
    .get();
}
