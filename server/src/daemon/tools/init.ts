import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, join, basename } from "path";
import type { DaemonContext } from "../context.js";
import { ensureConfigFile, loadConfig, getInterkastenDir } from "../../config/loader.js";
import { NotionClient } from "../../sync/notion-client.js";
import { registerProject, registerDoc } from "../../sync/entity-map.js";
import {
  findKeyDocs,
  enrichWithNotionIds,
  getKeyDocDbProperties,
  updateProjectKeyDocs,
} from "../../sync/key-docs.js";
import { triageProject } from "../../sync/triage.js";
import { updateDocTier } from "../../store/entities.js";

interface InitManifest {
  created_at: string;
  workspace_id: string | null;
  resources: Array<{
    type: string;
    id: string;
    name: string;
    step: number;
  }>;
  completed: boolean;
}

export function registerInitTool(server: McpServer, ctx: DaemonContext): void {
  server.tool(
    "interkasten_init",
    "First-time setup: validate token, create Notion workspace structure, scan projects, register discovered projects",
    {
      projects_dir: z
        .string()
        .optional()
        .describe("Override projects directory (default: from config or ~/projects)"),
      reset: z.boolean().optional().describe("Reset and start over if previous init was incomplete"),
    },
    async ({ projects_dir, reset }) => {
      const output: string[] = [];

      // 1. Ensure config exists
      const configPath = ensureConfigFile();
      const config = loadConfig(configPath);
      ctx.config = config;
      output.push(`Config: ${configPath}`);

      // 2. Validate Notion token
      const token = process.env.INTERKASTEN_NOTION_TOKEN;
      if (!token) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "INTERKASTEN_NOTION_TOKEN not set.",
                "",
                "To get started:",
                "1. Go to https://www.notion.so/my-integrations",
                '2. Click "New integration"',
                '3. Name it "Interkasten"',
                "4. Required capabilities: Read content, Update content, Insert content, Read user information",
                '5. Copy the "Internal Integration Secret" (starts with ntn_)',
                "6. Run: export INTERKASTEN_NOTION_TOKEN='ntn_...'",
                "7. Add it to your .bashrc/.zshrc for persistence",
                "8. Restart Claude Code and run /interkasten:init again",
              ].join("\n"),
            },
          ],
          isError: true,
        };
      }

      const notion = new NotionClient({
        token,
        concurrency: 3,
        initialDelayMs: config.sync.backoff.initial_delay_ms,
        maxDelayMs: config.sync.backoff.max_delay_ms,
        circuitBreakerThreshold: config.sync.backoff.circuit_breaker_threshold,
        circuitBreakerCheckInterval: config.sync.backoff.circuit_breaker_check_interval,
      });

      const { valid, error } = await notion.validateToken();
      if (!valid) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Notion token validation failed: ${error?.message}\n\n${error?.remediation}`,
            },
          ],
          isError: true,
        };
      }
      ctx.notion = notion;
      output.push("Notion token: valid");

      // 3. Check for existing init manifest
      const interkastenDir = getInterkastenDir();
      const manifestPath = resolve(interkastenDir, "init-manifest.json");
      let manifest: InitManifest | null = null;

      if (existsSync(manifestPath)) {
        manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

        if (manifest && manifest.completed && !reset) {
          output.push("Previous init completed successfully.");
          output.push("Use reset=true to start over.");
        }

        if (manifest && !manifest.completed && !reset) {
          output.push(
            `Previous init was incomplete (${manifest.resources.length} resources created).`
          );
          output.push("Resuming from last step...");
        }
      }

      // 4. Create Notion databases
      const projectsDir = projects_dir
        ? resolve(projects_dir)
        : config.projects_dir;

      if (!manifest || !manifest.completed || reset) {
        manifest = {
          created_at: new Date().toISOString(),
          workspace_id: null,
          resources: [],
          completed: false,
        };

        try {
          // Create Projects database
          const projectsDb = await notion.call(async () => {
            return notion.raw.databases.create({
              parent: { type: "page_id", page_id: await getWorkspacePageId(notion) },
              title: [{ type: "text", text: { content: "Projects" } }],
              properties: {
                Name: { title: {} },
                Status: {
                  select: {
                    options: [
                      { name: "Active", color: "green" },
                      { name: "Archived", color: "gray" },
                      { name: "Syncing", color: "blue" },
                    ],
                  },
                },
                "Last Sync": { date: {} },
                "Health Score": { number: { format: "percent" } },
                "Tech Stack": { rich_text: {} },
                "Doc Tier": {
                  select: {
                    options: [
                      { name: "Product", color: "green" },
                      { name: "Tool", color: "blue" },
                      { name: "Inactive", color: "gray" },
                    ],
                  },
                },
                ...getKeyDocDbProperties(),
              },
            });
          });
          manifest.resources.push({
            type: "database",
            id: projectsDb.id,
            name: "Projects",
            step: 1,
          });
          output.push(`Created Projects database: ${projectsDb.id}`);

          // Create Research Inbox database
          const researchDb = await notion.call(async () => {
            return notion.raw.databases.create({
              parent: { type: "page_id", page_id: await getWorkspacePageId(notion) },
              title: [{ type: "text", text: { content: "Research Inbox" } }],
              properties: {
                Title: { title: {} },
                URL: { url: {} },
                Status: {
                  select: {
                    options: [
                      { name: "New", color: "yellow" },
                      { name: "Processing", color: "blue" },
                      { name: "Classified", color: "green" },
                      { name: "Done", color: "gray" },
                    ],
                  },
                },
                "Source Type": { rich_text: {} },
                "Added By": { rich_text: {} },
              },
            });
          });
          manifest.resources.push({
            type: "database",
            id: researchDb.id,
            name: "Research Inbox",
            step: 2,
          });
          output.push(`Created Research Inbox database: ${researchDb.id}`);

          // Create Pagent Workflows database
          const workflowsDb = await notion.call(async () => {
            return notion.raw.databases.create({
              parent: { type: "page_id", page_id: await getWorkspacePageId(notion) },
              title: [{ type: "text", text: { content: "Pagent Workflows" } }],
              properties: {
                Name: { title: {} },
                Status: {
                  select: {
                    options: [
                      { name: "Active", color: "green" },
                      { name: "Paused", color: "yellow" },
                      { name: "Error", color: "red" },
                    ],
                  },
                },
                "Last Run": { date: {} },
                "Run Count": { number: {} },
                "Error Count": { number: {} },
              },
            });
          });
          manifest.resources.push({
            type: "database",
            id: workflowsDb.id,
            name: "Pagent Workflows",
            step: 3,
          });
          output.push(`Created Pagent Workflows database: ${workflowsDb.id}`);

          // Update config with database IDs
          const { setConfigValue } = await import("../../config/loader.js");
          setConfigValue("notion.databases.projects", projectsDb.id);
          setConfigValue("notion.databases.research_inbox", researchDb.id);
          setConfigValue("notion.databases.pagent_workflows", workflowsDb.id);
          ctx.config = loadConfig();

          manifest.completed = true;
        } catch (err) {
          output.push(`Error during init: ${(err as Error).message}`);
          // Save partial manifest for resume
          writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
          return {
            content: [{ type: "text" as const, text: output.join("\n") }],
            isError: true,
          };
        }

        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      }

      // 5. Scan projects directory
      if (existsSync(projectsDir) && ctx.db) {
        const discovered = discoverProjects(projectsDir, config.project_detection.markers, config.project_detection.max_depth);
        output.push(`\nDiscovered ${discovered.length} projects in ${projectsDir}:`);

        const projectsDbId = ctx.config.notion.databases.projects;
        if (projectsDbId) {
          for (const projPath of discovered) {
            const projName = basename(projPath);
            try {
              // Create project page in Notion
              const page = await notion.call(async () => {
                return notion.raw.pages.create({
                  parent: { database_id: projectsDbId },
                  properties: {
                    Name: { title: [{ text: { content: projName } }] },
                    Status: { select: { name: "Active" } },
                    "Last Sync": { date: { start: new Date().toISOString() } },
                  },
                });
              });

              // Register in entity_map
              registerProject(ctx.db, projPath, page.id);
              output.push(`  + ${projName} → ${page.id}`);

              // Scan for markdown docs in the project
              const mdFiles = findMarkdownFiles(projPath);
              for (const mdFile of mdFiles.slice(0, 20)) {
                // Register docs (they'll be synced on next push cycle)
                // For now, create placeholder pages
                const docName = basename(mdFile, ".md");
                const docPage = await notion.call(async () => {
                  return notion.raw.pages.create({
                    parent: { page_id: page.id },
                    properties: {
                      title: [{ text: { content: docName } }],
                    },
                  });
                });
                registerDoc(ctx.db, mdFile, docPage.id, "T1");
              }

              // Set key doc columns on the project page
              try {
                const keyDocs = findKeyDocs(projPath);
                const enriched = enrichWithNotionIds(ctx.db, projPath, keyDocs);
                await updateProjectKeyDocs(notion, page.id, enriched);
                const missing = enriched.filter((d) => !d.path).map((d) => d.type);
                if (missing.length > 0) {
                  output.push(`    missing: ${missing.join(", ")}`);
                }
              } catch (err) {
                output.push(`    key docs error: ${(err as Error).message}`);
              }

              // Triage: classify project and set doc tier
              try {
                const entity = registerProject(ctx.db, projPath, page.id);
                const triage = triageProject(projPath);
                updateDocTier(ctx.db, entity.id, triage.tier);

                // Update Notion with tier
                await notion.call(async () => {
                  return notion.raw.pages.update({
                    page_id: page.id,
                    properties: {
                      "Doc Tier": { select: { name: triage.tier } },
                    },
                  });
                });
                output.push(`    tier: ${triage.tier} (${triage.requiredDocs.length} docs required)`);
              } catch (err) {
                output.push(`    triage error: ${(err as Error).message}`);
              }
            } catch (err) {
              output.push(`  ! ${projName}: ${(err as Error).message}`);
            }
          }
        }
      }

      output.push("\nInit complete. Sync engine ready.");
      output.push("Edit a .md file in your projects directory — it will sync to Notion automatically.");

      return {
        content: [{ type: "text" as const, text: output.join("\n") }],
      };
    }
  );
}

/**
 * Get a page ID to use as parent for databases.
 * Searches for an existing "Interkasten" page or creates one.
 */
async function getWorkspacePageId(notion: NotionClient): Promise<string> {
  // Search for existing Interkasten page
  const searchResult = await notion.call(async () => {
    return notion.raw.search({
      query: "Interkasten",
      filter: { property: "object", value: "page" },
      page_size: 1,
    });
  });

  if (searchResult.results.length > 0) {
    return searchResult.results[0]!.id;
  }

  // Create a new page (we need a parent page — search for any accessible page)
  const anyPage = await notion.call(async () => {
    return notion.raw.search({
      filter: { property: "object", value: "page" },
      page_size: 1,
    });
  });

  if (anyPage.results.length === 0) {
    throw new Error(
      "No accessible Notion pages found. Share a page with your Interkasten integration first."
    );
  }

  const parentId = anyPage.results[0]!.id;
  const page = await notion.call(async () => {
    return notion.raw.pages.create({
      parent: { page_id: parentId },
      properties: {
        title: [{ text: { content: "Interkasten" } }],
      },
    });
  });

  return page.id;
}

/**
 * Discover projects in a directory by looking for marker files/dirs.
 */
function discoverProjects(
  dir: string,
  markers: string[],
  maxDepth: number,
  currentDepth = 0
): string[] {
  if (currentDepth >= maxDepth) return [];
  if (!existsSync(dir)) return [];

  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  // Check if this directory is a project
  const hasMarker = markers.some((marker) => entries.includes(marker));
  if (hasMarker && currentDepth > 0) {
    results.push(dir);
    return results; // Don't recurse into project subdirs
  }

  // Recurse into subdirectories
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const fullPath = join(dir, entry);
    try {
      if (statSync(fullPath).isDirectory()) {
        results.push(...discoverProjects(fullPath, markers, maxDepth, currentDepth + 1));
      }
    } catch {
      // Skip inaccessible dirs
    }
  }

  return results;
}

/**
 * Find markdown files in a project directory (non-recursive for now).
 */
function findMarkdownFiles(projectDir: string): string[] {
  const results: string[] = [];
  const docsDir = join(projectDir, "docs");

  // Check root-level markdown files
  try {
    for (const entry of readdirSync(projectDir)) {
      if (entry.endsWith(".md") && !entry.startsWith(".")) {
        results.push(join(projectDir, entry));
      }
    }
  } catch {
    // Skip
  }

  // Check docs/ directory
  if (existsSync(docsDir)) {
    try {
      for (const entry of readdirSync(docsDir)) {
        if (entry.endsWith(".md")) {
          results.push(join(docsDir, entry));
        }
      }
    } catch {
      // Skip
    }
  }

  return results;
}
