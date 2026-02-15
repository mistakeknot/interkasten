import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync, mkdirSync } from "fs";
import { openDatabase, closeDatabase, type DB } from "../../src/store/db.js";
import {
  registerProject,
  getProjectChildren,
  getProjectParent,
  getProjectAncestors,
  setProjectParent,
  setProjectTags,
  getProjectTags,
  getDocsForProject,
  listTopLevelProjects,
  listProjects,
  registerDoc,
} from "../../src/sync/entity-map.js";
import type Database from "better-sqlite3";

describe("Project Hierarchy", () => {
  let db: DB;
  let sqlite: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = resolve(tmpdir(), `interkasten-hierarchy-${Date.now()}.db`);
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

  it("registers a project with parent", () => {
    const parent = registerProject(db, "/projects/Interverse", "notion-parent");
    const child = registerProject(db, "/projects/Interverse/hub/clavain", "notion-child", parent.id);

    expect(child.parentId).toBe(parent.id);
  });

  it("registers a project with tags", () => {
    const project = registerProject(
      db,
      "/projects/Interverse/hub/clavain",
      "notion-123",
      null,
      ["claude-plugin", "mcp-server"]
    );

    expect(project.tags).toBe('["claude-plugin","mcp-server"]');
  });

  it("gets direct children of a project", () => {
    const parent = registerProject(db, "/projects/Interverse", "notion-parent");
    registerProject(db, "/projects/Interverse/hub/clavain", "notion-c1", parent.id);
    registerProject(db, "/projects/Interverse/plugins/interflux", "notion-c2", parent.id);
    registerProject(db, "/projects/standalone", "notion-standalone");

    const children = getProjectChildren(db, parent.id);
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.localPath).sort()).toEqual([
      "/projects/Interverse/hub/clavain",
      "/projects/Interverse/plugins/interflux",
    ]);
  });

  it("gets parent of a project", () => {
    const parent = registerProject(db, "/projects/Interverse", "notion-parent");
    const child = registerProject(db, "/projects/Interverse/hub/clavain", "notion-child", parent.id);

    const foundParent = getProjectParent(db, child.id);
    expect(foundParent).not.toBeNull();
    expect(foundParent!.localPath).toBe("/projects/Interverse");
  });

  it("returns null for top-level project parent", () => {
    const toplevel = registerProject(db, "/projects/standalone", "notion-tl");
    expect(getProjectParent(db, toplevel.id)).toBeNull();
  });

  it("gets ancestor chain", () => {
    const root = registerProject(db, "/projects/Interverse", "notion-root");
    const mid = registerProject(db, "/projects/Interverse/plugins", "notion-mid", root.id);
    const leaf = registerProject(db, "/projects/Interverse/plugins/interflux", "notion-leaf", mid.id);

    const ancestors = getProjectAncestors(db, leaf.id);
    expect(ancestors).toHaveLength(2);
    expect(ancestors[0]!.localPath).toBe("/projects/Interverse/plugins");
    expect(ancestors[1]!.localPath).toBe("/projects/Interverse");
  });

  it("reparents a project", () => {
    const parentA = registerProject(db, "/projects/A", "notion-a");
    const parentB = registerProject(db, "/projects/B", "notion-b");
    const child = registerProject(db, "/projects/A/child", "notion-child", parentA.id);

    expect(getProjectParent(db, child.id)!.localPath).toBe("/projects/A");

    setProjectParent(db, child.id, parentB.id);
    expect(getProjectParent(db, child.id)!.localPath).toBe("/projects/B");

    setProjectParent(db, child.id, null);
    expect(getProjectParent(db, child.id)).toBeNull();
  });

  it("sets and gets tags", () => {
    const project = registerProject(db, "/projects/test", "notion-test");

    setProjectTags(db, project.id, ["web-app", "typescript"]);
    expect(getProjectTags(db, project.id)).toEqual(["web-app", "typescript"]);

    setProjectTags(db, project.id, ["go-service"]);
    expect(getProjectTags(db, project.id)).toEqual(["go-service"]);

    setProjectTags(db, project.id, []);
    expect(getProjectTags(db, project.id)).toEqual([]);
  });

  it("gets docs for a project without including subproject docs", () => {
    const parent = registerProject(db, "/projects/Interverse", "notion-parent");
    const child = registerProject(db, "/projects/Interverse/hub/clavain", "notion-child", parent.id);

    // Doc belonging to parent project — set parent_id via raw SQL since registerDoc doesn't support it yet
    registerDoc(db, "/projects/Interverse/README.md", "notion-doc1");
    sqlite.prepare("UPDATE entity_map SET parent_id = ? WHERE local_path = ?").run(
      parent.id,
      "/projects/Interverse/README.md"
    );

    // Doc belonging to child project
    registerDoc(db, "/projects/Interverse/hub/clavain/CLAUDE.md", "notion-doc2");
    sqlite.prepare("UPDATE entity_map SET parent_id = ? WHERE local_path = ?").run(
      child.id,
      "/projects/Interverse/hub/clavain/CLAUDE.md"
    );

    const parentDocs = getDocsForProject(db, parent.id);
    expect(parentDocs).toHaveLength(1);
    expect(parentDocs[0]!.localPath).toBe("/projects/Interverse/README.md");

    const childDocs = getDocsForProject(db, child.id);
    expect(childDocs).toHaveLength(1);
    expect(childDocs[0]!.localPath).toBe("/projects/Interverse/hub/clavain/CLAUDE.md");
  });

  it("lists top-level projects only", () => {
    const parent = registerProject(db, "/projects/Interverse", "notion-parent");
    registerProject(db, "/projects/Interverse/hub/clavain", "notion-child", parent.id);
    registerProject(db, "/projects/standalone", "notion-standalone");

    const topLevel = listTopLevelProjects(db);
    expect(topLevel).toHaveLength(2);
    expect(topLevel.map((p) => p.localPath).sort()).toEqual([
      "/projects/Interverse",
      "/projects/standalone",
    ]);
  });
});

