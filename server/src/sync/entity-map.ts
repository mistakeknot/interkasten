import { resolve, relative, basename, dirname } from "path";
import { eq, and, isNull } from "drizzle-orm";
import { type DB } from "../store/db.js";
import {
  upsertEntity,
  getEntityByPath,
  getEntityByNotionId,
  listEntities,
} from "../store/entities.js";
import { entityMap, type EntityMap } from "../store/schema.js";

export type EntityType = "project" | "doc" | "ref" | "issues" | "database" | "db_row";
export type Tier = "T1" | "T2";

/**
 * Register a project in the entity map.
 */
export function registerProject(
  db: DB,
  localPath: string,
  notionId: string,
  parentId?: number | null,
  tags?: string[]
): EntityMap {
  const entity = upsertEntity(db, {
    localPath,
    notionId,
    entityType: "project",
    tier: null,
    lastLocalHash: null,
    lastNotionHash: null,
    lastNotionVer: null,
    baseContentId: null,
    lastSyncTs: new Date().toISOString(),
  });

  // Set parent and tags if provided (upsertEntity doesn't handle these)
  if (parentId !== undefined || tags !== undefined) {
    const updates: Record<string, unknown> = {};
    if (parentId !== undefined) updates.parentId = parentId;
    if (tags !== undefined) updates.tags = JSON.stringify(tags);

    db.update(entityMap)
      .set(updates)
      .where(eq(entityMap.id, entity.id))
      .run();

    return db.select().from(entityMap).where(eq(entityMap.id, entity.id)).get()!;
  }

  return entity;
}

/**
 * Register a document in the entity map.
 */
export function registerDoc(
  db: DB,
  localPath: string,
  notionId: string,
  tier: Tier = "T2"
): EntityMap {
  return upsertEntity(db, {
    localPath,
    notionId,
    entityType: "doc",
    tier,
    lastLocalHash: null,
    lastNotionHash: null,
    lastNotionVer: null,
    baseContentId: null,
    lastSyncTs: new Date().toISOString(),
  });
}

/**
 * Look up an entity by its local filesystem path.
 */
export function lookupByPath(db: DB, localPath: string): EntityMap | undefined {
  return getEntityByPath(db, localPath);
}

/**
 * Look up an entity by its Notion page ID.
 */
export function lookupByNotionId(db: DB, notionId: string): EntityMap | undefined {
  return getEntityByNotionId(db, notionId);
}

/**
 * List all registered projects.
 */
export function listProjects(db: DB): EntityMap[] {
  return listEntities(db, "project");
}

/**
 * List all registered docs.
 */
export function listDocs(db: DB): EntityMap[] {
  return listEntities(db, "doc");
}

/**
 * Determine entity type from a file path relative to a project.
 */
export function computeEntityType(filePath: string, projectsDir: string): EntityType {
  const rel = relative(projectsDir, filePath);
  const parts = rel.split("/");

  // Top-level directory = project
  if (parts.length === 1) return "project";

  return "doc";
}

/**
 * Determine tier from file path.
 * T1: docs in specific directories (docs/, PRD, roadmap, etc.)
 * T2: everything else (CLAUDE.md, AGENTS.md, misc)
 */
export function computeTier(filePath: string): Tier {
  const name = basename(filePath).toLowerCase();
  const dir = dirname(filePath).toLowerCase();

  // T1 documents — Notion-native
  const t1Names = ["prd.md", "roadmap.md", "architecture.md", "changelog.md"];
  if (t1Names.includes(name)) return "T1";
  if (dir.endsWith("/docs") || dir.includes("/docs/")) return "T1";

  // Everything else is T2 (linked reference)
  return "T2";
}

// --- Hierarchy operations ---

/**
 * Get direct children of a project (one level deep).
 */
export function getProjectChildren(db: DB, parentId: number): EntityMap[] {
  return db
    .select()
    .from(entityMap)
    .where(
      and(
        eq(entityMap.parentId, parentId),
        eq(entityMap.entityType, "project"),
        eq(entityMap.deleted, false)
      )
    )
    .all();
}

/**
 * Get the parent project of a project, or null if top-level.
 */
export function getProjectParent(db: DB, projectId: number): EntityMap | null {
  const project = db
    .select()
    .from(entityMap)
    .where(eq(entityMap.id, projectId))
    .get();

  if (!project?.parentId) return null;

  return (
    db
      .select()
      .from(entityMap)
      .where(and(eq(entityMap.id, project.parentId), eq(entityMap.deleted, false)))
      .get() ?? null
  );
}

