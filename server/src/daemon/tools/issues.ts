import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { basename } from "path";
import type { DaemonContext } from "../context.js";
import { listEntities } from "../../store/entities.js";

/**
 * Register beads issue sync MCP tools.
 */
export function registerIssuesTools(
  server: McpServer,
  ctx: DaemonContext,
): void {
  server.tool(
    "interkasten_list_issues",
    "List synced beads issues with both beads ID and Notion page ID",
    {
      project: z
        .string()
        .optional()
        .describe("Filter by project path or name"),
    },
    async ({ project }) => {
      if (!ctx.db) {
        return {
          content: [{ type: "text" as const, text: "Database not connected" }],
          isError: true,
        };
      }

      const issues = listEntities(ctx.db, "issue");

      const filtered = project
        ? issues.filter((i) =>
            i.localPath.includes(project) || basename(i.localPath).includes(project),
          )
        : issues;

      if (filtered.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No synced issues found." },
          ],
        };
      }

      const result = filtered.map((i) => ({
        beadsId: basename(i.localPath),
        notionPageId: i.notionId,
        localPath: i.localPath,
        lastSyncTs: i.lastSyncTs,
        hasConflict: !!i.conflictDetectedAt,
      }));

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}
