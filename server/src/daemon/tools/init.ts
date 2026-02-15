import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  existsSync,
  readdirSync,
  statSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
} from "fs";
import { resolve, join, basename } from "path";
import type { DaemonContext } from "../context.js";
import { ensureConfigFile, loadConfig, getinterkastenDir } from "../../config/loader.js";
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

/**
 * A discovered project with its hierarchy.
 */
export interface DiscoveredProject {
  path: string;
  markers: string[]; // which markers were found ([".git"], [".beads"], [".git", ".beads"])
  children: DiscoveredProject[];
}

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
                '3. Name it "interkasten"',
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
      const interkastenDir = getinterkastenDir();
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
        const discoveryTree = discoverProjects(
          projectsDir,
          config.project_detection.markers,
          config.project_detection.exclude,
          config.project_detection.max_depth,
          config.project_detection.hierarchy_marker,
          config.layout.resolve_symlinks
        );
        const discovered = flattenDiscovery(discoveryTree);
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
              const projEntity = registerProject(ctx.db, projPath, page.id);
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
                const enriched = enrichWithNotionIds(ctx.db, projEntity.id, keyDocs);
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
 * Searches for an existing "interkasten" page or creates one.
 */
async function getWorkspacePageId(notion: NotionClient): Promise<string> {
  // Search for existing interkasten page
  const searchResult = await notion.call(async () => {
    return notion.raw.search({
      query: "interkasten",
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
      "No accessible Notion pages found. Share a page with your interkasten integration first."
    );
  }

  const parentId = anyPage.results[0]!.id;
  const page = await notion.call(async () => {
    return notion.raw.pages.create({
      parent: { page_id: parentId },
      properties: {
        title: [{ text: { content: "interkasten" } }],
      },
    });
  });

  return page.id;
}

/**
 * Discover projects in a directory, returning a hierarchy tree.
 *
 * Hierarchy rules:
 * - Any directory with a marker (.git or .beads) is a project
 * - If a project has the hierarchy_marker (.beads), it can be a parent — continue recursing
 * - If a project only has non-hierarchy markers (.git without .beads), it's a leaf — don't recurse
 * - Intermediate directories without any marker are transparent (traversed, not registered)
 * - Parent-child: nearest ancestor with the hierarchy_marker is the parent
 *
 * @param seenPaths - Set of resolved real paths for symlink deduplication
 */
export function discoverProjects(
  dir: string,
  markers: string[],
  exclude: string[],
  maxDepth: number,
  hierarchyMarker: string,
  resolveSymlinks: boolean,
  currentDepth = 0,
  seenPaths?: Set<string>
): DiscoveredProject[] {
  if (currentDepth >= maxDepth) return [];
  if (!existsSync(dir)) return [];

  const seen = seenPaths ?? new Set<string>();

  // Symlink dedup: resolve to real path, skip if already seen
  if (resolveSymlinks) {
    try {
      const realPath = realpathSync(dir);
      if (seen.has(realPath)) return [];
      seen.add(realPath);
    } catch {
      // Can't resolve — proceed with original path
    }
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const excludeSet = new Set(exclude);

  // Check which markers this directory has
  const foundMarkers = markers.filter((m) => entries.includes(m));
  const isProject = foundMarkers.length > 0 && currentDepth > 0;
  const hasHierarchyMarker = foundMarkers.includes(hierarchyMarker);

  if (isProject && !hasHierarchyMarker) {
    // Leaf project (e.g., .git only, no .beads) — register, don't recurse
    return [{ path: dir, markers: foundMarkers, children: [] }];
  }

  // Either: (a) this is a hierarchy-capable project (.beads) — recurse for children
  //     or: (b) this is not a project at all — recurse to find projects below
  const children: DiscoveredProject[] = [];

  for (const entry of entries) {
    if (entry.startsWith(".") || excludeSet.has(entry)) continue;
    const fullPath = join(dir, entry);
    try {
      // Skip symlinks to non-directories and check symlink targets
      const lstats = lstatSync(fullPath);
      if (lstats.isSymbolicLink()) {
        if (!resolveSymlinks) continue; // skip symlinks if not resolving
        // For symlinks, check if target is a directory
        try {
          if (!statSync(fullPath).isDirectory()) continue;
        } catch {
          continue; // broken symlink
        }
      } else if (!lstats.isDirectory()) {
        continue;
      }

      children.push(
        ...discoverProjects(fullPath, markers, exclude, maxDepth, hierarchyMarker, resolveSymlinks, currentDepth + 1, seen)
      );
    } catch {
      // Skip inaccessible dirs
    }
  }

  if (isProject) {
    // This is a hierarchy-capable project with children
    return [{ path: dir, markers: foundMarkers, children }];
  }

  // Not a project — return discovered children as-is (transparent directory)
  return children;
}

/**
 * Flatten a discovery tree into a list of paths (for backward compatibility).
 */
export function flattenDiscovery(projects: DiscoveredProject[]): string[] {
  const result: string[] = [];
  for (const p of projects) {
    result.push(p.path);
    result.push(...flattenDiscovery(p.children));
  }
  return result;
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