describe("Project Discovery (scanner)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `interkasten-discovery-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Helper to create a fake project directory with markers
  function makeProject(path: string, markers: string[]): void {
    const fullPath = join(tempDir, path);
    mkdirSync(fullPath, { recursive: true });
    for (const marker of markers) {
      mkdirSync(join(fullPath, marker), { recursive: true });
    }
  }

  // Dynamic import to get the discovery function
  async function discover(maxDepth = 5) {
    const { discoverProjects } = await import("../../src/daemon/tools/init.js");
    return discoverProjects(
      tempDir,
      [".git", ".beads"],
      ["node_modules"],
      maxDepth,
      ".beads",
      true
    );
  }

  it("discovers flat projects", async () => {
    makeProject("projectA", [".git"]);
    makeProject("projectB", [".git", ".beads"]);

    const tree = await discover();
    expect(tree).toHaveLength(2);
    expect(tree.map((p) => p.path).sort()).toEqual([
      join(tempDir, "projectA"),
      join(tempDir, "projectB"),
    ]);
  });

  it("discovers hierarchical projects via .beads", async () => {
    makeProject("monorepo", [".beads"]);
    makeProject("monorepo/child1", [".git", ".beads"]);
    makeProject("monorepo/child2", [".git"]);

    const tree = await discover();
    expect(tree).toHaveLength(1);

    const mono = tree[0]!;
    expect(mono.path).toBe(join(tempDir, "monorepo"));
    expect(mono.children).toHaveLength(2);
    expect(mono.children.map((c) => c.path).sort()).toEqual([
      join(tempDir, "monorepo/child1"),
      join(tempDir, "monorepo/child2"),
    ]);
  });

  it("handles transparent intermediate directories", async () => {
    // Interverse layout: monorepo/hub/clavain, monorepo/plugins/interflux
    makeProject("monorepo", [".beads"]);
    mkdirSync(join(tempDir, "monorepo/hub")); // no marker — transparent
    makeProject("monorepo/hub/clavain", [".git", ".beads"]);
    mkdirSync(join(tempDir, "monorepo/plugins")); // no marker — transparent
    makeProject("monorepo/plugins/interflux", [".git", ".beads"]);

    const tree = await discover();
    expect(tree).toHaveLength(1);

    const mono = tree[0]!;
    expect(mono.children).toHaveLength(2);
    expect(mono.children.map((c) => c.path).sort()).toEqual([
      join(tempDir, "monorepo/hub/clavain"),
      join(tempDir, "monorepo/plugins/interflux"),
    ]);
  });

  it("does not recurse into .git-only projects", async () => {
    makeProject("leaf-project", [".git"]);
    // If someone puts a .git inside a git project
    makeProject("leaf-project/nested", [".git"]);

    const tree = await discover();
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children).toHaveLength(0);
  });

  it("respects max depth", async () => {
    makeProject("a", [".beads"]);
    mkdirSync(join(tempDir, "a/b"));
    makeProject("a/b/c", [".git"]);

    // depth 2: can see a (depth 1), but a/b/c is depth 3 — too deep
    const shallow = await discover(2);
    expect(shallow).toHaveLength(1);
    expect(shallow[0]!.children).toHaveLength(0);

    // depth 4: can see everything
    const deep = await discover(4);
    expect(deep).toHaveLength(1);
    expect(deep[0]!.children).toHaveLength(1);
  });

  it("excludes configured directories", async () => {
    makeProject("project", [".beads"]);
    makeProject("project/node_modules/dep", [".git"]);

    const tree = await discover();
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children).toHaveLength(0);
  });

  it("flattens discovery tree", async () => {
    const { flattenDiscovery } = await import("../../src/daemon/tools/init.js");

    makeProject("mono", [".beads"]);
    makeProject("mono/child", [".git"]);
    makeProject("standalone", [".git"]);

    const tree = await discover();
    const flat = flattenDiscovery(tree);
    expect(flat).toHaveLength(3);
    expect(flat).toContain(join(tempDir, "mono"));
    expect(flat).toContain(join(tempDir, "mono/child"));
    expect(flat).toContain(join(tempDir, "standalone"));
  });
});
