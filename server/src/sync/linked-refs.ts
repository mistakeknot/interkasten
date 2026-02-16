import { statSync } from "fs";
import { basename } from "path";

export interface SummaryCard {
  title: string;
  path: string;
  lastModified: string;
  lineCount: number;
}

/**
 * Generate summary card properties for a T2 linked reference file.
 * T2 files get a lightweight Notion page with metadata only (no content sync).
 */
export function generateSummaryCard(filePath: string, lineCount: number): SummaryCard {
  const stat = statSync(filePath);
  return {
    title: basename(filePath),
    path: filePath,
    lastModified: stat.mtime.toISOString(),
    lineCount,
  };
}

/**
 * Map summary card to Notion page properties.
 */
export function summaryCardToNotionProperties(card: SummaryCard): any {
  return {
    Name: { title: [{ text: { content: card.title } }] },
    Path: { rich_text: [{ text: { content: card.path } }] },
    "Last Modified": { date: { start: card.lastModified } },
    "Line Count": { number: card.lineCount },
  };
}
