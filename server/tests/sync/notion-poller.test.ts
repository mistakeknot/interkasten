import { describe, it, expect, vi } from "vitest";
import { NotionPoller } from "../../src/sync/notion-poller.js";

describe("NotionPoller", () => {
  it("should detect pages updated after last sync", async () => {
    const mockNotion = {
      call: vi.fn().mockResolvedValue({
        results: [
          {
            id: "page-1",
            last_edited_time: "2026-02-15T10:00:00Z",
            properties: { Name: { title: [{ plain_text: "Test Doc" }] } },
          },
        ],
        has_more: false,
      }),
      raw: {
        databases: {
          query: vi.fn(),
        },
      },
    };

    const poller = new NotionPoller(mockNotion as any);
    const changes = await poller.pollDatabase("db-123", new Date("2026-02-15T09:00:00Z"));

    expect(changes).toHaveLength(1);
    expect(changes[0].pageId).toBe("page-1");
  });

  it("should return empty array when no changes", async () => {
    const mockNotion = {
      call: vi.fn().mockResolvedValue({ results: [], has_more: false }),
      raw: { databases: { query: vi.fn() } },
    };

    const poller = new NotionPoller(mockNotion as any);
    const changes = await poller.pollDatabase("db-123", new Date());
    expect(changes).toHaveLength(0);
  });

  it("should handle pagination", async () => {
    const mockNotion = {
      call: vi.fn()
        .mockResolvedValueOnce({
          results: [{
            id: "page-1",
            last_edited_time: "2026-02-15T10:00:00Z",
            properties: { Name: { title: [{ plain_text: "Doc 1" }] } },
          }],
          has_more: true,
          next_cursor: "cursor-1",
        })
        .mockResolvedValueOnce({
          results: [{
            id: "page-2",
            last_edited_time: "2026-02-15T10:01:00Z",
            properties: { Name: { title: [{ plain_text: "Doc 2" }] } },
          }],
          has_more: false,
        }),
      raw: { databases: { query: vi.fn() } },
    };

    const poller = new NotionPoller(mockNotion as any);
    const changes = await poller.pollDatabase("db-123", new Date("2026-02-15T09:00:00Z"));
    expect(changes).toHaveLength(2);
  });

  it("should respect MAX_PAGES limit", async () => {
    // Create a mock that always says has_more=true to test pagination limit
    let callCount = 0;
    const mockNotion = {
      call: vi.fn().mockImplementation(async () => {
        callCount++;
        return {
          results: [{
            id: `page-${callCount}`,
            last_edited_time: "2026-02-15T10:00:00Z",
            properties: { Name: { title: [{ plain_text: `Doc ${callCount}` }] } },
          }],
          has_more: true,
          next_cursor: `cursor-${callCount}`,
        };
      }),
      raw: { databases: { query: vi.fn() } },
    };

    const poller = new NotionPoller(mockNotion as any);
    const changes = await poller.pollDatabase("db-123", new Date("2026-02-15T09:00:00Z"));

    // Should stop after MAX_PAGES (20) iterations, not loop forever
    expect(changes.length).toBeLessThanOrEqual(20);
    expect(mockNotion.call).toHaveBeenCalledTimes(20);
  });
});
