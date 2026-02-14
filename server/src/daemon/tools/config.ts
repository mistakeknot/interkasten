import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DaemonContext } from "../context.js";
import { setConfigValue } from "../../config/loader.js";

export function registerConfigTools(server: McpServer, ctx: DaemonContext): void {
  server.tool(
    "interkasten_config_get",
    "Read current Interkasten configuration",
    {
      key: z
        .string()
        .optional()
        .describe("Dot-separated config key (e.g. 'sync.poll_interval'). Omit for full config."),
    },
    async ({ key }) => {
      const config = ctx.config;

      if (!key) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(config, null, 2) },
          ],
        };
      }

      // Navigate the key path
      const keys = key.split(".");
      let value: unknown = config;
      for (const k of keys) {
        if (value === null || value === undefined || typeof value !== "object") {
          return {
            content: [
              { type: "text" as const, text: `Key "${key}" not found in config` },
            ],
            isError: true,
          };
        }
        value = (value as Record<string, unknown>)[k];
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(value, null, 2) },
        ],
      };
    }
  );

  server.tool(
    "interkasten_config_set",
    "Update an Interkasten configuration value",
    {
      key: z.string().describe("Dot-separated config key (e.g. 'sync.poll_interval')"),
      value: z.union([z.string(), z.number(), z.boolean()]).describe("New value"),
    },
    async ({ key, value }) => {
      try {
        const updated = setConfigValue(key, value);
        ctx.config = updated;

        return {
          content: [
            {
              type: "text" as const,
              text: `Updated "${key}" to ${JSON.stringify(value)}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to update config: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
