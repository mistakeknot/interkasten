import { describe, it, expect } from "vitest";
import {
  isNotionHostedAssetUrl,
  sanitizeFilename,
  extensionFromContentType,
  resolveAssetDir,
} from "../../src/sync/assets.js";

describe("assets", () => {
  describe("isNotionHostedAssetUrl", () => {
    it("detects prod-files-secure S3 URLs", () => {
      expect(
        isNotionHostedAssetUrl(
          "https://prod-files-secure.s3.us-west-2.amazonaws.com/abc/def/image.png?X-Amz-Expires=3600",
        ),
      ).toBe(true);
    });

    it("detects notion-static.com URLs", () => {
      expect(
        isNotionHostedAssetUrl("https://www.notion-static.com/images/logo.png"),
      ).toBe(true);
    });

    it("detects signed notion.so URLs", () => {
      expect(
        isNotionHostedAssetUrl(
          "https://www.notion.so/signed/abc123?table=block",
        ),
      ).toBe(true);
    });

    it("detects amazonaws.com with notion-static path", () => {
      expect(
        isNotionHostedAssetUrl(
          "https://s3.amazonaws.com/secure.notion-static.com/abc/image.png",
        ),
      ).toBe(true);
    });

    it("rejects non-Notion URLs", () => {
      expect(isNotionHostedAssetUrl("https://example.com/image.png")).toBe(
        false,
      );
      expect(isNotionHostedAssetUrl("https://github.com/assets/logo.png")).toBe(
        false,
      );
    });

    it("rejects invalid URLs", () => {
      expect(isNotionHostedAssetUrl("not-a-url")).toBe(false);
      expect(isNotionHostedAssetUrl("")).toBe(false);
    });

    it("rejects non-HTTP protocols", () => {
      expect(
        isNotionHostedAssetUrl(
          "ftp://prod-files-secure.s3.us-west-2.amazonaws.com/file.png",
        ),
      ).toBe(false);
    });
  });

  describe("sanitizeFilename", () => {
    it("replaces unsafe characters", () => {
      expect(sanitizeFilename('file<>:"/\\|?*.txt')).toBe("file-.txt");
    });

    it("collapses spaces and hyphens", () => {
      expect(sanitizeFilename("my   file - - name")).toBe("my-file-name");
    });

    it("trims leading/trailing hyphens", () => {
      expect(sanitizeFilename("-file-")).toBe("file");
    });

    it("handles empty string", () => {
      expect(sanitizeFilename("")).toBe("");
    });
  });

  describe("extensionFromContentType", () => {
    it("maps image types", () => {
      expect(extensionFromContentType("image/png")).toBe(".png");
      expect(extensionFromContentType("image/jpeg")).toBe(".jpg");
      expect(extensionFromContentType("image/gif")).toBe(".gif");
      expect(extensionFromContentType("image/webp")).toBe(".webp");
      expect(extensionFromContentType("image/svg+xml")).toBe(".svg");
    });

    it("maps document types", () => {
      expect(extensionFromContentType("application/pdf")).toBe(".pdf");
      expect(extensionFromContentType("text/plain")).toBe(".txt");
      expect(extensionFromContentType("text/csv")).toBe(".csv");
    });

    it("handles content-type with charset", () => {
      expect(extensionFromContentType("image/png; charset=utf-8")).toBe(".png");
    });

    it("returns empty for null", () => {
      expect(extensionFromContentType(null)).toBe("");
    });

    it("returns empty for unknown types", () => {
      expect(extensionFromContentType("application/octet-stream")).toBe("");
    });
  });

  describe("resolveAssetDir", () => {
    it("uses .assets for _index.md", () => {
      expect(resolveAssetDir("/projects/foo/_index.md")).toBe(
        "/projects/foo/.assets",
      );
    });

    it("uses pagename.assets for regular files", () => {
      expect(resolveAssetDir("/projects/foo/my-page.md")).toBe(
        "/projects/foo/my-page.assets",
      );
    });

    it("handles nested paths", () => {
      expect(resolveAssetDir("/a/b/c/doc.md")).toBe("/a/b/c/doc.assets");
    });
  });
});
