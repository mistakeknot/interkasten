import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import { WebhookServer } from "../../src/sync/webhook-server.js";
import { DurableQueue } from "../../src/sync/durable-queue.js";

const TEST_SECRET = "test-webhook-secret";
let nextPort = 19876;

function sign(body: string, secret = TEST_SECRET): string {
  const hash = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hash}`;
}

function makeQueue(): DurableQueue {
  return new DurableQueue(":memory:");
}

describe("WebhookServer", () => {
  let queue: DurableQueue;
  let server: WebhookServer | null = null;
  let port: number;

  beforeEach(() => {
    queue = makeQueue();
    port = nextPort++;
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
    queue.close();
  });

  async function startServer(
    overrides: {
      scopeRootIds?: string[];
      scopeExcludeIds?: string[];
    } = {},
  ): Promise<WebhookServer> {
    server = new WebhookServer(queue, null, {
      port,
      path: "/webhook",
      secret: TEST_SECRET,
      batchWindowMs: 0,
      scopeRootIds: overrides.scopeRootIds ?? [],
      scopeExcludeIds: overrides.scopeExcludeIds ?? [],
    });
    await server.start();
    return server;
  }

  async function postWebhook(
    body: Record<string, unknown>,
    opts: { signature?: string; path?: string } = {},
  ): Promise<Response> {
    const rawBody = JSON.stringify(body);
    const sig = opts.signature ?? sign(rawBody);
    const path = opts.path ?? "/webhook";

    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-notion-signature": sig,
      },
      body: rawBody,
    });
  }

  it("accepts valid webhook and enqueues work item", async () => {
    await startServer();

    const res = await postWebhook({
      id: "evt-1",
      type: "page.updated",
      entity: { id: "page-abc" },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.enqueued).toBe(1);

    // Verify item was enqueued in durable queue
    const items = queue.claimReady(10);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("remote_entity_pull");
    expect((items[0].payload as any).notionId).toBe("page-abc");
  });

  it("rejects invalid signature", async () => {
    await startServer();

    const res = await postWebhook(
      { id: "evt-1", type: "page.updated", entity: { id: "p1" } },
      { signature: "sha256=invalid" },
    );

    expect(res.status).toBe(401);
    const json = (await res.json()) as any;
    expect(json.error).toBe("invalid_signature");
  });

  it("returns 404 for wrong path", async () => {
    await startServer();

    const res = await postWebhook(
      { id: "evt-1", type: "page.updated" },
      { path: "/wrong-path" },
    );

    expect(res.status).toBe(404);
  });

  it("handles Notion verification handshake", async () => {
    await startServer();

    const body = { verification_token: "notion-verify-token-123" };
    const rawBody = JSON.stringify(body);
    // Verification requests don't need valid signature
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawBody,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.verification_token).toBe("notion-verify-token-123");

    // Verify token was persisted
    const stored = queue.getState("last_verification_token");
    expect(stored).toBe("notion-verify-token-123");
  });

  it("records webhook receipt", async () => {
    await startServer();

    await postWebhook({
      id: "evt-receipt-test",
      type: "page.updated",
      entity: { id: "p1" },
    });

    // Webhook receipt should be recorded in the queue db
    const stats = queue.getStats();
    expect(stats.webhookReceipts).toBeGreaterThanOrEqual(1);
  });

  it("deduplicates events for same entity", async () => {
    await startServer();

    // Send two events for the same entity
    await postWebhook({
      id: "evt-1",
      type: "page.updated",
      entity: { id: "same-page" },
    });
    await postWebhook({
      id: "evt-2",
      type: "page.updated",
      entity: { id: "same-page" },
    });

    // Should only have 1 work item due to dedupeKey
    const items = queue.claimReady(10);
    expect(items).toHaveLength(1);
  });

  it("handles batched events", async () => {
    await startServer();

    const res = await postWebhook({
      events: [
        { id: "evt-1", type: "page.updated", entity: { id: "p1" } },
        { id: "evt-2", type: "page.updated", entity: { id: "p2" } },
      ],
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.received).toBe(2);
    expect(json.enqueued).toBe(2);
  });

  it("skips events without entityId", async () => {
    await startServer();

    const res = await postWebhook({
      id: "evt-no-entity",
      type: "workspace.ping",
      // No entity field
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.enqueued).toBe(0);
  });

  it("stops cleanly", async () => {
    const s = await startServer();
    await s.stop();
    server = null; // prevent double-stop in afterEach

    // Server should no longer accept connections
    try {
      await fetch(`http://127.0.0.1:${port}/webhook`);
      expect.fail("Should have thrown connection error");
    } catch {
      // Expected
    }
  });
});
