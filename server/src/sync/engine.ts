import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, relative, basename } from "path";
import type { DB } from "../store/db.js";
import type { NotionClient } from "./notion-client.js";
import type { Config } from "../config/schema.js";
import type { FileChangeEvent } from "./watcher.js";
import type { SyncOperation } from "./queue.js";
import { SyncQueue } from "./queue.js";
import { FileWatcher } from "./watcher.js";
import { NotionPoller, type PageChange } from "./notion-poller.js";
import {
  threeWayMerge,
  formatConflictFile,
  type ConflictStrategy,
} from "./merge.js";
import {
  markdownToNotionBlocks,
  notionBlocksToMarkdown,
  hashMarkdown,
  normalizeMarkdown,
} from "./translator.js";
import {
  getEntityByPath,
  getEntityByNotionId,
  upsertEntity,
  hashContent,
  updateEntityAfterSync,
  upsertBaseContent,
  getBaseContent,
  markConflict,
  clearConflict,
  listEntities,
} from "../store/entities.js";
import { walCreatePending, walMarkTargetWritten, walMarkCommitted, walDelete } from "../store/wal.js";
import { appendSyncLog } from "../store/sync-log.js";
import { lookupByPath, registerDoc, computeTier } from "./entity-map.js";
import {
  fetchBeadsIssues,
  diffBeadsState,
  mapBeadsToNotionProperties,
  mapNotionToBeadsUpdate,
  updateBeadsIssue,
  type BeadsIssue,
} from "./beads-sync.js";
import { sql } from "drizzle-orm";
import { softDeleteEntity, gcDeletedEntities } from "../store/entities.js";

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
  private pollTimer: NodeJS.Timeout | null = null;
  private poller: NotionPoller;
  private pollInProgress = false;

  constructor(options: SyncEngineOptions) {
    this.db = options.db;
    this.notion = options.notion;
    this.config = options.config;
    this.poller = new NotionPoller(options.notion);
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

    // Poll Notion for remote changes
    const pollIntervalMs = (this.config.sync?.poll_interval ?? 60) * 1000;
    this.pollTimer = setInterval(() => {
      this.pollNotionChanges().catch((err) => {
        console.error("Poll error:", err);
      });
    }, pollIntervalMs);
  }

  /**
   * Stop the sync engine.
   */
  async stop(): Promise<void> {
    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
    // Process remaining queue items
    await this.processQueue();
    await this.queue.onIdle();

    // Clean up expired soft-deleted entities
    const gcCount = this.runGC();
    if (gcCount > 0) {
      console.log(`GC: removed ${gcCount} expired soft-deleted entities`);
    }
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
        if (op.side === "notion") {
          await this.processPullOperation(op);
        } else {
          await this.processPushOperation(op);
        }
      } catch (err) {
        console.error(`Sync error for ${op.entityKey}:`, err);
        appendSyncLog(this.db, {
          operation: "error",
          direction: op.side === "notion" ? "notion_to_local" : "local_to_notion",
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
    if (op.type === "file_removed") {
      await this.handleLocalDeletion(op.entityKey);
      return;
    }

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
   * Poll Notion for changes and enqueue pull operations.
   * Guarded by pollInProgress to prevent overlapping polls.
   */
  async pollNotionChanges(): Promise<void> {
    if (this.pollInProgress) return;
    this.pollInProgress = true;

    try {
      // Get all tracked entities that have a Notion page
      const entities = listEntities(this.db);

      // Group entities by their Notion database ID (via project parent)
      // For simplicity, poll at the entity level using last sync timestamp
      for (const entity of entities) {
        if (!entity.notionId || !entity.lastSyncTs) continue;

        const since = new Date(entity.lastSyncTs);

        // Check if this page was edited after our last sync
        try {
          const page: any = await this.notion.call(async () => {
            return this.notion.raw.pages.retrieve({ page_id: entity.notionId });
          });

          const remoteEditTime = new Date(page.last_edited_time);
          if (remoteEditTime <= since) continue;

          // Page was edited — enqueue a pull operation
          this.queue.enqueue({
            side: "notion",
            type: "page_updated",
            entityKey: entity.notionId,
            timestamp: remoteEditTime,
          });
        } catch {
          // Skip pages we can't access (deleted, permission changed, etc.)
        }
      }
    } finally {
      this.pollInProgress = false;
    }
  }

  /**
   * Process a pull operation: fetch Notion content, compare, detect conflicts.
   */
  private async processPullOperation(op: SyncOperation): Promise<void> {
    const entity = getEntityByNotionId(this.db, op.entityKey);
    if (!entity) {
      // Untracked page — skip (don't auto-register, per PRD)
      return;
    }

    // Validate path (safety: prevent path traversal)
    const projectDir = this.findProjectDir(entity.localPath);
    if (!projectDir) {
      appendSyncLog(this.db, {
        entityMapId: entity.id,
        operation: "error",
        direction: "notion_to_local",
        detail: { error: "No project directory found — aborting pull", path: entity.localPath },
      });
      return;
    }
    const resolved = resolve(projectDir, basename(entity.localPath));
    if (!resolved.startsWith(projectDir + "/")) {
      appendSyncLog(this.db, {
        entityMapId: entity.id,
        operation: "error",
        direction: "notion_to_local",
        detail: { error: "Path validation failed", path: entity.localPath },
      });
      return;
    }

    // Fetch content from Notion
    const notionContent = await notionBlocksToMarkdown(this.notion.raw, entity.notionId);
    const notionHash = hashContent(normalizeMarkdown(notionContent));

    // Skip if Notion content hasn't actually changed (hash verification)
    if (entity.lastNotionHash === notionHash) return;

    // Read current local content
    let localContent = "";
    let localHash = "";
    if (existsSync(entity.localPath)) {
      localContent = readFileSync(entity.localPath, "utf-8");
      // Strip frontmatter before hashing for comparison
      const bodyOnly = this.stripFrontmatter(localContent);
      localHash = hashContent(normalizeMarkdown(bodyOnly));
    }

    // Determine sync action:
    // - If local unchanged since last sync → clean pull
    // - If both changed → conflict/merge
    const localUnchanged = entity.lastLocalHash === localHash || !localHash;

    if (localUnchanged) {
      // Clean pull — no local changes, just overwrite body
      await this.executePull(entity, notionContent, notionHash, localContent);
    } else {
      // Both sides changed — handle conflict
      await this.handleConflict(entity, localContent, notionContent);
    }
  }

  /**
   * Execute a pull: write Notion content to local file, preserving frontmatter.
   * Follows WAL protocol: pending → write file → target_written → update entity → committed → delete
   */
  private async executePull(
    entity: { id: number; notionId: string; localPath: string },
    notionContent: string,
    notionHash: string,
    currentLocalContent: string,
  ): Promise<void> {
    // 1. WAL: pending
    const walEntry = walCreatePending(this.db, {
      entityMapId: entity.id,
      operation: "pull",
      newContent: notionContent,
    });

    try {
      // 2. Preserve local frontmatter
      const frontmatter = this.extractFrontmatter(currentLocalContent);
      const mergedContent = frontmatter
        ? frontmatter + "\n" + notionContent
        : notionContent;

      // 3. Write to local file
      writeFileSync(entity.localPath, mergedContent, "utf-8");

      // 4. WAL: target_written
      walMarkTargetWritten(this.db, walEntry.id);

      // 5. Update entity_map and set base content
      const base = upsertBaseContent(this.db, notionContent);
      const localHash = hashContent(normalizeMarkdown(mergedContent));
      updateEntityAfterSync(this.db, entity.id, {
        lastLocalHash: localHash,
        lastNotionHash: notionHash,
        baseContentId: base.id,
        lastSyncTs: new Date().toISOString(),
      });

      // 6. WAL: committed
      walMarkCommitted(this.db, walEntry.id);

      // 7. WAL: cleanup
      walDelete(this.db, walEntry.id);

      // Log success
      appendSyncLog(this.db, {
        entityMapId: entity.id,
        operation: "pull",
        direction: "notion_to_local",
        detail: { hash: notionHash },
      });
    } catch (err) {
      appendSyncLog(this.db, {
        entityMapId: entity.id,
        operation: "error",
        direction: "notion_to_local",
        detail: { error: (err as Error).message },
      });
      throw err;
    }
  }

  /**
   * Handle a conflict when both local and Notion have changed since last sync.
   * Uses configured conflict strategy (three-way-merge, local-wins, notion-wins, conflict-file).
   */
  private async handleConflict(
    entity: any,
    localContent: string,
    notionContent: string,
  ): Promise<void> {
    const strategy = (this.config.sync?.conflict_strategy || "three-way-merge") as ConflictStrategy;

    // Get base content for three-way merge
    const base = entity.baseContentId
      ? getBaseContent(this.db, entity.baseContentId)?.content ?? ""
      : "";

    // Strip frontmatter from local for merge (frontmatter is local-only)
    const localBody = this.stripFrontmatter(localContent);
    const frontmatter = this.extractFrontmatter(localContent);

    if (strategy === "conflict-file") {
      const conflictPath = entity.localPath + ".conflict";
      writeFileSync(conflictPath, formatConflictFile(localBody, notionContent, entity.localPath), "utf-8");
      const localId = upsertBaseContent(this.db, localBody).id;
      const notionId = upsertBaseContent(this.db, notionContent).id;
      markConflict(this.db, entity.id, localId, notionId);
      appendSyncLog(this.db, {
        entityMapId: entity.id,
        operation: "conflict",
        detail: { strategy: "conflict-file", conflictPath },
      });
      return;
    }

    // Three-way merge with configured fallback
    const fallback: ConflictStrategy = strategy === "three-way-merge" ? "local-wins" : strategy;
    const result = threeWayMerge(base, localBody, notionContent, fallback);

    if (result.hasConflicts) {
      // Record conflict even though auto-resolved via fallback
      const localId = upsertBaseContent(this.db, localBody).id;
      const notionId = upsertBaseContent(this.db, notionContent).id;
      markConflict(this.db, entity.id, localId, notionId);
      appendSyncLog(this.db, {
        entityMapId: entity.id,
        operation: "merge",
        detail: {
          strategy: fallback,
          conflictCount: result.conflicts.length,
          autoResolved: true,
        },
      });
    } else {
      clearConflict(this.db, entity.id);
    }

    // Re-attach frontmatter to merged result
    const mergedWithFm = frontmatter
      ? frontmatter + "\n" + result.merged
      : result.merged;

    // WAL-protected local write (crash recovery for conflict resolution)
    const walEntry = walCreatePending(this.db, {
      entityMapId: entity.id,
      operation: "merge",
      newContent: result.merged,
    });

    // Write merged to local
    writeFileSync(entity.localPath, mergedWithFm, "utf-8");
    walMarkTargetWritten(this.db, walEntry.id);

    // Update entity and base content
    const newBase = upsertBaseContent(this.db, result.merged);
    const localHash = hashContent(normalizeMarkdown(mergedWithFm));
    const notionHash = hashContent(normalizeMarkdown(result.merged));
    updateEntityAfterSync(this.db, entity.id, {
      lastLocalHash: localHash,
      lastNotionHash: notionHash,
      baseContentId: newBase.id,
      lastSyncTs: new Date().toISOString(),
    });

    walMarkCommitted(this.db, walEntry.id);

    // Push merged result to Notion (so both sides converge)
    await this.pushUpdate(entity.id, entity.notionId, result.merged, notionHash);

    walDelete(this.db, walEntry.id);
  }

  /**
   * Extract frontmatter block from content (returns empty string if none).
   */
  private extractFrontmatter(content: string): string {
    const match = content.match(/^---\n[\s\S]*?\n---\n/);
    return match ? match[0] : "";
  }

  /**
   * Strip frontmatter from content, returning body only.
   */
  private stripFrontmatter(content: string): string {
    const match = content.match(/^---\n[\s\S]*?\n---\n/);
    return match ? content.slice(match[0].length) : content;
  }

  /**
   * Find the project directory containing a file path.
   * Walks up looking for directories registered as project entities.
   */
  private findProjectDir(filePath: string): string | null {
    const parts = filePath.split("/");
    for (let i = parts.length - 1; i >= 1; i--) {
      const candidate = parts.slice(0, i).join("/");
      const entity = getEntityByPath(this.db, candidate);
      if (entity?.entityType === "project") return candidate;
    }
    return null;
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
  /**
   * Poll beads issues for changes and sync to Notion.
   * Compares current state against stored snapshot to detect changes.
   */
  async pollBeadsChanges(): Promise<void> {
    const projects = listEntities(this.db, "project");

    for (const project of projects) {
      try {
        const current = fetchBeadsIssues(project.localPath);
        if (current.length === 0) continue;

        // Load previous snapshot
        const prevRow = this.db.all(
          sql`SELECT snapshot_json FROM beads_snapshot WHERE project_id = ${String(project.id)}`,
        ) as { snapshot_json: string }[];

        const previous: BeadsIssue[] = prevRow.length > 0
          ? JSON.parse(prevRow[0].snapshot_json)
          : [];

        const diff = diffBeadsState(previous, current);

        // Push new/changed issues to Notion
        for (const issue of [...diff.added, ...diff.modified]) {
          try {
            const props = mapBeadsToNotionProperties(issue);
            // Find existing Notion page for this issue or create new
            const entity = getEntityByPath(this.db, `${project.localPath}/.beads/${issue.id}`);

            if (entity) {
              // Update existing
              await this.notion.call(async () => {
                await this.notion.raw.pages.update({
                  page_id: entity.notionId,
                  properties: props,
                });
              }, { pageId: entity.notionId });
            }
            // New issues: creation handled by beads integration tool, not auto-create here
          } catch (err) {
            appendSyncLog(this.db, {
              operation: "error",
              detail: { error: `Beads push failed: ${(err as Error).message}`, issueId: issue.id },
            });
          }
        }

        // Save current snapshot
        this.db.run(
          sql`INSERT INTO beads_snapshot (project_id, snapshot_json, updated_at)
              VALUES (${String(project.id)}, ${JSON.stringify(current)}, datetime('now'))
              ON CONFLICT(project_id) DO UPDATE SET
                snapshot_json = ${JSON.stringify(current)},
                updated_at = datetime('now')`,
        );
      } catch (err) {
        appendSyncLog(this.db, {
          operation: "error",
          detail: { error: `Beads poll failed: ${(err as Error).message}`, project: project.localPath },
        });
      }
    }
  }

  /**
   * Handle soft-delete when a local file is removed.
   * Marks entity as deleted, updates Notion page status.
   */
  private async handleLocalDeletion(filePath: string): Promise<void> {
    const entity = getEntityByPath(this.db, filePath);
    if (!entity) return;

    softDeleteEntity(this.db, entity.id);

    // Update Notion page status to indicate source was deleted
    try {
      await this.notion.call(async () => {
        await this.notion.raw.pages.update({
          page_id: entity.notionId,
          properties: {
            Status: { select: { name: "⚠️ Source Deleted" } },
          } as any,
        });
      }, { pageId: entity.notionId });
    } catch {
      // Notion update failure is non-fatal for soft-delete
    }

    appendSyncLog(this.db, {
      entityMapId: entity.id,
      operation: "soft-delete",
      direction: "local_to_notion",
      detail: { path: filePath },
    });
  }

  /**
   * Run garbage collection for soft-deleted entities older than retention period.
   * Default retention: 30 days (aligned with Notion trash retention).
   */
  runGC(): number {
    const retentionMs = 30 * 24 * 60 * 60 * 1000; // 30 days
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    return gcDeletedEntities(this.db, cutoff);
  }

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
