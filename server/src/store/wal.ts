import { eq, ne, and } from "drizzle-orm";
import { type DB } from "./db.js";
import { syncWal, type SyncWal } from "./schema.js";

export type WalState = "pending" | "target_written" | "committed" | "rolled_back";

/**
 * Create a new WAL entry (state = 'pending').
 * Call this BEFORE writing to the target.
 */
export function walCreatePending(
  db: DB,
  data: {
    entityMapId: number;
    operation: string;
    oldBaseId?: number;
    newContent?: string;
  }
): SyncWal {
  return db
    .insert(syncWal)
    .values({
      entityMapId: data.entityMapId,
      operation: data.operation,
      state: "pending",
      oldBaseId: data.oldBaseId ?? null,
      newContent: data.newContent ?? null,
    })
    .returning()
    .get();
}

/**
 * Mark WAL entry as target_written (target was written successfully).
 */
export function walMarkTargetWritten(db: DB, walId: number): void {
  db.update(syncWal)
    .set({ state: "target_written" })
    .where(eq(syncWal.id, walId))
    .run();
}

/**
 * Mark WAL entry as committed (entity_map updated, sync complete).
 */
export function walMarkCommitted(db: DB, walId: number): void {
  db.update(syncWal)
    .set({
      state: "committed",
      completedAt: new Date().toISOString(),
    })
    .where(eq(syncWal.id, walId))
    .run();
}

/**
 * Mark WAL entry as rolled back.
 */
export function walMarkRolledBack(db: DB, walId: number): void {
  db.update(syncWal)
    .set({
      state: "rolled_back",
      completedAt: new Date().toISOString(),
    })
    .where(eq(syncWal.id, walId))
    .run();
}

/**
 * Delete a completed WAL entry (cleanup after commit).
 */
export function walDelete(db: DB, walId: number): void {
  db.delete(syncWal).where(eq(syncWal.id, walId)).run();
}

/**
 * Query all incomplete WAL entries (for crash recovery).
 * Returns entries in 'pending' or 'target_written' state.
 */
export function walQueryIncomplete(db: DB): SyncWal[] {
  return db
    .select()
    .from(syncWal)
    .where(
      and(
        ne(syncWal.state, "committed"),
        ne(syncWal.state, "rolled_back")
      )
    )
    .all();
}

/**
 * Get count of pending WAL entries.
 */
export function walPendingCount(db: DB): number {
  return walQueryIncomplete(db).length;
}
