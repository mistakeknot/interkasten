import { Client } from "@notionhq/client";
import PQueue from "p-queue";

/**
 * Circuit breaker states for the Notion API client.
 */
export type CircuitState = "closed" | "open" | "half-open";

/**
 * Notion API error translated to user-friendly message.
 */
export interface NotionError {
  code: number;
  message: string;
  remediation: string;
  raw?: string;
}

/**
 * Error translation table from PRD §6.
 */
const ERROR_TABLE: Record<number, { message: string; remediation: string }> = {
  401: {
    message: "Notion token is invalid or expired",
    remediation:
      "Regenerate at notion.so/my-integrations and update INTERKASTEN_NOTION_TOKEN",
  },
  403: {
    message: "Integration lacks access to this page",
    remediation: "Share the page with your interkasten integration in Notion",
  },
  404: {
    message: "Notion page was deleted or archived",
    remediation: "Page will be soft-deleted from sync; check Notion trash to restore",
  },
  409: {
    message: "Page was modified during sync",
    remediation: "Will retry on next sync cycle",
  },
  429: {
    message: "Notion API rate limit reached",
    remediation: "Backing off automatically; operations will resume shortly",
  },
  502: {
    message: "Notion API is temporarily unavailable",
    remediation: "Circuit breaker will retry automatically",
  },
  503: {
    message: "Notion API is temporarily unavailable",
    remediation: "Circuit breaker will retry automatically",
  },
  504: {
    message: "Notion API is temporarily unavailable",
    remediation: "Circuit breaker will retry automatically",
  },
};

/**
 * Translate a Notion API error to a user-friendly message.
 */
export function translateError(statusCode: number, rawMessage?: string): NotionError {
  const entry = ERROR_TABLE[statusCode];
  if (entry) {
    return { code: statusCode, ...entry, raw: rawMessage };
  }
  return {
    code: statusCode,
    message: `Notion API error (${statusCode})`,
    remediation: "Check Notion API status and try again",
    raw: rawMessage,
  };
}

/**
 * Per-page advisory mutex to prevent concurrent writes to the same page.
 * Keyed on notion_id. Held for duration of a single sync operation.
 */
class PageMutex {
  private locks = new Map<string, Promise<void>>();

  async acquire(pageId: string): Promise<() => void> {
    // Wait for any existing lock on this page
    while (this.locks.has(pageId)) {
      await this.locks.get(pageId);
    }

    let releaseFn: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    this.locks.set(pageId, lockPromise);

    return () => {
      this.locks.delete(pageId);
      releaseFn!();
    };
  }
}

export interface NotionClientOptions {
  token: string;
  concurrency?: number; // Default 3
  initialDelayMs?: number; // Default 1000
  maxDelayMs?: number; // Default 32000
  circuitBreakerThreshold?: number; // Default 10
  circuitBreakerCheckInterval?: number; // Default 60 seconds
}

/**
 * Wraps @notionhq/client with rate limiting, exponential backoff,
 * circuit breaker, and per-page mutex.
 */
export class NotionClient {
  private client: Client;
  private queue: PQueue;
  private mutex: PageMutex;

  // Circuit breaker state
  private circuitState: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastSuccessfulCall: Date | null = null;
  private circuitOpenedAt: Date | null = null;

  // Backoff state
  private currentBackoffMs: number;
  private consecutive429s = 0;

  // Configuration
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly circuitBreakerThreshold: number;
  private readonly circuitBreakerCheckIntervalMs: number;

  constructor(options: NotionClientOptions) {
    this.client = new Client({ auth: options.token });

    this.queue = new PQueue({
      concurrency: options.concurrency ?? 3,
      interval: 1000,
      intervalCap: options.concurrency ?? 3,
    });

    this.mutex = new PageMutex();
    this.initialDelayMs = options.initialDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 32000;
    this.currentBackoffMs = this.initialDelayMs;
    this.circuitBreakerThreshold = options.circuitBreakerThreshold ?? 10;
    this.circuitBreakerCheckIntervalMs = (options.circuitBreakerCheckInterval ?? 60) * 1000;
  }

  /**
   * Get the underlying Notion SDK client (for operations not wrapped here).
   */
  get raw(): Client {
    return this.client;
  }

  /**
   * Current circuit breaker state.
   */
  getCircuitState(): CircuitState {
    return this.circuitState;
  }

  /**
   * Timestamp of last successful API call.
   */
  getLastSuccessTime(): Date | null {
    return this.lastSuccessfulCall;
  }

