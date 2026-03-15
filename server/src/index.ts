import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "path";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";

import { loadConfig, getinterkastenDir } from "./config/loader.js";
import { openDatabase, closeDatabase } from "./store/db.js";
import { NotionClient } from "./sync/notion-client.js";
import { TokenResolver } from "./sync/token-resolver.js";
import { discoverNotionMcpToken } from "./config/notion-mcp-discovery.js";
import { SyncEngine } from "./sync/engine.js";
import { createDaemonContext } from "./daemon/context.js";
import { registerHealthTools } from "./daemon/tools/health.js";
import { registerConfigTools } from "./daemon/tools/config.js";
import { registerVersionTool } from "./daemon/tools/version.js";
import { registerInitTool } from "./daemon/tools/init.js";
import { registerProjectTools } from "./daemon/tools/projects.js";
import { registerSyncTools } from "./daemon/tools/sync.js";
import { registerTriageTool } from "./daemon/tools/triage.js";
import { registerSignalsTools } from "./daemon/tools/signals.js";
import { registerHierarchyTools } from "./daemon/tools/hierarchy.js";
import { registerDiscoveryTools } from "./daemon/tools/discovery.js";
import { registerDatabaseTools } from "./daemon/tools/databases.js";
import { registerLinkTool } from "./daemon/tools/link.js";
import { registerPageTools } from "./daemon/tools/pages.js";

/** Staleness threshold: if heartbeat is older than this, consider the process dead. */
const STALE_HEARTBEAT_MS = 2 * 60 * 1000; // 2 minutes

/** Self-watchdog: if no MCP message for this long AND stdin is dead, self-terminate. */
const WATCHDOG_INTERVAL_MS = 60 * 1000; // check every 60s
const WATCHDOG_IDLE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes without activity

const server = new McpServer({
  name: "interkasten",
  version: "0.2.0",
});

/**
 * Check if a PID file indicates a fresh, running instance.
 * Returns true if another instance owns the PID file and is alive with a fresh heartbeat.
 */
function isOtherInstanceAlive(pidFile: string): boolean {
  try {
    if (!existsSync(pidFile)) return false;
    const prev = JSON.parse(readFileSync(pidFile, "utf-8"));
    if (!prev.pid || prev.pid === process.pid) return false;

    // Check if process is alive (signal 0 = existence check)
    try {
      process.kill(prev.pid, 0);
    } catch {
      return false; // Process is dead
    }

    // Process is alive — check heartbeat freshness
    if (prev.heartbeat) {
      const age = Date.now() - new Date(prev.heartbeat).getTime();
      if (age < STALE_HEARTBEAT_MS) {
        return true; // Fresh heartbeat — another healthy instance is running
      }
    }
    // No heartbeat or stale heartbeat — not considered alive
    return false;
  } catch {
    return false;
  }
}

/**
 * Kill a stale process from the PID file, if present.
 */
function killStaleProcess(pidFile: string): void {
  try {
    if (!existsSync(pidFile)) return;
    const prev = JSON.parse(readFileSync(pidFile, "utf-8"));
    if (!prev.pid || prev.pid === process.pid) return;

    try {
      process.kill(prev.pid, 0); // existence check
      // Process is alive — check if stale
      const isStale =
        !prev.heartbeat ||
        Date.now() - new Date(prev.heartbeat).getTime() > STALE_HEARTBEAT_MS;

      if (isStale) {
        console.error(`interkasten: killing stale process ${prev.pid}`);
        process.kill(prev.pid, "SIGTERM");
      }
    } catch {
      // Process already dead — just clean up
    }
  } catch {
    // PID file corrupt or unreadable
  }
}

