import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DaemonContext } from "../context.js";
import {
  discoverNotionWorkspace,
  renderTree,
  renderEntityTree,
} from "../../sync/discovery.js";
import { listEntities } from "../../store/entities.js";

export function registerDiscoveryTools(server: McpServer, ctx: DaemonContext): void {
  /**
   * Enumerate the full Notion workspace as an ASCII tree.
   * Shows databases with schemas/row counts and tracked vs untracked status.
   */
  server.tool(
    "interkasten_discover_workspace",
    "Enumerate Notion workspace: ASCII tree of all pages and databases with schemas, row counts, and tracked/untracked status",
    {},
    async () => {
      if (!ctx.notion) {
        return {
          content: [{ type: "text" as const, text: "Notion client not initialized — set INTERKASTEN_NOTION_TOKEN" }],
          isError: true,
        };
      }

      const result = await discoverNotionWorkspace(ctx.notion);

      // Build tracked set for comparison
      const trackedNotionIds = new Set<string>();
      if (ctx.db) {
        const entities = listEntities(ctx.db);
        for (const e of entities) {
          trackedNotionIds.add(e.notionId);
        }
      }

      // Render tree
      const treeStr = renderTree(result.tree);

      // Database summary
      const dbLines: string[] = [];
      for (const [dsId, info] of result.databases) {
        const tracked = trackedNotionIds.has(dsId) ? "TRACKED" : "untracked";
        const rowLabel = info.rowCount === -1 ? "1+ rows" : `${info.rowCount} rows`;
        const propCount = Object.keys(info.schema.properties).length;
        dbLines.push(`  ${info.schema.title} (${dsId})`);
        dbLines.push(`    ${rowLabel}, ${propCount} properties, ${tracked}`);
        // List property names/types
        for (const [name, prop] of Object.entries(info.schema.properties)) {
          const opts = prop.options ? ` [${prop.options.join(", ")}]` : "";
          dbLines.push(`    - ${name}: ${prop.type}${opts}`);
        }
      }

      const output = [
        "Notion Workspace Tree",
        "=====================",
        treeStr || "(empty workspace)",
        "",
        `Databases (${result.databases.size}):`,
        ...dbLines,
        "",
        `Total pages: ${result.flat.size}`,
        `Tracked entities: ${trackedNotionIds.size}`,
      ].join("\n");

      return {
        content: [{ type: "text" as const, text: output }],
      };
    }
  );

  /**
   * Render the current entity_map as a diagnostic tree (no API calls).
   */
  server.tool(
    "interkasten_notion_tree",
    "Show the local entity_map as a diagnostic tree — tracked entities, sync status, conflicts (no API calls)",
    {},
    async () => {
      if (!ctx.db) {
        return {
          content: [{ type: "text" as const, text: "Database not initialized" }],
          isError: true,
        };
      }

      const tree = renderEntityTree(ctx.db);
      return {
        content: [{ type: "text" as const, text: tree }],
      };
    }
  );
}
