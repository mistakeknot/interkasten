/**
 * Standalone webhook daemon for interkasten.
 *
 * Runs independently of Claude Code / MCP — designed as an always-on service
 * that receives Notion webhook events and syncs changes to local files.
 *
 * Usage:
 *   node dist/webhook-daemon.js                     # uses default config
 *   INTERKASTEN_CONFIG_PATH=./config.yaml node dist/webhook-daemon.js
 *
 * Config requirements:
 *   sync.webhook.enabled: true
 *   INTERKASTEN_NOTION_TOKEN environment variable (or ~/.interkasten/.env)
 *
 * Post-sync hooks:
 *   sync.webhook.post_sync_command — shell command run after each sync batch.
 *   Runs via bash -c (admin-controlled config, not user input).
 *   Example: "node scripts/ideagui-to-json.mjs && cd ~/projects/transfer/ideagui && git add -A && git commit -m 'sync' && git push"
 */
import { resolve } from "path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { execFileSync } from "child_process";

import { loadConfig, getinterkastenDir } from "./config/loader.js";
import { openDatabase, closeDatabase } from "./store/db.js";
import { NotionClient } from "./sync/notion-client.js";
import { TokenResolver } from "./sync/token-resolver.js";
import { SyncEngine } from "./sync/engine.js";
import { DurableQueue } from "./sync/durable-queue.js";
import { WebhookServer } from "./sync/webhook-server.js";

const STALE_HEARTBEAT_MS = 2 * 60 * 1000;

async function main() {
  console.log("interkasten-webhook: starting...");

  // 1. Load configuration
  const config = loadConfig();

  if (!config.sync.webhook.enabled) {
    console.error(
      "interkasten-webhook: sync.webhook.enabled is false. Set to true in config and restart.",
    );
    process.exit(1);
  }

  // 2. Token
  const token = process.env.INTERKASTEN_NOTION_TOKEN;
  if (!token) {
    console.error(
      "interkasten-webhook: INTERKASTEN_NOTION_TOKEN not set. Export it or add to ~/.interkasten/.env",
    );
    process.exit(1);
  }

  // 3. PID file (separate from MCP daemon — uses webhook.pid)
  const interkastenDir = getinterkastenDir();
  const pidFile = resolve(interkastenDir, "webhook.pid");

  if (existsSync(pidFile)) {
    try {
      const prev = JSON.parse(readFileSync(pidFile, "utf-8"));
      if (prev.pid && prev.pid !== process.pid) {
        try {
          process.kill(prev.pid, 0);
          const age = Date.now() - new Date(prev.heartbeat).getTime();
          if (age < STALE_HEARTBEAT_MS) {
            console.error(
              `interkasten-webhook: another instance (pid ${prev.pid}) is running. Exiting.`,
            );
            process.exit(1);
          }
          console.error(
            `interkasten-webhook: killing stale process ${prev.pid}`,
          );
          process.kill(prev.pid, "SIGTERM");
        } catch {
          // Process dead — clean up
        }
      }
    } catch {
      // Corrupt PID file
    }
  }

  // 4. Open database + queue
  const dbPath = resolve(interkastenDir, "state.db");
  const queueDbPath = resolve(interkastenDir, "queue.db");
  const { db, sqlite } = openDatabase(dbPath);
  const durableQueue = new DurableQueue(queueDbPath);

  // 5. Create Notion client
  const tokenResolver = new TokenResolver(config, token);
  const notion = tokenResolver.getClient(token);
  const { valid, error } = await notion.validateToken();
  if (!valid) {
    console.error(
      `interkasten-webhook: token invalid: ${error?.message}`,
    );
    process.exit(1);
  }

  // 6. Start sync engine (handles queue processing)
  const syncEngine = new SyncEngine({ config, db, notion, durableQueue });
  syncEngine.start();

  // 7. Start webhook server
  const webhookServer = new WebhookServer(
    durableQueue,
    db,
    {
      port: config.sync.webhook.port,
      path: config.sync.webhook.path,
      secret: config.sync.webhook.secret,
      batchWindowMs: config.sync.webhook.batch_window_ms,
      scopeRootIds: config.sync.scope_root_ids,
      scopeExcludeIds: config.sync.scope_exclude_ids,
    },
    config.sync.cloud_bridge.url
      ? {
          url: config.sync.cloud_bridge.url!,
          token: config.sync.cloud_bridge.token!,
          pollMs: config.sync.cloud_bridge.poll_ms,
          batchSize: config.sync.cloud_bridge.batch_size,
        }
      : undefined,
  );
  await webhookServer.start();

  console.log(
    `interkasten-webhook: listening on http://localhost:${config.sync.webhook.port}${config.sync.webhook.path}`,
  );

  // 8. Post-sync hook: run a shell command after each queue processing cycle
  const postSyncCommand = config.sync.webhook.post_sync_command;
  let hookInterval: NodeJS.Timeout | null = null;
  if (postSyncCommand) {
    console.log(`interkasten-webhook: post-sync hook configured`);

    // Monitor the durable queue — after processing completes, run the hook
    let lastDoneCount = 0;
    hookInterval = setInterval(() => {
      const stats = durableQueue.getStats();
      // Run hook when new items were processed and nothing is in-flight
      if (
        stats.done > lastDoneCount &&
        stats.processing === 0 &&
        stats.queued === 0
      ) {
        lastDoneCount = stats.done;
        try {
          console.log("interkasten-webhook: running post-sync hook...");
          // Uses bash -c for shell features (&&, cd, pipes).
          // Command comes from admin-controlled config file, not user input.
          execFileSync("bash", ["-c", postSyncCommand], {
            cwd: process.cwd(),
            stdio: "inherit",
            timeout: 60000,
          });
          console.log("interkasten-webhook: post-sync hook complete");
        } catch (err) {
          console.error(
            `interkasten-webhook: post-sync hook failed: ${(err as Error).message}`,
          );
        }
      }
    }, 15000); // Check every 15s
  }

  // 9. PID file + heartbeat
  const writePid = () =>
    writeFileSync(
      pidFile,
      JSON.stringify({
        pid: process.pid,
        started: new Date().toISOString(),
        heartbeat: new Date().toISOString(),
      }),
    );
  writePid();
  const heartbeatInterval = setInterval(writePid, 30000);

  // 10. Graceful shutdown
  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    console.log("interkasten-webhook: shutting down...");
    clearInterval(heartbeatInterval);
    if (hookInterval) clearInterval(hookInterval);
    try {
      await webhookServer.stop();
    } catch {
      /* best effort */
    }
    try {
      await syncEngine.stop();
    } catch {
      /* best effort */
    }
    try {
      closeDatabase(sqlite);
    } catch {
      /* best effort */
    }
    try {
      unlinkSync(pidFile);
    } catch {
      /* already gone */
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    cleanup();
  });
  process.on("SIGTERM", () => {
    cleanup();
  });

  console.log("interkasten-webhook: ready");
}

main().catch((err) => {
  console.error("interkasten-webhook: fatal:", err.message);
  process.exit(1);
});
