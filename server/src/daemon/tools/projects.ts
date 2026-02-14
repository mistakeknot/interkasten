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
import {
  findKeyDocs,
  enrichWithNotionIds,
  buildKeyDocPageProperties,
  updateProjectKeyDocs,
  categorizeKeyDocs,
  type KeyDocResult,
} from "../../sync/key-docs.js";
import type { DocTier } from "../../sync/triage.js";

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

      const db = ctx.db;
      const projects = listProjects(db);
      const result = projects.map((p) => {
        const keyDocs = findKeyDocs(p.localPath);
        const enriched = enrichWithNotionIds(db, p.localPath, keyDocs);
        const docTier = (p.docTier as DocTier) ?? null;
        const { requiredMissing, requiredPresent, optional } = categorizeKeyDocs(enriched, docTier);

        return {
          name: basename(p.localPath),
          local_path: p.localPath,
          notion_id: p.notionId,
          last_sync: p.lastSyncTs,
          notion_url: `https://notion.so/${p.notionId.replace(/-/g, "")}`,
          doc_tier: docTier,
          key_docs: {
            required_present: requiredPresent.map((d) => d.type),
            required_missing: requiredMissing.map((d) => d.type),
            optional: optional.map((d) => d.type),
          },
        };
      });

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

      // Key doc status
      const keyDocs = findKeyDocs(entity.localPath);
      const enriched = enrichWithNotionIds(ctx.db, entity.localPath, keyDocs);
      const docTier = (entity.docTier as DocTier) ?? null;
      const { requiredMissing, requiredPresent, optional } = categorizeKeyDocs(enriched, docTier);

      const result = {
        name: basename(entity.localPath),
        local_path: entity.localPath,
        notion_id: entity.notionId,
        notion_url: `https://notion.so/${entity.notionId.replace(/-/g, "")}`,
        last_sync: entity.lastSyncTs,
        doc_tier: docTier,
        key_docs: enriched.map((kd) => ({
          type: kd.type,
          exists: kd.path !== null,
          required: docTier
            ? requiredPresent.some((r) => r.type === kd.type) ||
              requiredMissing.some((r) => r.type === kd.type)
            : null,
          path: kd.path,
          notion_url: kd.notionId
            ? `https://notion.so/${kd.notionId.replace(/-/g, "")}`
            : null,
        })),
        doc_gaps: {
          required_missing: requiredMissing.map((d) => d.type),
          required_present: requiredPresent.map((d) => d.type),
        },
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

      // Set key doc columns
      const keyDocs = findKeyDocs(path);
      const enriched = enrichWithNotionIds(ctx.db, path, keyDocs);
      try {
        await updateProjectKeyDocs(ctx.notion, page.id, enriched);
      } catch {
        // Non-fatal — columns may not exist yet on older databases
      }

      const missing = enriched.filter((d) => !d.path).map((d) => d.type);

      appendSyncLog(ctx.db, {
        operation: "push",
        direction: "local_to_notion",
        detail: { action: "register_project", path, notionId: page.id },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Registered project: ${projName}`,
              `Notion page: https://notion.so/${page.id.replace(/-/g, "")}`,
              missing.length > 0 ? `Missing key docs: ${missing.join(", ")}` : "All key docs present",
            ].join("\n"),
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

  server.tool(
    "interkasten_refresh_key_docs",
    "Scan all projects (or one) for key docs (Vision, PRD, Roadmap, AGENTS.md, CLAUDE.md) and update their Notion database columns",
    {
      project: z
        .string()
        .optional()
        .describe("Project name or path (omit to refresh all projects)"),
      add_columns: z
        .boolean()
        .optional()
        .describe("Add key doc columns to the Projects database if missing (default: false)"),
    },
    async ({ project, add_columns }) => {
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

      const output: string[] = [];

      // Optionally add columns to the database
      if (add_columns) {
        const projectsDbId = ctx.config.notion.databases.projects;
        if (projectsDbId) {
          try {
            const { getKeyDocDbProperties } = await import("../../sync/key-docs.js");
            await ctx.notion.call(async () => {
              return ctx.notion!.raw.databases.update({
                database_id: projectsDbId,
                properties: getKeyDocDbProperties() as any,
              });
            });
            output.push("Added key doc columns to Projects database.");
          } catch (err) {
            output.push(`Failed to add columns: ${(err as Error).message}`);
          }
        }
      }

      // Get projects to refresh
      const refreshDb = ctx.db;
      let projects = listProjects(refreshDb);
      if (project) {
        const match = projects.find(
          (p) => basename(p.localPath) === project || p.localPath === project
        );
        if (!match) {
          return {
            content: [
              { type: "text" as const, text: `Project not found: ${project}` },
            ],
            isError: true,
          };
        }
        projects = [match];
      }

      output.push(`Refreshing key docs for ${projects.length} project(s)...`);

      let updated = 0;
      let errors = 0;
      for (const p of projects) {
        try {
          const keyDocs = findKeyDocs(p.localPath);
          const enriched = enrichWithNotionIds(refreshDb, p.localPath, keyDocs);
          await updateProjectKeyDocs(ctx.notion, p.notionId, enriched);
          updated++;

          const missing = enriched.filter((d) => !d.path).map((d) => d.type);
          const present = enriched.filter((d) => d.path).map((d) => d.type);
          const synced = enriched.filter((d) => d.notionId).map((d) => d.type);

          output.push(
            `  ${basename(p.localPath)}: ${present.length}/5 present` +
              (missing.length > 0 ? ` (missing: ${missing.join(", ")})` : "") +
              (synced.length > 0 ? ` [${synced.length} linked]` : "")
          );
        } catch (err) {
          errors++;
          output.push(`  ${basename(p.localPath)}: ERROR ${(err as Error).message}`);
        }
      }

      output.push(`\nDone: ${updated} updated, ${errors} errors.`);

      return {
        content: [{ type: "text" as const, text: output.join("\n") }],
      };
    }
  );
}
