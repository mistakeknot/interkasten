import { resolve } from "path";
import { homedir } from "os";
import type { Config } from "../config/schema.js";
import { NotionClient, type NotionClientOptions } from "./notion-client.js";

/**
 * Resolves Notion tokens using a priority chain:
 *   1. Database-specific override (notion.database_tokens)
 *   2. Project-specific override (notion.project_tokens)
 *   3. Global default (INTERKASTEN_NOTION_TOKEN env var)
 *
 * Manages a pool of NotionClient instances keyed by resolved token,
 * so each workspace gets its own rate limiter and circuit breaker.
 */
export class TokenResolver {
  private config: Config;
  private pool = new Map<string, NotionClient>();
  private defaultToken: string | undefined;
  private backoffOpts: Pick<
    NotionClientOptions,
    "initialDelayMs" | "maxDelayMs" | "circuitBreakerThreshold" | "circuitBreakerCheckInterval"
  >;

  constructor(config: Config, defaultToken?: string) {
    this.config = config;
    this.defaultToken = defaultToken;
    this.backoffOpts = {
      initialDelayMs: config.sync.backoff.initial_delay_ms,
      maxDelayMs: config.sync.backoff.max_delay_ms,
      circuitBreakerThreshold: config.sync.backoff.circuit_breaker_threshold,
      circuitBreakerCheckInterval: config.sync.backoff.circuit_breaker_check_interval,
    };
  }

  /**
   * Resolve a token alias to its actual value.
   * Alias "default" maps to the INTERKASTEN_NOTION_TOKEN env var.
   */
  resolveAlias(alias: string): string | undefined {
    if (alias === "default") return this.defaultToken;
    return this.config.notion.tokens[alias];
  }

  /**
   * Resolve the token for a specific database ID.
   * Chain: database_tokens[databaseId] → default token.
   */
  resolveForDatabase(databaseId: string): string | undefined {
    const alias = this.config.notion.database_tokens[databaseId];
    if (alias) {
      const resolved = this.resolveAlias(alias);
      if (resolved) return resolved;
    }
    return this.defaultToken;
  }

  /**
   * Resolve the token for a project path.
   * Chain: project_tokens[path] → default token.
   * Normalizes paths (expands ~) for comparison.
   */
  resolveForProject(projectPath: string): string | undefined {
    const normalizedPath = expandHome(projectPath);
    for (const [configPath, alias] of Object.entries(this.config.notion.project_tokens)) {
      if (normalizedPath === expandHome(configPath) || normalizedPath.startsWith(expandHome(configPath) + "/")) {
        const resolved = this.resolveAlias(alias);
        if (resolved) return resolved;
      }
    }
    return this.defaultToken;
  }

  /**
   * Full resolution chain: explicit alias → database → project → default.
   */
  resolve(opts?: { alias?: string; databaseId?: string; projectPath?: string }): string | undefined {
    // 1. Explicit alias (from tool parameter)
    if (opts?.alias) {
      const resolved = this.resolveAlias(opts.alias);
      if (resolved) return resolved;
    }

    // 2. Database-specific override
    if (opts?.databaseId) {
      const alias = this.config.notion.database_tokens[opts.databaseId];
      if (alias) {
        const resolved = this.resolveAlias(alias);
        if (resolved) return resolved;
      }
    }

    // 3. Project-specific override
    if (opts?.projectPath) {
      const token = this.resolveForProject(opts.projectPath);
      if (token && token !== this.defaultToken) return token;
    }

    // 4. Global default
    return this.defaultToken;
  }

  /**
   * Get or create a NotionClient for the given token.
   * Returns the pooled client if one exists for this token.
   */
  getClient(token: string): NotionClient {
    let client = this.pool.get(token);
    if (!client) {
      client = new NotionClient({
        token,
        concurrency: 3,
        ...this.backoffOpts,
      });
      this.pool.set(token, client);
    }
    return client;
  }

  /**
   * Get the default NotionClient (for the global token).
   */
  getDefaultClient(): NotionClient | null {
    if (!this.defaultToken) return null;
    return this.getClient(this.defaultToken);
  }

  /**
   * Get a NotionClient for the resolved token, using the full resolution chain.
   */
  getClientFor(opts?: { alias?: string; databaseId?: string; projectPath?: string }): NotionClient | null {
    const token = this.resolve(opts);
    if (!token) return null;
    return this.getClient(token);
  }

  /**
   * List all token aliases that have been configured.
   */
  listAliases(): string[] {
    return Object.keys(this.config.notion.tokens);
  }

  /**
   * Check if any non-default tokens are configured.
   */
  hasMultipleTokens(): boolean {
    return Object.keys(this.config.notion.tokens).length > 0;
  }
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}
