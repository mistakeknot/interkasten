import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { basename } from "path";
import type { DaemonContext } from "../context.js";
import { listProjects, lookupByPath } from "../../sync/entity-map.js";
import { updateDocTier } from "../../store/entities.js";
import { triageProject, type DocTier, type TriageResult } from "../../sync/triage.js";

export function registerTriageTool(server: McpServer, ctx: DaemonContext): void {
  server.tool(
    "interkasten_triage",
    "Legacy: classify projects into doc tiers using hardcoded thresholds. Prefer interkasten_gather_signals (returns raw signals for the agent to interpret) + agent-driven classification instead.",
    {
      project: z
        .string()
        .optional()
        .describe("Project name or path (omit to triage all registered projects)"),
      apply: z
        .boolean()
        .optional()
        .default(false)
        .describe("Write results to SQLite and Notion (default: dry-run)"),
    },
    async ({ project, apply }) => {
      if (!ctx.db) {
        return {
          content: [{ type: "text" as const, text: "Database not connected" }],
          isError: true,
        };
      }

      const db = ctx.db;
      let projects = listProjects(db);

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

      if (projects.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No projects registered. Run interkasten_init to discover projects.",
            },
          ],
        };
      }

      const results: Array<{
        name: string;
        path: string;
        tier: DocTier;
        previousTier: string | null;
        requiredDocs: string[];
        signals: TriageResult["signals"];
      }> = [];

      for (const p of projects) {
        const triage = triageProject(p.localPath);
        results.push({
          name: basename(p.localPath),
          path: p.localPath,
          tier: triage.tier,
          previousTier: p.docTier,
          requiredDocs: triage.requiredDocs,
          signals: triage.signals,
        });

        if (apply) {
          // Update SQLite
          updateDocTier(db, p.id, triage.tier);

          // Update Notion (if connected)
          if (ctx.notion) {
            try {
              await ctx.notion.call(async () => {
                return ctx.notion!.raw.pages.update({
                  page_id: p.notionId,
                  properties: {
                    "Doc Tier": { select: { name: triage.tier } },
                  },
                });
              });
            } catch {
              // Non-fatal: Doc Tier column may not exist yet on older databases
            }
          }
        }
      }

      // Build summary
      const tierCounts = { Product: 0, Tool: 0, Inactive: 0 };
      for (const r of results) {
        tierCounts[r.tier]++;
      }

      const output = {
        mode: apply ? "applied" : "dry-run",
        summary: tierCounts,
        projects: results,
      };

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(output, null, 2) },
        ],
      };
    }
  );
}
