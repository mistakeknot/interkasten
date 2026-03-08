import type { Config } from "../config/schema.js";
import type { DB } from "../store/db.js";
import type Database from "better-sqlite3";
import type { NotionClient } from "../sync/notion-client.js";
import type { TokenResolver } from "../sync/token-resolver.js";
import { walPendingCount } from "../store/wal.js";

/**
 * Shared context passed to all tool handlers.
 * Holds references to the config, database, and Notion client.
 */
export interface DaemonContext {
  version: string;
  config: Config;
  db: DB | null;
  sqlite: Database.Database | null;
  dbPath: string;
  /** Default NotionClient (global token). Use tokenResolver for multi-token. */
  notion: NotionClient | null;
  /** Token resolver for multi-workspace support. */
  tokenResolver: TokenResolver | null;
  startedAt: Date;

  /** Check if the database connection is alive. */
  isDbConnected(): boolean;

  /** Get count of pending WAL entries. */
  walPendingCount(): number;

  /**
   * Get a NotionClient for a specific database/project/alias.
   * Falls back to the default client if no override is configured.
   */
  getNotionClient(opts?: { alias?: string; databaseId?: string; projectPath?: string }): NotionClient | null;
}

/**
 * Create a new daemon context.
 */
export function createDaemonContext(config: Config, dbPath: string): DaemonContext {
  return {
    version: "0.2.0",
    config,
    db: null,
    sqlite: null,
    dbPath,
    notion: null,
    tokenResolver: null,
    startedAt: new Date(),

    isDbConnected() {
      if (!this.sqlite) return false;
      try {
        this.sqlite.pragma("quick_check");
        return true;
      } catch {
        return false;
      }
    },

    walPendingCount() {
      if (!this.db) return 0;
      return walPendingCount(this.db);
    },

    getNotionClient(opts) {
      if (this.tokenResolver) {
        return this.tokenResolver.getClientFor(opts);
      }
      return this.notion;
    },
  };
}
