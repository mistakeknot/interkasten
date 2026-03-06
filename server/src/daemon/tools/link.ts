import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readdirSync } from "fs";
import { resolve, basename } from "path";
import type { DaemonContext } from "../context.js";
import {
  registerDoc,
  registerProject,
  lookupByPath,
  lookupByNotionId,
} from "../../sync/entity-map.js";
import { appendSyncLog } from "../../store/sync-log.js";

/**
 * Extract a Notion page ID from a URL or raw ID string.
 * Accepts:
 *   - Full URL: https://www.notion.so/Page-Title-abc123def456...
 *   - UUID with dashes: abc123de-f456-7890-abcd-ef1234567890
 *   - UUID without dashes: abc123def4567890abcdef1234567890
 */
function parseNotionPageId(input: string): string | null {
  // Strip URL prefix
  let raw = input.trim();
  if (raw.includes("notion.so/") || raw.includes("notion.site/")) {
    // Extract the last path segment (before any query params)
    const url = new URL(raw);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (!last) return null;
    // The ID is the last 32 hex chars (possibly with dashes) at the end of the slug
    raw = last;
  }

  // Extract 32 hex chars from the end of the string (Notion slugs end with the ID)
  const hexMatch = raw.match(/([0-9a-f]{32})$/i);
  if (hexMatch) {
    const hex = hexMatch[1]!;
    // Format as UUID with dashes
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join("-");
  }

  // Try UUID with dashes
  const uuidMatch = raw.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  );
  if (uuidMatch) {
    return uuidMatch[1]!;
  }

  return null;
}

