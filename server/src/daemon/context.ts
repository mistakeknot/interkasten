import type { Config } from "../config/schema.js";
import type { DB } from "../store/db.js";
import type Database from "better-sqlite3";
import type { NotionClient } from "../sync/notion-client.js";
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
  notion: NotionClient | null;
  startedAt: Date;

  /** Check if the database connection is alive. */
  isDbConnected(): boolean;

  /** Get count of pending WAL entries. */
  walPendingCount(): number;
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
  };
}
