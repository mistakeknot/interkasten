import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import {
  runGit,
  isGitRepo,
  getHead,
  hasChanges,
  changedFilesBetween,
  outputDirRelativePath,
} from "../../src/sync/git-ops.js";

function git(workdir: string, args: string[]): string {
  return execFileSync("git", ["-C", workdir, ...args], {
    encoding: "utf-8",
  }).trim();
}

describe("git-ops", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "git-ops-test-"));
    git(tmpDir, ["init"]);
    git(tmpDir, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@test",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ]);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("runGit", () => {
    it("runs a git command and returns trimmed output", () => {
      const result = runGit(tmpDir, ["rev-parse", "--is-inside-work-tree"]);
      expect(result).toBe("true");
    });

    it("throws on invalid command", () => {
      expect(() => runGit(tmpDir, ["not-a-command"])).toThrow();
    });
  });

  describe("isGitRepo", () => {
    it("returns true for a git repo", () => {
      expect(isGitRepo(tmpDir)).toBe(true);
    });

    it("returns false for a non-repo", () => {
      const nonRepo = mkdtempSync(join(tmpdir(), "not-git-"));
      expect(isGitRepo(nonRepo)).toBe(false);
      rmSync(nonRepo, { recursive: true, force: true });
    });
  });

  describe("getHead", () => {
    it("returns a 40-char commit hash", () => {
      const head = getHead(tmpDir);
      expect(head).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  describe("hasChanges", () => {
    it("returns false for clean working tree", () => {
      expect(hasChanges(tmpDir)).toBe(false);
    });

    it("returns true when there are untracked files", () => {
      writeFileSync(join(tmpDir, "new-file.txt"), "hello");
      expect(hasChanges(tmpDir)).toBe(true);
    });

    it("returns true when there are staged changes", () => {
      writeFileSync(join(tmpDir, "staged.txt"), "content");
      git(tmpDir, ["add", "staged.txt"]);
      expect(hasChanges(tmpDir)).toBe(true);
    });
  });

  describe("changedFilesBetween", () => {
    it("returns changed files between two commits", () => {
      const before = getHead(tmpDir);

      writeFileSync(join(tmpDir, "changed.md"), "content");
      git(tmpDir, ["add", "changed.md"]);
      git(tmpDir, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@test",
        "commit",
        "-m",
        "add file",
      ]);

      const after = getHead(tmpDir);
      const files = changedFilesBetween(tmpDir, before, after);
      expect(files).toEqual(["changed.md"]);
    });

    it("returns empty array for same commit", () => {
      const head = getHead(tmpDir);
      expect(changedFilesBetween(tmpDir, head, head)).toEqual([]);
    });

    it("returns empty array for empty from/to", () => {
      expect(changedFilesBetween(tmpDir, "", "abc")).toEqual([]);
      expect(changedFilesBetween(tmpDir, "abc", "")).toEqual([]);
    });
  });

  describe("outputDirRelativePath", () => {
    it("returns relative path for subdirectory", () => {
      expect(outputDirRelativePath("/repo", "/repo/docs")).toBe("docs");
    });

    it("returns '.' for same directory", () => {
      expect(outputDirRelativePath("/repo", "/repo")).toBe(".");
    });

    it("returns null for parent directory", () => {
      expect(outputDirRelativePath("/repo/sub", "/repo")).toBeNull();
    });

    it("returns nested relative path", () => {
      expect(outputDirRelativePath("/repo", "/repo/a/b/c")).toBe("a/b/c");
    });
  });
});
