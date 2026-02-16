import { describe, it, expect } from "vitest";
import { threeWayMerge, formatConflictFile } from "../../src/sync/merge.js";

describe("engine merge scenarios", () => {
  it("should auto-merge non-overlapping doc changes", () => {
    const base = "# Title\n\nIntro.\n\n## Section A\n\nContent A.\n\n## Section B\n\nContent B.";
    const local = "# Title\n\nIntro.\n\n## Section A\n\nLocal edit A.\n\n## Section B\n\nContent B.";
    const remote = "# Title\n\nIntro.\n\n## Section A\n\nContent A.\n\n## Section B\n\nNotion edit B.";

    const result = threeWayMerge(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.merged).toContain("Local edit A.");
    expect(result.merged).toContain("Notion edit B.");
  });

  it("should detect overlapping and apply local-wins", () => {
    const base = "# Title\n\nSame paragraph.";
    const local = "# Title\n\nLocal rewrite of paragraph.";
    const remote = "# Title\n\nNotion rewrite of paragraph.";

    const result = threeWayMerge(base, local, remote, "local-wins");
    expect(result.hasConflicts).toBe(true);
    expect(result.merged).toContain("Local rewrite");
    expect(result.merged).not.toContain("Notion rewrite");
  });

  it("should detect overlapping and apply notion-wins", () => {
    const base = "# Title\n\nSame paragraph.";
    const local = "# Title\n\nLocal rewrite of paragraph.";
    const remote = "# Title\n\nNotion rewrite of paragraph.";

    const result = threeWayMerge(base, local, remote, "notion-wins");
    expect(result.hasConflicts).toBe(true);
    expect(result.merged).toContain("Notion rewrite");
  });

  it("should generate conflict file with both versions", () => {
    const output = formatConflictFile(
      "# Local content",
      "# Notion content",
      "docs/readme.md",
    );
    expect(output).toContain("Local Version");
    expect(output).toContain("Notion Version");
    expect(output).toContain("docs/readme.md");
    expect(output).toContain("# Local content");
    expect(output).toContain("# Notion content");
  });
});
