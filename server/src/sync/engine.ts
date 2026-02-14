import { readFileSync, existsSync } from "fs";
import { resolve, relative, basename } from "path";
import type { DB } from "../store/db.js";
import type { NotionClient } from "./notion-client.js";
import type { Config } from "../config/schema.js";
import type { FileChangeEvent } from "./watcher.js";
import type { SyncOperation } from "./queue.js";
import { SyncQueue } from "./queue.js";
import { FileWatcher } from "./watcher.js";
import {
  markdownToNotionBlocks,
  notionBlocksToMarkdown,
  hashMarkdown,
  normalizeMarkdown,
} from "./translator.js";
import {
  getEntityByPath,
  upsertEntity,
  hashContent,
  updateEntityAfterSync,
  upsertBaseContent,
} from "../store/entities.js";
import { walCreatePending, walMarkTargetWritten, walMarkCommitted, walDelete } from "../store/wal.js";
import { appendSyncLog } from "../store/sync-log.js";
import { lookupByPath, registerDoc, computeTier } from "./entity-map.js";

export interface SyncEngineOptions {
  config: Config;
  db: DB;
  notion: NotionClient;
}

/**
 * The sync engine orchestrates push operations:
 * watcher event → hash comparison → WAL pending → translate → Notion write →
 * WAL target_written → entity_map update → WAL committed → WAL delete
 */
export class SyncEngine {
  private db: DB;
  private notion: NotionClient;
  private config: Config;
  private watcher: FileWatcher | null = null;
  private queue: SyncQueue;
  private processTimer: NodeJS.Timeout | null = null;

  constructor(options: SyncEngineOptions) {
    this.db = options.db;
    this.notion = options.notion;
    this.config = options.config;
    this.queue = new SyncQueue({
      concurrency: 1,
      maxQueueSize: options.config.sync.max_queue_size,
    });
  }

  /**
   * Start the sync engine: begin watching and processing.
   */
  start(): void {
    // Start filesystem watcher
    this.watcher = new FileWatcher({
      projectsDir: this.config.projects_dir,
      debounceMs: this.config.watcher.debounce_ms,
      ignorePatterns: this.config.watcher.ignore_patterns,
    });

    this.watcher.on("file-change", (event: FileChangeEvent) => {
      this.handleFileChange(event);
    });

    this.watcher.on("error", (err: Error) => {
      console.error("Watcher error:", err.message);
    });

    this.watcher.start();

    // Process queue on interval
    this.processTimer = setInterval(() => {
      this.processQueue().catch((err) => {
        console.error("Queue processing error:", err);
      });
    }, 2000);
  }

  /**
   * Stop the sync engine.
   */
  async stop(): Promise<void> {
    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
    // Process remaining queue items
    await this.processQueue();
    await this.queue.onIdle();
  }

  /**
   * Handle a file change event from the watcher.
   */
  private handleFileChange(event: FileChangeEvent): void {
    const op: SyncOperation = {
      side: "local",
      type: event.type === "add" ? "file_added" : event.type === "change" ? "file_modified" : "file_removed",
      entityKey: event.path,
      timestamp: event.timestamp,
    };
    this.queue.enqueue(op);
  }

  /**
   * Notify the engine of a file change (from hook or external trigger).
   */
  notifyFileChange(filePath: string): void {
    if (!existsSync(filePath)) {
      this.queue.enqueue({
        side: "local",
        type: "file_removed",
        entityKey: filePath,
        timestamp: new Date(),
      });
    } else {
      this.queue.enqueue({
        side: "local",
        type: "file_modified",
        entityKey: filePath,
        timestamp: new Date(),
      });
    }
  }

  /**
   * Process all pending operations in the queue.
   */
  async processQueue(): Promise<void> {
    const ops = this.queue.drain();
    for (const op of ops) {
      try {
        await this.processPushOperation(op);
      } catch (err) {
        console.error(`Sync error for ${op.entityKey}:`, err);
        appendSyncLog(this.db, {
          operation: "error",
          direction: "local_to_notion",
          detail: {
            entityKey: op.entityKey,
            error: (err as Error).message,
          },
        });
      }
    }
  }

