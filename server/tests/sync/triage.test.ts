import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import {
  gatherSignals,
  classifyProject,
  getRequiredDocs,
  triageProject,
  TIER_DOC_REQUIREMENTS,
  type TriageSignals,
} from "../../src/sync/triage.js";

const TEST_DIR = join(tmpdir(), "interkasten-triage-test");

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

/** Create a file with N non-blank lines of TypeScript. */
function createCodeFile(dir: string, filename: string, lines: number): void {
  mkdirSync(dir, { recursive: true });
  const content = Array.from({ length: lines }, (_, i) => `const x${i} = ${i};`).join("\n");
  writeFileSync(join(dir, filename), content);
}

/** Initialize a git repo with a given number of commits. */
function initGitRepo(dir: string, commitCount: number): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });

  for (let i = 0; i < commitCount; i++) {
    writeFileSync(join(dir, `file${i}.txt`), `commit ${i}`);
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", `commit ${i}`, "--no-gpg-sign"], {
      cwd: dir,
      stdio: "pipe",
    });
  }
}

// --- gatherSignals tests ---

describe("gatherSignals", () => {
  it("returns minimal signals on empty directory", () => {
    const signals = gatherSignals(TEST_DIR);

    expect(signals.loc).toBe(0);
    expect(signals.hasBeads).toBe(false);
    expect(signals.isPlugin).toBe(false);
    expect(signals.mdCount).toBe(0);
    expect(signals.hasManifest).toBe(false);
    expect(signals.lastCommitDays).toBeNull();
    expect(signals.commitCount).toBe(0);
    expect(signals.hasReadme).toBe(false);
    expect(signals.hasSrc).toBe(false);
  });

  it("detects .beads directory", () => {
    mkdirSync(join(TEST_DIR, ".beads"));
    expect(gatherSignals(TEST_DIR).hasBeads).toBe(true);
  });

  it("detects plugin manifest", () => {
    mkdirSync(join(TEST_DIR, ".claude-plugin"), { recursive: true });
    writeFileSync(join(TEST_DIR, ".claude-plugin", "plugin.json"), "{}");
    expect(gatherSignals(TEST_DIR).isPlugin).toBe(true);
  });

  it("counts markdown files in root and docs/", () => {
    writeFileSync(join(TEST_DIR, "README.md"), "# Hello");
    writeFileSync(join(TEST_DIR, "CHANGELOG.md"), "# Changes");
    mkdirSync(join(TEST_DIR, "docs"));
    writeFileSync(join(TEST_DIR, "docs", "guide.md"), "# Guide");

    const signals = gatherSignals(TEST_DIR);
    expect(signals.mdCount).toBe(3);
    expect(signals.hasReadme).toBe(true);
  });

  it("counts LOC in source files, skipping node_modules", () => {
    createCodeFile(join(TEST_DIR, "src"), "index.ts", 50);
    createCodeFile(join(TEST_DIR, "src"), "utils.py", 30);
    createCodeFile(join(TEST_DIR, "node_modules", "pkg"), "index.js", 1000);

    const signals = gatherSignals(TEST_DIR);
    expect(signals.loc).toBe(80);
    expect(signals.hasSrc).toBe(true);
  });

  it("detects manifest files", () => {
    writeFileSync(join(TEST_DIR, "package.json"), "{}");
    expect(gatherSignals(TEST_DIR).hasManifest).toBe(true);
  });

  it("gets commit count and last commit days from git", () => {
    initGitRepo(TEST_DIR, 5);

    const signals = gatherSignals(TEST_DIR);
    expect(signals.commitCount).toBe(5);
    expect(signals.lastCommitDays).not.toBeNull();
    expect(signals.lastCommitDays).toBeGreaterThanOrEqual(0);
    expect(signals.lastCommitDays!).toBeLessThan(1); // committed just now
  });

  it("returns null/0 for git fields on non-git directory", () => {
    const signals = gatherSignals(TEST_DIR);
    expect(signals.commitCount).toBe(0);
    expect(signals.lastCommitDays).toBeNull();
  });
});

// --- classifyProject tests ---

