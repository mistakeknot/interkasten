import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DaemonContext } from "../context.js";
import { setConfigValue, loadConfig } from "../../config/loader.js";
import { TokenResolver } from "../../sync/token-resolver.js";

export function registerConfigTools(server: McpServer, ctx: DaemonContext): void {
  server.tool(
    "interkasten_config_get",
    "Read current interkasten configuration",
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
    "Update an interkasten configuration value",
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

  server.tool(
    "interkasten_config_save",
    "Save a named Notion token for multi-workspace sync. Value should use ${ENV_VAR} syntax to avoid storing secrets in config.",
    {
      alias: z.string().describe("Token alias name (e.g. 'texturaize', 'work')"),
      value: z.string().describe("Token value or env var reference (e.g. '${NOTION_TOKEN_WORK}')"),
    },
    async ({ alias, value }) => {
      try {
        // Read current tokens, add the new one
        const currentTokens = ctx.config.notion.tokens ?? {};
        const updatedTokens = { ...currentTokens, [alias]: value };
        const updated = setConfigValue("notion.tokens", updatedTokens);
        ctx.config = updated;

        // Refresh token resolver with new config
        if (ctx.tokenResolver) {
          ctx.tokenResolver = new TokenResolver(
            updated,
            process.env.INTERKASTEN_NOTION_TOKEN,
          );
        }

        // Check if the token resolves to an actual value
        const resolved = ctx.tokenResolver?.resolveAlias(alias);
        const status = resolved ? "configured and resolves" : "configured but env var not set";

        return {
          content: [{
            type: "text" as const,
            text: `Token '${alias}' saved (${status}). Use it with: interkasten_track_database(database_id, token: '${alias}')`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to save token: ${(err as Error).message}`,
          }],
          isError: true,
        };
      }
    }
  );
}
