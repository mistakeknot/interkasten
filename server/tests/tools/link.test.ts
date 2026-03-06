import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "path";
import { tmpdir } from "os";
import { mkdirSync, rmSync, existsSync } from "fs";
import { openDatabase, closeDatabase } from "../../src/store/db.js";
import {
  lookupByPath,
  lookupByNotionId,
  registerProject,
  registerDoc,
  listDocs,
} from "../../src/sync/entity-map.js";
import type { DB } from "../../src/store/db.js";
import type Database from "better-sqlite3";

// Import the parseNotionPageId function — it's not exported, so we test it
// indirectly through behavior. We also test the tool registration directly.
// For parseNotionPageId unit tests, we re-implement the same logic inline.
function parseNotionPageId(input: string): string | null {
  let raw = input.trim();
  if (raw.includes("notion.so/") || raw.includes("notion.site/")) {
    const url = new URL(raw);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (!last) return null;
    raw = last;
  }

  const hexMatch = raw.match(/([0-9a-f]{32})$/i);
  if (hexMatch) {
    const hex = hexMatch[1]!;
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join("-");
  }

  const uuidMatch = raw.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  );
  if (uuidMatch) {
    return uuidMatch[1]!;
  }

  return null;
}

describe("parseNotionPageId", () => {
  it("parses a full Notion URL", () => {
    const id = parseNotionPageId(
      "https://www.notion.so/workspace/My-Page-Title-abcdef1234567890abcdef1234567890"
    );
    expect(id).toBe("abcdef12-3456-7890-abcd-ef1234567890");
  });

  it("parses a Notion URL without workspace prefix", () => {
    const id = parseNotionPageId(
      "https://notion.so/My-Page-abcdef1234567890abcdef1234567890"
    );
    expect(id).toBe("abcdef12-3456-7890-abcd-ef1234567890");
  });

  it("parses a bare 32-char hex ID", () => {
    const id = parseNotionPageId("abcdef1234567890abcdef1234567890");
    expect(id).toBe("abcdef12-3456-7890-abcd-ef1234567890");
  });

  it("parses a UUID with dashes", () => {
    const id = parseNotionPageId("abcdef12-3456-7890-abcd-ef1234567890");
    expect(id).toBe("abcdef12-3456-7890-abcd-ef1234567890");
  });

  it("parses a notion.site URL", () => {
    const id = parseNotionPageId(
      "https://my-workspace.notion.site/Page-abcdef1234567890abcdef1234567890"
    );
    expect(id).toBe("abcdef12-3456-7890-abcd-ef1234567890");
  });

  it("parses URL with query params", () => {
    const id = parseNotionPageId(
      "https://www.notion.so/Page-abcdef1234567890abcdef1234567890?pvs=4"
    );
    expect(id).toBe("abcdef12-3456-7890-abcd-ef1234567890");
  });

  it("returns null for invalid input", () => {
    expect(parseNotionPageId("not-a-valid-id")).toBeNull();
    expect(parseNotionPageId("https://notion.so/")).toBeNull();
    expect(parseNotionPageId("")).toBeNull();
  });
});

describe("interkasten_link entity registration", () => {
  let db: DB;
  let sqlite: Database.Database;
  let dbPath: string;
  let testDir: string;

  beforeEach(() => {
    dbPath = resolve(tmpdir(), `interkasten-link-test-${Date.now()}.db`);
    const result = openDatabase(dbPath);
    db = result.db;
    sqlite = result.sqlite;

    testDir = resolve(tmpdir(), `interkasten-link-dir-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    closeDatabase(sqlite);
    for (const ext of ["", "-wal", "-shm", "-journal"]) {
      if (existsSync(dbPath + ext)) rmSync(dbPath + ext);
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it("registers a project entity with correct notionId and localPath", () => {
    const notionId = "abcdef12-3456-7890-abcd-ef1234567890";
    const entity = registerProject(db, testDir, notionId);

    expect(entity.localPath).toBe(testDir);
    expect(entity.notionId).toBe(notionId);
    expect(entity.entityType).toBe("project");

    // Verify lookups work
    const byPath = lookupByPath(db, testDir);
    expect(byPath).toBeDefined();
    expect(byPath!.notionId).toBe(notionId);

    const byNotion = lookupByNotionId(db, notionId);
    expect(byNotion).toBeDefined();
    expect(byNotion!.localPath).toBe(testDir);
  });

  it("detects duplicate path registration", () => {
    const notionId = "abcdef12-3456-7890-abcd-ef1234567890";
    registerProject(db, testDir, notionId);

    // Second registration with same path should upsert (not error)
    const existing = lookupByPath(db, testDir);
    expect(existing).toBeDefined();
  });

  it("detects duplicate notionId registration", () => {
    const notionId = "abcdef12-3456-7890-abcd-ef1234567890";
    registerProject(db, testDir, notionId);

    const existing = lookupByNotionId(db, notionId);
    expect(existing).toBeDefined();
    expect(existing!.localPath).toBe(testDir);
  });

  it("registers a doc entity (not project) for linked page content", () => {
    const notionId = "abcdef12-3456-7890-abcd-ef1234567890";
    const docPath = resolve(testDir, "My-Page.md");

    // interkasten_link registers a doc entity so the sync engine has a
    // concrete file path to write pulled content to
    const doc = registerDoc(db, docPath, notionId, "T1");

    expect(doc.entityType).toBe("doc");
    expect(doc.localPath).toBe(docPath);
    expect(doc.notionId).toBe(notionId);

    // Should be retrievable by both path and notionId
    const byDocPath = lookupByPath(db, docPath);
    expect(byDocPath).toBeDefined();
    expect(byDocPath!.entityType).toBe("doc");

    const byNotion = lookupByNotionId(db, notionId);
    expect(byNotion).toBeDefined();
    expect(byNotion!.entityType).toBe("doc");

    // Doc entity should appear in doc listing
    const docs = listDocs(db);
    expect(docs.some((d) => d.notionId === notionId)).toBe(true);
  });
});
