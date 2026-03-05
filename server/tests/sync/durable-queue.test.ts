import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync, unlinkSync } from "fs";
import { DurableQueue } from "../../src/sync/durable-queue.js";

function tmpDbPath(): string {
  return join(
    tmpdir(),
    `interkasten-queue-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const f = path + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
}

describe("DurableQueue", () => {
  let dbPath: string;
  let queue: DurableQueue;

  beforeEach(() => {
    dbPath = tmpDbPath();
    queue = new DurableQueue(dbPath);
  });

  afterEach(() => {
    queue.close();
    cleanupDb(dbPath);
  });

  describe("enqueue", () => {
    it("inserts a new work item", () => {
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "remote:abc-123",
        payload: { notionId: "abc-123" },
      });

      const items = queue.claimReady(10);
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe("remote_entity_pull");
      expect(items[0].dedupeKey).toBe("remote:abc-123");
      expect(items[0].payload).toEqual({ notionId: "abc-123" });
      expect(items[0].status).toBe("processing"); // claimed
      expect(items[0].attempts).toBe(0);
    });

    it("deduplicates by dedupeKey when status is queued", () => {
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "remote:abc",
        payload: { v: 1 },
      });
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "remote:abc",
        payload: { v: 2 },
      });

      const items = queue.claimReady(10);
      expect(items).toHaveLength(1);
      expect(items[0].payload).toEqual({ v: 2 }); // latest payload wins
    });

    it("takes earliest available_at_ms on dedup (MIN)", () => {
      const early = Date.now();
      const late = early + 60000;

      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "remote:abc",
        payload: { v: 1 },
        availableAtMs: late,
      });
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "remote:abc",
        payload: { v: 2 },
        availableAtMs: early,
      });

      const items = queue.claimReady(10);
      expect(items).toHaveLength(1);
      expect(items[0].availableAtMs).toBe(early);
    });

    it("bounces processing items back to queued", () => {
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "remote:abc",
        payload: { v: 1 },
      });

      // Claim it (now processing)
      const claimed = queue.claimReady(10);
      expect(claimed).toHaveLength(1);

      // Enqueue same key while processing → bounces back to queued
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "remote:abc",
        payload: { v: 2 },
      });

      // markDone should be a no-op since status was bounced to queued
      queue.markDone(claimed[0].id);

      // Should be claimable again with new payload
      const reclaimed = queue.claimReady(10);
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0].payload).toEqual({ v: 2 });
    });

    it("re-inserts after done status", () => {
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "remote:abc",
        payload: { v: 1 },
      });

      const claimed = queue.claimReady(10);
      queue.markDone(claimed[0].id);

      // Enqueue same key after done → fresh insert
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "remote:abc",
        payload: { v: 2 },
      });

      const items = queue.claimReady(10);
      expect(items).toHaveLength(1);
      expect(items[0].payload).toEqual({ v: 2 });
      expect(items[0].attempts).toBe(0); // reset
    });

    it("re-inserts after dead status", () => {
      queue.enqueue({
        kind: "local_entity_push",
        dedupeKey: "local:xyz",
        payload: {},
      });

      const claimed = queue.claimReady(10);
      // Exhaust retries
      queue.markRetryOrDead(
        { ...claimed[0], attempts: 5 },
        new Error("persistent failure"),
        5,
      );

      // Enqueue same key after dead → fresh insert
      queue.enqueue({
        kind: "local_entity_push",
        dedupeKey: "local:xyz",
        payload: { retry: true },
      });

      const items = queue.claimReady(10);
      expect(items).toHaveLength(1);
      expect(items[0].attempts).toBe(0);
    });

    it("supports beads_sync work item kind", () => {
      queue.enqueue({
        kind: "beads_sync",
        dedupeKey: "beads:project-1",
        payload: { projectPath: "/projects/foo" },
      });

      const items = queue.claimReady(10);
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe("beads_sync");
    });
  });

  describe("claimReady", () => {
    it("respects available_at_ms delay", () => {
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "remote:delayed",
        payload: {},
        availableAtMs: Date.now() + 60000, // 60s in the future
      });

      const items = queue.claimReady(10);
      expect(items).toHaveLength(0); // not yet ready
    });

    it("respects limit", () => {
      for (let i = 0; i < 5; i++) {
        queue.enqueue({
          kind: "remote_entity_pull",
          dedupeKey: `remote:item-${i}`,
          payload: { i },
        });
      }

      const items = queue.claimReady(3);
      expect(items).toHaveLength(3);
    });

    it("orders by available_at_ms ASC", () => {
      const now = Date.now();
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "remote:later",
        payload: { order: 2 },
        availableAtMs: now - 1000,
      });
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "remote:earlier",
        payload: { order: 1 },
        availableAtMs: now - 2000,
      });

      const items = queue.claimReady(10);
      expect(items).toHaveLength(2);
      expect(items[0].payload).toEqual({ order: 1 }); // earlier first
      expect(items[1].payload).toEqual({ order: 2 });
    });

    it("does not return already-claimed items", () => {
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "remote:abc",
        payload: {},
      });

      const first = queue.claimReady(10);
      expect(first).toHaveLength(1);

      const second = queue.claimReady(10);
      expect(second).toHaveLength(0); // already claimed
    });
  });

  describe("stale processing recovery", () => {
    it("recovers items stuck in processing for >15 minutes", () => {
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "remote:stuck",
        payload: {},
      });

      // Claim the item
      const claimed = queue.claimReady(10);
      expect(claimed).toHaveLength(1);

      // Simulate stale lock by backdating locked_at_ms
      const staleTime =
        Date.now() - DurableQueue["STALE_PROCESSING_TIMEOUT_MS"] - 1000;
      (queue as any).db
        .prepare("UPDATE work_items SET locked_at_ms = ? WHERE id = ?")
        .run(staleTime, claimed[0].id);

      // Next claim should recover the stale item
      const recovered = queue.claimReady(10);
      expect(recovered).toHaveLength(1);
      expect(recovered[0].dedupeKey).toBe("remote:stuck");
      expect(recovered[0].attempts).toBe(1); // incremented
    });
  });

  describe("markDone", () => {
    it("transitions processing → done", () => {
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "remote:abc",
        payload: {},
      });

      const claimed = queue.claimReady(10);
      queue.markDone(claimed[0].id);

      // Should not be claimable again
      const next = queue.claimReady(10);
      expect(next).toHaveLength(0);
    });

    it("is a no-op if item was bounced back to queued", () => {
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "remote:abc",
        payload: { v: 1 },
      });

      const claimed = queue.claimReady(10);

      // Bounce while processing
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "remote:abc",
        payload: { v: 2 },
      });

      // markDone should not transition since status is now queued
      queue.markDone(claimed[0].id);

      const items = queue.claimReady(10);
      expect(items).toHaveLength(1); // still available
    });
  });

  describe("markRetryOrDead", () => {
    it("retries with exponential backoff", () => {
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "remote:flaky",
        payload: {},
      });

      const claimed = queue.claimReady(10);
      const item = claimed[0];

      queue.markRetryOrDead(item, new Error("transient"), 5);

      // Item should be queued again but with a delay
      // Backoff for attempt 1: min(60000, 2000 * 2^0) = 2000ms
      const stats = queue.getStats();
      expect(stats.queued).toBe(1);
      expect(stats.dead).toBe(0);
    });

    it("moves to dead letter queue after max retries", () => {
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "remote:doomed",
        payload: { data: "important" },
      });

      const claimed = queue.claimReady(10);
      const item = { ...claimed[0], attempts: 5 }; // already at max

      queue.markRetryOrDead(item, new Error("permanent failure"), 5);

      const stats = queue.getStats();
      expect(stats.dead).toBe(1);
      expect(stats.deadLetters).toBe(1);
      expect(stats.queued).toBe(0);
    });

    it("records error message on retry", () => {
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "remote:err",
        payload: {},
      });

      const claimed = queue.claimReady(10);
      queue.markRetryOrDead(claimed[0], new Error("something broke"), 5);

      // Wait for backoff then claim
      // Manually clear the delay for testing
      (queue as any).db
        .prepare("UPDATE work_items SET available_at_ms = 0 WHERE id = ?")
        .run(claimed[0].id);

      const retry = queue.claimReady(10);
      expect(retry).toHaveLength(1);
      expect(retry[0].lastError).toBe("Error: something broke");
      expect(retry[0].attempts).toBe(1);
    });
  });

  describe("webhookReceipt", () => {
    it("records a receipt", () => {
      queue.recordWebhookReceipt({
        eventId: "evt-123",
        eventType: "page.updated",
        entityId: "page-abc",
        signatureOk: true,
        payload: { test: true },
      });

      const stats = queue.getStats();
      expect(stats.webhookReceipts).toBe(1);
    });

    it("ignores duplicate event_ids", () => {
      const receipt = {
        eventId: "evt-123",
        eventType: "page.updated",
        entityId: "page-abc",
        signatureOk: true,
        payload: { test: true },
      };

      queue.recordWebhookReceipt(receipt);
      queue.recordWebhookReceipt(receipt); // duplicate

      const stats = queue.getStats();
      expect(stats.webhookReceipts).toBe(1); // still 1
    });
  });

  describe("service state", () => {
    it("stores and retrieves state", () => {
      queue.setState("last_git_commit", "abc123");
      expect(queue.getState("last_git_commit")).toBe("abc123");
    });

    it("returns null for missing keys", () => {
      expect(queue.getState("nonexistent")).toBeNull();
    });

    it("upserts on conflict", () => {
      queue.setState("cursor", "v1");
      queue.setState("cursor", "v2");
      expect(queue.getState("cursor")).toBe("v2");
    });
  });

  describe("getStats", () => {
    it("returns counts by status", () => {
      // Enqueue 3 items
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "a",
        payload: {},
      });
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "b",
        payload: {},
      });
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "c",
        payload: {},
      });

      let stats = queue.getStats();
      expect(stats.queued).toBe(3);

      // Claim 2
      const claimed = queue.claimReady(2);
      stats = queue.getStats();
      expect(stats.queued).toBe(1);
      expect(stats.processing).toBe(2);

      // Mark 1 done
      queue.markDone(claimed[0].id);
      stats = queue.getStats();
      expect(stats.done).toBe(1);
      expect(stats.processing).toBe(1);
    });
  });

  describe("purgeDone", () => {
    it("removes completed items older than threshold", () => {
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "old",
        payload: {},
      });
      const claimed = queue.claimReady(10);
      queue.markDone(claimed[0].id);

      // Backdate the done item
      (queue as any).db
        .prepare("UPDATE work_items SET updated_at_ms = ? WHERE id = ?")
        .run(Date.now() - 100000, claimed[0].id);

      const purged = queue.purgeDone(50000); // older than 50s
      expect(purged).toBe(1);

      const stats = queue.getStats();
      expect(stats.done).toBe(0);
    });

    it("does not purge recent done items", () => {
      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "recent",
        payload: {},
      });
      const claimed = queue.claimReady(10);
      queue.markDone(claimed[0].id);

      const purged = queue.purgeDone(60000);
      expect(purged).toBe(0);
    });
  });

  describe("concurrent access", () => {
    it("two queue instances on same db can enqueue and claim safely", () => {
      const queue2 = new DurableQueue(dbPath);

      queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "shared-1",
        payload: { from: "q1" },
      });
      queue2.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: "shared-2",
        payload: { from: "q2" },
      });

      // Each claims one
      const items1 = queue.claimReady(1);
      const items2 = queue2.claimReady(1);

      expect(items1).toHaveLength(1);
      expect(items2).toHaveLength(1);
      expect(items1[0].dedupeKey).not.toBe(items2[0].dedupeKey);

      queue2.close();
    });
  });
});
