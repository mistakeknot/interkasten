import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { basename } from "path";
import type { DaemonContext } from "../context.js";
import type { SyncEngine } from "../../sync/engine.js";
import { querySyncLog } from "../../store/sync-log.js";
import { walQueryIncomplete } from "../../store/wal.js";
import { listProjects, lookupByPath, getDocsForProject } from "../../sync/entity-map.js";
import { listEntities } from "../../store/entities.js";

/**
 * Register sync-related MCP tools.
 * The SyncEngine reference is passed lazily (nullable) because
 * the engine starts after tools are registered.
 */
export function registerSyncTools(
  server: McpServer,
  ctx: DaemonContext,
  getEngine: () => SyncEngine | null
): void {
  server.tool(
    "interkasten_sync",
    "Trigger immediate sync for one or all projects",
    {
      project: z
        .string()
        .optional()
        .describe("Project path or name. Omit for all projects."),
    },
    async ({ project }) => {
      if (!ctx.db || !ctx.notion) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Sync not available — Notion client not connected. Run interkasten_init.",
            },
          ],
          isError: true,
        };
      }

      const engine = getEngine();
      if (!engine) {
        return {
          content: [
            { type: "text" as const, text: "Sync engine not started." },
          ],
          isError: true,
        };
      }

      if (project) {
        // Sync specific project
        let entity = lookupByPath(ctx.db, project);
        if (!entity) {
          const projects = listProjects(ctx.db);
          entity = projects.find((p) => basename(p.localPath) === project);
        }

        if (!entity) {
          return {
            content: [
              { type: "text" as const, text: `Project not found: ${project}` },
            ],
            isError: true,
          };
        }

        // Find docs belonging to this project (using parent_id, not path prefix)
        const docs = getDocsForProject(ctx.db, entity.id);

        let synced = 0;
        for (const doc of docs) {
          try {
            await engine.syncFile(doc.localPath);
            synced++;
          } catch (err) {
            // Continue syncing other files
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Synced ${synced}/${docs.length} docs for ${basename(entity.localPath)}.`,
            },
          ],
        };
      }

      // Sync all — just trigger queue processing
      await engine.processQueue();

      return {
        content: [
          { type: "text" as const, text: "Sync cycle triggered for all projects." },
        ],
      };
    }
  );

  server.tool(
    "interkasten_sync_status",
    "Show pending operations, last sync timestamps, errors, circuit breaker state",
    {},
    async () => {
      if (!ctx.db) {
        return {
          content: [{ type: "text" as const, text: "Database not connected" }],
          isError: true,
        };
      }

      const engine = getEngine();
      const engineStatus = engine?.getStatus() ?? {
        pending: 0,
        active: 0,
        dropped: 0,
        watcherActive: false,
      };

      const walEntries = walQueryIncomplete(ctx.db);
      const recentLogs = querySyncLog(ctx.db, { limit: 10 });
      const recentErrors = querySyncLog(ctx.db, { operation: "error", limit: 5 });

      const result = {
        engine: engineStatus,
        circuit_breaker: ctx.notion?.getCircuitState() ?? "unknown",
        consecutive_failures: ctx.notion?.getConsecutiveFailures() ?? 0,
        wal: {
          incomplete_entries: walEntries.length,
          entries: walEntries.map((w) => ({
            id: w.id,
            operation: w.operation,
            state: w.state,
            created: w.createdAt,
          })),
        },
        recent_operations: recentLogs.map((l) => ({
          operation: l.operation,
          direction: l.direction,
          created: l.createdAt,
          detail: l.detail ? JSON.parse(l.detail) : null,
        })),
        recent_errors: recentErrors.map((l) => ({
          created: l.createdAt,
          detail: l.detail ? JSON.parse(l.detail) : null,
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
    "interkasten_sync_log",
    "Query sync log with filters (stored locally in SQLite, not Notion)",
    {
      operation: z
        .string()
        .optional()
        .describe("Filter by operation: push, pull, merge, conflict, error"),
      since: z.string().optional().describe("ISO date string — show entries after this date"),
      limit: z.number().optional().describe("Max entries to return (default: 50)"),
    },
    async ({ operation, since, limit }) => {
      if (!ctx.db) {
        return {
          content: [{ type: "text" as const, text: "Database not connected" }],
          isError: true,
        };
      }

      const logs = querySyncLog(ctx.db, {
        operation: operation ?? undefined,
        since: since ?? undefined,
        limit: limit ?? 50,
      });

      const result = logs.map((l) => ({
        id: l.id,
        entity_map_id: l.entityMapId,
        operation: l.operation,
        direction: l.direction,
        created_at: l.createdAt,
        detail: l.detail ? JSON.parse(l.detail) : null,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text:
              result.length === 0
                ? "No sync log entries found."
                : JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
