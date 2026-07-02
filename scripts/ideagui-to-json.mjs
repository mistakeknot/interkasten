#!/usr/bin/env node
/**
 * Transform interkasten-synced markdown files into ideagui.json.
 * Reads frontmatter from each .md file in the input directory,
 * produces the same JSON schema that Meadowsyn and other consumers expect.
 *
 * Usage: node scripts/ideagui-to-json.mjs [input_dir] [output_file]
 *   input_dir  — directory of synced .md files (default: ~/projects/transfer/ideagui)
 *   output_file — JSON output path (default: ~/projects/transfer/ideagui.json)
 */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const matter = require("../server/node_modules/gray-matter");

const DEFAULT_INPUT = resolve(process.env.HOME, "projects/transfer/ideagui");
const DEFAULT_OUTPUT = resolve(DEFAULT_INPUT, "ideagui.json");
const DATABASE_ID = "1728711309c14db4ac34d9d6f7f3028a";
const DATA_SOURCE_ID = "c158161b-e088-4045-9484-4779d4c5bc4f";

function main() {
  const inputDir = process.argv[2] ?? DEFAULT_INPUT;
  const outputFile = process.argv[3] ?? DEFAULT_OUTPUT;

  // Read all .md files (skip _index.md)
  const files = readdirSync(inputDir)
    .filter(f => f.endsWith(".md") && f !== "_index.md")
    .sort();

  const sessions = [];

  for (const file of files) {
    const content = readFileSync(join(inputDir, file), "utf-8");
    const { data: fm } = matter(content);

    sessions.push({
      session: fm.title || null,
      project: fm.project || null,
      terminal: fm.terminal || null,
      pane: fm.pane || null,
      domain: fm.domain || null,
      agent: fm.agent || null,
      sync: fm.sync || null,
    });
  }

  // Build summary aggregations
  const summary = {
    by_project: countBy(sessions, "project"),
    by_terminal: countBy(sessions, "terminal"),
    by_agent: countBy(sessions, "agent"),
    by_sync: countBy(sessions, "sync"),
  };

  const output = {
    meta: {
      database_id: DATABASE_ID,
      data_source_id: DATA_SOURCE_ID,
      notion_url: `https://www.notion.so/${DATABASE_ID}`,
      generated: new Date().toISOString(),
      total_sessions: sessions.length,
      description:
        "IdeaGUI ('Idea Guy') — operational resource management and idea capture for all agent sessions. Synced from Notion via interkasten. Regenerate: node interverse/interkasten/scripts/ideagui-to-json.mjs",
    },
    summary,
    sessions,
  };

  writeFileSync(outputFile, JSON.stringify(output, null, 2) + "\n", "utf-8");
  console.log(`${sessions.length} sessions → ${outputFile}`);
}

/** Count occurrences of a field value, sorted descending by count. */
function countBy(items, field) {
  const counts = {};
  for (const item of items) {
    const val = item[field];
    if (val) counts[val] = (counts[val] || 0) + 1;
  }
  // Sort descending by count
  return Object.fromEntries(
    Object.entries(counts).sort(([, a], [, b]) => b - a)
  );
}

main();