/**
 * Get the full ancestor chain from a project up to the root.
 * Returns [immediate_parent, grandparent, ..., root] (closest first).
 */
export function getProjectAncestors(db: DB, projectId: number): EntityMap[] {
  const ancestors: EntityMap[] = [];
  let currentId: number | null = projectId;

  while (currentId !== null) {
    const entity = db
      .select()
      .from(entityMap)
      .where(eq(entityMap.id, currentId))
      .get();

    if (!entity?.parentId) break;

    const parent = db
      .select()
      .from(entityMap)
      .where(and(eq(entityMap.id, entity.parentId), eq(entityMap.deleted, false)))
      .get();

    if (!parent) break;
    ancestors.push(parent);
    currentId = parent.id;
  }

  return ancestors;
}

/**
 * Set or change a project's parent.
 * Pass null to make it top-level.
 */
export function setProjectParent(
  db: DB,
  projectId: number,
  parentId: number | null
): void {
  db.update(entityMap)
    .set({ parentId })
    .where(eq(entityMap.id, projectId))
    .run();
}

/**
 * Replace all tags on a project.
 */
export function setProjectTags(
  db: DB,
  projectId: number,
  tags: string[]
): void {
  db.update(entityMap)
    .set({ tags: JSON.stringify(tags) })
    .where(eq(entityMap.id, projectId))
    .run();
}

/**
 * Get parsed tags for a project.
 */
export function getProjectTags(db: DB, projectId: number): string[] {
  const entity = db
    .select({ tags: entityMap.tags })
    .from(entityMap)
    .where(eq(entityMap.id, projectId))
    .get();

  if (!entity?.tags) return [];
  try {
    return JSON.parse(entity.tags);
  } catch {
    return [];
  }
}

/**
 * Get docs that belong directly to a project (not to its subprojects).
 * Uses parent_id FK — does NOT use path prefix matching.
 */
export function getDocsForProject(db: DB, projectId: number): EntityMap[] {
  return db
    .select()
    .from(entityMap)
    .where(
      and(
        eq(entityMap.parentId, projectId),
        eq(entityMap.entityType, "doc"),
        eq(entityMap.deleted, false)
      )
    )
    .all();
}

/**
 * Register a database in the entity map.
 */
export function registerDatabase(
  db: DB,
  localPath: string,
  notionId: string,
  parentId?: number | null,
): EntityMap {
  const entity = upsertEntity(db, {
    localPath,
    notionId,
    entityType: "database",
    tier: null,
    lastLocalHash: null,
    lastNotionHash: null,
    lastNotionVer: null,
    baseContentId: null,
    lastSyncTs: new Date().toISOString(),
  });

  if (parentId !== undefined) {
    db.update(entityMap)
      .set({ parentId })
      .where(eq(entityMap.id, entity.id))
      .run();
    return db.select().from(entityMap).where(eq(entityMap.id, entity.id)).get()!;
  }

  return entity;
}

/**
 * Register a database row in the entity map.
 */
export function registerDbRow(
  db: DB,
  localPath: string,
  notionId: string,
  databaseEntityId: number,
): EntityMap {
  const entity = upsertEntity(db, {
    localPath,
    notionId,
    entityType: "db_row",
    tier: null,
    lastLocalHash: null,
    lastNotionHash: null,
    lastNotionVer: null,
    baseContentId: null,
    lastSyncTs: new Date().toISOString(),
  });

  db.update(entityMap)
    .set({ parentId: databaseEntityId })
    .where(eq(entityMap.id, entity.id))
    .run();

  return db.select().from(entityMap).where(eq(entityMap.id, entity.id)).get()!;
}

/**
 * Get all row entities belonging to a database entity.
 */
export function getRowsForDatabase(db: DB, databaseEntityId: number): EntityMap[] {
  return db
    .select()
    .from(entityMap)
    .where(
      and(
        eq(entityMap.parentId, databaseEntityId),
        eq(entityMap.entityType, "db_row"),
        eq(entityMap.deleted, false)
      )
    )
    .all();
}

/**
 * List top-level projects (no parent).
 */
export function listTopLevelProjects(db: DB): EntityMap[] {
  return db
    .select()
    .from(entityMap)
    .where(
      and(
        eq(entityMap.entityType, "project"),
        isNull(entityMap.parentId),
        eq(entityMap.deleted, false)
      )
    )
    .all();
}
