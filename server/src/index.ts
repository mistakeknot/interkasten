import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "path";
import { writeFileSync } from "fs";

import { loadConfig, getInterkastenDir } from "./config/loader.js";
import { openDatabase, closeDatabase } from "./store/db.js";
import { NotionClient } from "./sync/notion-client.js";
import { SyncEngine } from "./sync/engine.js";
import { createDaemonContext } from "./daemon/context.js";
import { registerHealthTools } from "./daemon/tools/health.js";
import { registerConfigTools } from "./daemon/tools/config.js";
import { registerVersionTool } from "./daemon/tools/version.js";
import { registerInitTool } from "./daemon/tools/init.js";
import { registerProjectTools } from "./daemon/tools/projects.js";
import { registerSyncTools } from "./daemon/tools/sync.js";

const server = new McpServer({
  name: "interkasten",
  version: "0.1.0",
});

async function main() {
  // 1. Load configuration
  const config = loadConfig();

  // 2. Open database + migrate
  const interkastenDir = getInterkastenDir();
  const dbPath = resolve(interkastenDir, "state.db");
  const { db, sqlite } = openDatabase(dbPath);

  // 3. Create daemon context
  const ctx = createDaemonContext(config, dbPath);
  ctx.db = db;
  ctx.sqlite = sqlite;

  // 4. Validate Notion token (if set)
  let syncEngine: SyncEngine | null = null;
  const token = process.env.INTERKASTEN_NOTION_TOKEN;
  if (token) {
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
      console.error(
        `Notion token validation failed: ${error?.message}. ${error?.remediation}`
      );
      // Don't exit — daemon can still serve config/health/version tools
    } else {
      ctx.notion = notion;

      // 5. Start sync engine
      syncEngine = new SyncEngine({ config, db, notion });
      syncEngine.start();
    }
  } else {
    console.error(
      "INTERKASTEN_NOTION_TOKEN not set — run: export INTERKASTEN_NOTION_TOKEN='ntn_...'"
    );
  }

  // 6. Write PID/heartbeat file
  const pidFile = resolve(interkastenDir, "daemon.pid");
  writeFileSync(pidFile, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));

  const heartbeatInterval = setInterval(() => {
    try {
      writeFileSync(
        pidFile,
        JSON.stringify({
          pid: process.pid,
          started: ctx.startedAt.toISOString(),
          heartbeat: new Date().toISOString(),
        })
      );
    } catch {
      // Non-fatal
    }
  }, 30000);

  // 7. Register all tools
  registerHealthTools(server, ctx);
  registerConfigTools(server, ctx);
  registerVersionTool(server, ctx);
  registerInitTool(server, ctx);
  registerProjectTools(server, ctx);
  registerSyncTools(server, ctx, () => syncEngine);

  // Graceful shutdown
  const cleanup = async () => {
    clearInterval(heartbeatInterval);
    if (syncEngine) await syncEngine.stop();
    if (ctx.sqlite) closeDatabase(ctx.sqlite);
    process.exit(0);
  };
  process.on("SIGINT", () => { cleanup(); });
  process.on("SIGTERM", () => { cleanup(); });

  // 8. Connect MCP transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal: MCP server failed to start:", err);
  process.exit(1);
});
