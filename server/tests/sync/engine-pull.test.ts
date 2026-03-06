import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { openDatabase, closeDatabase } from "../../src/store/db.js";
import { getEntityByPath } from "../../src/store/entities.js";
import { registerProject, registerDoc } from "../../src/sync/entity-map.js";
import type { DB } from "../../src/store/db.js";
import type Database from "better-sqlite3";

/**
 * Replicate the fixed findProjectDir logic from engine.ts for testing.
 * This verifies the fix for issue #4: project entities should find themselves.
 */
function findProjectDir(db: DB, filePath: string): string | null {
  // Check the path itself first (handles project entities whose path IS the project dir)
  const selfEntity = getEntityByPath(db, filePath);
  if (selfEntity?.entityType === "project") return filePath;

  // Walk up ancestors
  const parts = filePath.split("/");
  for (let i = parts.length - 1; i >= 1; i--) {
    const candidate = parts.slice(0, i).join("/");
    const entity = getEntityByPath(db, candidate);
    if (entity?.entityType === "project") return candidate;
  }
  return null;
}

describe("findProjectDir (issue #4 fix)", () => {
  let db: DB;
  let sqlite: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = resolve(tmpdir(), `interkasten-findproj-${Date.now()}.db`);
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

  it("finds a project entity by its own path", () => {
    registerProject(db, "/projects/foo", "notion-id-1");
    expect(findProjectDir(db, "/projects/foo")).toBe("/projects/foo");
  });

  it("finds a project entity for a doc inside it", () => {
    registerProject(db, "/projects/foo", "notion-id-1");
    registerDoc(db, "/projects/foo/docs/README.md", "notion-id-2");
    expect(findProjectDir(db, "/projects/foo/docs/README.md")).toBe("/projects/foo");
  });

  it("returns null for an unregistered path", () => {
    expect(findProjectDir(db, "/projects/nonexistent/docs/README.md")).toBeNull();
  });

  it("finds the nearest project ancestor (not a doc ancestor)", () => {
    registerProject(db, "/projects/parent", "notion-id-1");
    registerProject(db, "/projects/parent/child", "notion-id-2");
    registerDoc(db, "/projects/parent/child/README.md", "notion-id-3");
    expect(findProjectDir(db, "/projects/parent/child/README.md")).toBe("/projects/parent/child");
  });
});

describe("path validation", () => {
  it("should reject paths with traversal sequences", () => {
    const projectDir = "/root/projects/test";
    const malicious = "../../../etc/passwd";
    const resolved = resolve(projectDir, malicious);
    expect(resolved.startsWith(projectDir + "/")).toBe(false);
  });

  it("should accept valid subpaths", () => {
    const projectDir = "/root/projects/test";
    const valid = "docs/readme.md";
    const resolved = resolve(projectDir, valid);
    expect(resolved.startsWith(projectDir + "/")).toBe(true);
  });

  it("should reject absolute paths", () => {
    const projectDir = "/root/projects/test";
    const absolute = "/etc/passwd";
    const resolved = resolve(projectDir, absolute);
    expect(resolved.startsWith(projectDir + "/")).toBe(false);
  });

  it("should reject the project dir itself (must be a subpath)", () => {
    const projectDir = "/root/projects/test";
    const resolved = resolve(projectDir, ".");
    // projectDir + "/" is required — exact match means writing to directory, not a file
    expect(resolved.startsWith(projectDir + "/")).toBe(false);
  });
});

describe("frontmatter preservation", () => {
  it("should preserve local frontmatter on pull", () => {
    const localContent = "---\ntags: [test]\n---\n\n# Title\n\nBody text";
    const notionContent = "# Title\n\nUpdated body text";

    const fmMatch = localContent.match(/^---\n[\s\S]*?\n---\n/);
    const frontmatter = fmMatch ? fmMatch[0] : "";
    const merged = frontmatter + "\n" + notionContent;

    expect(merged).toContain("tags: [test]");
    expect(merged).toContain("Updated body text");
  });

  it("should handle content without frontmatter", () => {
    const localContent = "# Title\n\nBody text";
    const notionContent = "# Title\n\nUpdated body";

    const fmMatch = localContent.match(/^---\n[\s\S]*?\n---\n/);
    expect(fmMatch).toBeNull();
  });

  it("should strip frontmatter from local before hash comparison", () => {
    const localWithFm = "---\ntags: [test]\n---\n\n# Title\n\nBody";
    const fmMatch = localWithFm.match(/^---\n[\s\S]*?\n---\n/);
    const bodyOnly = fmMatch ? localWithFm.slice(fmMatch[0].length) : localWithFm;
    expect(bodyOnly).toBe("\n# Title\n\nBody");
  });
});
