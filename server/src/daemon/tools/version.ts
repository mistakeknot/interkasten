import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DaemonContext } from "../context.js";

export function registerVersionTool(server: McpServer, ctx: DaemonContext): void {
  server.tool(
    "interkasten_version",
    "Return daemon version, schema version, and plugin compatibility range",
    {},
    async () => {
      const result = {
        daemon_version: ctx.version,
        schema_version: 1,
        plugin_compatibility: ">=0.1.0",
        node_version: process.version,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
