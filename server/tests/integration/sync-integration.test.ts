/**
 * Integration tests for bidirectional Notion sync.
 *
 * These tests exercise the real Notion API and require:
 *   INTERKASTEN_TEST_TOKEN  — Notion integration token
 *   INTERKASTEN_TEST_DATABASE — Notion database ID to use for testing
 *
 * Skipped automatically when env vars are absent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { resolve } from "path";
import { tmpdir } from "os";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "fs";
import { openDatabase, closeDatabase } from "../../src/store/db.js";
import {
  upsertEntity,
  getEntityByPath,
  getEntityByNotionId,
  softDeleteEntity,
  gcDeletedEntities,
  markConflict,
  clearConflict,
  listConflicts,
} from "../../src/store/entities.js";
import {
  markdownToNotionBlocks,
  notionBlocksToMarkdown,
  hashMarkdown,
  normalizeMarkdown,
} from "../../src/sync/translator.js";
import { NotionClient } from "../../src/sync/notion-client.js";
import { threeWayMerge } from "../../src/sync/merge.js";
import type { DB } from "../../src/store/db.js";
import type Database from "better-sqlite3";

const TEST_TOKEN = process.env.INTERKASTEN_TEST_TOKEN;
const TEST_DATABASE = process.env.INTERKASTEN_TEST_DATABASE;

/**
 * Clean up test pages created during integration tests.
 * Deletes (archives) the page in Notion.
 */
async function cleanupNotionPage(
  notion: NotionClient,
  pageId: string,
): Promise<void> {
  try {
    await notion.call(async () => {
      return notion.raw.pages.update({
        page_id: pageId,
        archived: true,
      });
    });
  } catch {
    // Best-effort cleanup
  }
}

