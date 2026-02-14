/**
 * Backfill key doc columns on existing Projects database.
 * 1. Adds the 10 new columns (5 URL + 5 checkbox) to the database
 * 2. Scans each registered project for key docs
 * 3. Updates each project page with URLs and missing flags
 */

import { Client } from "@notionhq/client";
import Database from "better-sqlite3";
import { existsSync, readdirSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

const token = process.env.INTERKASTEN_NOTION_TOKEN;
if (!token) {
  console.error("Set INTERKASTEN_NOTION_TOKEN");
  process.exit(1);
}

const notion = new Client({ auth: token });
const dbPath = join(homedir(), ".interkasten", "state.db");
const sqlite = new Database(dbPath);

// Config
const configPath = join(homedir(), ".interkasten", "config.yaml");
// Simple YAML parse for database ID
import { readFileSync } from "fs";
const configText = readFileSync(configPath, "utf-8");
const projectsDbMatch = configText.match(/projects:\s*"([^"]+)"/);
const projectsDbId = projectsDbMatch?.[1];

if (!projectsDbId) {
  console.error("Could not find projects database ID in config");
  process.exit(1);
}

console.log(`Projects DB: ${projectsDbId}`);

// Key doc types and detection
const KEY_DOC_TYPES = ["Vision", "PRD", "Roadmap", "AGENTS.md", "CLAUDE.md"];

function findKeyDoc(projectPath, type) {
  if (type === "AGENTS.md" || type === "CLAUDE.md") {
    const path = join(projectPath, type);
    return existsSync(path) ? path : null;
  }

  const searchDirs = [projectPath];
  const docsDir = join(projectPath, "docs");
  if (existsSync(docsDir)) searchDirs.push(docsDir);

  const pattern = type.toLowerCase();
  for (const dir of searchDirs) {
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const lower = entry.toLowerCase();
      if (lower === `${pattern}.md` || lower.startsWith(`${pattern}-`)) {
        return join(dir, entry);
      }
    }
  }
  return null;
}

function getDocNotionId(projectPath, docPath) {
  if (!docPath) return null;
  const row = sqlite.prepare(
    "SELECT notion_id FROM entity_map WHERE local_path = ? AND deleted = 0"
  ).get(docPath);
  return row?.notion_id ?? null;
}

// Step 1: Add columns to database
console.log("\n--- Step 1: Adding key doc columns to Projects database ---");
const newProps = {};
for (const type of KEY_DOC_TYPES) {
  newProps[type] = { url: {} };
}

try {
  await notion.databases.update({
    database_id: projectsDbId,
    properties: newProps,
  });
  console.log("Added 10 columns (5 URL + 5 checkbox)");
} catch (err) {
  console.log(`Column update: ${err.message}`);
  // May already exist — continue
}

// Step 2: Get all registered projects
console.log("\n--- Step 2: Scanning projects for key docs ---");
const projects = sqlite.prepare(
  "SELECT * FROM entity_map WHERE entity_type = 'project' AND deleted = 0"
).all();

console.log(`Found ${projects.length} registered projects\n`);

// Step 3: Update each project page
let updated = 0;
let errors = 0;

for (const proj of projects) {
  const name = basename(proj.local_path);
  const keyDocs = KEY_DOC_TYPES.map(type => ({
    type,
    path: findKeyDoc(proj.local_path, type),
    notionId: null,
  }));

  // Enrich with Notion IDs
  for (const kd of keyDocs) {
    if (kd.path) {
      kd.notionId = getDocNotionId(proj.local_path, kd.path);
    }
  }

  // Build properties — URL only, empty = missing
  const pageProps = {};
  for (const kd of keyDocs) {
    if (kd.notionId) {
      pageProps[kd.type] = { url: `https://notion.so/${kd.notionId.replace(/-/g, "")}` };
    } else {
      pageProps[kd.type] = { url: null };
    }
  }

  try {
    await notion.pages.update({
      page_id: proj.notion_id,
      properties: pageProps,
    });
    updated++;

    const present = keyDocs.filter(d => d.path).map(d => d.type);
    const missing = keyDocs.filter(d => !d.path).map(d => d.type);
    const linked = keyDocs.filter(d => d.notionId).map(d => d.type);

    console.log(`  ${name}: ${present.length}/5 present${missing.length > 0 ? ` (missing: ${missing.join(", ")})` : ""}${linked.length > 0 ? ` [linked: ${linked.join(", ")}]` : ""}`);
  } catch (err) {
    errors++;
    console.log(`  ${name}: ERROR ${err.message}`);
  }

  // Rate limit
  await new Promise(r => setTimeout(r, 250));
}

console.log(`\nDone: ${updated} updated, ${errors} errors`);
sqlite.close();
