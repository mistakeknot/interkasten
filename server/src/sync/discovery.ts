import type {
  PageObjectResponse,
  DataSourceObjectResponse,
} from "@notionhq/client/build/src/api-endpoints.js";
import type { NotionClient } from "./notion-client.js";
import { listEntities } from "../store/entities.js";
import type { DB } from "../store/db.js";

// ---------- Types ----------

export interface PageNode {
  id: string;
  title: string;
  parentId: string | null;
  parentType: "workspace" | "page" | "database" | "block";
  type: "page" | "database";
  lastEditedTime: string;
  hasChildren: boolean;
  children: PageNode[];
}

export interface DatabaseSchema {
  id: string;
  title: string;
  properties: Record<string, DatabaseProperty>;
}

export interface DatabaseProperty {
  id: string;
  name: string;
  type: string;
  options?: string[];
}

export interface DiscoveryResult {
  tree: PageNode[];
  flat: Map<string, PageNode>;
  databases: Map<
    string,
    { ds: DataSourceObjectResponse; schema: DatabaseSchema; rowCount: number }
  >;
}

export interface DiscoveryScope {
  rootIds: Set<string>;
  excludeIds: Set<string>;
}

// ---------- Scope filtering ----------

/**
 * Normalize a Notion ID by stripping hyphens and lowercasing.
 */
export function normalizeNotionId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

/**
 * Check if a scope is active (has any root or exclude IDs).
 */
export function hasDiscoveryScope(
  scope: DiscoveryScope | undefined,
): scope is DiscoveryScope {
  if (!scope) return false;
  return scope.rootIds.size > 0 || scope.excludeIds.size > 0;
}

/**
 * Build a DiscoveryScope from raw config arrays.
 */
export function buildDiscoveryScope(
  rootIds: string[],
  excludeIds: string[],
): DiscoveryScope {
  return {
    rootIds: new Set(rootIds.map(normalizeNotionId)),
    excludeIds: new Set(excludeIds.map(normalizeNotionId)),
  };
}

/**
 * Walk up the parent chain and return true if any ancestor (including self)
 * is in the target set. Uses memoization to avoid redundant walks.
 */
export function hasAncestorMatch(
  id: string,
  targetIds: Set<string>,
  flat: Map<string, PageNode>,
  memo: Map<string, boolean>,
  visiting = new Set<string>(),
): boolean {
  const normId = normalizeNotionId(id);

  if (targetIds.has(normId)) {
    memo.set(normId, true);
    return true;
  }

  const cached = memo.get(normId);
  if (cached !== undefined) return cached;

  // Cycle detection
  if (visiting.has(normId)) return false;
  visiting.add(normId);

  const node = flat.get(id);
  if (!node?.parentId) {
    memo.set(normId, false);
    return false;
  }

  const result = hasAncestorMatch(
    node.parentId,
    targetIds,
    flat,
    memo,
    visiting,
  );
  memo.set(normId, result);
  return result;
}

/**
 * Filter a DiscoveryResult to only include pages within the configured scope.
 *
 * - If rootIds is non-empty, only pages with an ancestor in rootIds are kept.
 * - If excludeIds is non-empty, pages with an ancestor in excludeIds are removed.
 * - Both filters can be combined.
 */
export function applyDiscoveryScope(
  discovery: DiscoveryResult,
  scope: DiscoveryScope,
): DiscoveryResult {
  if (!hasDiscoveryScope(scope)) return discovery;

  const rootMemo = new Map<string, boolean>();
  const excludeMemo = new Map<string, boolean>();

  const filteredFlat = new Map<string, PageNode>();

  for (const [id, node] of discovery.flat) {
    const isExcluded =
      scope.excludeIds.size > 0 &&
      hasAncestorMatch(id, scope.excludeIds, discovery.flat, excludeMemo);
    if (isExcluded) continue;

    const inScope =
      scope.rootIds.size === 0 ||
      hasAncestorMatch(id, scope.rootIds, discovery.flat, rootMemo);
    if (!inScope) continue;

    filteredFlat.set(id, node);
  }

  // Rebuild children lists to only reference in-scope nodes
  for (const node of filteredFlat.values()) {
    node.children = node.children.filter((c) => filteredFlat.has(c.id));
  }

  // Rebuild root tree
  const tree: PageNode[] = [];
  for (const node of filteredFlat.values()) {
    if (
      node.parentType === "workspace" ||
      (node.parentId &&
        !filteredFlat.has(node.parentId) &&
        node.parentType !== "database")
    ) {
      tree.push(node);
    }
  }

  sortTree(tree);

  // Filter databases to only include in-scope ones
  const filteredDbs = new Map(
    [...discovery.databases].filter(([id]) => filteredFlat.has(id)),
  );

  return { tree, flat: filteredFlat, databases: filteredDbs };
}

