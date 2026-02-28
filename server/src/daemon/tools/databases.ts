import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolve, join } from "path";
import { mkdirSync } from "fs";
import type { DaemonContext } from "../context.js";
import {
  upsertDatabaseSchema,
  getDatabaseSchema,
  listTrackedDatabases,
  removeDatabaseSchema,
} from "../../store/databases.js";
import {
  registerDatabase,
  registerDbRow,
  getRowsForDatabase,
  lookupByNotionId,
} from "../../sync/entity-map.js";
import { softDeleteEntity } from "../../store/entities.js";
import {
  extractDatabaseSchema,
} from "../../sync/discovery.js";
import {
  rowToFrontmatter,
  sanitizeTitle,
  generateTableMarkdown,
} from "../../sync/databases.js";
import { stringifyFrontmatter } from "../../sync/frontmatter.js";
import { notionBlocksToMarkdown } from "../../sync/translator.js";
import type { SyncEngine } from "../../sync/engine.js";

export function registerDatabaseTools(
  server: McpServer,
  ctx: DaemonContext,
  getSyncEngine: () => SyncEngine | null,
): void {
  /**
   * Track a Notion database for row-level sync.
   */
  server.tool(
    "interkasten_track_database",
    "Start tracking a Notion database: fetch schema, pull all rows as markdown files with YAML frontmatter",
    {
      database_id: z.string().describe("Notion database ID or data source ID to track"),
      output_dir: z.string().optional().describe("Local directory for row files (defaults to ~/.interkasten/databases/<title>)"),
    },
    async ({ database_id, output_dir }) => {
      if (!ctx.notion || !ctx.db) {
        return {
          content: [{ type: "text" as const, text: "Notion client or database not initialized" }],
          isError: true,
        };
      }

      // Fetch data source
      let ds: any;
      try {
        ds = await ctx.notion.call(() =>
          ctx.notion!.raw.dataSources.retrieve({ data_source_id: database_id } as any)
        );
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to retrieve data source: ${(err as Error).message}` }],
          isError: true,
        };
      }

      const schema = extractDatabaseSchema(ds);
      const outputPath = output_dir ?? resolve(
        process.env.HOME ?? "~",
        ".interkasten",
        "databases",
        sanitizeTitle(schema.title),
      );

      // Ensure output dir exists
      mkdirSync(outputPath, { recursive: true });

      // Store schema
      upsertDatabaseSchema(ctx.db, {
        notionDatabaseId: database_id,
        dataSourceId: ds.id,
        title: schema.title,
        schemaJson: JSON.stringify(schema.properties),
        outputDir: outputPath,
      });

      // Register database entity
      const dbEntity = registerDatabase(ctx.db, outputPath, database_id);

      // Fetch all rows
      const rows = await ctx.notion.queryDataSource(ds.id);

      // Track filenames for dedup
      const usedFilenames = new Set<string>();
      let pulledCount = 0;

      for (const row of rows) {
        const fm = rowToFrontmatter(row, schema);
        let filename = sanitizeTitle(fm.title || "Untitled");

        // Dedup: append last 4 chars of ID on collision
        if (usedFilenames.has(filename.toLowerCase())) {
          filename = `${filename}-${row.id.slice(-4)}`;
        }
        usedFilenames.add(filename.toLowerCase());

        const filePath = join(outputPath, `${filename}.md`);

        // Fetch body
        let body = "";
        try {
          body = await notionBlocksToMarkdown(ctx.notion!.raw, row.id);
        } catch {
          // Some rows have no body
        }

        const content = stringifyFrontmatter(fm as Record<string, unknown>, body);

        // Write file
        const { writeFileSync } = await import("fs");
        writeFileSync(filePath, content, "utf-8");

        // Register entity
        registerDbRow(ctx.db, filePath, row.id, dbEntity.id);
        pulledCount++;
      }

      // Generate index table
      const indexContent = [
        `---`,
        `notion_id: ${database_id}`,
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

      const { writeFileSync } = await import("fs");
      writeFileSync(join(outputPath, "_index.md"), indexContent, "utf-8");

      const propList = Object.entries(schema.properties)
        .map(([name, p]) => `  ${name}: ${p.type}`)
        .join("\n");

      return {
        content: [{
          type: "text" as const,
          text: [
            `Tracked database: ${schema.title}`,
            `Data source: ${ds.id}`,
            `Output: ${outputPath}`,
            `Rows pulled: ${pulledCount}`,
            `Properties:\n${propList}`,
          ].join("\n"),
        }],
      };
    }
  );

  /**
   * Stop tracking a database — soft-delete all row entities + remove schema.
   */
  server.tool(
    "interkasten_untrack_database",
    "Stop tracking a Notion database: soft-delete all row entities and remove stored schema",
    {
      database_id: z.string().describe("Notion database ID to untrack"),
    },
    async ({ database_id }) => {
      if (!ctx.db) {
        return {
          content: [{ type: "text" as const, text: "Database not initialized" }],
          isError: true,
        };
      }

      const schemaRow = getDatabaseSchema(ctx.db, database_id);
      if (!schemaRow) {
        return {
          content: [{ type: "text" as const, text: `Database ${database_id} is not tracked` }],
          isError: true,
        };
      }

      // Soft-delete the database entity and all its rows
      const dbEntity = lookupByNotionId(ctx.db, database_id);
      let deletedRows = 0;
      if (dbEntity) {
        const rows = getRowsForDatabase(ctx.db, dbEntity.id);
        for (const row of rows) {
          softDeleteEntity(ctx.db, row.id);
          deletedRows++;
        }
        softDeleteEntity(ctx.db, dbEntity.id);
      }

      // Remove schema
      removeDatabaseSchema(ctx.db, database_id);

      return {
        content: [{
          type: "text" as const,
          text: `Untracked database: ${schemaRow.title}\nSoft-deleted ${deletedRows} row entities + database entity\nSchema removed`,
        }],
      };
    }
  );

  /**
   * List tracked databases with status.
   */
  server.tool(
    "interkasten_list_databases",
    "List all tracked Notion databases with row counts, schema details, and sync status",
    {},
    async () => {
      if (!ctx.db) {
        return {
          content: [{ type: "text" as const, text: "Database not initialized" }],
          isError: true,
        };
      }

      const tracked = listTrackedDatabases(ctx.db);
      if (tracked.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No databases tracked. Use interkasten_track_database to start." }],
        };
      }

      const lines: string[] = [];
      for (const schema of tracked) {
        const dbEntity = lookupByNotionId(ctx.db!, schema.notionDatabaseId);
        const rowCount = dbEntity ? getRowsForDatabase(ctx.db!, dbEntity.id).length : 0;
        const props = JSON.parse(schema.schemaJson);
        const propCount = Object.keys(props).length;

        lines.push(`${schema.title}`);
        lines.push(`  ID: ${schema.notionDatabaseId}`);
        lines.push(`  Data Source: ${schema.dataSourceId}`);
        lines.push(`  Output: ${schema.outputDir ?? "(not set)"}`);
        lines.push(`  Properties: ${propCount}`);
        lines.push(`  Tracked rows: ${rowCount}`);
        lines.push(`  Last fetched: ${schema.lastFetchedAt}`);
        lines.push("");
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );

  /**
   * Refresh a tracked database: re-fetch schema, sync new/changed/deleted rows.
   */
  server.tool(
    "interkasten_refresh_database",
    "Re-sync a tracked database: update schema, pull new/changed rows, detect deleted rows",
    {
      database_id: z.string().describe("Notion database ID to refresh"),
    },
    async ({ database_id }) => {
      if (!ctx.notion || !ctx.db) {
        return {
          content: [{ type: "text" as const, text: "Notion client or database not initialized" }],
          isError: true,
        };
      }

      const schemaRow = getDatabaseSchema(ctx.db, database_id);
      if (!schemaRow) {
        return {
          content: [{ type: "text" as const, text: `Database ${database_id} is not tracked. Use interkasten_track_database first.` }],
          isError: true,
        };
      }

      // Re-fetch data source for schema
      let ds: any;
      try {
        ds = await ctx.notion.call(() =>
          ctx.notion!.raw.dataSources.retrieve({ data_source_id: schemaRow.dataSourceId } as any)
        );
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to retrieve data source: ${(err as Error).message}` }],
          isError: true,
        };
      }

      const schema = extractDatabaseSchema(ds);
      const outputPath = schemaRow.outputDir ?? resolve(
        process.env.HOME ?? "~",
        ".interkasten",
        "databases",
        sanitizeTitle(schema.title),
      );

      // Update stored schema
      upsertDatabaseSchema(ctx.db, {
        notionDatabaseId: database_id,
        dataSourceId: ds.id,
        title: schema.title,
        schemaJson: JSON.stringify(schema.properties),
        outputDir: outputPath,
      });

      // Fetch all rows
      const rows = await ctx.notion.queryDataSource(ds.id);
      const remoteRowIds = new Set(rows.map((r) => r.id));

      // Get existing tracked rows
      const dbEntity = lookupByNotionId(ctx.db, database_id);
      const existingRows = dbEntity ? getRowsForDatabase(ctx.db, dbEntity.id) : [];

      let newCount = 0;
      let updatedCount = 0;
      let deletedCount = 0;

      const syncEngine = getSyncEngine();
      const usedFilenames = new Set<string>();

      // Pull new and updated rows
      for (const row of rows) {
        const existing = existingRows.find((e) => e.notionId === row.id);

        if (existing) {
          // Check if updated
          if (existing.lastNotionVer !== row.last_edited_time) {
            if (syncEngine) {
              await syncEngine.pullDbRow(existing, schema);
            }
            updatedCount++;
          }
        } else {
          // New row
          const fm = rowToFrontmatter(row, schema);
          let filename = sanitizeTitle(fm.title || "Untitled");
          if (usedFilenames.has(filename.toLowerCase())) {
            filename = `${filename}-${row.id.slice(-4)}`;
          }
          usedFilenames.add(filename.toLowerCase());

          const filePath = join(outputPath, `${filename}.md`);

          let body = "";
          try {
            body = await notionBlocksToMarkdown(ctx.notion!.raw, row.id);
          } catch {
            // No body
          }

          const content = stringifyFrontmatter(fm as Record<string, unknown>, body);
          const { writeFileSync } = await import("fs");
          writeFileSync(filePath, content, "utf-8");

          if (dbEntity) {
            registerDbRow(ctx.db!, filePath, row.id, dbEntity.id);
          }
          newCount++;
        }
      }

      // Detect deleted rows
      for (const existing of existingRows) {
        if (!remoteRowIds.has(existing.notionId)) {
          softDeleteEntity(ctx.db, existing.id);
          deletedCount++;
        }
      }

      // Regenerate index
      const indexContent = [
        `---`,
        `notion_id: ${database_id}`,
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
      const { writeFileSync } = await import("fs");
      writeFileSync(join(outputPath, "_index.md"), indexContent, "utf-8");

      return {
        content: [{
          type: "text" as const,
          text: [
            `Refreshed: ${schema.title}`,
            `New rows: ${newCount}`,
            `Updated rows: ${updatedCount}`,
            `Deleted rows: ${deletedCount}`,
            `Total rows: ${rows.length}`,
          ].join("\n"),
        }],
      };
    }
  );
}
