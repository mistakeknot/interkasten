import { markdownToBlocks } from "@tryfabric/martian";
import { NotionToMarkdown } from "notion-to-md";
import { Client } from "@notionhq/client";
import { createHash } from "crypto";

/**
 * Convert markdown string to Notion block objects.
 * Uses @tryfabric/martian for the conversion.
 */
export function markdownToNotionBlocks(markdown: string): unknown[] {
  const normalized = normalizeMarkdown(markdown);
  return markdownToBlocks(normalized);
}

/**
 * Convert Notion page blocks to markdown string.
 * Uses notion-to-md with the Notion client.
 */
export async function notionBlocksToMarkdown(
  notionClient: Client,
  pageId: string
): Promise<string> {
  const n2m = new NotionToMarkdown({ notionClient });

  // Suppress child_page and child_database blocks to prevent recursive fetching
  n2m.setCustomTransformer("child_page", async () => "");
  n2m.setCustomTransformer("child_database", async () => "");

  let mdBlocks;
  try {
    mdBlocks = await n2m.pageToMarkdown(pageId);
  } catch (err) {
    console.error(`Failed to convert page ${pageId} to markdown:`, err);
    return "";
  }

  let mdString;
  try {
    mdString = n2m.toMarkdownString(mdBlocks);
  } catch (err) {
    console.error(`Failed to stringify markdown for page ${pageId}:`, err);
    return "";
  }

  // notion-to-md returns { parent: string } in newer versions
  const raw = typeof mdString === "string" ? mdString : mdString.parent;

  return normalizeMarkdown(raw);
}

/**
 * Normalize markdown for consistent hashing and diff comparison.
 * - Strip trailing whitespace from each line
 * - Unify line endings to \n
 * - Collapse consecutive blank lines to one
 * - Trim leading/trailing whitespace
 */
export function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n") // CRLF → LF
    .replace(/\r/g, "\n") // CR → LF
    .replace(/[ \t]+$/gm, "") // trailing whitespace per line
    .replace(/\n{3,}/g, "\n\n") // collapse blank lines
    .trim();
}

/**
 * Compute SHA-256 hash of normalized markdown content.
 */
export function hashMarkdown(markdown: string): string {
  const normalized = normalizeMarkdown(markdown);
  return createHash("sha256").update(normalized, "utf-8").digest("hex");
}

/**
 * Check if two markdown strings are semantically equal after normalization.
 */
export function markdownEqual(a: string, b: string): boolean {
  return normalizeMarkdown(a) === normalizeMarkdown(b);
}
