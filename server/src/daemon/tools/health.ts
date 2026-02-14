import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DaemonContext } from "../context.js";

export function registerHealthTools(server: McpServer, ctx: DaemonContext): void {
  server.tool(
    "interkasten_health",
    "Liveness probe: daemon uptime, SQLite status, Notion reachability, circuit breaker state, pending WAL entries",
    {},
    async () => {
      const walCount = ctx.walPendingCount();
      const circuitState = ctx.notion?.getCircuitState() ?? "unknown";
      const lastSuccess = ctx.notion?.getLastSuccessTime()?.toISOString() ?? null;
      const consecutiveFailures = ctx.notion?.getConsecutiveFailures() ?? 0;

      const result = {
        status: "ok",
        uptime_seconds: Math.round(process.uptime()),
        version: ctx.version,
        pid: process.pid,
        node_version: process.version,
        sqlite: { connected: ctx.isDbConnected(), path: ctx.dbPath },
        notion: {
          circuit_state: circuitState,
          last_successful_call: lastSuccess,
          consecutive_failures: consecutiveFailures,
        },
        wal: { pending_entries: walCount },
        memory_mb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