  /**
   * Number of consecutive failures.
   */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /**
   * Validate the Notion token by calling users.me().
   */
  async validateToken(): Promise<{ valid: boolean; error?: NotionError }> {
    try {
      await this.client.users.me({});
      this.recordSuccess();
      return { valid: true };
    } catch (err: unknown) {
      const statusCode = extractStatusCode(err);
      return { valid: false, error: translateError(statusCode, String(err)) };
    }
  }

  /**
   * Execute a Notion API call with rate limiting, backoff, and circuit breaker.
   * Optionally acquires a per-page mutex for write operations.
   */
  async call<T>(
    operation: () => Promise<T>,
    options?: { pageId?: string }
  ): Promise<T> {
    // Circuit breaker check
    if (this.circuitState === "open") {
      const elapsed = Date.now() - (this.circuitOpenedAt?.getTime() ?? 0);
      if (elapsed < this.circuitBreakerCheckIntervalMs) {
        throw new CircuitOpenError(
          "Circuit breaker is open — Notion API is unavailable"
        );
      }
      // Time to try half-open
      this.circuitState = "half-open";
    }

    // Acquire page mutex if needed
    let releaseMutex: (() => void) | undefined;
    if (options?.pageId) {
      releaseMutex = await this.mutex.acquire(options.pageId);
    }

    try {
      const result = await this.queue.add(async () => {
        return this.executeWithBackoff(operation);
      });
      return result as T;
    } finally {
      releaseMutex?.();
    }
  }

  /**
   * Execute with exponential backoff on 429 errors.
   */
  private async executeWithBackoff<T>(
    operation: () => Promise<T>,
    attempt = 0
  ): Promise<T> {
    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (err: unknown) {
      const statusCode = extractStatusCode(err);

      if (statusCode === 429) {
        this.consecutive429s++;

        // After 5 consecutive 429s, pause for 60s
        if (this.consecutive429s >= 5) {
          await sleep(60000);
          this.consecutive429s = 0;
          this.currentBackoffMs = this.initialDelayMs;
        }

        // Exponential backoff
        const retryAfter = extractRetryAfter(err) ?? this.currentBackoffMs;
        const delay = Math.min(retryAfter, this.maxDelayMs);
        this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, this.maxDelayMs);

        await sleep(delay);
        return this.executeWithBackoff(operation, attempt + 1);
      }

      // Record failure for circuit breaker
      this.recordFailure();

      // Translate and rethrow
      const translated = translateError(statusCode, String(err));
      throw new NotionApiError(translated);
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.consecutive429s = 0;
    this.currentBackoffMs = this.initialDelayMs;
    this.lastSuccessfulCall = new Date();

    if (this.circuitState === "half-open") {
      this.circuitState = "closed";
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures++;

    if (this.circuitState === "half-open") {
      this.openCircuit();
      return;
    }

    if (this.consecutiveFailures >= this.circuitBreakerThreshold) {
      this.openCircuit();
    }
  }

  private openCircuit(): void {
    this.circuitState = "open";
    this.circuitOpenedAt = new Date();
  }
}

/**
 * Custom error for circuit breaker open state.
 */
export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitOpenError";
  }
}

/**
 * Custom error wrapping a translated Notion API error.
 */
export class NotionApiError extends Error {
  readonly notionError: NotionError;

  constructor(notionError: NotionError) {
    super(notionError.message);
    this.name = "NotionApiError";
    this.notionError = notionError;
  }
}

/**
 * Extract HTTP status code from a Notion SDK error.
 */
function extractStatusCode(err: unknown): number {
  if (err && typeof err === "object") {
    if ("status" in err && typeof (err as Record<string, unknown>).status === "number") {
      return (err as Record<string, unknown>).status as number;
    }
    if ("code" in err && typeof (err as Record<string, unknown>).code === "number") {
      return (err as Record<string, unknown>).code as number;
    }
  }
  return 500;
}

/**
 * Extract Retry-After header value from a 429 response.
 */
function extractRetryAfter(err: unknown): number | undefined {
  if (err && typeof err === "object" && "headers" in err) {
    const headers = (err as Record<string, unknown>).headers;
    if (headers && typeof headers === "object" && "retry-after" in headers) {
      const val = (headers as Record<string, unknown>)["retry-after"];
      const parsed = Number(val);
      if (!isNaN(parsed)) return parsed * 1000; // Convert seconds to ms
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
