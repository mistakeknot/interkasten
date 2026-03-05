import { describe, it, expect } from "vitest";
import type { DataSourceObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import {
  normalizeNotionId,
  hasDiscoveryScope,
  buildDiscoveryScope,
  hasAncestorMatch,
  applyDiscoveryScope,
  type PageNode,
  type DiscoveryResult,
  type DiscoveryScope,
} from "../../src/sync/discovery.js";

function makeNode(
  id: string,
  parentId: string | null = null,
  type: "page" | "database" = "page",
): PageNode {
  return {
    id,
    title: `Page ${id}`,
    parentId,
    parentType: parentId ? "page" : "workspace",
    type,
    lastEditedTime: new Date().toISOString(),
    hasChildren: false,
    children: [],
  };
}

function makeDiscoveryResult(nodes: PageNode[]): DiscoveryResult {
  const flat = new Map<string, PageNode>();
  for (const node of nodes) {
    flat.set(node.id, node);
  }

  // Build children
  for (const node of flat.values()) {
    if (node.parentId && flat.has(node.parentId)) {
      const parent = flat.get(node.parentId)!;
      parent.children.push(node);
      parent.hasChildren = true;
    }
  }

  const tree = nodes.filter(
    (n) =>
      n.parentType === "workspace" || (n.parentId && !flat.has(n.parentId)),
  );

  return {
    tree,
    flat,
    databases: new Map() as Map<
      string,
      { ds: DataSourceObjectResponse; schema: any; rowCount: number }
    >,
  };
}

describe("discovery scope", () => {
  describe("normalizeNotionId", () => {
    it("strips hyphens and lowercases", () => {
      expect(normalizeNotionId("ABC-DEF-123")).toBe("abcdef123");
    });

    it("handles already normalized IDs", () => {
      expect(normalizeNotionId("abcdef123")).toBe("abcdef123");
    });
  });

  describe("hasDiscoveryScope", () => {
    it("returns false for undefined", () => {
      expect(hasDiscoveryScope(undefined)).toBe(false);
    });

    it("returns false for empty scope", () => {
      expect(
        hasDiscoveryScope({ rootIds: new Set(), excludeIds: new Set() }),
      ).toBe(false);
    });

    it("returns true with root IDs", () => {
      expect(
        hasDiscoveryScope({
          rootIds: new Set(["abc"]),
          excludeIds: new Set(),
        }),
      ).toBe(true);
    });

    it("returns true with exclude IDs", () => {
      expect(
        hasDiscoveryScope({
          rootIds: new Set(),
          excludeIds: new Set(["abc"]),
        }),
      ).toBe(true);
    });
  });

  describe("buildDiscoveryScope", () => {
    it("normalizes IDs", () => {
      const scope = buildDiscoveryScope(["ABC-DEF"], ["GHI-JKL"]);
      expect(scope.rootIds.has("abcdef")).toBe(true);
      expect(scope.excludeIds.has("ghijkl")).toBe(true);
    });
  });

  describe("hasAncestorMatch", () => {
    it("matches self", () => {
      const flat = new Map<string, PageNode>();
      flat.set("a", makeNode("a"));
      const targets = new Set(["a"]);
      expect(hasAncestorMatch("a", targets, flat, new Map())).toBe(true);
    });

    it("matches parent", () => {
      const flat = new Map<string, PageNode>();
      flat.set("root", makeNode("root"));
      flat.set("child", makeNode("child", "root"));
      const targets = new Set(["root"]);
      expect(hasAncestorMatch("child", targets, flat, new Map())).toBe(true);
    });

    it("matches grandparent", () => {
      const flat = new Map<string, PageNode>();
      flat.set("root", makeNode("root"));
      flat.set("mid", makeNode("mid", "root"));
      flat.set("leaf", makeNode("leaf", "mid"));
      const targets = new Set(["root"]);
      expect(hasAncestorMatch("leaf", targets, flat, new Map())).toBe(true);
    });

    it("returns false when no match", () => {
      const flat = new Map<string, PageNode>();
      flat.set("a", makeNode("a"));
      flat.set("b", makeNode("b"));
      const targets = new Set(["a"]);
      expect(hasAncestorMatch("b", targets, flat, new Map())).toBe(false);
    });

    it("handles cycles without infinite loop", () => {
      const flat = new Map<string, PageNode>();
      flat.set("a", makeNode("a", "b"));
      flat.set("b", makeNode("b", "a"));
      const targets = new Set(["z"]); // not found
      expect(hasAncestorMatch("a", targets, flat, new Map())).toBe(false);
    });

    it("uses memoization", () => {
      const flat = new Map<string, PageNode>();
      flat.set("root", makeNode("root"));
      flat.set("child", makeNode("child", "root"));
      flat.set("sibling", makeNode("sibling", "root"));
      const targets = new Set(["root"]);
      const memo = new Map<string, boolean>();

      hasAncestorMatch("child", targets, flat, memo);
      expect(memo.get("root")).toBe(true);

      // sibling should benefit from memo
      hasAncestorMatch("sibling", targets, flat, memo);
      expect(memo.get("sibling")).toBe(true);
    });
  });

  describe("applyDiscoveryScope", () => {
    it("filters by root IDs (keeps subtree)", () => {
      // Tree:
      //   workspace
      //     ├── roota
      //     │   └── childa
      //     └── rootb
      //         └── childb
      const discovery = makeDiscoveryResult([
        makeNode("roota"),
        makeNode("childa", "roota"),
        makeNode("rootb"),
        makeNode("childb", "rootb"),
      ]);

      const scope: DiscoveryScope = {
        rootIds: new Set(["roota"]),
        excludeIds: new Set(),
      };

      const result = applyDiscoveryScope(discovery, scope);
      expect(result.flat.size).toBe(2);
      expect(result.flat.has("roota")).toBe(true);
      expect(result.flat.has("childa")).toBe(true);
      expect(result.flat.has("rootb")).toBe(false);
    });

    it("excludes subtree by exclude IDs", () => {
      const discovery = makeDiscoveryResult([
        makeNode("root"),
        makeNode("keep", "root"),
        makeNode("excludeme", "root"),
        makeNode("alsoexcluded", "excludeme"),
      ]);

      const scope: DiscoveryScope = {
        rootIds: new Set(),
        excludeIds: new Set(["excludeme"]),
      };

      const result = applyDiscoveryScope(discovery, scope);
      expect(result.flat.has("root")).toBe(true);
      expect(result.flat.has("keep")).toBe(true);
      expect(result.flat.has("excludeme")).toBe(false);
      expect(result.flat.has("alsoexcluded")).toBe(false);
    });

    it("combines root + exclude filters", () => {
      const discovery = makeDiscoveryResult([
        makeNode("root"),
        makeNode("keepsubtree", "root"),
        makeNode("keepleaf", "keepsubtree"),
        makeNode("excludesubtree", "root"),
        makeNode("excludedleaf", "excludesubtree"),
        makeNode("otherroot"),
      ]);

      const scope: DiscoveryScope = {
        rootIds: new Set(["root"]),
        excludeIds: new Set(["excludesubtree"]),
      };

      const result = applyDiscoveryScope(discovery, scope);
      expect(result.flat.has("root")).toBe(true);
      expect(result.flat.has("keepsubtree")).toBe(true);
      expect(result.flat.has("keepleaf")).toBe(true);
      expect(result.flat.has("excludesubtree")).toBe(false);
      expect(result.flat.has("excludedleaf")).toBe(false);
      expect(result.flat.has("otherroot")).toBe(false);
    });

    it("returns unchanged result for empty scope", () => {
      const discovery = makeDiscoveryResult([makeNode("a"), makeNode("b")]);

      const scope: DiscoveryScope = {
        rootIds: new Set(),
        excludeIds: new Set(),
      };

      const result = applyDiscoveryScope(discovery, scope);
      expect(result.flat.size).toBe(2);
    });

    it("works with hyphenated Notion IDs via buildDiscoveryScope", () => {
      // Real Notion IDs have hyphens: "abc-def-123"
      // buildDiscoveryScope normalizes them, and hasAncestorMatch normalizes lookups
      const discovery = makeDiscoveryResult([
        makeNode("abcdef"),
        makeNode("child1", "abcdef"),
        makeNode("ghijkl"),
      ]);

      // Simulate real usage: config has hyphenated IDs
      const scope = buildDiscoveryScope(["abc-def"], []);
      // scope.rootIds contains "abcdef" (normalized)

      const result = applyDiscoveryScope(discovery, scope);
      expect(result.flat.has("abcdef")).toBe(true);
      expect(result.flat.has("child1")).toBe(true);
      expect(result.flat.has("ghijkl")).toBe(false);
    });

    it("rebuilds children lists correctly", () => {
      const discovery = makeDiscoveryResult([
        makeNode("root"),
        makeNode("keep", "root"),
        makeNode("exclude", "root"),
      ]);

      const scope: DiscoveryScope = {
        rootIds: new Set(),
        excludeIds: new Set(["exclude"]),
      };

      const result = applyDiscoveryScope(discovery, scope);
      const root = result.flat.get("root")!;
      expect(root.children).toHaveLength(1);
      expect(root.children[0].id).toBe("keep");
    });
  });
});
