import { describe, it, expect } from "vitest";
import {
  verifyNotionSignature,
  parseWebhookEvents,
} from "../../src/sync/webhooks.js";
import { createHmac } from "crypto";

describe("webhooks", () => {
  describe("verifyNotionSignature", () => {
    const secret = "test-secret-key";

    function sign(body: string): string {
      const hash = createHmac("sha256", secret).update(body).digest("hex");
      return `sha256=${hash}`;
    }

    it("accepts valid signature", () => {
      const body = '{"type":"page.updated"}';
      const sig = sign(body);
      expect(verifyNotionSignature(body, sig, secret)).toBe(true);
    });

    it("rejects invalid signature", () => {
      const body = '{"type":"page.updated"}';
      expect(verifyNotionSignature(body, "sha256=invalid", secret)).toBe(false);
    });

    it("rejects signature with wrong length", () => {
      const body = '{"type":"page.updated"}';
      expect(verifyNotionSignature(body, "sha256=abc", secret)).toBe(false);
    });

    it("rejects tampered body", () => {
      const body = '{"type":"page.updated"}';
      const sig = sign(body);
      expect(verifyNotionSignature(body + "tampered", sig, secret)).toBe(false);
    });
  });

  describe("parseWebhookEvents", () => {
    it("parses single event payload", () => {
      const payload = {
        id: "evt-123",
        type: "page.updated",
        entity: { id: "page-abc" },
      };

      const events = parseWebhookEvents(payload);
      expect(events).toHaveLength(1);
      expect(events[0].eventId).toBe("evt-123");
      expect(events[0].eventType).toBe("page.updated");
      expect(events[0].entityId).toBe("page-abc");
    });

    it("parses batched events array", () => {
      const payload = {
        events: [
          { id: "evt-1", type: "page.created", entity: { id: "p1" } },
          { id: "evt-2", type: "page.updated", entity: { id: "p2" } },
        ],
      };

      const events = parseWebhookEvents(payload);
      expect(events).toHaveLength(2);
      expect(events[0].eventId).toBe("evt-1");
      expect(events[1].eventId).toBe("evt-2");
    });

    it("handles alternative field names", () => {
      const payload = {
        event_id: "alt-id",
        event_type: "database.updated",
        data: { database_id: "db-123" },
      };

      const events = parseWebhookEvents(payload);
      expect(events).toHaveLength(1);
      expect(events[0].eventId).toBe("alt-id");
      expect(events[0].eventType).toBe("database.updated");
      expect(events[0].entityId).toBe("db-123");
    });

    it("generates synthetic event ID when missing", () => {
      const payload = { type: "page.updated", entity: { id: "p1" } };

      const events = parseWebhookEvents(payload);
      expect(events[0].eventId).toMatch(/^evt-/);
    });

    it("returns null entityId when not present", () => {
      const payload = { id: "evt-1", type: "unknown_event" };

      const events = parseWebhookEvents(payload);
      expect(events[0].entityId).toBeNull();
    });

    it("handles empty string values", () => {
      const payload = { id: "", type: "", entity: { id: "" } };

      const events = parseWebhookEvents(payload);
      // Empty strings should be treated as missing
      expect(events[0].eventId).toMatch(/^evt-/);
      expect(events[0].eventType).toBe("unknown");
      expect(events[0].entityId).toBeNull();
    });
  });
});
