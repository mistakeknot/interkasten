import { describe, it, expect } from "vitest";
import { resolve } from "path";

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
