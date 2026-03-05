import Database from "better-sqlite3";
import { dirname } from "path";
import { existsSync, mkdirSync } from "fs";

export type WorkItemKind =
  | "remote_entity_pull"
  | "local_entity_push"
  | "reconcile_full"
  | "beads_sync";

export type WorkItemStatus = "queued" | "processing" | "done" | "dead";

export interface EnqueueWorkItem {
  kind: WorkItemKind;
  dedupeKey: string;
  payload: Record<string, unknown>;
  availableAtMs?: number;
}

export interface WorkItem {
  id: number;
  kind: WorkItemKind;
  dedupeKey: string;
  payload: Record<string, unknown>;
  status: WorkItemStatus;
  attempts: number;
  availableAtMs: number;
  lockedAtMs: number | null;
  lastError: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface WebhookReceipt {
  eventId: string;
  eventType: string;
  entityId: string | null;
  signatureOk: boolean;
  payload: Record<string, unknown>;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS work_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at_ms INTEGER NOT NULL,
    locked_at_ms INTEGER,
    last_error TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_work_items_ready
  ON work_items(status, available_at_ms);

  CREATE TABLE IF NOT EXISTS webhook_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    entity_id TEXT,
    received_at_ms INTEGER NOT NULL,
    signature_ok INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS service_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS dead_letters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_item_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    error_message TEXT,
    failed_at_ms INTEGER NOT NULL
  );
`;

/**
 * SQLite-backed durable work queue with deduplication, retry backoff,
 * dead-letter archive, and stale-processing recovery.
 *
 * Ported from wm/notion-sync — adapted for better-sqlite3 (synchronous API).
 * Manages its own connection to a separate queue.db file.
 */
export class DurableQueue {
  private db: Database.Database;
  private static readonly STALE_PROCESSING_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

  // Prepared statements (cached for performance)
  private stmtSelectByDedupeKey: Database.Statement;
  private stmtInsert: Database.Statement;
  private stmtUpdateQueued: Database.Statement;
  private stmtUpdateProcessing: Database.Statement;
  private stmtDelete: Database.Statement;
  private stmtRecoverStale: Database.Statement;
  private stmtSelectReady: Database.Statement;
  private stmtClaim: Database.Statement;
  private stmtMarkDone: Database.Statement;
  private stmtInsertDeadLetter: Database.Statement;
  private stmtMarkDead: Database.Statement;
  private stmtRetry: Database.Statement;
  private stmtInsertReceipt: Database.Statement;
  private stmtGetState: Database.Statement;
  private stmtSetState: Database.Statement;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA_SQL);

    // Prepare all statements once
    this.stmtSelectByDedupeKey = this.db.prepare(
      "SELECT id, status FROM work_items WHERE dedupe_key = ?",
    );

    this.stmtInsert = this.db.prepare(`
      INSERT INTO work_items (
        kind, dedupe_key, payload_json, status, attempts,
        available_at_ms, locked_at_ms, last_error, created_at_ms, updated_at_ms
      )
      VALUES (?, ?, ?, 'queued', 0, ?, NULL, NULL, ?, ?)
    `);

    this.stmtUpdateQueued = this.db.prepare(`
      UPDATE work_items
      SET kind = ?, payload_json = ?,
          available_at_ms = MIN(available_at_ms, ?),
          updated_at_ms = ?
      WHERE id = ?
    `);

    this.stmtUpdateProcessing = this.db.prepare(`
      UPDATE work_items
      SET kind = ?, payload_json = ?, status = 'queued',
          available_at_ms = MIN(available_at_ms, ?),
          locked_at_ms = NULL,
          updated_at_ms = ?
      WHERE id = ?
    `);

    this.stmtDelete = this.db.prepare("DELETE FROM work_items WHERE id = ?");

    this.stmtRecoverStale = this.db.prepare(`
      UPDATE work_items
      SET status = 'queued',
          locked_at_ms = NULL,
          available_at_ms = ?,
          attempts = attempts + 1,
          last_error = COALESCE(last_error, 'stale_processing_requeued'),
          updated_at_ms = ?
      WHERE status = 'processing'
        AND locked_at_ms IS NOT NULL
        AND locked_at_ms < ?
    `);

    this.stmtSelectReady = this.db.prepare(`
      SELECT * FROM work_items
      WHERE status = 'queued' AND available_at_ms <= ?
      ORDER BY available_at_ms ASC
      LIMIT ?
    `);

    this.stmtClaim = this.db.prepare(`
      UPDATE work_items
      SET status = 'processing', locked_at_ms = ?, updated_at_ms = ?
      WHERE id = ? AND status = 'queued'
    `);

    this.stmtMarkDone = this.db.prepare(`
      UPDATE work_items
      SET status = 'done', updated_at_ms = ?, locked_at_ms = NULL
      WHERE id = ? AND status = 'processing'
    `);

    this.stmtInsertDeadLetter = this.db.prepare(`
      INSERT INTO dead_letters (
        work_item_id, kind, dedupe_key, payload_json, error_message, failed_at_ms
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.stmtMarkDead = this.db.prepare(`
      UPDATE work_items
      SET status = 'dead', attempts = ?, last_error = ?, updated_at_ms = ?, locked_at_ms = NULL
      WHERE id = ?
    `);

    this.stmtRetry = this.db.prepare(`
      UPDATE work_items
      SET status = 'queued', attempts = ?,
          available_at_ms = ?, last_error = ?,
          updated_at_ms = ?, locked_at_ms = NULL
      WHERE id = ?
    `);

    this.stmtInsertReceipt = this.db.prepare(`
      INSERT INTO webhook_receipts (
        event_id, event_type, entity_id, received_at_ms, signature_ok, payload_json
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `);

    this.stmtGetState = this.db.prepare(
      "SELECT value FROM service_state WHERE key = ?",
    );

    this.stmtSetState = this.db.prepare(`
      INSERT INTO service_state (key, value, updated_at_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at_ms = excluded.updated_at_ms
    `);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Enqueue a work item with deduplication.
   *
   * Dedup logic by existing status:
   * - Not found → INSERT as queued
   * - queued → UPDATE payload/kind, take MIN(available_at_ms) (earliest wins)
   * - processing → bounce back to queued (forces follow-up run after current finishes)
   * - done/dead → DELETE + re-INSERT fresh
   */
  enqueue(item: EnqueueWorkItem): void {
    const now = Date.now();
    const availableAtMs = item.availableAtMs ?? now;
    const payloadJson = JSON.stringify(item.payload ?? {});

    const existing = this.stmtSelectByDedupeKey.get(item.dedupeKey) as
      | { id: number; status: WorkItemStatus }
      | undefined;

    if (!existing) {
      this.stmtInsert.run(
        item.kind,
        item.dedupeKey,
        payloadJson,
        availableAtMs,
        now,
        now,
      );
      return;
    }

    if (existing.status === "queued") {
      this.stmtUpdateQueued.run(
        item.kind,
        payloadJson,
        availableAtMs,
        now,
        existing.id,
      );
      return;
    }

    if (existing.status === "processing") {
      // Re-queue so markDone() becomes a no-op and the item gets reprocessed
      this.stmtUpdateProcessing.run(
        item.kind,
        payloadJson,
        availableAtMs,
        now,
        existing.id,
      );
      return;
    }

    // done or dead — delete and re-insert fresh
    this.stmtDelete.run(existing.id);
    this.stmtInsert.run(
      item.kind,
      item.dedupeKey,
      payloadJson,
      availableAtMs,
      now,
      now,
    );
  }

  /**
   * Atomically claim up to `limit` ready work items.
   *
   * First recovers any stale-processing items (locked > 15min ago),
   * then claims queued items whose available_at_ms has passed.
   * Uses optimistic locking to handle concurrent claims safely.
   */
  claimReady(limit: number): WorkItem[] {
    const now = Date.now();

    // Recover stale-processing items (crash recovery)
    this.stmtRecoverStale.run(
      now,
      now,
      now - DurableQueue.STALE_PROCESSING_TIMEOUT_MS,
    );

    const rows = this.stmtSelectReady.all(now, limit) as Array<
      Record<string, unknown>
    >;

    const claimed: WorkItem[] = [];
    for (const row of rows) {
      const result = this.stmtClaim.run(now, now, row.id as number);
      if (result.changes === 0) continue; // concurrently claimed by another connection
      const item = rowToWorkItem(row);
      item.status = "processing";
      item.lockedAtMs = now;
      claimed.push(item);
    }

    return claimed;
  }

  /**
   * Mark a work item as done. Only transitions processing → done.
   * If the item was bounced back to queued (by a concurrent enqueue),
   * this becomes a no-op and the item will be reprocessed.
   */
  markDone(id: number): void {
    this.stmtMarkDone.run(Date.now(), id);
  }

  /**
   * On failure: retry with exponential backoff, or move to dead-letter queue.
   * Backoff: min(60s, 2s * 2^attempt). Max retries default: 5.
   */
  markRetryOrDead(item: WorkItem, err: unknown, maxRetries = 5): void {
    const now = Date.now();
    const message = normalizeError(err);
    const nextAttempt = item.attempts + 1;

    if (nextAttempt > maxRetries) {
      this.stmtInsertDeadLetter.run(
        item.id,
        item.kind,
        item.dedupeKey,
        JSON.stringify(item.payload ?? {}),
        message,
        now,
      );

      this.stmtMarkDead.run(nextAttempt, message, now, item.id);
      return;
    }

    const backoffMs = Math.min(60_000, 2_000 * Math.pow(2, nextAttempt - 1));
    this.stmtRetry.run(nextAttempt, now + backoffMs, message, now, item.id);
  }

  /**
   * Record a webhook event receipt for idempotency.
   * Uses INSERT ... ON CONFLICT DO NOTHING — duplicate event_ids are silently ignored.
   */
  recordWebhookReceipt(receipt: WebhookReceipt): void {
    this.stmtInsertReceipt.run(
      receipt.eventId,
      receipt.eventType,
      receipt.entityId,
      Date.now(),
      receipt.signatureOk ? 1 : 0,
      JSON.stringify(receipt.payload ?? {}),
    );
  }

  /**
   * Get a service state value by key. Returns null if not set.
   */
  getState(key: string): string | null {
    const row = this.stmtGetState.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * Set a service state value (upsert).
   */
  setState(key: string, value: string): void {
    this.stmtSetState.run(key, value, Date.now());
  }

  /**
   * Get queue statistics for diagnostics.
   */
  getStats(): {
    queued: number;
    processing: number;
    done: number;
    dead: number;
    deadLetters: number;
    webhookReceipts: number;
  } {
    const counts = this.db
      .prepare(
        `SELECT status, COUNT(*) as count FROM work_items GROUP BY status`,
      )
      .all() as Array<{ status: string; count: number }>;

    const countMap = Object.fromEntries(counts.map((r) => [r.status, r.count]));

    const deadLetters = this.db
      .prepare("SELECT COUNT(*) as count FROM dead_letters")
      .get() as { count: number };

    const receipts = this.db
      .prepare("SELECT COUNT(*) as count FROM webhook_receipts")
      .get() as { count: number };

    return {
      queued: countMap["queued"] ?? 0,
      processing: countMap["processing"] ?? 0,
      done: countMap["done"] ?? 0,
      dead: countMap["dead"] ?? 0,
      deadLetters: deadLetters.count,
      webhookReceipts: receipts.count,
    };
  }

  /**
   * Purge completed (done) work items older than the given age in milliseconds.
   * Useful for periodic cleanup to keep queue.db small.
   */
  purgeDone(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const result = this.db
      .prepare(
        "DELETE FROM work_items WHERE status = 'done' AND updated_at_ms < ?",
      )
      .run(cutoff);
    return result.changes;
  }
}

function rowToWorkItem(row: Record<string, unknown>): WorkItem {
  return {
    id: row.id as number,
    kind: row.kind as WorkItemKind,
    dedupeKey: row.dedupe_key as string,
    payload: JSON.parse((row.payload_json as string) ?? "{}") as Record<
      string,
      unknown
    >,
    status: row.status as WorkItemStatus,
    attempts: row.attempts as number,
    availableAtMs: row.available_at_ms as number,
    lockedAtMs: (row.locked_at_ms as number | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    createdAtMs: row.created_at_ms as number,
    updatedAtMs: row.updated_at_ms as number,
  };
}

function normalizeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === "string") return err;
  return JSON.stringify(err);
}
