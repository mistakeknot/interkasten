import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import type { DaemonContext } from "../context.js";
import {
  upsertPageTracking,
  getPageTracking,
  listTrackedPages,
  removePageTracking,
} from "../../store/pages.js";
import {
  registerPage,
  registerPageChild,
  getChildrenForPage,
  lookupByNotionId,
} from "../../sync/entity-map.js";
import { softDeleteEntity } from "../../store/entities.js";
import { notionBlocksToMarkdown } from "../../sync/translator.js";
import { stringifyFrontmatter } from "../../sync/frontmatter.js";
import type { NotionClient } from "../../sync/notion-client.js";

/**
 * Extract the title from a Notion page object.
 */
function extractPageTitle(page: any): string {
  // Try title-type properties first
  for (const prop of Object.values(page.properties ?? {})) {
    const p = prop as any;
    if (p.type === "title" && p.title?.length > 0) {
      return p.title.map((t: any) => t.plain_text).join("");
    }
  }
  return "Untitled";
}

/**
 * Sanitize a title for use as a filename.
 */
function sanitizeFilename(title: string): string {
  return title
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100) || "Untitled";
}

/**
 * Resolve a NotionClient for a page operation.
 */
function resolveClient(
  ctx: DaemonContext,
  opts?: { tokenAlias?: string; },
): NotionClient | null {
  if (ctx.tokenResolver && opts?.tokenAlias) {
    return ctx.tokenResolver.getClientFor({ alias: opts.tokenAlias });
  }
  return ctx.notion;
}

interface PageInfo {
  id: string;
  title: string;
  lastEditedTime: string;
  hasChildren: boolean;
}

/**
 * Discover child pages under a Notion page (one level).
 */
