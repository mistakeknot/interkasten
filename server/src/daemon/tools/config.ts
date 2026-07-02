import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DaemonContext } from "../context.js";
import { setConfigValue, loadConfig, findProjectConfig, type ConfigScope } from "../../config/loader.js";
import { TokenResolver } from "../../sync/token-resolver.js";

const ScopeParam = z
  .enum(["global", "project"])
  .optional()
  .default("global")
  .describe("Config scope: 'global' writes to ~/.interkasten/config.yaml, 'project' writes to nearest .interkasten.yaml (creates in CWD if none exists)");

export function registerConfigTools(server: McpServer, ctx: DaemonContext): void {
  server.tool(
    "interkasten_config_get",
    "Read current interkasten configuration (merged: project overrides global)",
    {
      key: z
        .string()
        .optional()
        .describe("Dot-separated config key (e.g. 'sync.poll_interval'). Omit for full config."),
    },
    async ({ key }) => {
      const config = ctx.config;
      const projectConfigPath = findProjectConfig();

      if (!key) {
        const header = projectConfigPath
          ? `# Merged config (project: ${projectConfigPath})\n`
          : "# Global config (no project-level .interkasten.yaml found)\n";
        return {
          content: [
            { type: "text" as const, text: header + JSON.stringify(config, null, 2) },
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
    "Update an interkasten configuration value. Use scope='project' to write to .interkasten.yaml (project-level), or 'global' for ~/.interkasten/config.yaml.",
    {
      key: z.string().describe("Dot-separated config key (e.g. 'sync.poll_interval')"),
      value: z.union([z.string(), z.number(), z.boolean()]).describe("New value"),
      scope: ScopeParam,
    },
    async ({ key, value, scope }) => {
      try {
        const updated = setConfigValue(key, value, scope as ConfigScope);
        ctx.config = updated;

        const target = scope === "project" ? ".interkasten.yaml" : "~/.interkasten/config.yaml";
        return {
          content: [
            {
              type: "text" as const,
              text: `Updated "${key}" to ${JSON.stringify(value)} in ${target}`,
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
    "Save a named Notion token for multi-workspace sync. Value should use ${ENV_VAR} syntax to avoid storing secrets in config. Use scope='project' to keep the token scoped to this project.",
    {
      alias: z.string().describe("Token alias name (e.g. 'texturaize', 'work')"),
      value: z.string().describe("Token value or env var reference (e.g. '${NOTION_TOKEN_WORK}')"),
      scope: ScopeParam,
    },
    async ({ alias, value, scope }) => {
      try {
        // Read current tokens, add the new one
        const currentTokens = ctx.config.notion.tokens ?? {};
        const updatedTokens = { ...currentTokens, [alias]: value };
        const updated = setConfigValue("notion.tokens", updatedTokens, scope as ConfigScope);
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

        const target = scope === "project" ? ".interkasten.yaml" : "~/.interkasten/config.yaml";
        return {
          content: [{
            type: "text" as const,
            text: `Token '${alias}' saved to ${target} (${status}). Use it with: interkasten_track_database(database_id, token: '${alias}')`,
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
