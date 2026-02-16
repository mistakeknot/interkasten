import { describe, it, expect } from "vitest";
import { threeWayMerge, formatConflictFile } from "../../src/sync/merge.js";

describe("threeWayMerge", () => {
  it("should return unchanged when all three are identical", () => {
    const result = threeWayMerge("hello world", "hello world", "hello world");
    expect(result.merged).toBe("hello world");
    expect(result.conflicts).toHaveLength(0);
    expect(result.hasConflicts).toBe(false);
  });

  it("should accept local-only changes", () => {
    const base = "line 1\nline 2\nline 3";
    const local = "line 1\nmodified locally\nline 3";
    const remote = "line 1\nline 2\nline 3";
    const result = threeWayMerge(base, local, remote);
    expect(result.merged).toBe("line 1\nmodified locally\nline 3");
    expect(result.hasConflicts).toBe(false);
  });

  it("should accept remote-only changes", () => {
    const base = "line 1\nline 2\nline 3";
    const local = "line 1\nline 2\nline 3";
    const remote = "line 1\nmodified remotely\nline 3";
    const result = threeWayMerge(base, local, remote);
    expect(result.merged).toBe("line 1\nmodified remotely\nline 3");
    expect(result.hasConflicts).toBe(false);
  });

  it("should merge non-overlapping changes from both sides", () => {
    const base = "line 1\nline 2\nline 3\nline 4";
    const local = "line 1\nlocal edit\nline 3\nline 4";
    const remote = "line 1\nline 2\nline 3\nremote edit";
    const result = threeWayMerge(base, local, remote);
    expect(result.merged).toBe("line 1\nlocal edit\nline 3\nremote edit");
    expect(result.hasConflicts).toBe(false);
  });

  it("should detect overlapping changes as conflicts", () => {
    const base = "line 1\nline 2\nline 3";
    const local = "line 1\nlocal version\nline 3";
    const remote = "line 1\nremote version\nline 3";
    const result = threeWayMerge(base, local, remote);
    expect(result.hasConflicts).toBe(true);
    expect(result.conflicts.length).toBeGreaterThan(0);
  });

  it("should apply local-wins fallback for conflicts", () => {
    const base = "line 1\nline 2\nline 3";
    const local = "line 1\nlocal version\nline 3";
    const remote = "line 1\nremote version\nline 3";
    const result = threeWayMerge(base, local, remote, "local-wins");
    expect(result.merged).toContain("local version");
    expect(result.merged).not.toContain("remote version");
  });

  it("should apply notion-wins fallback for conflicts", () => {
    const base = "line 1\nline 2\nline 3";
    const local = "line 1\nlocal version\nline 3";
    const remote = "line 1\nremote version\nline 3";
    const result = threeWayMerge(base, local, remote, "notion-wins");
    expect(result.merged).toContain("remote version");
    expect(result.merged).not.toContain("local version");
  });

  it("should handle empty base (new file on both sides)", () => {
    const result = threeWayMerge("", "local content", "remote content");
    expect(result.hasConflicts).toBe(true);
  });
});

describe("formatConflictFile", () => {
  it("should include both versions with headers", () => {
    const output = formatConflictFile("local ver", "remote ver", "docs/test.md");
    expect(output).toContain("Local Version");
    expect(output).toContain("Notion Version");
    expect(output).toContain("local ver");
    expect(output).toContain("remote ver");
    expect(output).toContain("docs/test.md");
  });
});