async function main() {
  // 1. Load configuration
  const config = loadConfig();

  // 2. Open database + migrate
  const interkastenDir = getinterkastenDir();
  const dbPath = resolve(interkastenDir, "state.db");
  const pidFile = resolve(interkastenDir, "daemon.pid");

  // --- Fix 3: Refuse to start if another healthy instance is running ---
  if (isOtherInstanceAlive(pidFile)) {
    const prev = JSON.parse(readFileSync(pidFile, "utf-8"));
    console.error(
      `interkasten: another instance (pid ${prev.pid}) is already running with a fresh heartbeat. Exiting.`
    );
    process.exit(1);
  }

  // --- Fix 1 (server-side): Kill any stale process from PID file ---
  killStaleProcess(pidFile);

  const { db, sqlite } = openDatabase(dbPath);

  // 3. Create daemon context
  const ctx = createDaemonContext(config, dbPath);
  ctx.db = db;
  ctx.sqlite = sqlite;

  // 4. Initialize token resolver and validate default token
  let syncEngine: SyncEngine | null = null;
  let token = process.env.INTERKASTEN_NOTION_TOKEN;
  let tokenSource = "INTERKASTEN_NOTION_TOKEN";

  // Auto-discover from Notion MCP plugin if no explicit token
  if (!token) {
    const discovered = discoverNotionMcpToken();
    if (discovered) {
      token = discovered;
      tokenSource = "Notion MCP plugin (.mcp.json)";
      console.error(`Notion token auto-discovered from ${tokenSource}`);
    }
  }

  const tokenResolver = new TokenResolver(config, token);
  ctx.tokenResolver = tokenResolver;

  if (token) {
    const notion = tokenResolver.getClient(token);

    const { valid, error } = await notion.validateToken();
    if (!valid) {
      console.error(
        `Notion token validation failed (source: ${tokenSource}): ${error?.message}. ${error?.remediation}`
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
      "INTERKASTEN_NOTION_TOKEN not set and no Notion MCP plugin found — run: export INTERKASTEN_NOTION_TOKEN='ntn_...'"
    );
  }

  // Log multi-token status
  if (tokenResolver.hasMultipleTokens()) {
    console.error(
      `Multi-token: ${tokenResolver.listAliases().length} named token(s) configured`
    );
  }

  // 6. Write PID/heartbeat file
  writeFileSync(
    pidFile,
    JSON.stringify({
      pid: process.pid,
      started: new Date().toISOString(),
      heartbeat: new Date().toISOString(),
    })
  );

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
  registerTriageTool(server, ctx);
  registerSignalsTools(server, ctx);
  registerHierarchyTools(server, ctx);
  registerDiscoveryTools(server, ctx);
  registerDatabaseTools(server, ctx, () => syncEngine);
  registerLinkTool(server, ctx);
  registerPageTools(server, ctx);

  // --- Graceful shutdown (idempotent) ---
  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return; // prevent double-cleanup
    cleaningUp = true;
    clearInterval(heartbeatInterval);
    clearInterval(watchdogInterval);
    if (syncEngine) {
      try { await syncEngine.stop(); } catch { /* best effort */ }
    }
    if (ctx.sqlite) {
      try { closeDatabase(ctx.sqlite); } catch { /* best effort */ }
    }
    try { unlinkSync(pidFile); } catch { /* already gone */ }
    process.exit(0);
  };

  process.on("SIGINT", () => { cleanup(); });
  process.on("SIGTERM", () => { cleanup(); });

  // --- Fix 2: Additional shutdown triggers ---
  // beforeExit fires when the event loop drains (no more work scheduled)
  process.on("beforeExit", () => { cleanup(); });

  // disconnect fires when the parent process IPC channel closes (parent died)
  process.on("disconnect", () => { cleanup(); });

  // Exit when MCP client disconnects (stdin closes).
  // Without this, background timers keep the process alive indefinitely.
  process.stdin.on("end", () => { cleanup(); });
  process.stdin.on("close", () => { cleanup(); });

  // --- Self-watchdog ---
  // If no MCP message for 5 minutes AND stdin is dead, self-terminate.
  // Catches cases where stdin close/end events don't fire (e.g., parent crash).
  let lastActivityTime = Date.now();
  process.stdin.on("data", () => {
    lastActivityTime = Date.now();
  });

  const watchdogInterval = setInterval(() => {
    const idleMs = Date.now() - lastActivityTime;
    const stdinDead =
      process.stdin.destroyed ||
      !process.stdin.readable ||
      (process.stdin.readableEnded === true);

    if (idleMs > WATCHDOG_IDLE_LIMIT_MS && stdinDead) {
      console.error(
        `interkasten: watchdog triggered — idle ${Math.round(idleMs / 1000)}s, stdin dead. Shutting down.`
      );
      cleanup();
    }
  }, WATCHDOG_INTERVAL_MS);

  // Ensure watchdog timer doesn't prevent natural exit
  if (watchdogInterval.unref) watchdogInterval.unref();

  // 8. Connect MCP transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal: MCP server failed to start:", err);
  process.exit(1);
});
