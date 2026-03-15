import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

/**
 * MCP server entry from .mcp.json
 */
interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Structure of .mcp.json files
 */
interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
}

/** Cached result so we only parse once per process */
let cached: string | null | undefined;

/**
 * Discover a Notion API token from the official Notion MCP plugin configuration.
 *
 * Searches Claude Code's `.mcp.json` files for a server entry that uses
 * `@notionhq/notion-mcp-server`, then extracts the Bearer token from
 * the `OPENAPI_MCP_HEADERS` environment variable.
 *
 * Search order:
 *   1. ~/.claude/.mcp.json  (global Claude MCP config)
 *   2. .mcp.json            (project-level config, relative to cwd)
 *
 * Returns the first token found, or null if none.
 */
export function discoverNotionMcpToken(): string | null {
  if (cached !== undefined) return cached;

  const candidates = [
    resolve(homedir(), ".claude", ".mcp.json"),
    resolve(process.cwd(), ".mcp.json"),
  ];

  for (const filePath of candidates) {
    const token = extractTokenFromMcpConfig(filePath);
    if (token) {
      cached = token;
      return token;
    }
  }

  cached = null;
  return null;
}

/**
 * Parse a single .mcp.json file and extract the Notion token if present.
 */
function extractTokenFromMcpConfig(filePath: string): string | null {
  if (!existsSync(filePath)) return null;

  let config: McpConfig;
  try {
    const content = readFileSync(filePath, "utf-8");
    config = JSON.parse(content) as McpConfig;
  } catch {
    return null;
  }

  if (!config.mcpServers || typeof config.mcpServers !== "object") return null;

  for (const entry of Object.values(config.mcpServers)) {
    if (!isNotionMcpServer(entry)) continue;

    const headersJson = entry.env?.OPENAPI_MCP_HEADERS;
    if (!headersJson) continue;

    const token = extractBearerToken(headersJson);
    if (token) return token;
  }

  return null;
}

/**
 * Check if an MCP server entry is the Notion MCP plugin.
 * Matches if command or any arg contains `@notionhq/notion-mcp-server`.
 */
function isNotionMcpServer(entry: McpServerEntry): boolean {
  const needle = "@notionhq/notion-mcp-server";
  if (entry.command?.includes(needle)) return true;
  if (entry.args?.some((arg) => arg.includes(needle))) return true;
  return false;
}

/**
 * Extract a Bearer token from a JSON-encoded OPENAPI_MCP_HEADERS value.
 * Expected format: {"Authorization": "Bearer ntn_xxx", ...}
 */
function extractBearerToken(headersJson: string): string | null {
  try {
    const headers = JSON.parse(headersJson) as Record<string, string>;
    const auth = headers.Authorization || headers.authorization;
    if (!auth) return null;

    const match = auth.match(/^Bearer\s+(\S+)$/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Reset the cached discovery result. Useful for testing.
 */
export function resetDiscoveryCache(): void {
  cached = undefined;
}
