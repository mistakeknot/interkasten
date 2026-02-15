import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { basename } from "path";
import type { DaemonContext } from "../context.js";
import {
  listProjects,
  lookupByPath,
  setProjectParent,
  setProjectTags,
  getProjectChildren,
  getProjectParent,
  getProjectTags,
} from "../../sync/entity-map.js";
import { discoverProjects, type DiscoveredProject } from "./init.js";
import { gatherProjectSignals } from "./signals.js";

export function registerHierarchyTools(server: McpServer, ctx: DaemonContext): void {
  server.tool(
    "interkasten_scan_preview",
    "Preview what projects would be discovered without registering anything. Returns hierarchy tree with raw signals. Writes nothing to SQLite or Notion.",
    {
      root_dir: z
        .string()
        .optional()
        .describe("Directory to scan (default: projects_dir from config)"),
      max_depth: z
        .number()
        .optional()
        .describe("Override max scan depth (default: from config)"),
    },
    async ({ root_dir, max_depth }) => {
      const config = ctx.config;
      const projectsDir = root_dir ?? config.projects_dir;
      const depth = max_depth ?? config.project_detection.max_depth;

      const tree = discoverProjects(
        projectsDir,
        config.project_detection.markers,
        config.project_detection.exclude,
        depth,
        config.project_detection.hierarchy_marker,
        config.layout.resolve_symlinks
      );

      // Enrich with signals
      const enriched = enrichTree(tree);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            root: projectsDir,
            max_depth: depth,
            hierarchy_marker: config.project_detection.hierarchy_marker,
            project_count: countProjects(tree),
            projects: enriched,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "interkasten_set_project_parent",
    "Set or change a project's parent. Pass null for parent to make it top-level.",
    {
      project: z.string().describe("Project name or path"),
      parent: z
        .string()
        .nullable()
        .describe("Parent project name or path, or null to make top-level"),
    },
    async ({ project: projectInput, parent: parentInput }) => {
      if (!ctx.db) {
        return {
          content: [{ type: "text" as const, text: "Database not connected" }],
          isError: true,
        };
      }

      // Resolve project
      const projectEntity = resolveProject(ctx, projectInput);
      if (!projectEntity) {
        return {
          content: [{
            type: "text" as const,
            text: `Project not found: ${projectInput}`,
          }],
          isError: true,
        };
      }

      // Resolve parent
      let parentId: number | null = null;
      if (parentInput !== null) {
        const parentEntity = resolveProject(ctx, parentInput);
        if (!parentEntity) {
          return {
            content: [{
              type: "text" as const,
              text: `Parent project not found: ${parentInput}`,
            }],
            isError: true,
          };
        }

        // Prevent circular references
        if (parentEntity.id === projectEntity.id) {
          return {
            content: [{
              type: "text" as const,
              text: "A project cannot be its own parent.",
            }],
            isError: true,
          };
        }

        parentId = parentEntity.id;
      }

      setProjectParent(ctx.db, projectEntity.id, parentId);

      // Update Notion relation if connected
      if (ctx.notion && parentId !== null) {
        try {
          const parentEntity = resolveProject(ctx, parentInput!);
          if (parentEntity) {
            await ctx.notion.call(async () => {
              return ctx.notion!.raw.pages.update({
                page_id: projectEntity.notionId,
                properties: {
                  "Parent Project": {
                    relation: [{ id: parentEntity.notionId }],
                  },
                },
              });
            });
          }
        } catch {
          // Non-fatal — Parent Project relation may not exist yet
        }
      } else if (ctx.notion && parentId === null) {
        try {
          await ctx.notion.call(async () => {
            return ctx.notion!.raw.pages.update({
              page_id: projectEntity.notionId,
              properties: {
                "Parent Project": { relation: [] },
              },
            });
          });
        } catch {
          // Non-fatal
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: parentInput
            ? `Set parent of ${basename(projectEntity.localPath)} to ${parentInput}`
            : `Made ${basename(projectEntity.localPath)} a top-level project`,
        }],
      };
    }
  );

  server.tool(
    "interkasten_set_project_tags",
    "Set tags on a project. Replaces all existing tags.",
    {
      project: z.string().describe("Project name or path"),
      tags: z.array(z.string()).describe("Tags to set"),
    },
    async ({ project: projectInput, tags }) => {
      if (!ctx.db) {
        return {
          content: [{ type: "text" as const, text: "Database not connected" }],
          isError: true,
        };
      }

      const projectEntity = resolveProject(ctx, projectInput);
      if (!projectEntity) {
        return {
          content: [{
            type: "text" as const,
            text: `Project not found: ${projectInput}`,
          }],
          isError: true,
        };
      }

      setProjectTags(ctx.db, projectEntity.id, tags);

      // Update Notion multi-select if connected
      if (ctx.notion) {
        try {
          await ctx.notion.call(async () => {
            return ctx.notion!.raw.pages.update({
              page_id: projectEntity.notionId,
              properties: {
                Tags: {
                  multi_select: tags.map((t) => ({ name: t })),
                },
              },
            });
          });
        } catch {
          // Non-fatal — Tags column may not exist yet
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: `Set tags on ${basename(projectEntity.localPath)}: ${tags.length > 0 ? tags.join(", ") : "(none)"}`,
        }],
      };
    }
  );

  server.tool(
    "interkasten_add_database_property",
    "Add a property to the Projects database. Idempotent — existing properties are not modified.",
    {
      name: z.string().describe("Property name"),
      type: z
        .enum(["select", "multi_select", "url", "date", "number", "rich_text", "relation", "checkbox"])
        .describe("Property type"),
      options: z
        .array(z.object({
          name: z.string(),
          color: z.string().optional(),
        }))
        .optional()
        .describe("For select/multi_select: initial options with optional colors"),
    },
    async ({ name, type, options }) => {
      if (!ctx.notion) {
        return {
          content: [{
            type: "text" as const,
            text: "Notion client not connected. Run interkasten_init first.",
          }],
          isError: true,
        };
      }

      const projectsDbId = ctx.config.notion.databases.projects;
      if (!projectsDbId) {
        return {
          content: [{
            type: "text" as const,
            text: "Projects database not configured. Run interkasten_init first.",
          }],
          isError: true,
        };
      }

      // Build property definition
      const propDef: Record<string, unknown> = {};

      switch (type) {
        case "select":
          propDef[name] = {
            select: options ? { options } : {},
          };
          break;
        case "multi_select":
          propDef[name] = {
            multi_select: options ? { options } : {},
          };
          break;
        case "relation":
          // Self-referential relation for hierarchy
          propDef[name] = {
            relation: {
              database_id: projectsDbId,
              single_property: {},
            },
          };
          break;
        case "url":
          propDef[name] = { url: {} };
          break;
        case "date":
          propDef[name] = { date: {} };
          break;
        case "number":
          propDef[name] = { number: {} };
          break;
        case "rich_text":
          propDef[name] = { rich_text: {} };
          break;
        case "checkbox":
          propDef[name] = { checkbox: {} };
          break;
      }

      try {
        await ctx.notion.call(async () => {
          return ctx.notion!.raw.databases.update({
            database_id: projectsDbId,
            properties: propDef as any,
          });
        });

        return {
          content: [{
            type: "text" as const,
            text: `Added property "${name}" (${type}) to Projects database.`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to add property: ${(err as Error).message}`,
          }],
          isError: true,
        };
      }
    }
  );
}

// --- Helpers ---

function resolveProject(ctx: DaemonContext, input: string) {
  if (!ctx.db) return undefined;

  let entity = lookupByPath(ctx.db, input);
  if (!entity) {
    const projects = listProjects(ctx.db);
    entity = projects.find((p) => basename(p.localPath) === input);
  }
  return entity;
}

interface EnrichedDiscoveredProject {
  path: string;
  name: string;
  markers: string[];
  signals: ReturnType<typeof gatherProjectSignals>;
  children: EnrichedDiscoveredProject[];
}

function enrichTree(projects: DiscoveredProject[]): EnrichedDiscoveredProject[] {
  return projects.map((p) => ({
    path: p.path,
    name: basename(p.path),
    markers: p.markers,
    signals: gatherProjectSignals(p.path),
    children: enrichTree(p.children),
  }));
}

function countProjects(projects: DiscoveredProject[]): number {
  let count = projects.length;
  for (const p of projects) {
    count += countProjects(p.children);
  }
  return count;
}
