import { eq } from "drizzle-orm";
import type { DB } from "./db.js";
import {
  databaseSchemas,
  type DatabaseSchemaRow,
} from "./schema.js";

export interface UpsertDatabaseSchemaInput {
  notionDatabaseId: string;
  dataSourceId: string;
  title: string;
  schemaJson: string;
  outputDir?: string | null;
}

/**
 * Insert or update a tracked database schema.
 */
export function upsertDatabaseSchema(
  db: DB,
  data: UpsertDatabaseSchemaInput
): DatabaseSchemaRow {
  const existing = db
    .select()
    .from(databaseSchemas)
    .where(eq(databaseSchemas.notionDatabaseId, data.notionDatabaseId))
    .get();

  if (existing) {
    db.update(databaseSchemas)
      .set({
        dataSourceId: data.dataSourceId,
        title: data.title,
        schemaJson: data.schemaJson,
        outputDir: data.outputDir ?? existing.outputDir,
        lastFetchedAt: new Date().toISOString(),
      })
      .where(eq(databaseSchemas.id, existing.id))
      .run();

    return db
      .select()
      .from(databaseSchemas)
      .where(eq(databaseSchemas.id, existing.id))
      .get()!;
  }

  return db
    .insert(databaseSchemas)
    .values({
      notionDatabaseId: data.notionDatabaseId,
      dataSourceId: data.dataSourceId,
      title: data.title,
      schemaJson: data.schemaJson,
      outputDir: data.outputDir ?? null,
      lastFetchedAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

/**
 * Get a tracked database schema by its Notion database ID.
 */
export function getDatabaseSchema(
  db: DB,
  notionDatabaseId: string
): DatabaseSchemaRow | undefined {
  return db
    .select()
    .from(databaseSchemas)
    .where(eq(databaseSchemas.notionDatabaseId, notionDatabaseId))
    .get();
}

/**
 * List all tracked databases.
 */
export function listTrackedDatabases(db: DB): DatabaseSchemaRow[] {
  return db.select().from(databaseSchemas).all();
}

/**
 * Remove a tracked database schema.
 */
export function removeDatabaseSchema(db: DB, notionDatabaseId: string): void {
  db.delete(databaseSchemas)
    .where(eq(databaseSchemas.notionDatabaseId, notionDatabaseId))
    .run();
}
