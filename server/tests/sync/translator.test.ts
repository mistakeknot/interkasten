import { describe, it, expect } from "vitest";
import {
  normalizeMarkdown,
  hashMarkdown,
  markdownEqual,
  markdownToNotionBlocks,
} from "../../src/sync/translator.js";

describe("Content Translation", () => {
  describe("normalizeMarkdown", () => {
    it("strips trailing whitespace", () => {
      const input = "line one   \nline two\t\nline three";
      expect(normalizeMarkdown(input)).toBe("line one\nline two\nline three");
    });

    it("unifies line endings", () => {
      expect(normalizeMarkdown("a\r\nb\rc")).toBe("a\nb\nc");
    });

    it("collapses consecutive blank lines", () => {
      expect(normalizeMarkdown("a\n\n\n\nb")).toBe("a\n\nb");
    });

    it("trims leading and trailing whitespace", () => {
      expect(normalizeMarkdown("\n\n  hello  \n\n")).toBe("hello");
    });

    it("handles complex markdown", () => {
      const input = `# Title\r\n\r\n\r\nSome text   \r\n\r\n- item 1\r\n- item 2  \r\n\r\n\`\`\`js\r\nconst x = 1;\r\n\`\`\`\r\n`;
      const expected = `# Title\n\nSome text\n\n- item 1\n- item 2\n\n\`\`\`js\nconst x = 1;\n\`\`\``;
      expect(normalizeMarkdown(input)).toBe(expected);
    });
  });

  describe("hashMarkdown", () => {
    it("produces consistent hashes for same content", () => {
      const a = hashMarkdown("# Hello\n\nWorld");
      const b = hashMarkdown("# Hello\n\nWorld");
      expect(a).toBe(b);
    });

    it("produces same hash for differently-formatted same content", () => {
      const a = hashMarkdown("# Hello   \r\n\r\n\r\nWorld  ");
      const b = hashMarkdown("# Hello\n\nWorld");
      expect(a).toBe(b);
    });

    it("produces different hashes for different content", () => {
      const a = hashMarkdown("# Hello");
      const b = hashMarkdown("# Goodbye");
      expect(a).not.toBe(b);
    });
  });

  describe("markdownEqual", () => {
    it("considers normalized-equivalent strings equal", () => {
      expect(markdownEqual("hello   \n", "hello\n")).toBe(true);
    });

    it("considers different content not equal", () => {
      expect(markdownEqual("hello", "world")).toBe(false);
    });
  });

  describe("markdownToNotionBlocks", () => {
    it("converts heading to Notion blocks", () => {
      const blocks = markdownToNotionBlocks("# Hello World");
      expect(blocks.length).toBeGreaterThan(0);

      const first = blocks[0] as Record<string, unknown>;
      expect(first.type).toBe("heading_1");
    });

    it("converts paragraph to Notion blocks", () => {
      const blocks = markdownToNotionBlocks("Just a paragraph.");
      expect(blocks.length).toBeGreaterThan(0);

      const first = blocks[0] as Record<string, unknown>;
      expect(first.type).toBe("paragraph");
    });

    it("converts list to Notion blocks", () => {
      const blocks = markdownToNotionBlocks("- item one\n- item two");
      expect(blocks.length).toBe(2);

      const first = blocks[0] as Record<string, unknown>;
      expect(first.type).toBe("bulleted_list_item");
    });

    it("converts code block to Notion blocks", () => {
      const blocks = markdownToNotionBlocks("```javascript\nconst x = 1;\n```");
      expect(blocks.length).toBeGreaterThan(0);

      const first = blocks[0] as Record<string, unknown>;
      expect(first.type).toBe("code");
    });

    it("handles empty input", () => {
      const blocks = markdownToNotionBlocks("");
      expect(blocks.length).toBe(0);
    });
  });
});