// ---------- Schema extraction ----------

/**
 * Extract the property schema from a Notion data source.
 */
export function extractDatabaseSchema(
  ds: DataSourceObjectResponse,
): DatabaseSchema {
  const properties: Record<string, DatabaseProperty> = {};
  const dsProps = ds.properties as Record<string, any>;

  for (const [name, prop] of Object.entries(dsProps)) {
    const dbProp: DatabaseProperty = {
      id: prop.id,
      name,
      type: prop.type,
    };

    if (prop.type === "select" && prop.select?.options) {
      dbProp.options = prop.select.options.map((o: any) => o.name);
    }
    if (prop.type === "multi_select" && prop.multi_select?.options) {
      dbProp.options = prop.multi_select.options.map((o: any) => o.name);
    }
    if (prop.type === "status" && prop.status?.options) {
      dbProp.options = prop.status.options.map((o: any) => o.name);
    }

    properties[name] = dbProp;
  }

  const titleParts = ds.title as any[];
  const title = titleParts?.map((t: any) => t.plain_text).join("") ?? ds.id;
  return { id: ds.id, title, properties };
}

// ---------- Discovery ----------

/**
 * Discover the full Notion workspace — pages + databases.
 * Lightweight: fetches schemas and row counts per database, but NOT full row data.
 */
export async function discoverNotionWorkspace(
  notion: NotionClient,
  scope?: DiscoveryScope,
): Promise<DiscoveryResult> {
  const [pages, dataSources] = await Promise.all([
    notion.searchAllPages(),
    notion.searchAllDataSources(),
  ]);

  const flat = new Map<string, PageNode>();
  const dbMap = new Map<
    string,
    { ds: DataSourceObjectResponse; schema: DatabaseSchema; rowCount: number }
  >();

  // Process data sources (databases) — schema + row count only
  for (const ds of dataSources) {
    const schema = extractDatabaseSchema(ds);

    // Get row count via a lightweight single-page query
    let rowCount = 0;
    try {
      const probe: any = await notion.call(() =>
        notion.raw.dataSources.query({
          data_source_id: ds.id,
          page_size: 1,
        } as any),
      );
      // Notion doesn't return total count, but we can check has_more
      // For a rough count, we'll note 1+ rows exist
      rowCount = probe.results?.length ?? 0;
      if (probe.has_more) rowCount = -1; // -1 means "more than 1"
    } catch {
      // Skip inaccessible databases
    }

    dbMap.set(ds.id, { ds, schema, rowCount });

    const dsTitleParts = ds.title as any[];
    const title =
      dsTitleParts?.map((t: any) => t.plain_text).join("") ||
      "Untitled Database";
    const parentInfo = resolveParent(
      (ds as any).database_parent ?? (ds as any).parent,
    );

    const node: PageNode = {
      id: ds.id,
      title,
      parentId: parentInfo.parentId,
      parentType: parentInfo.parentType,
      type: "database",
      lastEditedTime: ds.last_edited_time,
      hasChildren: rowCount !== 0,
      children: [],
    };
    flat.set(ds.id, node);
  }

  // Process regular pages (skip any that are database rows — they'll have database parent)
  for (const page of pages) {
    if (flat.has(page.id)) continue;

    const title = extractPageTitle(page);
    const parentInfo = resolveParent(page.parent);

    const node: PageNode = {
      id: page.id,
      title,
      parentId: parentInfo.parentId,
      parentType: parentInfo.parentType,
      type: "page",
      lastEditedTime: page.last_edited_time,
      hasChildren: false,
      children: [],
    };
    flat.set(page.id, node);
  }

  // Build parent-child relationships for non-database pages
  for (const node of flat.values()) {
    if (
      node.parentId &&
      node.parentType !== "database" &&
      flat.has(node.parentId)
    ) {
      const parent = flat.get(node.parentId)!;
      if (!parent.children.find((c) => c.id === node.id)) {
        parent.children.push(node);
        parent.hasChildren = true;
      }
    }
  }

  // Collect root nodes
  const tree: PageNode[] = [];
  for (const node of flat.values()) {
    if (
      node.parentType === "workspace" ||
      (node.parentId &&
        !flat.has(node.parentId) &&
        node.parentType !== "database")
    ) {
      tree.push(node);
    }
  }

  sortTree(tree);
  const result = { tree, flat, databases: dbMap };

  // Apply scope filtering if configured
  if (hasDiscoveryScope(scope)) {
    return applyDiscoveryScope(result, scope);
  }

  return result;
}

