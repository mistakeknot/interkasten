import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { openDatabase, closeDatabase } from "../../src/store/db.js";
import {
  upsertEntity,
  getEntityByPath,
  getEntityByNotionId,
  listEntities,
  softDeleteEntity,
  gcDeletedEntities,
  upsertBaseContent,
  getBaseContent,
  gcOrphanedBaseContent,
  hashContent,
  updateEntityAfterSync,
  markConflict,
  clearConflict,
  listConflicts,
} from "../../src/store/entities.js";
import type { DB } from "../../src/store/db.js";
import type Database from "better-sqlite3";

describe("Entity Store", () => {
  let db: DB;
  let sqlite: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = resolve(tmpdir(), `interkasten-test-${Date.now()}.db`);
    const result = openDatabase(dbPath);
    db = result.db;
    sqlite = result.sqlite;
  });

  afterEach(() => {
    closeDatabase(sqlite);
    for (const ext of ["", "-wal", "-shm", "-journal"]) {
      if (existsSync(dbPath + ext)) rmSync(dbPath + ext);
    }
  });

  it("inserts and retrieves an entity", () => {
    const entity = upsertEntity(db, {
      localPath: "/projects/test/README.md",
      notionId: "abc-123",
      entityType: "doc",
      tier: "T1",
      lastLocalHash: "hash1",
      lastNotionHash: "hash2",
      lastNotionVer: null,
      baseContentId: null,
      lastSyncTs: new Date().toISOString(),
    });

    expect(entity.id).toBeTruthy();
    expect(entity.localPath).toBe("/projects/test/README.md");

    const found = getEntityByPath(db, "/projects/test/README.md");
    expect(found).toBeTruthy();
    expect(found!.notionId).toBe("abc-123");
  });

  it("updates on upsert when path exists", () => {
    upsertEntity(db, {
      localPath: "/projects/test/README.md",
      notionId: "abc-123",
      entityType: "doc",
      tier: "T1",
      lastLocalHash: "old",
      lastNotionHash: null,
      lastNotionVer: null,
      baseContentId: null,
      lastSyncTs: "2024-01-01T00:00:00Z",
    });

    const updated = upsertEntity(db, {
      localPath: "/projects/test/README.md",
      notionId: "abc-123",
      entityType: "doc",
      tier: "T1",
      lastLocalHash: "new",
      lastNotionHash: null,
      lastNotionVer: null,
      baseContentId: null,
      lastSyncTs: "2024-01-02T00:00:00Z",
    });

    expect(updated.lastLocalHash).toBe("new");

    const all = listEntities(db);
    expect(all.length).toBe(1);
  });

  it("soft deletes and GCs entities", () => {
    const entity = upsertEntity(db, {
      localPath: "/projects/test/README.md",
      notionId: "abc-123",
      entityType: "doc",
      tier: "T1",
      lastLocalHash: null,
      lastNotionHash: null,
      lastNotionVer: null,
      baseContentId: null,
      lastSyncTs: new Date().toISOString(),
    });

    softDeleteEntity(db, entity.id);

    // Should not appear in normal queries
    const found = getEntityByPath(db, "/projects/test/README.md");
    expect(found).toBeUndefined();

    // GC with future date
    const gcCount = gcDeletedEntities(db, new Date(Date.now() + 100000).toISOString());
    expect(gcCount).toBe(1);
  });

  it("filters by entity type", () => {
    upsertEntity(db, {
      localPath: "/projects/test",
      notionId: "proj-1",
      entityType: "project",
      tier: null,
      lastLocalHash: null,
      lastNotionHash: null,
      lastNotionVer: null,
      baseContentId: null,
      lastSyncTs: new Date().toISOString(),
    });

    upsertEntity(db, {
      localPath: "/projects/test/doc.md",
      notionId: "doc-1",
      entityType: "doc",
      tier: "T1",
      lastLocalHash: null,
      lastNotionHash: null,
      lastNotionVer: null,
      baseContentId: null,
      lastSyncTs: new Date().toISOString(),
    });

    expect(listEntities(db, "project").length).toBe(1);
    expect(listEntities(db, "doc").length).toBe(1);
    expect(listEntities(db).length).toBe(2);
  });

  it("deduplicates base content by hash", () => {
    const content = "# Hello World\n\nSome content.";
    const bc1 = upsertBaseContent(db, content);
    const bc2 = upsertBaseContent(db, content);

    expect(bc1.id).toBe(bc2.id);
    expect(bc1.contentHash).toBe(hashContent(content));
  });

  it("GCs orphaned base content", () => {
    const bc = upsertBaseContent(db, "orphaned content");
    expect(getBaseContent(db, bc.id)).toBeTruthy();

    const gcCount = gcOrphanedBaseContent(db);
    expect(gcCount).toBe(1);
    expect(getBaseContent(db, bc.id)).toBeUndefined();
  });

  describe("conflict tracking", () => {
    it("should have conflict columns after migration", () => {
      const info = sqlite.prepare("PRAGMA table_info(entity_map)").all() as { name: string }[];
      const columns = info.map((c) => c.name);
      expect(columns).toContain("conflict_detected_at");
      expect(columns).toContain("conflict_local_content_id");
      expect(columns).toContain("conflict_notion_content_id");
    });
  });

  describe("beads snapshot table", () => {
    it("should have beads_snapshot table after migration", () => {
      const tables = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='beads_snapshot'")
        .all() as { name: string }[];
      expect(tables).toHaveLength(1);
    });
  });

  describe("conflict operations", () => {
    it("should mark an entity as conflicted", () => {
      const entity = upsertEntity(db, {
        localPath: "/test/file.md",
        notionId: "notion-abc",
        entityType: "doc",
        tier: "T1",
        lastLocalHash: null,
        lastNotionHash: null,
        lastNotionVer: null,
        baseContentId: null,
        lastSyncTs: new Date().toISOString(),
      });
      const localContentId = upsertBaseContent(db, "local version").id;
      const notionContentId = upsertBaseContent(db, "notion version").id;

      markConflict(db, entity.id, localContentId, notionContentId);

      const found = getEntityByPath(db, "/test/file.md")!;
      expect(found.conflictDetectedAt).toBeTruthy();
      expect(found.conflictLocalContentId).toBe(localContentId);
      expect(found.conflictNotionContentId).toBe(notionContentId);
    });

    it("should clear conflict state", () => {
      const entity = upsertEntity(db, {
        localPath: "/test/file.md",
        notionId: "notion-abc",
        entityType: "doc",
        tier: "T1",
        lastLocalHash: null,
        lastNotionHash: null,
        lastNotionVer: null,
        baseContentId: null,
        lastSyncTs: new Date().toISOString(),
      });
      const localId = upsertBaseContent(db, "local").id;
      const notionId = upsertBaseContent(db, "notion").id;
      markConflict(db, entity.id, localId, notionId);

      clearConflict(db, entity.id);

      const found = getEntityByPath(db, "/test/file.md")!;
      expect(found.conflictDetectedAt).toBeNull();
      expect(found.conflictLocalContentId).toBeNull();
      expect(found.conflictNotionContentId).toBeNull();
    });

    it("should list conflicted entities", () => {
      const e1 = upsertEntity(db, {
        localPath: "/a.md",
        notionId: "notion-a",
        entityType: "doc",
        tier: "T1",
        lastLocalHash: null,
        lastNotionHash: null,
        lastNotionVer: null,
        baseContentId: null,
        lastSyncTs: new Date().toISOString(),
      });
      upsertEntity(db, {
        localPath: "/b.md",
        notionId: "notion-b",
        entityType: "doc",
        tier: "T1",
        lastLocalHash: null,
        lastNotionHash: null,
        lastNotionVer: null,
        baseContentId: null,
        lastSyncTs: new Date().toISOString(),
      });
      const contentId = upsertBaseContent(db, "content").id;
      markConflict(db, e1.id, contentId, contentId);

      const conflicts = listConflicts(db);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].id).toBe(e1.id);
    });
  });

  it("updates entity after sync", () => {
    const entity = upsertEntity(db, {
      localPath: "/projects/test/doc.md",
      notionId: "page-1",
      entityType: "doc",
      tier: "T1",
      lastLocalHash: "old",
      lastNotionHash: null,
      lastNotionVer: null,
      baseContentId: null,
      lastSyncTs: "2024-01-01T00:00:00Z",
    });

    updateEntityAfterSync(db, entity.id, {
      lastLocalHash: "new-hash",
      lastNotionHash: "notion-hash",
      lastSyncTs: "2024-01-02T00:00:00Z",
    });

    const updated = getEntityByPath(db, "/projects/test/doc.md")!;
    expect(updated.lastLocalHash).toBe("new-hash");
    expect(updated.lastNotionHash).toBe("notion-hash");
    expect(updated.lastSyncTs).toBe("2024-01-02T00:00:00Z");
  });
});
