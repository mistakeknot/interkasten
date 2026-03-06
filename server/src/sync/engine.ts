import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, basename, dirname, join } from "path";
import type { DB } from "../store/db.js";
import type { NotionClient } from "./notion-client.js";
import type { Config } from "../config/schema.js";
import type { FileChangeEvent } from "./watcher.js";
import type { SyncOperation } from "./queue.js";
import { SyncQueue } from "./queue.js";
import { DurableQueue, type WorkItem } from "./durable-queue.js";
import { localizeNotionAssetLinks } from "./assets.js";
import {
  isGitRepo,
  getHead,
  hasChanges,
  commitAndPush,
  changedFilesBetween,
  pullFastForward,
} from "./git-ops.js";
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
  softDeleteEntity,
  gcDeletedEntities,
} from "../store/entities.js";
import {
  walCreatePending,
  walMarkTargetWritten,
  walMarkCommitted,
  walDelete,
} from "../store/wal.js";
import { appendSyncLog } from "../store/sync-log.js";
import {
  lookupByPath,
  lookupByNotionId,
  registerDoc,
  computeTier,
  getRowsForDatabase,
} from "./entity-map.js";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";
import {
  frontmatterToProperties,
  rowToFrontmatter,
  sanitizeTitle,
} from "./databases.js";
import type { DatabaseSchema } from "./discovery.js";
import { getDatabaseSchema, listTrackedDatabases } from "../store/databases.js";
import {
  fetchBeadsIssues,
  diffBeadsState,
  mapBeadsToNotionProperties,
  mapNotionToBeadsUpdate,
  updateBeadsIssue,
  type BeadsIssue,
} from "./beads-sync.js";
import { sql } from "drizzle-orm";

export interface SyncEngineOptions {
  config: Config;
  db: DB;
  notion: NotionClient;
  durableQueue?: DurableQueue;
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
  private durableQueue: DurableQueue | null;
  private processTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private gitTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private poller: NotionPoller;
  private pollInProgress = false;
  private shadowMode: boolean;
  private gitEnabled: boolean;