async function discoverChildPages(
  notion: NotionClient,
  pageId: string,
): Promise<PageInfo[]> {
  const children: PageInfo[] = [];
  let cursor: string | undefined;

  do {
    const response: any = await notion.call(() =>
      notion.raw.blocks.children.list({
        block_id: pageId,
        start_cursor: cursor,
        page_size: 100,
      })
    );

    for (const block of response.results) {
      if (block.type === "child_page") {
        children.push({
          id: block.id,
          title: block.child_page?.title ?? "Untitled",
          lastEditedTime: block.last_edited_time ?? "",
          hasChildren: block.has_children ?? false,
        });
      }
    }

    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return children;
}

/**
 * Recursively pull a page and its children to local markdown files.
 */
async function pullPageTree(
  notion: NotionClient,
  db: DaemonContext["db"],
  pageId: string,
  title: string,
  outputDir: string,
  parentEntityId: number | null,
  depth: number,
  maxDepth: number,
  usedFilenames: Set<string>,
  isRoot: boolean,
): Promise<{ pulled: number; errors: string[] }> {
  let pulled = 0;
  const errors: string[] = [];

  // Pull this page's content
  let body = "";
  try {
    body = await notionBlocksToMarkdown(notion.raw, pageId);
  } catch (err) {
    errors.push(`Failed to convert page ${pageId}: ${(err as Error).message}`);
  }

  // Build frontmatter
  const fm: Record<string, unknown> = {
    notion_id: pageId,
    notion_type: isRoot ? "page" : "page_child",
    title,
    last_synced: new Date().toISOString(),
  };

  const content = stringifyFrontmatter(fm, body);

  // Generate deduplicated filename
  let filename = sanitizeFilename(title);
  if (usedFilenames.has(filename.toLowerCase())) {
    filename = `${filename}-${pageId.slice(-4)}`;
  }
  usedFilenames.add(filename.toLowerCase());

  const filePath = join(outputDir, `${filename}.md`);
  writeFileSync(filePath, content, "utf-8");

  // Register in entity_map
  if (db) {
    if (isRoot) {
      registerPage(db, filePath, pageId);
    } else if (parentEntityId != null) {
      registerPageChild(db, filePath, pageId, parentEntityId);
    }
  }
  pulled++;

  // Get the entity ID for this page (needed as parent for children)
  const thisEntity = db ? lookupByNotionId(db, pageId) : null;

  // Recurse into children if within depth limit
  if (depth < maxDepth) {
    let childPages: PageInfo[];
    try {
      childPages = await discoverChildPages(notion, pageId);
    } catch (err) {
      errors.push(`Failed to discover children of ${pageId}: ${(err as Error).message}`);
      return { pulled, errors };
    }

    for (const child of childPages) {
      const result = await pullPageTree(
        notion,
        db,
        child.id,
        child.title,
        outputDir,
        thisEntity?.id ?? null,
        depth + 1,
        maxDepth,
        usedFilenames,
        false,
      );
      pulled += result.pulled;
      errors.push(...result.errors);
    }
  }

  return { pulled, errors };
}

export function registerPageTools(
  server: McpServer,
  ctx: DaemonContext,
): void {
  /**
   * Track a Notion page for one-way sync (Notion → local markdown).
   */
  server.tool(
    "interkasten_track_page",
    "Pull a Notion page (and optionally its child pages) as local markdown files. Supports multi-workspace via token alias.",
    {
      page_id: z.string().describe("Notion page ID to track"),
      output_dir: z.string().optional().describe("Local directory for page files (defaults to ~/.interkasten/pages/<title>)"),
      token: z.string().optional().describe("Named token alias from config (e.g. 'texturaize'). Uses default token if omitted."),
      recursive: z.boolean().optional().default(true).describe("Pull child pages recursively (default: true)"),
      depth: z.number().int().min(1).max(10).optional().default(3).describe("Max recursion depth for child pages (default: 3)"),
    },
    async ({ page_id, output_dir, token: tokenAlias, recursive, depth }) => {
      if (!ctx.db) {
        return {
          content: [{ type: "text" as const, text: "Database not initialized" }],
          isError: true,
        };
      }

      // Resolve NotionClient
      const notion = resolveClient(ctx, { tokenAlias });
      if (!notion) {
        const hint = tokenAlias
          ? `Token alias '${tokenAlias}' not found in config. Check notion.tokens in config.yaml.`
          : "Notion client not initialized. Set INTERKASTEN_NOTION_TOKEN or configure notion.tokens in config.yaml.";
        return {
          content: [{ type: "text" as const, text: hint }],
          isError: true,
        };
      }

      // Validate token
      const { valid, error } = await notion.validateToken();
      if (!valid) {
        return {
          content: [{ type: "text" as const, text: `Token validation failed: ${error?.message}. ${error?.remediation}` }],
          isError: true,
        };
      }

      // Fetch the root page to get its title
      let page: any;
      try {
        page = await notion.call(() =>
          notion.raw.pages.retrieve({ page_id })
        );
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to retrieve page: ${(err as Error).message}` }],
          isError: true,
        };
      }

      const title = extractPageTitle(page);
      const outputPath = output_dir ?? resolve(
        process.env.HOME ?? "~",
        ".interkasten",
        "pages",
        sanitizeFilename(title),
      );

      // Ensure output dir exists
      mkdirSync(outputPath, { recursive: true });

      // Store tracking config
      upsertPageTracking(ctx.db, {
        notionPageId: page_id,
        title,
        outputDir: outputPath,
        tokenAlias: tokenAlias ?? null,
        recursive: recursive ?? true,
        maxDepth: depth ?? 3,
      });

      // Pull page tree
      const maxDepth = (recursive ?? true) ? (depth ?? 3) : 0;
      const usedFilenames = new Set<string>();
      const result = await pullPageTree(
        notion,
        ctx.db,
        page_id,
        title,
        outputPath,
        null,
        0,
        maxDepth,
        usedFilenames,
        true,
      );

      const tokenInfo = tokenAlias ? `\nToken: ${tokenAlias}` : "";
      const errorInfo = result.errors.length > 0
        ? `\nErrors:\n${result.errors.map(e => `  - ${e}`).join("\n")}`
        : "";

      return {
        content: [{
          type: "text" as const,
          text: [
            `Tracked page: ${title}`,
            `Output: ${outputPath}`,
            `Pages pulled: ${result.pulled}`,
            `Recursive: ${recursive ?? true} (max depth: ${depth ?? 3})`,
            tokenInfo,
            errorInfo,
          ].filter(Boolean).join("\n"),
        }],
      };
    }
  );

  /**
   * Stop tracking a page — soft-delete all child entities + remove tracking.
   */
  server.tool(
    "interkasten_untrack_page",
    "Stop tracking a Notion page: soft-delete all page entities and remove tracking config",
    {
      page_id: z.string().describe("Notion page ID to untrack"),
    },
    async ({ page_id }) => {
      if (!ctx.db) {
        return {
          content: [{ type: "text" as const, text: "Database not initialized" }],
          isError: true,
        };
      }

      const tracking = getPageTracking(ctx.db, page_id);
      if (!tracking) {
        return {
          content: [{ type: "text" as const, text: `Page ${page_id} is not tracked` }],
          isError: true,
        };
      }

      // Soft-delete page entity and all children
      const pageEntity = lookupByNotionId(ctx.db, page_id);
      let deletedCount = 0;
      if (pageEntity) {
        const children = getChildrenForPage(ctx.db, pageEntity.id);
        for (const child of children) {
          softDeleteEntity(ctx.db, child.id);
          deletedCount++;
        }
        softDeleteEntity(ctx.db, pageEntity.id);
        deletedCount++;
      }

      removePageTracking(ctx.db, page_id);

      return {
        content: [{
          type: "text" as const,
          text: `Untracked page: ${tracking.title}\nSoft-deleted ${deletedCount} entities\nTracking removed`,
        }],
      };
    }
  );

  /**
   * List tracked pages with status.
   */
  server.tool(
    "interkasten_list_pages",
    "List all tracked Notion pages with child counts and sync status",
    {},
    async () => {
      if (!ctx.db) {
        return {
          content: [{ type: "text" as const, text: "Database not initialized" }],
          isError: true,
        };
      }

      const tracked = listTrackedPages(ctx.db);
      if (tracked.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No pages tracked. Use interkasten_track_page to start." }],
        };
      }

      const lines: string[] = [];
      for (const page of tracked) {
        const pageEntity = lookupByNotionId(ctx.db!, page.notionPageId);
        const childCount = pageEntity ? getChildrenForPage(ctx.db!, pageEntity.id).length : 0;

        lines.push(`${page.title}`);
        lines.push(`  ID: ${page.notionPageId}`);
        lines.push(`  Output: ${page.outputDir}`);
        lines.push(`  Token: ${page.tokenAlias ?? "(default)"}`);
        lines.push(`  Recursive: ${page.recursive} (max depth: ${page.maxDepth})`);
        lines.push(`  Child pages: ${childCount}`);
        lines.push(`  Last fetched: ${page.lastFetchedAt}`);
        lines.push("");
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );

  /**
   * Refresh a tracked page: re-pull content and discover new/deleted children.
   */
  server.tool(
    "interkasten_refresh_page",
    "Re-sync a tracked page: pull updated content, discover new child pages, detect deletions",
    {
      page_id: z.string().describe("Notion page ID to refresh"),
    },
    async ({ page_id }) => {
      if (!ctx.db) {
        return {
          content: [{ type: "text" as const, text: "Database not initialized" }],
          isError: true,
        };
      }

      const tracking = getPageTracking(ctx.db, page_id);
      if (!tracking) {
        return {
          content: [{ type: "text" as const, text: `Page ${page_id} is not tracked. Use interkasten_track_page first.` }],
          isError: true,
        };
      }

      // Resolve client using stored token alias
      const notion = resolveClient(ctx, {
        tokenAlias: tracking.tokenAlias ?? undefined,
      });
      if (!notion) {
        const hint = tracking.tokenAlias
          ? `Stored token alias '${tracking.tokenAlias}' not found. Update notion.tokens in config.yaml.`
          : "Notion client not initialized.";
        return {
          content: [{ type: "text" as const, text: hint }],
          isError: true,
        };
      }

      // Fetch root page for updated title
      let page: any;
      try {
        page = await notion.call(() =>
          notion.raw.pages.retrieve({ page_id })
        );
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to retrieve page: ${(err as Error).message}` }],
          isError: true,
        };
      }

      const title = extractPageTitle(page);
      const outputPath = tracking.outputDir;

      // Get existing tracked children for deletion detection
      const pageEntity = lookupByNotionId(ctx.db, page_id);
      const existingChildren = pageEntity ? getChildrenForPage(ctx.db, pageEntity.id) : [];
      const existingChildIds = new Set(existingChildren.map(c => c.notionId));

      // Re-pull the entire tree
      const maxDepth = tracking.recursive ? tracking.maxDepth : 0;
      const usedFilenames = new Set<string>();
      const result = await pullPageTree(
        notion,
        ctx.db,
        page_id,
        title,
        outputPath,
        null,
        0,
        maxDepth,
        usedFilenames,
        true,
      );

      // Collect all notion IDs we just pulled
      const pulledIds = new Set<string>();
      pulledIds.add(page_id);
      // Walk entity_map for all children of this page
      if (pageEntity) {
        const refreshedChildren = getChildrenForPage(ctx.db, pageEntity.id);
        for (const child of refreshedChildren) {
          pulledIds.add(child.notionId);
        }
      }

      // Soft-delete children that no longer exist in Notion
      let deletedCount = 0;
      for (const existing of existingChildren) {
        if (!pulledIds.has(existing.notionId)) {
          softDeleteEntity(ctx.db, existing.id);
          deletedCount++;
        }
      }

      // Update tracking metadata
      upsertPageTracking(ctx.db, {
        notionPageId: page_id,
        title,
        outputDir: outputPath,
      });

      return {
        content: [{
          type: "text" as const,
          text: [
            `Refreshed: ${title}`,
            `Pages pulled: ${result.pulled}`,
            `Deleted: ${deletedCount}`,
            result.errors.length > 0
              ? `Errors:\n${result.errors.map(e => `  - ${e}`).join("\n")}`
              : "",
          ].filter(Boolean).join("\n"),
        }],
      };
    }
  );
}
