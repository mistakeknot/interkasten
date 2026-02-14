import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readdirSync, statSync } from "fs";
import { basename, join } from "path";
import type { DaemonContext } from "../context.js";
import {
  listProjects,
  lookupByPath,
  registerProject,
  registerDoc,
} from "../../sync/entity-map.js";
import {
  softDeleteEntity,
  listEntities,
} from "../../store/entities.js";
import { appendSyncLog } from "../../store/sync-log.js";

export function registerProjectTools(server: McpServer, ctx: DaemonContext): void {
  server.tool(
    "interkasten_list_projects",
    "List all discovered projects with sync status and Notion URLs",
    {},
    async () => {
      if (!ctx.db) {
        return {
          content: [{ type: "text" as const, text: "Database not connected" }],
          isError: true,
        };
      }

      const projects = listProjects(ctx.db);
      const result = projects.map((p) => ({
        name: basename(p.localPath),
        local_path: p.localPath,
        notion_id: p.notionId,
        last_sync: p.lastSyncTs,
        notion_url: `https://notion.so/${p.notionId.replace(/-/g, "")}`,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: projects.length === 0
              ? "No projects registered. Run interkasten_init to discover and register projects."
              : JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "interkasten_get_project",
    "Get detailed project info: docs, sync status, Notion URL",
    {
      path: z.string().describe("Local project path or project name"),
    },
    async ({ path }) => {
      if (!ctx.db) {
        return {
          content: [{ type: "text" as const, text: "Database not connected" }],
          isError: true,
        };
      }

      // Try exact path first, then search by name
      let entity = lookupByPath(ctx.db, path);
      if (!entity) {
        const projects = listProjects(ctx.db);
        entity = projects.find((p) => basename(p.localPath) === path);
      }

      if (!entity) {
        return {
          content: [
            { type: "text" as const, text: `Project not found: ${path}` },
          ],
          isError: true,
        };
      }

      // Get associated docs
      const allEntities = listEntities(ctx.db);
      const docs = allEntities.filter(
        (e) =>
          e.entityType === "doc" &&
          e.localPath.startsWith(entity!.localPath)
      );

      const result = {
        name: basename(entity.localPath),
        local_path: entity.localPath,
        notion_id: entity.notionId,
        notion_url: `https://notion.so/${entity.notionId.replace(/-/g, "")}`,
        last_sync: entity.lastSyncTs,
        docs: docs.map((d) => ({
          name: basename(d.localPath, ".md"),
          path: d.localPath,
          tier: d.tier,
          last_sync: d.lastSyncTs,
        })),
      };

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    }
  );

  server.tool(
    "interkasten_register_project",
    "Manually register a directory as a project for Notion sync",
    {
      path: z.string().describe("Absolute path to the project directory"),
    },
    async ({ path }) => {
      if (!ctx.db || !ctx.notion) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Database or Notion client not connected. Run interkasten_init first.",
            },
          ],
          isError: true,
        };
      }

      if (!existsSync(path)) {
        return {
          content: [
            { type: "text" as const, text: `Path does not exist: ${path}` },
          ],
          isError: true,
        };
      }

      // Check if already registered
      const existing = lookupByPath(ctx.db, path);
      if (existing) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Project already registered: ${basename(path)} → ${existing.notionId}`,
            },
          ],
        };
      }

      const projectsDbId = ctx.config.notion.databases.projects;
      if (!projectsDbId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Projects database not configured. Run interkasten_init first.",
            },
          ],
          isError: true,
        };
      }

      const projName = basename(path);

      // Create project page in Notion
      const page = await ctx.notion.call(async () => {
        return ctx.notion!.raw.pages.create({
          parent: { database_id: projectsDbId },
          properties: {
            Name: { title: [{ text: { content: projName } }] },
            Status: { select: { name: "Active" } },
            "Last Sync": { date: { start: new Date().toISOString() } },
          },
        });
      });

      registerProject(ctx.db, path, page.id);

      appendSyncLog(ctx.db, {
        operation: "push",
        direction: "local_to_notion",
        detail: { action: "register_project", path, notionId: page.id },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Registered project: ${projName}\nNotion page: https://notion.so/${page.id.replace(/-/g, "")}`,
          },
        ],
      };
    }
  );

  server.tool(
    "interkasten_unregister_project",
    "Stop tracking a project (does not delete Notion pages)",
    {
      path: z.string().describe("Local project path or project name"),
    },
    async ({ path }) => {
      if (!ctx.db) {
        return {
          content: [{ type: "text" as const, text: "Database not connected" }],
          isError: true,
        };
      }

      let entity = lookupByPath(ctx.db, path);
      if (!entity) {
        const projects = listProjects(ctx.db);
        entity = projects.find((p) => basename(p.localPath) === path);
      }

      if (!entity) {
        return {
          content: [
            { type: "text" as const, text: `Project not found: ${path}` },
          ],
          isError: true,
        };
      }

      // Soft-delete project and all its docs
      const allEntities = listEntities(ctx.db);
      const toDelete = allEntities.filter(
        (e) => e.localPath.startsWith(entity!.localPath)
      );

      const orphanedPages: string[] = [];
      for (const e of toDelete) {
        softDeleteEntity(ctx.db, e.id);
        orphanedPages.push(e.notionId);
      }

      appendSyncLog(ctx.db, {
        entityMapId: entity.id,
        operation: "push",
        direction: "local_to_notion",
        detail: {
          action: "unregister_project",
          orphaned_notion_pages: orphanedPages,
        },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Unregistered: ${basename(entity.localPath)}`,
              `Removed ${toDelete.length} entity mappings.`,
              `Notion pages preserved (${orphanedPages.length} orphaned).`,
            ].join("\n"),
          },
        ],
      };
    }
  );
}