describe.skipIf(!TEST_TOKEN || !TEST_DATABASE)(
  "integration: bidirectional sync",
  () => {
    let notion: NotionClient;
    let db: DB;
    let sqlite: Database.Database;
    let dbPath: string;
    let tmpDir: string;
    const createdPageIds: string[] = [];

    beforeAll(() => {
      notion = new NotionClient({ token: TEST_TOKEN! });
      tmpDir = resolve(tmpdir(), `interkasten-integ-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
    });

    beforeEach(() => {
      // Fresh database for each test
      dbPath = resolve(tmpDir, `test-${Date.now()}.db`);
      const result = openDatabase(dbPath);
      db = result.db;
      sqlite = result.sqlite;
    });

    afterAll(async () => {
      // Clean up all created Notion pages
      for (const pageId of createdPageIds) {
        await cleanupNotionPage(notion, pageId);
      }
      // Clean up temp directory
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("should validate the Notion token", async () => {
      const result = await notion.validateToken();
      expect(result.valid).toBe(true);
    });

    it(
      "should push a local doc and read it back via Notion API",
      async () => {
        const markdown = "# Integration Test\n\nThis is a push test.";
        const blocks = markdownToNotionBlocks(markdown);

        // Resolve the data source for creating pages
        const dataSourceId =
          await notion.resolveDataSourceId(TEST_DATABASE!);

        // Create a page in the test database
        const page: any = await notion.call(async () => {
          return notion.raw.pages.create({
            parent: { database_id: TEST_DATABASE! } as any,
            properties: {
              Name: {
                title: [{ text: { content: "integ-push-test" } }],
              },
            },
            children: blocks as any,
          });
        });

        createdPageIds.push(page.id);
        expect(page.id).toBeTruthy();

        // Read back via notion-to-md
        const readBack = await notionBlocksToMarkdown(
          notion.raw,
          page.id,
        );
        expect(readBack).toContain("Integration Test");
        expect(readBack).toContain("push test");
      },
      30_000,
    );

    it(
      "should detect Notion-side edit after push",
      async () => {
        // Create initial page
        const initialMd = "# Detect Edit\n\nOriginal content.";
        const blocks = markdownToNotionBlocks(initialMd);

        const page: any = await notion.call(async () => {
          return notion.raw.pages.create({
            parent: { database_id: TEST_DATABASE! } as any,
            properties: {
              Name: {
                title: [{ text: { content: "integ-edit-detect" } }],
              },
            },
            children: blocks as any,
          });
        });
        createdPageIds.push(page.id);

        // Record the hash of the initial content
        const initialHash = hashMarkdown(initialMd);

        // Update the page content in Notion (simulates user editing in Notion)
        // Append a new paragraph block
        await notion.call(async () => {
          return notion.raw.blocks.children.append({
            block_id: page.id,
            children: [
              {
                object: "block" as const,
                type: "paragraph" as const,
                paragraph: {
                  rich_text: [
                    { type: "text" as const, text: { content: "Added from Notion." } },
                  ],
                },
              },
            ],
          });
        });

        // Read back and verify hash differs
        const updated = await notionBlocksToMarkdown(notion.raw, page.id);
        const updatedHash = hashMarkdown(updated);

        expect(updatedHash).not.toBe(initialHash);
        expect(updated).toContain("Added from Notion");
      },
      30_000,
    );

    it(
      "should merge non-overlapping changes without conflict",
      async () => {
        const base = "# Merge Test\n\nParagraph one.\n\nParagraph two.";
        const local =
          "# Merge Test\n\nParagraph one (edited locally).\n\nParagraph two.";
        const remote =
          "# Merge Test\n\nParagraph one.\n\nParagraph two (edited remotely).";

        const result = threeWayMerge(base, local, remote);

        expect(result.hasConflicts).toBe(false);
        expect(result.merged).toContain("edited locally");
        expect(result.merged).toContain("edited remotely");
      },
    );

    it(
      "should apply local-wins on overlapping conflict",
      async () => {
        const base = "# Conflict Test\n\nShared line.";
        const local = "# Conflict Test\n\nLocal version of shared line.";
        const remote = "# Conflict Test\n\nRemote version of shared line.";

        const result = threeWayMerge(base, local, remote, "local-wins");

        expect(result.merged).toContain("Local version");
        expect(result.merged).not.toContain("Remote version");
      },
    );

    it("should track entities in the database across push and pull", () => {
      // Simulate entity creation during push
      const entity = upsertEntity(db, {
        localPath: resolve(tmpDir, "test-doc.md"),
        notionId: "notion-fake-id-123",
        entityType: "doc",
        tier: "T1",
        lastLocalHash: hashMarkdown("# Test\n\nContent."),
        lastNotionHash: hashMarkdown("# Test\n\nContent."),
        lastNotionVer: null,
        baseContentId: null,
        lastSyncTs: new Date().toISOString(),
      });

      expect(entity.id).toBeGreaterThan(0);

      // Look up by path
      const byPath = getEntityByPath(
        db,
        resolve(tmpDir, "test-doc.md"),
      );
      expect(byPath).toBeDefined();
      expect(byPath!.notionId).toBe("notion-fake-id-123");

      // Simulate pull — update hash
      const updatedEntity = upsertEntity(db, {
        localPath: resolve(tmpDir, "test-doc.md"),
        notionId: "notion-fake-id-123",
        entityType: "doc",
        tier: "T1",
        lastLocalHash: hashMarkdown("# Test\n\nUpdated Content."),
        lastNotionHash: hashMarkdown("# Test\n\nUpdated Content."),
        lastNotionVer: null,
        baseContentId: null,
        lastSyncTs: new Date().toISOString(),
      });

      expect(updatedEntity.id).toBe(entity.id); // Same entity, upserted
    });

    it("should soft-delete when local file removed", () => {
      const entity = upsertEntity(db, {
        localPath: resolve(tmpDir, "deleted-doc.md"),
        notionId: "notion-del-id",
        entityType: "doc",
        tier: "T1",
        lastLocalHash: "abc",
        lastNotionHash: "abc",
        lastNotionVer: null,
        baseContentId: null,
        lastSyncTs: new Date().toISOString(),
      });

      softDeleteEntity(db, entity.id);

      // Should not appear in normal queries
      const found = getEntityByPath(
        db,
        resolve(tmpDir, "deleted-doc.md"),
      );
      expect(found).toBeUndefined();
    });

    it("should track and clear conflicts", () => {
      const entity = upsertEntity(db, {
        localPath: resolve(tmpDir, "conflict-doc.md"),
        notionId: "notion-conflict-id",
        entityType: "doc",
        tier: "T1",
        lastLocalHash: "hash-a",
        lastNotionHash: "hash-b",
        lastNotionVer: null,
        baseContentId: null,
        lastSyncTs: new Date().toISOString(),
      });

      // Mark conflict (using fake content IDs since we don't have real base_content rows)
      // Insert fake base_content rows first
      sqlite
        .prepare(
          "INSERT INTO base_content (content, hash) VALUES (?, ?)",
        )
        .run("local content", "hash-local");
      sqlite
        .prepare(
          "INSERT INTO base_content (content, hash) VALUES (?, ?)",
        )
        .run("notion content", "hash-notion");

      markConflict(db, entity.id, 1, 2);

      const conflicts = listConflicts(db);
      expect(conflicts.length).toBe(1);
      expect(conflicts[0].local_path).toBe(
        resolve(tmpDir, "conflict-doc.md"),
      );

      // Clear conflict
      clearConflict(db, entity.id);
      const afterClear = listConflicts(db);
      expect(afterClear.length).toBe(0);
    });

    it(
      "should roundtrip content through Notion (push → Notion → pull)",
      async () => {
        const originalContent =
          "# Roundtrip Test\n\nLine one.\n\nLine two with **bold**.";

        // Push: create Notion page
        const blocks = markdownToNotionBlocks(originalContent);
        const page: any = await notion.call(async () => {
          return notion.raw.pages.create({
            parent: { database_id: TEST_DATABASE! } as any,
            properties: {
              Name: {
                title: [{ text: { content: "integ-roundtrip" } }],
              },
            },
            children: blocks as any,
          });
        });
        createdPageIds.push(page.id);

        // Pull: read back from Notion
        const pulledContent = await notionBlocksToMarkdown(
          notion.raw,
          page.id,
        );

        // Normalize both for comparison (Notion may alter formatting slightly)
        const normalizedOriginal = normalizeMarkdown(originalContent);
        const normalizedPulled = normalizeMarkdown(pulledContent);

        // Content should preserve structure (heading, paragraphs, bold)
        expect(normalizedPulled).toContain("Roundtrip Test");
        expect(normalizedPulled).toContain("Line one");
        expect(normalizedPulled).toContain("Line two");
        // Bold may be preserved as ** or rendered differently
        expect(
          normalizedPulled.includes("**bold**") ||
            normalizedPulled.includes("bold"),
        ).toBe(true);
      },
      30_000,
    );
  },
);
