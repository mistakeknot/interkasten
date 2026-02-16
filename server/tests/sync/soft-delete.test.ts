import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { openDatabase, closeDatabase } from "../../src/store/db.js";
import {
  upsertEntity,
  getEntityByPath,
  softDeleteEntity,
  gcDeletedEntities,
} from "../../src/store/entities.js";
import type { DB } from "../../src/store/db.js";
import type Database from "better-sqlite3";

describe("soft delete", () => {
  let db: DB;
  let sqlite: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = resolve(tmpdir(), `interkasten-softdel-${Date.now()}.db`);
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

  it("should soft-delete entity when local file removed", () => {
    const entity = upsertEntity(db, {
      localPath: "/test/doc.md",
      notionId: "notion-123",
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
    const found = getEntityByPath(db, "/test/doc.md");
    expect(found).toBeUndefined();
  });

  it("should gc entities deleted more than 30 days ago", () => {
    const entity = upsertEntity(db, {
      localPath: "/test/old.md",
      notionId: "notion-old",
      entityType: "doc",
      tier: "T1",
      lastLocalHash: null,
      lastNotionHash: null,
      lastNotionVer: null,
      baseContentId: null,
      lastSyncTs: new Date().toISOString(),
    });

    softDeleteEntity(db, entity.id);

    // Manually backdate the deletedAt to 31 days ago
    sqlite.prepare("UPDATE entity_map SET deleted_at = datetime('now', '-31 days') WHERE id = ?").run(entity.id);

    const gcCount = gcDeletedEntities(db, new Date().toISOString());
    expect(gcCount).toBe(1);
  });

  it("should not gc entities deleted less than 30 days ago", () => {
    const entity = upsertEntity(db, {
      localPath: "/test/recent.md",
      notionId: "notion-recent",
      entityType: "doc",
      tier: "T1",
      lastLocalHash: null,
      lastNotionHash: null,
      lastNotionVer: null,
      baseContentId: null,
      lastSyncTs: new Date().toISOString(),
    });

    softDeleteEntity(db, entity.id);

    // GC with a cutoff of 30 days from now — entity was just deleted, should survive
    const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const gcCount = gcDeletedEntities(db, cutoff30d);
    expect(gcCount).toBe(0);
  });
});
