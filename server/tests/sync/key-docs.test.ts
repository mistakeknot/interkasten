import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { findKeyDocs, buildKeyDocPageProperties, type KeyDocResult } from "../../src/sync/key-docs.js";

const TEST_DIR = join(tmpdir(), "interkasten-keydocs-test");

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("findKeyDocs", () => {
  it("finds all 5 key docs when present", () => {
    mkdirSync(join(TEST_DIR, "docs"), { recursive: true });
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Claude");
    writeFileSync(join(TEST_DIR, "AGENTS.md"), "# Agents");
    writeFileSync(join(TEST_DIR, "docs", "vision.md"), "# Vision");
    writeFileSync(join(TEST_DIR, "docs", "PRD.md"), "# PRD");
    writeFileSync(join(TEST_DIR, "docs", "roadmap.md"), "# Roadmap");

    const results = findKeyDocs(TEST_DIR);
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.path !== null)).toBe(true);
    expect(results.find((r) => r.type === "CLAUDE.md")!.path).toContain("CLAUDE.md");
    expect(results.find((r) => r.type === "AGENTS.md")!.path).toContain("AGENTS.md");
    expect(results.find((r) => r.type === "Vision")!.path).toContain("vision.md");
    expect(results.find((r) => r.type === "PRD")!.path).toContain("PRD.md");
    expect(results.find((r) => r.type === "Roadmap")!.path).toContain("roadmap.md");
  });

  it("returns nulls for missing docs", () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Claude");

    const results = findKeyDocs(TEST_DIR);
    expect(results).toHaveLength(5);
    expect(results.find((r) => r.type === "CLAUDE.md")!.path).not.toBeNull();
    expect(results.find((r) => r.type === "AGENTS.md")!.path).toBeNull();
    expect(results.find((r) => r.type === "Vision")!.path).toBeNull();
    expect(results.find((r) => r.type === "PRD")!.path).toBeNull();
    expect(results.find((r) => r.type === "Roadmap")!.path).toBeNull();
  });

  it("matches PRD-MVP.md as PRD", () => {
    mkdirSync(join(TEST_DIR, "docs"));
    writeFileSync(join(TEST_DIR, "docs", "PRD-MVP.md"), "# PRD MVP");

    const results = findKeyDocs(TEST_DIR);
    const prd = results.find((r) => r.type === "PRD")!;
    expect(prd.path).toContain("PRD-MVP.md");
  });

  it("matches case-insensitively", () => {
    mkdirSync(join(TEST_DIR, "docs"));
    writeFileSync(join(TEST_DIR, "docs", "VISION.md"), "# Vision");
    writeFileSync(join(TEST_DIR, "docs", "Roadmap.md"), "# Roadmap");

    const results = findKeyDocs(TEST_DIR);
    expect(results.find((r) => r.type === "Vision")!.path).toContain("VISION.md");
    expect(results.find((r) => r.type === "Roadmap")!.path).toContain("Roadmap.md");
  });

  it("prefers root-level match over docs/ for Vision/PRD/Roadmap", () => {
    mkdirSync(join(TEST_DIR, "docs"));
    writeFileSync(join(TEST_DIR, "PRD.md"), "# Root PRD");
    writeFileSync(join(TEST_DIR, "docs", "PRD.md"), "# Docs PRD");

    const results = findKeyDocs(TEST_DIR);
    const prd = results.find((r) => r.type === "PRD")!;
    // Should find root-level first (searches root before docs/)
    expect(prd.path).toBe(join(TEST_DIR, "PRD.md"));
  });

  it("does not match AGENTS.md or CLAUDE.md in subdirectories", () => {
    mkdirSync(join(TEST_DIR, "subdir"));
    writeFileSync(join(TEST_DIR, "subdir", "AGENTS.md"), "# Sub Agents");
    writeFileSync(join(TEST_DIR, "subdir", "CLAUDE.md"), "# Sub Claude");

    const results = findKeyDocs(TEST_DIR);
    expect(results.find((r) => r.type === "AGENTS.md")!.path).toBeNull();
    expect(results.find((r) => r.type === "CLAUDE.md")!.path).toBeNull();
  });

  it("handles empty project directory", () => {
    const results = findKeyDocs(TEST_DIR);
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.path === null)).toBe(true);
  });
});

describe("buildKeyDocPageProperties", () => {
  it("sets URLs for synced docs and null for missing/unsynced", () => {
    const keyDocs: KeyDocResult[] = [
      { type: "Vision", path: "/some/path", notionId: "abc-123" },
      { type: "PRD", path: null, notionId: null },
      { type: "Roadmap", path: "/some/roadmap.md", notionId: null },
      { type: "AGENTS.md", path: "/some/AGENTS.md", notionId: "def-456" },
      { type: "CLAUDE.md", path: null, notionId: null },
    ];

    const props = buildKeyDocPageProperties(keyDocs);

    // Only 5 properties (one per doc type, no checkboxes)
    expect(Object.keys(props)).toHaveLength(5);

    // Vision: synced -> URL
    expect(props["Vision"]).toEqual({ url: "https://notion.so/abc123" });

    // PRD: missing -> null
    expect(props["PRD"]).toEqual({ url: null });

    // Roadmap: exists locally but not synced -> null
    expect(props["Roadmap"]).toEqual({ url: null });

    // AGENTS.md: synced -> URL
    expect(props["AGENTS.md"]).toEqual({ url: "https://notion.so/def456" });

    // CLAUDE.md: missing -> null
    expect(props["CLAUDE.md"]).toEqual({ url: null });
  });
});
