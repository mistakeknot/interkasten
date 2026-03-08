import { eq } from "drizzle-orm";
import type { DB } from "./db.js";
import {
  pageTracking,
  type PageTrackingRow,
} from "./schema.js";

export interface UpsertPageTrackingInput {
  notionPageId: string;
  title: string;
  outputDir: string;
  tokenAlias?: string | null;
  recursive?: boolean;
  maxDepth?: number;
}

/**
 * Insert or update a tracked page root.
 */
export function upsertPageTracking(
  db: DB,
  data: UpsertPageTrackingInput
): PageTrackingRow {
  const existing = db
    .select()
    .from(pageTracking)
    .where(eq(pageTracking.notionPageId, data.notionPageId))
    .get();

  if (existing) {
    db.update(pageTracking)
      .set({
        title: data.title,
        outputDir: data.outputDir,
        tokenAlias: data.tokenAlias !== undefined ? data.tokenAlias : existing.tokenAlias,
        recursive: data.recursive ?? existing.recursive,
        maxDepth: data.maxDepth ?? existing.maxDepth,
        lastFetchedAt: new Date().toISOString(),
      })
      .where(eq(pageTracking.id, existing.id))
      .run();

    return db
      .select()
      .from(pageTracking)
      .where(eq(pageTracking.id, existing.id))
      .get()!;
  }

  return db
    .insert(pageTracking)
    .values({
      notionPageId: data.notionPageId,
      title: data.title,
      outputDir: data.outputDir,
      tokenAlias: data.tokenAlias ?? null,
      recursive: data.recursive ?? true,
      maxDepth: data.maxDepth ?? 3,
      lastFetchedAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

/**
 * Get a tracked page by its Notion page ID.
 */
export function getPageTracking(
  db: DB,
  notionPageId: string
): PageTrackingRow | undefined {
  return db
    .select()
    .from(pageTracking)
    .where(eq(pageTracking.notionPageId, notionPageId))
    .get();
}

/**
 * List all tracked pages.
 */
export function listTrackedPages(db: DB): PageTrackingRow[] {
  return db.select().from(pageTracking).all();
}

/**
 * Remove a tracked page.
 */
export function removePageTracking(db: DB, notionPageId: string): void {
  db.delete(pageTracking)
    .where(eq(pageTracking.notionPageId, notionPageId))
    .run();
}
