import { resolve, relative, basename, dirname } from "path";
import { type DB } from "../store/db.js";
import {
  upsertEntity,
  getEntityByPath,
  getEntityByNotionId,
  listEntities,
} from "../store/entities.js";
import type { EntityMap } from "../store/schema.js";

export type EntityType = "project" | "doc" | "ref" | "issues";
export type Tier = "T1" | "T2";

/**
 * Register a project in the entity map.
 */
export function registerProject(
  db: DB,
  localPath: string,
  notionId: string
): EntityMap {
  return upsertEntity(db, {
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