  constructor(options: SyncEngineOptions) {
    this.db = options.db;
    this.notion = options.notion;
    this.config = options.config;
    this.shadowMode = options.config.sync.shadow_mode;
    this.gitEnabled =
      (options.config.sync.git?.enabled ?? false) &&
      isGitRepo(options.config.projects_dir);
    this.poller = new NotionPoller(options.notion);
    this.queue = new SyncQueue({
      concurrency: 1,
      maxQueueSize: options.config.sync.max_queue_size,
    });
    this.durableQueue = options.durableQueue ?? null;
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
    }, 10000);

    // Poll Notion for remote changes
    const pollIntervalMs = (this.config.sync?.poll_interval ?? 60) * 1000;
    this.pollTimer = setInterval(() => {
      this.pollNotionChanges().catch((err) => {
        console.error("Poll error:", err);
      });
    }, pollIntervalMs);

    // Git scanning for committed changes
    if (this.gitEnabled) {
      const gitPollMs = this.config.sync.git?.poll_ms ?? 30000;
      this.gitTimer = setInterval(() => {
        this.scanGitForChanges().catch((err) => {
          console.error("Git scan error:", err);
        });
      }, gitPollMs);

      // Initialize git cursor
      this.initGitCursor();
    }

    // Reconciliation timer: periodic full-sync safety net
    if (this.durableQueue) {
      const reconcileMs =
        (this.config.sync.reconcile_interval_s ?? 21600) * 1000;
      this.reconcileTimer = setInterval(() => {
        this.enqueueReconcile();
      }, reconcileMs);
    }
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
    if (this.gitTimer) {
      clearInterval(this.gitTimer);
      this.gitTimer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
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
      type:
        event.type === "add"
          ? "file_added"
          : event.type === "change"
            ? "file_modified"
            : "file_removed",
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
   *
   * When a DurableQueue is configured:
   * 1. Drain in-memory SyncQueue → enqueue into DurableQueue (deduped)
   * 2. Claim batch from DurableQueue → process → markDone / markRetryOrDead
   *
   * Without a DurableQueue, falls back to the original in-memory drain-and-process.
   */
  async processQueue(): Promise<void> {
    if (this.durableQueue) {
      await this.processQueueDurable();
    } else {
      await this.processQueueLegacy();
    }
  }

  /**
   * Legacy queue processing: drain in-memory queue and process directly.
   */
  private async processQueueLegacy(): Promise<void> {
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
          direction:
            op.side === "notion" ? "notion_to_local" : "local_to_notion",
          detail: {
            entityKey: op.entityKey,
            error: (err as Error).message,
          },
        });
      }
    }
  }

  /**
   * Durable queue processing: drain in-memory ops into DurableQueue,
   * then claim and process a batch with retry/dead-letter handling.
   */
  private async processQueueDurable(): Promise<void> {
    const dq = this.durableQueue!;

    // 1. Flush in-memory queue into durable queue
    const ops = this.queue.drain();
    for (const op of ops) {
      const isLocal = op.side === "local";
      const entity = isLocal
        ? getEntityByPath(this.db, op.entityKey)
        : getEntityByNotionId(this.db, op.entityKey);

      dq.enqueue({
        kind: isLocal ? "local_entity_push" : "remote_entity_pull",
        dedupeKey: `${op.side}:${op.entityKey}`,
        payload: {
          entityKey: op.entityKey,
          type: op.type,
          side: op.side,
          notionId: isLocal ? entity?.notionId : op.entityKey,
          localPath: isLocal ? op.entityKey : entity?.localPath,
        },
      });
    }

    // 2. Claim and process a batch from durable queue
    const batchSize = this.config.sync.batch_size;
    const items = dq.claimReady(batchSize);

    for (const item of items) {
      try {
        await this.processWorkItem(item);
        dq.markDone(item.id);
      } catch (err) {
        console.error(`Durable queue error for ${item.dedupeKey}:`, err);
        dq.markRetryOrDead(item, err);
        appendSyncLog(this.db, {
          operation: "error",
          detail: {
            dedupeKey: item.dedupeKey,
            kind: item.kind,
            attempt: item.attempts + 1,
            error: (err as Error).message,
          },
        });
      }
    }

    // Auto-commit after processing batch if configured
    await this.autoCommitIfNeeded();
  }

  /**
   * Process a single work item from the durable queue.
   * Dispatches to push/pull operations based on item kind.
   */
  private async processWorkItem(item: WorkItem): Promise<void> {
    const payload = item.payload;

    if (this.shadowMode) {
      console.log(`[shadow] Would process ${item.kind}: ${item.dedupeKey}`);
      return;
    }

    switch (item.kind) {
      case "local_entity_push": {
        const op: SyncOperation = {
          side: "local",
          type: (payload.type as SyncOperation["type"]) ?? "file_modified",
          entityKey:
            (payload.entityKey as string) ??
            (payload.localPath as string) ??
            "",
          timestamp: new Date(),
        };
        await this.processPushOperation(op);
        break;
      }

      case "remote_entity_pull": {
        const op: SyncOperation = {
          side: "notion",
          type: (payload.type as SyncOperation["type"]) ?? "page_updated",
          entityKey:
            (payload.notionId as string) ?? (payload.entityKey as string) ?? "",
          timestamp: new Date(),
        };
        await this.processPullOperation(op);
        break;
      }

      case "reconcile_full":
        await this.pollNotionChanges();
        break;

      case "beads_sync":
        await this.pollBeadsChanges();
        break;
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

      // Database rows get special push handling (frontmatter → properties)
      if (entity.entityType === "db_row") {
        await this.pushDbRowUpdate(entity, content, currentHash);
        return;
      }

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
    localHash: string,
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
              children: chunk as Parameters<
                typeof this.notion.raw.blocks.children.append
              >[0]["children"],
            });
          }
        },
        { pageId: notionPageId },
      );

      // 3. WAL: target_written
      walMarkTargetWritten(this.db, walEntry.id);

      // 4. Pull back the content for roundtrip base
      let notionHash = localHash;
      let baseContentId: number | undefined;
      try {
        const pulledBack = await notionBlocksToMarkdown(
          this.notion.raw,
          notionPageId,
        );
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

      // Poll non-db_row entities individually
      for (const entity of entities) {
        if (!entity.notionId || !entity.lastSyncTs) continue;
        // Skip db_row entities — they are polled in batch via their database
        if (entity.entityType === "db_row") continue;

        const since = new Date(entity.lastSyncTs);

        try {
          const page: any = await this.notion.call(async () => {
            return this.notion.raw.pages.retrieve({ page_id: entity.notionId });
          });

          const remoteEditTime = new Date(page.last_edited_time);
          if (remoteEditTime <= since) continue;

          this.enqueueRemotePull(
            entity.notionId,
            "page_updated",
            remoteEditTime,
          );
        } catch {
          // Skip pages we can't access
        }
      }

      // Batch poll tracked databases for row changes
      const trackedDbs = listTrackedDatabases(this.db);
      for (const dbSchema of trackedDbs) {
        try {
          const dbEntity = lookupByNotionId(this.db, dbSchema.notionDatabaseId);
          if (!dbEntity) continue;

          const trackedRows = getRowsForDatabase(this.db, dbEntity.id);
          const oldestSync = trackedRows.reduce((oldest, r) => {
            const ts = r.lastSyncTs ? new Date(r.lastSyncTs) : new Date(0);
            return ts < oldest ? ts : oldest;
          }, new Date());

          // Poll via the poller's fast-path (last_edited_time filter)
          const changes = await this.poller.pollDatabase(
            dbSchema.notionDatabaseId,
            oldestSync,
          );

          for (const change of changes) {
            this.enqueueRemotePull(
              change.pageId,
              "page_updated",
              new Date(change.lastEdited),
            );
          }
        } catch {
          // Skip inaccessible databases
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

    // Database rows get special pull handling
    if (entity.entityType === "db_row") {
      const dbId = this.findDatabaseIdForRow(entity);
      if (dbId) {
        const schemaRow = getDatabaseSchema(this.db, dbId);
        if (schemaRow) {
          const schema: DatabaseSchema = {
            id: schemaRow.notionDatabaseId,
            title: schemaRow.title,
            properties: JSON.parse(schemaRow.schemaJson),
          };
          await this.pullDbRow(entity, schema);
        }
      }
      return;
    }

    // Validate path (safety: prevent path traversal)
    const projectDir = this.findProjectDir(entity.localPath);
    if (!projectDir) {
      appendSyncLog(this.db, {
        entityMapId: entity.id,
        operation: "error",
        direction: "notion_to_local",
        detail: {
          error: "No project directory found — aborting pull",
          path: entity.localPath,
        },
      });
      return;
    }

    // For project entities, the localPath IS the project dir — skip child-path validation.
    // For doc entities, verify the resolved path stays within the project boundary.
    if (entity.entityType !== "project") {
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
    }

    // Fetch content from Notion
    const notionContent = await notionBlocksToMarkdown(
      this.notion.raw,
      entity.notionId,
    );
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
      // 2. Localize Notion asset URLs (download images/attachments before they expire)
      let localizedContent = notionContent;
      if (this.config.sync.localize_assets) {
        try {
          const assetResult = await localizeNotionAssetLinks(
            notionContent,
            entity.localPath,
          );
          localizedContent = assetResult.markdown;
          if (assetResult.downloaded > 0) {
            console.log(
              `Assets: downloaded ${assetResult.downloaded}, localized ${assetResult.localized} links for ${basename(entity.localPath)}`,
            );
          }
        } catch (err) {
          console.error(
            `Asset localization failed for ${basename(entity.localPath)}:`,
            (err as Error).message,
          );
          // Continue with original content — asset localization failure is non-fatal
        }
      }

      // 3. Preserve local frontmatter
      const frontmatter = this.extractFrontmatter(currentLocalContent);
      const mergedContent = frontmatter
        ? frontmatter + "\n" + localizedContent
        : localizedContent;

      // 4. Write to local file
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
    const strategy = (this.config.sync?.conflict_strategy ||
      "three-way-merge") as ConflictStrategy;

    // Get base content for three-way merge
    const base = entity.baseContentId
      ? (getBaseContent(this.db, entity.baseContentId)?.content ?? "")
      : "";

    // Strip frontmatter from local for merge (frontmatter is local-only)
    const localBody = this.stripFrontmatter(localContent);
    const frontmatter = this.extractFrontmatter(localContent);

    if (strategy === "conflict-file") {
      const conflictPath = entity.localPath + ".conflict";
      writeFileSync(
        conflictPath,
        formatConflictFile(localBody, notionContent, entity.localPath),
        "utf-8",
      );
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

    if (strategy === "artifact") {
      const artifactPath = this.writeConflictArtifact(
        entity,
        base,
        localBody,
        notionContent,
      );
      const localId = upsertBaseContent(this.db, localBody).id;
      const notionId = upsertBaseContent(this.db, notionContent).id;
      markConflict(this.db, entity.id, localId, notionId);
      appendSyncLog(this.db, {
        entityMapId: entity.id,
        operation: "conflict",
        detail: { strategy: "artifact", artifactPath },
      });
      return;
    }

    // Three-way merge with configured fallback
    const fallback: ConflictStrategy =
      strategy === "three-way-merge" ? "local-wins" : strategy;
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
    await this.pushUpdate(
      entity.id,
      entity.notionId,
      result.merged,
      notionHash,
    );

    walDelete(this.db, walEntry.id);
  }

  /**
   * Write a structured conflict artifact file with base/local/remote sections.
   * Stored in .notion-conflicts/ alongside the conflicting file.
   * Returns the path of the artifact file.
   */
  private writeConflictArtifact(
    entity: { localPath: string; notionId: string },
    base: string,
    localContent: string,
    notionContent: string,
  ): string {
    const dir = join(dirname(entity.localPath), ".notion-conflicts");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const title = basename(entity.localPath, ".md");
    const shortId = entity.notionId.slice(0, 8);
    const filename = `${timestamp}-${title}-${shortId}.md`;
    const artifactPath = join(dir, filename);

    const content = [
      `# Conflict: ${title}`,
      "",
      `- **File:** \`${entity.localPath}\``,
      `- **Notion ID:** \`${entity.notionId}\``,
      `- **Detected:** ${new Date().toISOString()}`,
      "",
      "## Base (last synced)",
      "",
      "```markdown",
      base || "(no base content — first sync)",
      "```",
      "",
      "## Local (current file)",
      "",
      "```markdown",
      localContent,
      "```",
      "",
      "## Remote (current Notion)",
      "",
      "```markdown",
      notionContent,
      "```",
      "",
    ].join("\n");

    writeFileSync(artifactPath, content, "utf-8");
    return artifactPath;
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
    // Check the path itself first (handles project entities whose path IS the project dir)
    const selfEntity = getEntityByPath(this.db, filePath);
    if (selfEntity?.entityType === "project") return filePath;

    // Walk up ancestors
    const parts = filePath.split("/");
    for (let i = parts.length - 1; i >= 1; i--) {
      const candidate = parts.slice(0, i).join("/");
      const entity = getEntityByPath(this.db, candidate);
      if (entity?.entityType === "project") return candidate;
    }
    return null;
  }

  /**
   * Find the Notion database ID for a db_row entity (via its parent entity or frontmatter).
   */
  private findDatabaseIdForRow(entity: {
    localPath: string;
    parentId?: number | null;
  }): string | null {
    // Try reading notion_database_id from frontmatter
    if (existsSync(entity.localPath)) {
      try {
        const content = readFileSync(entity.localPath, "utf-8");
        const { data } = parseFrontmatter(content);
        if (data.notion_database_id) return data.notion_database_id as string;
      } catch {
        // Fall through to parent lookup
      }
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

        const previous: BeadsIssue[] =
          prevRow.length > 0 ? JSON.parse(prevRow[0].snapshot_json) : [];

        const diff = diffBeadsState(previous, current);

        // Push new/changed issues to Notion
        for (const issue of [...diff.added, ...diff.modified]) {
          try {
            const props = mapBeadsToNotionProperties(issue);
            // Find existing Notion page for this issue or create new
            const entity = getEntityByPath(
              this.db,
              `${project.localPath}/.beads/${issue.id}`,
            );

            if (entity) {
              // Update existing
              await this.notion.call(
                async () => {
                  await this.notion.raw.pages.update({
                    page_id: entity.notionId,
                    properties: props,
                  });
                },
                { pageId: entity.notionId },
              );
            }
            // New issues: creation handled by beads integration tool, not auto-create here
          } catch (err) {
            appendSyncLog(this.db, {
              operation: "error",
              detail: {
                error: `Beads push failed: ${(err as Error).message}`,
                issueId: issue.id,
              },
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
          detail: {
            error: `Beads poll failed: ${(err as Error).message}`,
            project: project.localPath,
          },
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
      await this.notion.call(
        async () => {
          await this.notion.raw.pages.update({
            page_id: entity.notionId,
            properties: {
              Status: { select: { name: "⚠️ Source Deleted" } },
            } as any,
          });
        },
        { pageId: entity.notionId },
      );
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

  /**
   * Push a database row update: parse frontmatter → update Notion properties + body.
   */
  private async pushDbRowUpdate(
    entity: {
      id: number;
      notionId: string;
      localPath: string;
      entityType: string;
    },
    content: string,
    localHash: string,
  ): Promise<void> {
    const { data, body } = parseFrontmatter(content);
    const dbId = data.notion_database_id as string;
    if (!dbId) {
      appendSyncLog(this.db, {
        entityMapId: entity.id,
        operation: "error",
        direction: "local_to_notion",
        detail: { error: "Missing notion_database_id in frontmatter" },
      });
      return;
    }

    // Load schema
    const schemaRow = getDatabaseSchema(this.db, dbId);
    if (!schemaRow) {
      appendSyncLog(this.db, {
        entityMapId: entity.id,
        operation: "error",
        direction: "local_to_notion",
        detail: { error: `No schema found for database ${dbId}` },
      });
      return;
    }
    const schema: DatabaseSchema = {
      id: schemaRow.notionDatabaseId,
      title: schemaRow.title,
      properties: JSON.parse(schemaRow.schemaJson),
    };

    // 1. WAL: pending
    const walEntry = walCreatePending(this.db, {
      entityMapId: entity.id,
      operation: "push",
      newContent: content,
    });

    try {
      // 2. Convert frontmatter to Notion properties
      const properties = frontmatterToProperties(data, schema);

      // 3. Update properties
      await this.notion.call(
        async () => {
          await this.notion.raw.pages.update({
            page_id: entity.notionId,
            properties: properties as any,
          });
        },
        { pageId: entity.notionId },
      );

      // 4. Update body blocks (if body content exists)
      if (body.trim()) {
        const blocks = markdownToNotionBlocks(body);
        await this.notion.call(
          async () => {
            const existingBlocks = await this.notion.raw.blocks.children.list({
              block_id: entity.notionId,
              page_size: 100,
            });
            for (const block of existingBlocks.results) {
              if ("id" in block) {
                await this.notion.raw.blocks.delete({ block_id: block.id });
              }
            }
            for (let i = 0; i < blocks.length; i += 100) {
              const chunk = blocks.slice(i, i + 100);
              await this.notion.raw.blocks.children.append({
                block_id: entity.notionId,
                children: chunk as any,
              });
            }
          },
          { pageId: entity.notionId },
        );
      }

      // 5. WAL: target_written
      walMarkTargetWritten(this.db, walEntry.id);

      // 6. Update entity_map
      const base = upsertBaseContent(this.db, content);
      updateEntityAfterSync(this.db, entity.id, {
        lastLocalHash: localHash,
        lastNotionHash: localHash,
        baseContentId: base.id,
        lastSyncTs: new Date().toISOString(),
      });

      // 7. WAL: committed + cleanup
      walMarkCommitted(this.db, walEntry.id);
      walDelete(this.db, walEntry.id);

      appendSyncLog(this.db, {
        entityMapId: entity.id,
        operation: "push",
        direction: "local_to_notion",
        detail: { hash: localHash, type: "db_row" },
      });
    } catch (err) {
      appendSyncLog(this.db, {
        entityMapId: entity.id,
        operation: "error",
        direction: "local_to_notion",
        detail: { error: (err as Error).message, type: "db_row" },
      });
      throw err;
    }
  }

  /**
   * Pull a database row from Notion: fetch properties + blocks → write file with frontmatter.
   */
  async pullDbRow(
    entity: { id: number; notionId: string; localPath: string },
    schema: DatabaseSchema,
  ): Promise<void> {
    // Fetch the page (row)
    const page: any = await this.notion.call(async () => {
      return this.notion.raw.pages.retrieve({ page_id: entity.notionId });
    });

    // Build frontmatter from properties
    const fm = rowToFrontmatter(page, schema);

    // Fetch body blocks
    let body = "";
    try {
      body = await notionBlocksToMarkdown(this.notion.raw, entity.notionId);
    } catch {
      // Some rows have no body — that's fine
    }

    // Localize asset URLs in body
    if (body && this.config.sync.localize_assets) {
      try {
        const assetResult = await localizeNotionAssetLinks(
          body,
          entity.localPath,
        );
        body = assetResult.markdown;
      } catch {
        // Non-fatal — continue with original URLs
      }
    }

    const content = stringifyFrontmatter(fm as Record<string, unknown>, body);
    const contentHash = hashContent(normalizeMarkdown(content));

    // WAL-protected write
    const walEntry = walCreatePending(this.db, {
      entityMapId: entity.id,
      operation: "pull",
      newContent: content,
    });

    try {
      writeFileSync(entity.localPath, content, "utf-8");
      walMarkTargetWritten(this.db, walEntry.id);

      const base = upsertBaseContent(this.db, content);
      updateEntityAfterSync(this.db, entity.id, {
        lastLocalHash: contentHash,
        lastNotionHash: contentHash,
        lastNotionVer: page.last_edited_time,
        baseContentId: base.id,
        lastSyncTs: new Date().toISOString(),
      });

      walMarkCommitted(this.db, walEntry.id);
      walDelete(this.db, walEntry.id);

      appendSyncLog(this.db, {
        entityMapId: entity.id,
        operation: "pull",
        direction: "notion_to_local",
        detail: { hash: contentHash, type: "db_row" },
      });
    } catch (err) {
      appendSyncLog(this.db, {
        entityMapId: entity.id,
        operation: "error",
        direction: "notion_to_local",
        detail: { error: (err as Error).message, type: "db_row" },
      });
      throw err;
    }
  }

  /**
   * Enqueue a remote pull operation, routing to DurableQueue when available.
   */
  private enqueueRemotePull(
    notionId: string,
    type: SyncOperation["type"],
    timestamp: Date,
  ): void {
    if (this.durableQueue) {
      this.durableQueue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: `notion:${notionId}`,
        payload: { notionId, type, side: "notion" },
      });
    } else {
      this.queue.enqueue({
        side: "notion",
        type,
        entityKey: notionId,
        timestamp,
      });
    }
  }

  // ---------- Git integration ----------

  /**
   * Initialize the git cursor to the current HEAD.
   * Called once at startup when git is enabled.
   */
  private initGitCursor(): void {
    if (!this.durableQueue) return;

    const existing = this.durableQueue.getState("last_processed_git_commit");
    if (existing) return;

    try {
      const head = getHead(this.config.projects_dir);
      this.durableQueue.setState("last_processed_git_commit", head);
    } catch {
      // Not a git repo or no commits yet
    }
  }

  /**
   * Scan git for committed changes since the last processed commit.
   * Enqueues local_entity_push work items for changed markdown files
   * that have a notion_id in their frontmatter.
   */
  private async scanGitForChanges(): Promise<void> {
    if (!this.gitEnabled || !this.durableQueue) return;

    const gitConfig = this.config.sync.git;
    const remote = gitConfig?.remote ?? "origin";
    const branch = gitConfig?.branch ?? "main";
    const workdir = this.config.projects_dir;

    // Fast-forward pull to get latest remote changes
    try {
      pullFastForward(workdir, remote, branch);
    } catch (err) {
      console.error("git pull --ff-only failed:", err);
      return;
    }

    const head = getHead(workdir);
    const previousHead = this.durableQueue.getState(
      "last_processed_git_commit",
    );

    if (!previousHead) {
      this.durableQueue.setState("last_processed_git_commit", head);
      return;
    }

    if (head === previousHead) return;

    const changedFiles = changedFilesBetween(
      workdir,
      previousHead,
      head,
    ).filter((file) => file.endsWith(".md"));

    for (const relPath of changedFiles) {
      const absPath = join(workdir, relPath);
      try {
        const content = readFileSync(absPath, "utf-8");
        const parsed = parseFrontmatter(content);
        if (!parsed?.data?.notion_id) continue;

        this.durableQueue.enqueue({
          kind: "local_entity_push",
          dedupeKey: `local:${parsed.data.notion_id}`,
          payload: {
            notionId: parsed.data.notion_id,
            source: "git_commit",
            localPath: relPath,
          },
        });
      } catch {
        // File might not exist (deleted in commit), skip
      }
    }

    this.durableQueue.setState("last_processed_git_commit", head);
  }

  /**
   * Auto-commit and push changes after webhook-triggered pulls.
   * Only runs when git.auto_commit is enabled.
   */
  async autoCommitIfNeeded(): Promise<void> {
    if (this.shadowMode) return;
    if (!this.gitEnabled || !this.durableQueue) return;

    const gitConfig = this.config.sync.git;
    if (!gitConfig?.auto_commit) return;

    const workdir = this.config.projects_dir;
    if (!hasChanges(workdir)) return;

    const message = `chore(interkasten): sync ${new Date().toISOString()}`;

    try {
      commitAndPush({
        workdir,
        remote: gitConfig.remote ?? "origin",
        branch: gitConfig.branch ?? "main",
        message,
        authorName: gitConfig.author_name ?? "interkasten-bot",
        authorEmail: gitConfig.author_email ?? "interkasten-bot@local",
      });

      const head = getHead(workdir);
      this.durableQueue.setState("last_processed_git_commit", head);
    } catch (err) {
      console.error("Auto commit/push failed:", err);
    }
  }

  // ---------- Reconciliation ----------

  /**
   * Enqueue a full reconciliation sync.
   * Used by the periodic timer and webhook server when scope is unknown.
   */
  enqueueReconcile(source = "interval"): void {
    if (!this.durableQueue) return;
    this.durableQueue.enqueue({
      kind: "reconcile_full",
      dedupeKey: "reconcile:full",
      payload: { source },
    });
  }

  /**
   * Get the durable queue instance (for external consumers like webhook server or MCP tools).
   */
  getDurableQueue(): DurableQueue | null {
    return this.durableQueue;
  }

  getStatus(): {
    pending: number;
    active: number;
    dropped: number;
    watcherActive: boolean;
    shadowMode: boolean;
    gitEnabled: boolean;
    durableQueue: {
      queued: number;
      processing: number;
      done: number;
      dead: number;
      deadLetters: number;
    } | null;
  } {
    const dqStats = this.durableQueue?.getStats() ?? null;
    return {
      pending: this.queue.size,
      active: this.queue.activeCount,
      dropped: this.queue.dropped,
      watcherActive: this.watcher !== null,
      shadowMode: this.shadowMode,
      gitEnabled: this.gitEnabled,
      durableQueue: dqStats
        ? {
            queued: dqStats.queued,
            processing: dqStats.processing,
            done: dqStats.done,
            dead: dqStats.dead,
            deadLetters: dqStats.deadLetters,
          }
        : null,
    };
  }
}
