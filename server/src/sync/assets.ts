import { createHash } from "crypto";
import { basename, dirname, extname, join, relative } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";

const MARKDOWN_LINK_RE = /(!?\[[^\]]*]\()([^)\s]+)(\))/g;
const DOWNLOADABLE_PROTOCOLS = new Set(["http:", "https:"]);

interface DownloadResult {
  localPath: string;
  downloaded: boolean;
}

export interface LocalizeAssetsResult {
  markdown: string;
  localized: number;
  downloaded: number;
  failed: number;
}

/**
 * Download Notion-hosted assets found in markdown and rewrite links
 * to relative local paths. Notion's signed S3 URLs expire after ~1 hour,
 * so this must run during pull to preserve images and attachments.
 *
 * - Scans all markdown links (images + regular links)
 * - Filters for Notion-hosted URLs (S3, notion-static, signed)
 * - Downloads to <pagename>.assets/ with SHA1 hash prefix for dedup
 * - Rewrites links in-place to relative paths
 */
export async function localizeNotionAssetLinks(
  markdown: string,
  markdownPath: string,
): Promise<LocalizeAssetsResult> {
  if (!markdown || markdown.trim().length === 0) {
    return { markdown, localized: 0, downloaded: 0, failed: 0 };
  }

  const matches = [...markdown.matchAll(MARKDOWN_LINK_RE)];
  if (matches.length === 0) {
    return { markdown, localized: 0, downloaded: 0, failed: 0 };
  }

  const targets = new Set<string>();
  for (const match of matches) {
    const target = match[2];
    if (!target) continue;
    if (!isNotionHostedAssetUrl(target)) continue;
    targets.add(target);
  }

  if (targets.size === 0) {
    return { markdown, localized: 0, downloaded: 0, failed: 0 };
  }

  const replacements = new Map<string, string>();
  let downloaded = 0;
  let failed = 0;

  for (const target of targets) {
    try {
      const result = await downloadAsset(target, markdownPath);
      const rel = toPosixPath(
        relative(dirname(markdownPath), result.localPath),
      );
      replacements.set(target, rel);
      if (result.downloaded) downloaded++;
    } catch {
      failed++;
    }
  }

  if (replacements.size === 0) {
    return { markdown, localized: 0, downloaded, failed };
  }

  let localized = 0;
  const rewritten = markdown.replace(
    MARKDOWN_LINK_RE,
    (full, prefix, target, suffix) => {
      const localTarget = replacements.get(target as string);
      if (!localTarget) return full;
      localized++;
      return `${prefix}${localTarget}${suffix}`;
    },
  );

  return {
    markdown: rewritten,
    localized,
    downloaded,
    failed,
  };
}

async function downloadAsset(
  url: string,
  markdownPath: string,
): Promise<DownloadResult> {
  const parsed = new URL(url);
  const canonical = `${parsed.origin}${parsed.pathname}`;
  const hashPrefix = createHash("sha1")
    .update(canonical)
    .digest("hex")
    .slice(0, 12);
  const rawName = decodeURIComponent(basename(parsed.pathname) || "asset");
  const safeName = sanitizeFilename(rawName) || "asset";

  let fileName = `${hashPrefix}-${safeName}`;
  let filePath = join(resolveAssetDir(markdownPath), fileName);
  if (existsSync(filePath)) {
    return { localPath: filePath, downloaded: false };
  }

  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": "interkasten-asset-fetcher/0.1",
    },
  });

  if (!response.ok) {
    throw new Error(`asset_download_failed:${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);

  if (!extname(fileName)) {
    const inferredExt = extensionFromContentType(
      response.headers.get("content-type"),
    );
    if (inferredExt) {
      fileName = `${fileName}${inferredExt}`;
      filePath = join(resolveAssetDir(markdownPath), fileName);
      if (existsSync(filePath)) {
        return { localPath: filePath, downloaded: false };
      }
    }
  }

  const assetDir = dirname(filePath);
  if (!existsSync(assetDir)) mkdirSync(assetDir, { recursive: true });
  writeFileSync(filePath, bytes);

  return { localPath: filePath, downloaded: true };
}

/**
 * Resolve the asset directory for a given markdown file.
 * _index.md → .assets/ (hidden directory in same folder)
 * other.md → other.assets/ (named after the page)
 */
export function resolveAssetDir(markdownPath: string): string {
  const dir = dirname(markdownPath);
  const base = basename(markdownPath);

  if (base === "_index.md") {
    return join(dir, ".assets");
  }

  const pageStem = base.slice(
    0,
    Math.max(0, base.length - extname(base).length),
  );
  return join(dir, `${pageStem}.assets`);
}

/**
 * Detect whether a URL points to a Notion-hosted asset.
 * Covers: S3 prod-files, notion-static CDN, signed notion.so URLs.
 */
export function isNotionHostedAssetUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }

  if (!DOWNLOADABLE_PROTOCOLS.has(parsed.protocol)) return false;

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  if (host.includes("prod-files-secure.s3")) return true;
  if (host.endsWith("notion-static.com")) return true;
  if (
    host.endsWith("amazonaws.com") &&
    path.includes("secure.notion-static.com")
  )
    return true;
  if (host.endsWith("notion.so") && path.startsWith("/signed/")) return true;

  return false;
}

export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .trim();
}

export function extensionFromContentType(contentType: string | null): string {
  if (!contentType) return "";
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      ".xlsx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      ".pptx",
    "text/plain": ".txt",
    "text/csv": ".csv",
    "application/zip": ".zip",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "video/mp4": ".mp4",
  };

  return map[type] ?? "";
}

function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