export function registerLinkTool(server: McpServer, ctx: DaemonContext): void {
  server.tool(
    "interkasten_link",
    "Link a Notion page to a local directory for sync — no full init required. " +
      "Creates entity_map entries so the sync engine picks up changes in both directions.",
    {
      notion_page: z
        .string()
        .describe("Notion page URL or ID to sync from"),
      local_dir: z
        .string()
        .describe("Absolute path to the local directory to sync to"),
      sync_children: z
        .boolean()
        .optional()
        .default(false)
        .describe("Also register child pages of this Notion page as docs (default: false)"),
    },
    async ({ notion_page, local_dir, sync_children }) => {
      // 1. Validate database is available
      if (!ctx.db) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Database not initialized. The MCP server must be running with a valid config.",
            },
          ],
          isError: true,
        };
      }

      // 2. Parse and validate Notion page ID
      const pageId = parseNotionPageId(notion_page);
      if (!pageId) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not parse Notion page ID from: ${notion_page}\n\nAccepted formats:\n- Full URL: https://www.notion.so/Page-Title-abc123...\n- UUID: abc123de-f456-7890-abcd-ef1234567890\n- Hex ID: abc123def4567890abcdef1234567890`,
            },
          ],
          isError: true,
        };
      }

      // 3. Validate local directory
      const dirPath = resolve(local_dir);
      if (!existsSync(dirPath)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Local directory does not exist: ${dirPath}`,
            },
          ],
          isError: true,
        };
      }

      // 4. Check for duplicate registrations.
      // A directory may already be registered as a project entity (via register_project
      // or init). That's fine — we'll create a doc entity alongside it for content sync.
      // But if a *doc* entity already exists for this path or notionId, it's a true dup.
      const existingByPath = lookupByPath(ctx.db, dirPath);
      if (existingByPath && existingByPath.entityType !== "project") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Already linked: ${basename(dirPath)} → https://notion.so/${existingByPath.notionId.replace(/-/g, "")}`,
            },
          ],
        };
      }

      const existingByNotion = lookupByNotionId(ctx.db, pageId);
      if (existingByNotion && existingByNotion.entityType !== "project") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Notion page already tracked as doc: ${pageId} → ${existingByNotion.localPath}`,
            },
          ],
        };
      }

      // Use the existing project entity as parent if one exists
      const projectEntity = existingByPath?.entityType === "project" ? existingByPath
        : existingByNotion?.entityType === "project" ? existingByNotion
        : null;

      // 5. Validate Notion page is accessible (if Notion client available)
      let pageTitle = basename(dirPath);
      if (ctx.notion) {
        try {
          const page: any = await ctx.notion.call(async () => {
            return ctx.notion!.raw.pages.retrieve({ page_id: pageId });
          });
          // Extract title from page properties
          const titleProp = page.properties?.title ?? page.properties?.Name;
          if (titleProp?.title?.[0]?.plain_text) {
            pageTitle = titleProp.title[0].plain_text;
          }
        } catch (err: any) {
          const status = err?.status ?? err?.code;
          if (status === 404) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Notion page not found: ${pageId}\n\nMake sure the page exists and is shared with your interkasten integration.`,
                },
              ],
              isError: true,
            };
          }
          if (status === 403) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `No access to Notion page: ${pageId}\n\nShare the page with your interkasten integration in Notion settings.`,
                },
              ],
              isError: true,
            };
          }
          // Other errors — proceed anyway, page might become accessible later
        }
      }

      // 6. Register as a doc entity pointing to a content file inside the directory.
      // A project entity maps a directory for hierarchy/containment but has no
      // file path for the sync engine to write content to. A doc entity with a
      // concrete file path gives the sync engine a target for pulled content.
      const contentFile = `${sanitizeFilename(pageTitle)}.md`;
      const docPath = resolve(dirPath, contentFile);

      // Check if a doc entity already exists for this file path
      const existingDoc = lookupByPath(ctx.db, docPath);
      if (existingDoc) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Already linked: ${contentFile} → https://notion.so/${existingDoc.notionId.replace(/-/g, "")}`,
            },
          ],
        };
      }

      const entity = registerDoc(ctx.db, docPath, pageId, "T1", projectEntity?.id ?? null);

      const output: string[] = [
        `Linked: ${pageTitle}`,
        `  Local: ${docPath}`,
        `  Notion: https://notion.so/${pageId.replace(/-/g, "")}`,
      ];

      // 7. Optionally register child pages
      let childCount = 0;
      if (sync_children && ctx.notion) {
        try {
          // Fetch child blocks that are child_page type
          let cursor: string | undefined;
          const childPages: Array<{ id: string; title: string }> = [];

          do {
            const response: any = await ctx.notion.call(async () => {
              return ctx.notion!.raw.blocks.children.list({
                block_id: pageId,
                start_cursor: cursor,
                page_size: 100,
              });
            });

            for (const block of response.results) {
              if (block.type === "child_page") {
                childPages.push({
                  id: block.id,
                  title: block.child_page?.title ?? "Untitled",
                });
              }
            }

            cursor = response.has_more ? response.next_cursor : undefined;
          } while (cursor);

          // Register each child page as a doc entity
          for (const child of childPages) {
            const childPath = resolve(dirPath, `${sanitizeFilename(child.title)}.md`);
            const existing = lookupByNotionId(ctx.db, child.id);
            if (!existing) {
              registerDoc(ctx.db, childPath, child.id, "T1", projectEntity?.id ?? null);
              childCount++;
            }
          }

          if (childCount > 0) {
            output.push(`  Children: ${childCount} child pages registered for sync`);
          }
        } catch (err) {
          output.push(`  Children: error fetching child pages — ${(err as Error).message}`);
        }
      }

      // 8. Log the operation
      appendSyncLog(ctx.db, {
        operation: "push",
        direction: "local_to_notion",
        detail: {
          action: "link",
          localPath: dirPath,
          notionId: pageId,
          childCount,
        },
      });

      output.push("");
      output.push("Sync engine will pick up changes on the next poll cycle.");
      if (!ctx.notion) {
        output.push(
          "Note: Notion client not connected — set INTERKASTEN_NOTION_TOKEN for bidirectional sync."
        );
      }

      return {
        content: [{ type: "text" as const, text: output.join("\n") }],
      };
    }
  );
}

/**
 * Sanitize a string for use as a filename.
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 200)
    || "untitled";
}
