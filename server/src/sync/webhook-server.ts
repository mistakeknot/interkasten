import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { DB } from "../store/db.js";
import { DurableQueue } from "./durable-queue.js";
import { parseWebhookEvents, verifyNotionSignature } from "./webhooks.js";
import { normalizeNotionId } from "./discovery.js";
import { listEntities } from "../store/entities.js";

// ---------- Types ----------

export interface WebhookServerOptions {
  port: number;
  path: string;
  secret: string;
  batchWindowMs: number;
  scopeRootIds: string[];
  scopeExcludeIds: string[];
}

export interface CloudBridgeOptions {
  url: string;
  token: string;
  pollMs: number;
  batchSize: number;
}

interface InboundEvent {
  eventId: string;
  eventType: string;
  entityId: string | null;
  payload: Record<string, unknown>;
}

interface IngestResult {
  enqueued: number;
  droppedOutOfScope: number;
  queuedReconcileForUnknownScope: number;
}

// ---------- WebhookServer ----------

/**
 * HTTP server that receives Notion webhook events and enqueues them
 * into the DurableQueue for processing by the SyncEngine.
 *
 * Also supports cloud bridge polling for NAT traversal scenarios.
 */
export class WebhookServer {
  private readonly queue: DurableQueue;
  private readonly db: DB | null;
  private readonly options: WebhookServerOptions;
  private readonly cloudBridge: CloudBridgeOptions | null;
  private readonly scopeRootIds: Set<string>;
  private readonly scopeExcludeIds: Set<string>;

  private server: ReturnType<typeof createServer> | null = null;
  private cloudTimer: NodeJS.Timeout | null = null;
  private cloudPolling = false;
  private webhookSecret: string;

  constructor(
    queue: DurableQueue,
    db: DB | null,
    options: WebhookServerOptions,
    cloudBridge?: CloudBridgeOptions,
  ) {
    this.queue = queue;
    this.db = db;
    this.options = options;
    this.cloudBridge = cloudBridge ?? null;
    this.webhookSecret = options.secret.trim();
    this.scopeRootIds = new Set(options.scopeRootIds.map(normalizeNotionId));
    this.scopeExcludeIds = new Set(
      options.scopeExcludeIds.map(normalizeNotionId),
    );
  }

