#!/usr/bin/env node
/**
 * One-shot script to track the IdeaGUI Notion database.
 * Uses the interkasten server library directly (no MCP).
 *
 * Usage: INTERKASTEN_NOTION_TOKEN=ntn_... node scripts/track-ideagui.mjs [output_dir]
 */
import { resolve, join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { loadConfig } from "../server/dist/config/loader.js";
import { NotionClient } from "../server/dist/sync/notion-client.js";
import { TokenResolver } from "../server/dist/sync/token-resolver.js";
import { extractDatabaseSchema } from "../server/dist/sync/discovery.js";
import {
  rowToFrontmatter,
  sanitizeTitle,
  generateTableMarkdown,
} from "../server/dist/sync/databases.js";
import { stringifyFrontmatter } from "../server/dist/sync/frontmatter.js";
import { notionBlocksToMarkdown } from "../server/dist/sync/translator.js";

const DATABASE_ID = "1728711309c14db4ac34d9d6f7f3028a";
const DEFAULT_OUTPUT = resolve(process.env.HOME, "projects/transfer/ideagui");

async function main() {
  const outputDir = process.argv[2] ?? DEFAULT_OUTPUT;

  // Load config (picks up .interkasten.yaml via project-level scoping)
  const config = loadConfig();
  const token = process.env.INTERKASTEN_NOTION_TOKEN;
  if (!token) {
    console.error("INTERKASTEN_NOTION_TOKEN not set");
    process.exit(1);
  }

  const resolver = new TokenResolver(config, token);
  const client = resolver.getClientFor({ databaseId: DATABASE_ID });

  // Validate
  const { valid, error } = await client.validateToken();
  if (!valid) {
    console.error("Token invalid:", error?.message);
    process.exit(1);
  }
  console.log("Token valid");

  // Resolve database_id → data_source_id
  const db = await client.call(() =>
    client.raw.databases.retrieve({ database_id: DATABASE_ID })
  );
  const dsId = db.data_sources?.[0]?.id;
  if (!dsId) {
    console.error("No data sources on database");
    process.exit(1);
  }
  console.log(`Database: ${db.title?.map(t => t.plain_text).join("")}`);
  console.log(`Data source: ${dsId}`);

  // Get schema
  const ds = await client.call(() =>
    client.raw.dataSources.retrieve({ data_source_id: dsId })
  );
  const schema = extractDatabaseSchema(ds);
  console.log(`Properties: ${Object.keys(schema.properties).length}`);

  // Ensure output dir
  mkdirSync(outputDir, { recursive: true });

  // Fetch all rows
  const rows = await client.queryDataSource(dsId);
  console.log(`Rows: ${rows.length}`);

  // Write each row as markdown with frontmatter
  const usedFilenames = new Set();
  let count = 0;
  for (const row of rows) {
    const fm = rowToFrontmatter(row, schema);
    let filename = sanitizeTitle(fm.title || "Untitled");
    if (usedFilenames.has(filename.toLowerCase())) {
      filename = `${filename}-${row.id.slice(-4)}`;
    }
    usedFilenames.add(filename.toLowerCase());

    const filePath = join(outputDir, `${filename}.md`);

    let body = "";
    try {
      body = await notionBlocksToMarkdown(client.raw, row.id);
    } catch {
      // Some rows have no body
    }

    const content = stringifyFrontmatter(fm, body);
    writeFileSync(filePath, content, "utf-8");
    count++;
  }

  // Generate index table
  const indexContent = [
    `---`,
    `notion_id: ${DATABASE_ID}`,
    `notion_type: database`,
    `title: "${schema.title}"`,
    `last_synced: "${new Date().toISOString()}"`,
    `---`,
    ``,
    `# ${schema.title}`,
    ``,
    generateTableMarkdown(rows, schema),
    ``,
  ].join("\n");
  writeFileSync(join(outputDir, "_index.md"), indexContent, "utf-8");

  console.log(`\nDone: ${count} rows → ${outputDir}`);
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
