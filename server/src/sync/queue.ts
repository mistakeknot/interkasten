import PQueue from "p-queue";

export type OperationSide = "local" | "notion";
export type OperationType =
  | "file_added"
  | "file_modified"
  | "file_removed"
  | "page_updated"
  | "page_created"
  | "page_deleted";

export interface SyncOperation {
  side: OperationSide;
  type: OperationType;
  entityKey: string; // local_path or notion_id
  hash?: string;
  timestamp: Date;
}

export interface QueueOptions {
  concurrency?: number;
  maxQueueSize?: number;
}

/**
 * Operation queue for sync operations.
 * Deduplicates by (side, entityKey) — only the latest operation per entity is kept.
 * Provides backpressure via max queue size.
 */
export class SyncQueue {
  private queue: PQueue;
  private pending = new Map<string, SyncOperation>();
  private readonly maxQueueSize: number;
  private droppedCount = 0;

  constructor(options?: QueueOptions) {
    this.queue = new PQueue({ concurrency: options?.concurrency ?? 1 });
    this.maxQueueSize = options?.maxQueueSize ?? 1000;
  }

  /**
   * Enqueue a sync operation. Deduplicates by (side, entityKey).
   * Returns false if queue is full (backpressure).
   */
  enqueue(operation: SyncOperation): boolean {
    const key = `${operation.side}:${operation.entityKey}`;

    // Backpressure check
    if (this.pending.size >= this.maxQueueSize && !this.pending.has(key)) {
      this.droppedCount++;
      return false;
    }

    // Dedup: replace existing operation for this entity
    this.pending.set(key, operation);
    return true;
  }

  /**
   * Drain the queue: remove all pending operations and return them.
   * Caller processes them and passes to the processor function.
   */
  drain(): SyncOperation[] {
    const ops = Array.from(this.pending.values());
    this.pending.clear();
    return ops;
  }

  /**
   * Process pending operations with a handler function.
   * Uses p-queue for concurrency control.
   */
  async process(handler: (op: SyncOperation) => Promise<void>): Promise<void> {
    const ops = this.drain();
    const tasks = ops.map((op) => this.queue.add(() => handler(op)));
    await Promise.allSettled(tasks);
  }

  /**
   * Number of pending (not yet processed) operations.
   */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Number of operations dropped due to backpressure.
   */
  get dropped(): number {
    return this.droppedCount;
  }

  /**
   * Number of operations currently being processed.
   */
  get activeCount(): number {
    return this.queue.pending;
  }

  /**
   * Clear all pending operations.
   */
  clear(): void {
    this.pending.clear();
  }

  /**
   * Wait for all in-flight operations to complete.
   */
  async onIdle(): Promise<void> {
    await this.queue.onIdle();
  }
}
