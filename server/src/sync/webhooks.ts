import { createHmac, timingSafeEqual } from "crypto";

export interface ParsedWebhookEvent {
  eventId: string;
  eventType: string;
  entityId: string | null;
}

/**
 * Verify a Notion webhook signature using HMAC-SHA256.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function verifyNotionSignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedFull = `sha256=${expected}`;

  const a = Buffer.from(expectedFull);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

/**
 * Parse webhook events from a Notion payload.
 * Handles various payload shapes: single event, batched events array,
 * and different field naming conventions from Notion's evolving API.
 */
export function parseWebhookEvents(
  payload: Record<string, unknown>,
): ParsedWebhookEvent[] {
  const events = Array.isArray((payload as any).events)
    ? ((payload as any).events as Array<Record<string, unknown>>)
    : [payload];

  const parsed: ParsedWebhookEvent[] = [];

  for (const event of events) {
    const eventId =
      stringOrNull(
        (event as any).id,
        (event as any).event_id,
        (event as any).webhook_event_id,
        (event as any).delivery_id,
      ) ?? `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const eventType =
      stringOrNull(
        (event as any).type,
        (event as any).event_type,
        (event as any).event?.type,
      ) ?? "unknown";

    const entityId = stringOrNull(
      (event as any).entity?.id,
      (event as any).event?.entity?.id,
      (event as any).entity_id,
      (event as any).data?.id,
      (event as any).data?.page_id,
      (event as any).data?.database_id,
    );

    parsed.push({ eventId, eventType, entityId });
  }

  return parsed;
}

function stringOrNull(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0)
      return value.trim();
  }
  return null;
}