describe("classifyProject", () => {
  const BASE_SIGNALS: TriageSignals = {
    loc: 0,
    hasBeads: false,
    isPlugin: false,
    mdCount: 0,
    hasManifest: false,
    lastCommitDays: null,
    commitCount: 0,
    hasReadme: false,
    hasSrc: false,
  };

  it("classifies as Inactive: no manifest, no src, <3 commits", () => {
    expect(classifyProject({ ...BASE_SIGNALS, commitCount: 2 })).toBe("Inactive");
  });

  it("classifies as Inactive: stale project (>180 days, <5 commits)", () => {
    expect(
      classifyProject({
        ...BASE_SIGNALS,
        lastCommitDays: 200,
        commitCount: 4,
        hasManifest: true,
        hasSrc: true,
      })
    ).toBe("Inactive");
  });

  it("classifies as Inactive: no code and <2 markdown files", () => {
    expect(
      classifyProject({
        ...BASE_SIGNALS,
        loc: 0,
        mdCount: 1,
        hasManifest: true,
        hasSrc: true,
        commitCount: 3,
      })
    ).toBe("Inactive");
  });

  it("classifies as Product: loc >= 1000", () => {
    expect(
      classifyProject({
        ...BASE_SIGNALS,
        loc: 1500,
        hasManifest: true,
        hasSrc: true,
        commitCount: 3,
        mdCount: 2,
      })
    ).toBe("Product");
  });

  it("classifies as Product: beads + commitCount >= 10", () => {
    expect(
      classifyProject({
        ...BASE_SIGNALS,
        hasBeads: true,
        commitCount: 15,
        hasManifest: true,
        hasSrc: true,
        loc: 500,
        mdCount: 2,
      })
    ).toBe("Product");
  });

  it("classifies as Product: mdCount >= 5, manifest, src", () => {
    expect(
      classifyProject({
        ...BASE_SIGNALS,
        mdCount: 6,
        hasManifest: true,
        hasSrc: true,
        commitCount: 3,
        loc: 100,
      })
    ).toBe("Product");
  });

  it("classifies as Tool: moderate project that doesn't match Product or Inactive", () => {
    expect(
      classifyProject({
        ...BASE_SIGNALS,
        loc: 200,
        hasManifest: true,
        hasSrc: true,
        commitCount: 5,
        mdCount: 2,
      })
    ).toBe("Tool");
  });

  it("classifies plugin with moderate LOC as Tool", () => {
    expect(
      classifyProject({
        ...BASE_SIGNALS,
        isPlugin: true,
        loc: 300,
        hasManifest: true,
        hasSrc: true,
        commitCount: 8,
        mdCount: 3,
      })
    ).toBe("Tool");
  });
});

// --- getRequiredDocs tests ---

describe("getRequiredDocs", () => {
  it("returns all 5 docs for Product tier", () => {
    const docs = getRequiredDocs("Product");
    expect(docs).toEqual(["Vision", "PRD", "Roadmap", "AGENTS.md", "CLAUDE.md"]);
  });

  it("returns AGENTS.md and CLAUDE.md for Tool tier", () => {
    const docs = getRequiredDocs("Tool");
    expect(docs).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  it("returns empty array for Inactive tier", () => {
    const docs = getRequiredDocs("Inactive");
    expect(docs).toEqual([]);
  });
});

// --- triageProject integration test ---

describe("triageProject", () => {
  it("performs full triage on a Product-level project", () => {
    // Set up a project with high LOC
    writeFileSync(join(TEST_DIR, "package.json"), "{}");
    mkdirSync(join(TEST_DIR, "src"));
    createCodeFile(join(TEST_DIR, "src"), "main.ts", 1200);
    writeFileSync(join(TEST_DIR, "README.md"), "# Project");
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Claude");

    const result = triageProject(TEST_DIR);
    expect(result.tier).toBe("Product");
    expect(result.signals.loc).toBeGreaterThanOrEqual(1000);
    expect(result.requiredDocs).toContain("Vision");
    expect(result.requiredDocs).toContain("PRD");
    expect(result.requiredDocs).toContain("CLAUDE.md");
  });

  it("performs full triage on an empty (Inactive) project", () => {
    const result = triageProject(TEST_DIR);
    expect(result.tier).toBe("Inactive");
    expect(result.requiredDocs).toEqual([]);
  });
});