// ---------- Tree rendering ----------

/**
 * Render a PageNode tree as an ASCII tree string.
 */
export function renderTree(nodes: PageNode[], indent = ""): string {
  const lines: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const prefix = indent + (isLast ? "└── " : "├── ");
    const typeTag = node.type === "database" ? " [DB]" : "";
    lines.push(`${prefix}${node.title}${typeTag}`);

    if (node.children.length > 0) {
      const childIndent = indent + (isLast ? "    " : "│   ");
      lines.push(renderTree(node.children, childIndent));
    }
  }
  return lines.join("\n");
}

/**
 * Render the entity_map as a diagnostic tree (no API calls).
 */
export function renderEntityTree(db: DB): string {
  const entities = listEntities(db);
  if (entities.length === 0) return "(no tracked entities)";

  const lines: string[] = [];
  // Group by entity type
  const byType = new Map<string, typeof entities>();
  for (const e of entities) {
    const group = byType.get(e.entityType) ?? [];
    group.push(e);
    byType.set(e.entityType, group);
  }

  for (const [type, group] of byType) {
    lines.push(`${type} (${group.length}):`);
    for (const e of group) {
      const syncInfo = e.lastSyncTs ? `synced ${e.lastSyncTs}` : "never synced";
      const conflict = e.conflictDetectedAt ? " [CONFLICT]" : "";
      lines.push(`  ${e.localPath} → ${e.notionId}${conflict} (${syncInfo})`);
    }
  }
  return lines.join("\n");
}

// ---------- Helpers ----------

function resolveParent(parent: any): {
  parentId: string | null;
  parentType: PageNode["parentType"];
} {
  if (!parent) return { parentId: null, parentType: "workspace" };

  if (parent.type === "workspace")
    return { parentId: null, parentType: "workspace" };
  if (parent.type === "page_id")
    return { parentId: parent.page_id, parentType: "page" };
  if (parent.type === "database_id")
    return { parentId: parent.database_id, parentType: "database" };
  if (parent.type === "block_id")
    return { parentId: parent.block_id, parentType: "block" };

  // Direct property access fallback
  if (parent.page_id) return { parentId: parent.page_id, parentType: "page" };
  if (parent.database_id)
    return { parentId: parent.database_id, parentType: "database" };
  if (parent.block_id)
    return { parentId: parent.block_id, parentType: "block" };
  if (parent.workspace === true)
    return { parentId: null, parentType: "workspace" };

  return { parentId: null, parentType: "workspace" };
}

function extractPageTitle(page: PageObjectResponse): string {
  const props = page.properties as Record<string, any>;
  for (const prop of Object.values(props)) {
    if (prop.type === "title" && prop.title) {
      const titleParts = prop.title;
      if (Array.isArray(titleParts) && titleParts.length > 0) {
        return titleParts.map((t: any) => t.plain_text).join("");
      }
    }
  }
  return "Untitled";
}

function sortTree(nodes: PageNode[]): void {
  nodes.sort((a, b) => a.title.localeCompare(b.title));
  for (const node of nodes) {
    if (node.children.length > 0) {
      sortTree(node.children);
    }
  }
}
