import { existsSync } from "fs";
import { join, basename } from "path";
import { readdirSync } from "fs";
import type { DB } from "../store/db.js";
import type { NotionClient } from "./notion-client.js";
import { getDocsForProject } from "./entity-map.js";
import { TIER_DOC_REQUIREMENTS, type DocTier } from "./triage.js";

/**
 * The 5 key documents tracked per project as Notion database columns.
 * Each maps to a well-known file pattern in the project tree.
 */
export const KEY_DOC_TYPES = ["Vision", "PRD", "Roadmap", "AGENTS.md", "CLAUDE.md"] as const;
export type KeyDocType = (typeof KEY_DOC_TYPES)[number];

export interface KeyDocResult {
  type: KeyDocType;
  path: string | null;    // absolute path if found, null if missing
  notionId: string | null; // notion page ID if synced
}

/**
 * Scan a project directory for the 5 key documents.
 * Returns results for all 5 types (path=null means missing).
 */
export function findKeyDocs(projectPath: string): KeyDocResult[] {
  return KEY_DOC_TYPES.map((type) => ({
    type,
    path: findKeyDoc(projectPath, type),
    notionId: null,
  }));
}

/**
 * Find a specific key doc in a project. Searches root and docs/ with
 * case-insensitive matching. Returns absolute path or null.
 */
function findKeyDoc(projectPath: string, type: KeyDocType): string | null {
  // AGENTS.md and CLAUDE.md: exact root-level match only
  if (type === "AGENTS.md" || type === "CLAUDE.md") {
    const path = join(projectPath, type);
    return existsSync(path) ? path : null;
  }

  // Vision, PRD, Roadmap: search root + docs/ with fuzzy matching
  const searchDirs = [projectPath];
  const docsDir = join(projectPath, "docs");
  if (existsSync(docsDir)) {
    searchDirs.push(docsDir);
  }

  const pattern = type.toLowerCase(); // "vision", "prd", "roadmap"

  for (const dir of searchDirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const lower = entry.toLowerCase();

      // Match: filename starts with or equals the pattern
      // e.g. "PRD.md", "PRD-MVP.md", "prd.md" all match "prd"
      // but "prd-template.md" in templates/ is excluded (we only search root + docs/)
      if (lower === `${pattern}.md` || lower.startsWith(`${pattern}-`)) {
        return join(dir, entry);
      }
    }
  }

  return null;
}

/**
 * Enrich key doc results with Notion page IDs from the entity map.
 * Uses parent_id FK to find docs belonging to the project (not path prefix).
 */
export function enrichWithNotionIds(
  db: DB,
  projectId: number,
  keyDocs: KeyDocResult[]
): KeyDocResult[] {
  const projectDocs = getDocsForProject(db, projectId);

  return keyDocs.map((kd) => {
    if (!kd.path) return kd;

    const entity = projectDocs.find((e) => e.localPath === kd.path);
    return {
      ...kd,
      notionId: entity?.notionId ?? null,
    };
  });
}

/**
 * Notion database property definitions for the 5 key doc columns.
 * Each is a URL column — empty URL means the doc is missing.
 */
export function getKeyDocDbProperties(): Record<string, any> {
  const props: Record<string, any> = {};
  for (const type of KEY_DOC_TYPES) {
    props[type] = { url: {} };
  }
  return props;
}

/**
 * Build Notion page properties for a project's key docs.
 * Sets URL to the Notion page link if synced, null otherwise.
 * Empty URL = doc is missing or not yet synced (filter "is empty" in Notion).
 */
export function buildKeyDocPageProperties(
  keyDocs: KeyDocResult[]
): Record<string, any> {
  const props: Record<string, any> = {};

  for (const kd of keyDocs) {
    if (kd.notionId) {
      props[kd.type] = {
        url: `https://notion.so/${kd.notionId.replace(/-/g, "")}`,
      };
    } else {
      props[kd.type] = { url: null };
    }
  }

  return props;
}

/**
 * Update a project's Notion page with current key doc status.
 */
export async function updateProjectKeyDocs(
  notion: NotionClient,
  projectNotionId: string,
  keyDocs: KeyDocResult[]
): Promise<void> {
  const properties = buildKeyDocPageProperties(keyDocs);

  await notion.call(
    async () => {
      return notion.raw.pages.update({
        page_id: projectNotionId,
        properties,
      });
    },
    { pageId: projectNotionId }
  );
}

/**
 * Get the list of required key doc types for a given tier.
 * Returns the subset of KEY_DOC_TYPES that the tier demands.
 */
export function getRequiredDocsForTier(tier: DocTier): readonly string[] {
  return TIER_DOC_REQUIREMENTS[tier] ?? [];
}

/**
 * Categorize key docs as required-missing, required-present, or optional
 * based on a project's doc tier.
 */
export function categorizeKeyDocs(
  keyDocs: KeyDocResult[],
  docTier: DocTier | null
): {
  requiredMissing: KeyDocResult[];
  requiredPresent: KeyDocResult[];
  optional: KeyDocResult[];
} {
  const tier = docTier ?? "Tool"; // default to Tool if no tier set
  const required = new Set(getRequiredDocsForTier(tier));

  const requiredMissing: KeyDocResult[] = [];
  const requiredPresent: KeyDocResult[] = [];
  const optional: KeyDocResult[] = [];

  for (const kd of keyDocs) {
    if (required.has(kd.type)) {
      if (kd.path) {
        requiredPresent.push(kd);
      } else {
        requiredMissing.push(kd);
      }
    } else {
      optional.push(kd);
    }
  }

  return { requiredMissing, requiredPresent, optional };
}
