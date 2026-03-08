import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, closeDatabase } from "../../src/store/db.js";
import {
  upsertPageTracking,
  getPageTracking,
  listTrackedPages,
  removePageTracking,
} from "../../src/store/pages.js";
import { resolve } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

describe("Page Tracking Store", () => {
  let db: ReturnType<typeof openDatabase>["db"];
  let sqlite: ReturnType<typeof openDatabase>["sqlite"];
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), "ik-pages-test-"));
    const result = openDatabase(resolve(tmpDir, "test.db"));
    db = result.db;
    sqlite = result.sqlite;
  });

  afterEach(() => {
    closeDatabase(sqlite);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("upsert creates a new page tracking entry", () => {
    const row = upsertPageTracking(db, {
      notionPageId: "page-123",
      title: "My Page",
      outputDir: "/tmp/pages/my-page",
    });

    expect(row.notionPageId).toBe("page-123");
    expect(row.title).toBe("My Page");
    expect(row.outputDir).toBe("/tmp/pages/my-page");
    expect(row.tokenAlias).toBeNull();
    expect(row.recursive).toBe(true);
    expect(row.maxDepth).toBe(3);
  });

  test("upsert updates existing entry", () => {
    upsertPageTracking(db, {
      notionPageId: "page-123",
      title: "My Page",
      outputDir: "/tmp/pages/my-page",
    });

    const updated = upsertPageTracking(db, {
      notionPageId: "page-123",
      title: "Renamed Page",
      outputDir: "/tmp/pages/my-page",
      tokenAlias: "work",
    });

    expect(updated.title).toBe("Renamed Page");
    expect(updated.tokenAlias).toBe("work");
  });

  test("upsert preserves existing tokenAlias when not provided", () => {
    upsertPageTracking(db, {
      notionPageId: "page-123",
      title: "My Page",
      outputDir: "/tmp/pages/my-page",
      tokenAlias: "work",
    });

    const updated = upsertPageTracking(db, {
      notionPageId: "page-123",
      title: "Renamed",
      outputDir: "/tmp/pages/my-page",
    });

    expect(updated.tokenAlias).toBe("work");
  });

  test("get returns undefined for nonexistent page", () => {
    expect(getPageTracking(db, "nonexistent")).toBeUndefined();
  });

  test("get returns tracked page", () => {
    upsertPageTracking(db, {
      notionPageId: "page-123",
      title: "My Page",
      outputDir: "/tmp/pages/my-page",
    });

    const row = getPageTracking(db, "page-123");
    expect(row).toBeDefined();
    expect(row!.title).toBe("My Page");
  });

  test("list returns all tracked pages", () => {
    upsertPageTracking(db, {
      notionPageId: "page-1",
      title: "Page One",
      outputDir: "/tmp/pages/one",
    });
    upsertPageTracking(db, {
      notionPageId: "page-2",
      title: "Page Two",
      outputDir: "/tmp/pages/two",
      tokenAlias: "other",
    });

    const pages = listTrackedPages(db);
    expect(pages).toHaveLength(2);
    expect(pages.map(p => p.title).sort()).toEqual(["Page One", "Page Two"]);
  });

  test("remove deletes tracking entry", () => {
    upsertPageTracking(db, {
      notionPageId: "page-123",
      title: "My Page",
      outputDir: "/tmp/pages/my-page",
    });

    removePageTracking(db, "page-123");
    expect(getPageTracking(db, "page-123")).toBeUndefined();
    expect(listTrackedPages(db)).toHaveLength(0);
  });

  test("stores recursive and maxDepth settings", () => {
    const row = upsertPageTracking(db, {
      notionPageId: "page-123",
      title: "Shallow Page",
      outputDir: "/tmp/pages/shallow",
      recursive: false,
      maxDepth: 1,
    });

    expect(row.recursive).toBe(false);
    expect(row.maxDepth).toBe(1);
  });
});
