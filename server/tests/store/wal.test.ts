import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { openDatabase, closeDatabase } from "../../src/store/db.js";
import { upsertEntity } from "../../src/store/entities.js";
import {
  walCreatePending,
  walMarkTargetWritten,
  walMarkCommitted,
  walMarkRolledBack,
  walDelete,
  walQueryIncomplete,
  walPendingCount,
} from "../../src/store/wal.js";
import type { DB } from "../../src/store/db.js";
import type Database from "better-sqlite3";

describe("WAL Operations", () => {
  let db: DB;
  let sqlite: Database.Database;
  let dbPath: string;
  let entityId: number;

  beforeEach(() => {
    dbPath = resolve(tmpdir(), `interkasten-wal-test-${Date.now()}.db`);
    const result = openDatabase(dbPath);
    db = result.db;
    sqlite = result.sqlite;

    // Create a test entity
    const entity = upsertEntity(db, {
      localPath: "/projects/test/doc.md",
      notionId: "page-1",
      entityType: "doc",
      tier: "T1",
      lastLocalHash: null,
      lastNotionHash: null,
      lastNotionVer: null,
      baseContentId: null,
      lastSyncTs: new Date().toISOString(),
    });
    entityId = entity.id;
  });

  afterEach(() => {
    closeDatabase(sqlite);
    for (const ext of ["", "-wal", "-shm", "-journal"]) {
      if (existsSync(dbPath + ext)) rmSync(dbPath + ext);
    }
  });

  it("creates pending WAL entry", () => {
    const wal = walCreatePending(db, {
      entityMapId: entityId,
      operation: "push",
      newContent: "# Test",
    });

    expect(wal.state).toBe("pending");
    expect(wal.operation).toBe("push");
    expect(wal.entityMapId).toBe(entityId);
  });

  it("transitions through WAL states", () => {
    const wal = walCreatePending(db, {
      entityMapId: entityId,
      operation: "push",
    });

    expect(walPendingCount(db)).toBe(1);

    walMarkTargetWritten(db, wal.id);
    const incomplete = walQueryIncomplete(db);
    expect(incomplete[0]!.state).toBe("target_written");

    walMarkCommitted(db, wal.id);
    expect(walPendingCount(db)).toBe(0);
  });

  it("rolls back WAL entry", () => {
    const wal = walCreatePending(db, {
      entityMapId: entityId,
      operation: "push",
    });

    walMarkRolledBack(db, wal.id);
    expect(walPendingCount(db)).toBe(0);
  });

  it("deletes committed WAL entries", () => {
    const wal = walCreatePending(db, {
      entityMapId: entityId,
      operation: "push",
    });

    walMarkCommitted(db, wal.id);
    walDelete(db, wal.id);

    expect(walQueryIncomplete(db).length).toBe(0);
  });

  it("finds incomplete entries for crash recovery", () => {
    // Create entries in different states
    const pending = walCreatePending(db, {
      entityMapId: entityId,
      operation: "push",
    });

    const entity2 = upsertEntity(db, {
      localPath: "/projects/test/doc2.md",
      notionId: "page-2",
      entityType: "doc",
      tier: "T1",
      lastLocalHash: null,
      lastNotionHash: null,
      lastNotionVer: null,
      baseContentId: null,
      lastSyncTs: new Date().toISOString(),
    });

    const targetWritten = walCreatePending(db, {
      entityMapId: entity2.id,
      operation: "push",
    });
    walMarkTargetWritten(db, targetWritten.id);

    const entity3 = upsertEntity(db, {
      localPath: "/projects/test/doc3.md",
      notionId: "page-3",
      entityType: "doc",
      tier: "T1",
      lastLocalHash: null,
      lastNotionHash: null,
      lastNotionVer: null,
      baseContentId: null,
      lastSyncTs: new Date().toISOString(),
    });

    const committed = walCreatePending(db, {
      entityMapId: entity3.id,
      operation: "push",
    });
    walMarkCommitted(db, committed.id);

    const incomplete = walQueryIncomplete(db);
    expect(incomplete.length).toBe(2); // pending + target_written
    expect(incomplete.map((w) => w.state).sort()).toEqual(["pending", "target_written"]);
  });
});