  /**
   * Process a single push operation.
   * Follows the WAL protocol from PRD §6.
   */
  private async processPushOperation(op: SyncOperation): Promise<void> {
    if (op.side !== "local") return;
    if (op.type === "file_removed") return; // Soft-delete handled separately

    const filePath = op.entityKey;
    if (!existsSync(filePath)) return;

    // Read current file content
    const content = readFileSync(filePath, "utf-8");
    const currentHash = hashContent(normalizeMarkdown(content));

    // Check if entity is already tracked
    const entity = getEntityByPath(this.db, filePath);

    if (entity) {
      // Skip if content hasn't changed
      if (entity.lastLocalHash === currentHash) return;

      // Push update to existing Notion page
      await this.pushUpdate(entity.id, entity.notionId, content, currentHash);
    } else {
      // New file — needs a project context to determine where to create in Notion
      // For now, we only push updates to already-registered entities.
      // New entity registration happens during init or register_project.
    }
  }

  /**
   * Push updated content to an existing Notion page.
   */
  private async pushUpdate(
    entityId: number,
    notionPageId: string,
    content: string,
    localHash: string
  ): Promise<void> {
    // 1. WAL: pending
    const walEntry = walCreatePending(this.db, {
      entityMapId: entityId,
      operation: "push",
      newContent: content,
    });

    try {
      // 2. Translate and write to Notion
      const blocks = markdownToNotionBlocks(content);

      await this.notion.call(
        async () => {
          // Clear existing blocks
          const existingBlocks = await this.notion.raw.blocks.children.list({
            block_id: notionPageId,
            page_size: 100,
          });

          // Delete existing blocks
          for (const block of existingBlocks.results) {
            if ("id" in block) {
              await this.notion.raw.blocks.delete({ block_id: block.id });
            }
          }

          // Append new blocks (Notion API limits to 100 blocks per call)
          for (let i = 0; i < blocks.length; i += 100) {
            const chunk = blocks.slice(i, i + 100);
            await this.notion.raw.blocks.children.append({
              block_id: notionPageId,
              children: chunk as Parameters<typeof this.notion.raw.blocks.children.append>[0]["children"],
            });
          }
        },
        { pageId: notionPageId }
      );

      // 3. WAL: target_written
      walMarkTargetWritten(this.db, walEntry.id);

      // 4. Pull back the content for roundtrip base
      let notionHash = localHash;
      let baseContentId: number | undefined;
      try {
        const pulledBack = await notionBlocksToMarkdown(this.notion.raw, notionPageId);
        notionHash = hashContent(normalizeMarkdown(pulledBack));
        const base = upsertBaseContent(this.db, pulledBack);
        baseContentId = base.id;
      } catch {
        // If pull-back fails, use local content as base
        const base = upsertBaseContent(this.db, content);
        baseContentId = base.id;
      }

      // 5. Update entity_map (within same transaction as WAL commit)
      updateEntityAfterSync(this.db, entityId, {
        lastLocalHash: localHash,
        lastNotionHash: notionHash,
        baseContentId,
        lastSyncTs: new Date().toISOString(),
      });

      // 6. WAL: committed
      walMarkCommitted(this.db, walEntry.id);

      // 7. WAL: cleanup
      walDelete(this.db, walEntry.id);

      // Log success
      appendSyncLog(this.db, {
        entityMapId: entityId,
        operation: "push",
        direction: "local_to_notion",
        detail: { hash: localHash },
      });
    } catch (err) {
      // WAL remains in pending/target_written state for crash recovery
      appendSyncLog(this.db, {
        entityMapId: entityId,
        operation: "error",
        direction: "local_to_notion",
        detail: { error: (err as Error).message },
      });
      throw err;
    }
  }

  /**
   * Force sync of a specific file (for manual trigger / hook notification).
   */
  async syncFile(filePath: string): Promise<void> {
    if (!existsSync(filePath)) return;

    const content = readFileSync(filePath, "utf-8");
    const currentHash = hashContent(normalizeMarkdown(content));
    const entity = getEntityByPath(this.db, filePath);

    if (entity && entity.lastLocalHash !== currentHash) {
      await this.pushUpdate(entity.id, entity.notionId, content, currentHash);
    }
  }

  /**
   * Get current queue status.
   */
  getStatus(): {
    pending: number;
    active: number;
    dropped: number;
    watcherActive: boolean;
  } {
    return {
      pending: this.queue.size,
      active: this.queue.activeCount,
      dropped: this.queue.dropped,
      watcherActive: this.watcher !== null,
    };
  }
}