  async start(): Promise<void> {
    // Restore persisted verification token if available
    const persistedToken = this.queue
      .getState("last_verification_token")
      ?.trim();
    if (persistedToken) {
      if (this.webhookSecret && this.webhookSecret !== persistedToken) {
        console.warn(
          "Using stored Notion verification token for webhook signature validation.",
        );
      }
      this.webhookSecret = persistedToken;
    }

    if (!this.webhookSecret && !this.cloudBridge) {
      throw new Error(
        "Webhook signing secret is not configured. Set webhook.secret in config or complete Notion webhook verification.",
      );
    }

    // Start HTTP server
    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        console.error("Webhook handler error:", err);
        if (!res.headersSent) {
          writeJson(res, 500, { ok: false, error: "internal_error" });
        }
      });
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.options.port, "127.0.0.1", () => resolve());
    });

    console.log(
      `Webhook server listening on http://127.0.0.1:${this.options.port}${this.options.path}`,
    );

    // Start cloud bridge polling
    if (this.cloudBridge) {
      this.cloudTimer = setInterval(
        () => {
          this.pollCloudBridge().catch((err) =>
            console.error("Cloud bridge poll error:", err),
          );
        },
        Math.max(1_000, this.cloudBridge.pollMs),
      );

      // Prime immediately
      await this.pollCloudBridge();
      console.log(
        `Cloud bridge: ${this.cloudBridge.url} (poll=${this.cloudBridge.pollMs}ms batch=${this.cloudBridge.batchSize})`,
      );
    }

    if (this.scopeRootIds.size > 0 || this.scopeExcludeIds.size > 0) {
      console.log(
        `Scope filter active: roots=${this.scopeRootIds.size}, excludes=${this.scopeExcludeIds.size}`,
      );
    }
  }

  async stop(): Promise<void> {
    if (this.cloudTimer) clearInterval(this.cloudTimer);

    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  // ---------- HTTP handler ----------

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const requestPath = normalizePath(req.url?.split("?")[0] ?? "");
    const webhookPath = normalizePath(this.options.path);

    if (req.method !== "POST" || requestPath !== webhookPath) {
      writeJson(res, 404, { ok: false, error: "not_found" });
      return;
    }

    const rawBody = await readRequestBody(req);
    let payload: Record<string, unknown>;

    try {
      payload = JSON.parse(rawBody);
    } catch {
      writeJson(res, 400, { ok: false, error: "invalid_json" });
      return;
    }

    // Notion verification handshake
    if (typeof payload.verification_token === "string") {
      const verificationToken = (payload.verification_token as string).trim();
      this.webhookSecret = verificationToken;

      this.queue.setState("last_verification_token", verificationToken);
      this.queue.setState(
        "last_verification_token_at",
        new Date().toISOString(),
      );

      writeJson(res, 200, {
        ok: true,
        verification_token: verificationToken,
        message: "verification token received",
      });
      return;
    }

    // Verify signature
    const signature = req.headers["x-notion-signature"];
    const signatureValue = Array.isArray(signature) ? signature[0] : signature;

    if (
      !signatureValue ||
      !verifyNotionSignature(rawBody, signatureValue, this.webhookSecret)
    ) {
      writeJson(res, 401, { ok: false, error: "invalid_signature" });
      return;
    }

    // Parse and ingest events
    const parsedEvents = parseWebhookEvents(payload);
    const ingestResult = this.ingestEvents(
      parsedEvents.map((event) => ({
        eventId: event.eventId,
        eventType: event.eventType,
        entityId: event.entityId,
        payload,
      })),
      Date.now() + this.options.batchWindowMs,
    );

    writeJson(res, 200, {
      ok: true,
      received: parsedEvents.length,
      enqueued: ingestResult.enqueued,
      dropped_out_of_scope: ingestResult.droppedOutOfScope,
      queued_reconcile_unknown_scope:
        ingestResult.queuedReconcileForUnknownScope,
    });
  }

  // ---------- Event ingestion ----------

  private ingestEvents(
    events: InboundEvent[],
    availableAtMs: number,
  ): IngestResult {
    const parentIndex = this.buildParentIndex();

    let enqueued = 0;
    let droppedOutOfScope = 0;
    let queuedReconcileForUnknownScope = 0;

    for (const event of events) {
      this.queue.recordWebhookReceipt({
        eventId: event.eventId,
        eventType: event.eventType,
        entityId: event.entityId,
        signatureOk: true,
        payload: event.payload,
      });

      if (!event.entityId) continue;

      const scopeDecision = this.evaluateScope(event.entityId, parentIndex);
      if (scopeDecision === "deny") {
        droppedOutOfScope++;
        continue;
      }
      if (scopeDecision === "unknown") {
        this.queue.enqueue({
          kind: "reconcile_full",
          dedupeKey: "reconcile:full",
          payload: { source: "scope_unknown_webhook" },
        });
        queuedReconcileForUnknownScope++;
        continue;
      }

      this.queue.enqueue({
        kind: "remote_entity_pull",
        dedupeKey: `remote:${event.entityId}`,
        payload: { notionId: event.entityId, source: event.eventType },
        availableAtMs,
      });
      enqueued++;
    }

    return { enqueued, droppedOutOfScope, queuedReconcileForUnknownScope };
  }

  /**
   * Evaluate whether a Notion entity is within the configured scope.
   *
   * Uses the entity_map's parent chain (via integer parent_id FK → notion_id lookup)
   * to walk up and check against scope root/exclude sets.
   *
   * Returns:
   * - "allow" if entity is in scope (or no scope configured)
   * - "deny" if entity or an ancestor is in the exclude set
   * - "unknown" if entity is not in entity_map (can't determine scope)
   */
  private evaluateScope(
    notionId: string,
    parentIndex: Map<string, string | null>,
  ): "allow" | "deny" | "unknown" {
    if (this.scopeRootIds.size === 0 && this.scopeExcludeIds.size === 0) {
      return "allow";
    }

    let current: string | null = normalizeNotionId(notionId);
    const visited = new Set<string>();
    let rootMatched = false;

    while (current && !visited.has(current)) {
      visited.add(current);

      if (this.scopeExcludeIds.has(current)) return "deny";
      if (this.scopeRootIds.has(current)) {
        rootMatched = true;
        break;
      }

      current = parentIndex.get(current) ?? null;
    }

    if (this.scopeRootIds.size === 0) return "allow";
    if (rootMatched) return "allow";

    // Entity not found in entity_map — can't determine scope
    return "unknown";
  }

  /**
   * Build a Notion ID → parent Notion ID index from the entity_map.
   * Uses the integer parent_id FK to join entity_map with itself.
   */
  private buildParentIndex(): Map<string, string | null> {
    const index = new Map<string, string | null>();
    if (!this.db) return index;

    const entities = listEntities(this.db);
    // Build id → notionId map first
    const idToNotionId = new Map<number, string>();
    for (const e of entities) {
      idToNotionId.set(e.id, normalizeNotionId(e.notionId));
    }

    // Build notionId → parent notionId
    for (const e of entities) {
      const normId = normalizeNotionId(e.notionId);
      const parentNotionId = e.parentId
        ? (idToNotionId.get(e.parentId) ?? null)
        : null;
      index.set(normId, parentNotionId);
    }

    return index;
  }

  // ---------- Cloud bridge ----------

  private async pollCloudBridge(): Promise<void> {
    if (!this.cloudBridge || this.cloudPolling) return;
    this.cloudPolling = true;

    try {
      const dequeueUrl = new URL("/internal/dequeue", this.cloudBridge.url);
      dequeueUrl.searchParams.set(
        "limit",
        String(Math.max(1, this.cloudBridge.batchSize)),
      );

      const response = await fetch(dequeueUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.cloudBridge.token}`,
          "User-Agent": "interkasten-cloud-poller/0.1",
        },
      });

      if (!response.ok) {
        console.error(
          `Cloud bridge dequeue failed: ${response.status} ${response.statusText}`,
        );
        return;
      }

      const payload = (await response.json()) as {
        leaseOwner: string;
        items: Array<{
          id: number;
          eventId: string;
          eventType: string;
          entityId: string | null;
          payload: Record<string, unknown>;
        }>;
      };

      if (
        !payload ||
        !Array.isArray(payload.items) ||
        typeof payload.leaseOwner !== "string"
      ) {
        console.error("Cloud bridge dequeue returned invalid payload.");
        return;
      }

      if (payload.items.length === 0) return;

      const processedIds: number[] = [];
      const inboundEvents: InboundEvent[] = [];

      for (const item of payload.items) {
        if (
          !item ||
          typeof item.id !== "number" ||
          typeof item.eventId !== "string"
        ) {
          continue;
        }

        inboundEvents.push({
          eventId: item.eventId,
          eventType: item.eventType,
          entityId: typeof item.entityId === "string" ? item.entityId : null,
          payload: item.payload ?? {},
        });
        processedIds.push(item.id);
      }

      if (inboundEvents.length > 0) {
        const result = this.ingestEvents(
          inboundEvents,
          Date.now() + this.options.batchWindowMs,
        );
        if (
          result.enqueued > 0 ||
          result.droppedOutOfScope > 0 ||
          result.queuedReconcileForUnknownScope > 0
        ) {
          console.log(
            `Cloud bridge: received=${inboundEvents.length} enqueued=${result.enqueued} dropped=${result.droppedOutOfScope} reconcile=${result.queuedReconcileForUnknownScope}`,
          );
        }
      }

      if (processedIds.length > 0) {
        await this.ackLease(payload.leaseOwner, processedIds);
      }
    } catch (err) {
      console.error("Cloud bridge poll failed:", err);
    } finally {
      this.cloudPolling = false;
    }
  }

  private async ackLease(leaseOwner: string, ids: number[]): Promise<void> {
    if (!this.cloudBridge || ids.length === 0) return;

    try {
      const ackUrl = new URL("/internal/ack", this.cloudBridge.url);
      const response = await fetch(ackUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cloudBridge.token}`,
          "Content-Type": "application/json",
          "User-Agent": "interkasten-cloud-poller/0.1",
        },
        body: JSON.stringify({ leaseOwner, ids }),
      });

      if (!response.ok) {
        console.error(
          `Cloud bridge ack failed: ${response.status} ${response.statusText}`,
        );
      }
    } catch (err) {
      console.error("Cloud bridge ack request failed:", err);
    }
  }
}

// ---------- Helpers ----------

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : "/";
}
