# Pipeline Operations & Schema Evolution Review

**Reviewer focus**: Sync Engine operations, Pagent DAG execution, error policies, daemon lifecycle, rate limiting
**Document**: PRD-MVP.md (interkasten Design Document)
**Date**: 2026-02-14
**Stage 1 P0 context**: DI-02 (crash recovery), DI-03 (Notion timestamp granularity), A3 (API backpressure), A7 (daemon restart)

---

### Findings Index

| SEVERITY | ID | Section | Title |
|---|---|---|---|
| P0 | PO-01 | Sync Engine | No write-ahead log or transaction fencing for multi-step sync operations |
| P0 | PO-02 | Sync Engine | Operation queue is unbounded with no backpressure or shedding mechanism |
| P0 | PO-03 | Daemon Lifecycle | No daemon crash-recovery or restart protocol defined |
| P0 | PO-04 | Sync Engine | Notion 429 rate-limit handling not specified beyond p-queue concurrency cap |
| P1 | PO-05 | Pagent DAG | Recursive workflow expansion has no memoization or deduplication guard |
| P1 | PO-06 | Sync Engine | base_content stored inline in entity_map risks unbounded SQLite row size |
| P1 | PO-07 | Pagent DAG | Fan-out cardinality is unbounded — no max_fan_out limit |
| P1 | PO-08 | Sync Engine | Polling + FS watcher + hooks can produce duplicate operations for the same change |
| P1 | PO-09 | Pagent DAG | Pagent workflow and sync engine share no coordination — concurrent Notion writes can conflict |
| P1 | PO-10 | Sync Engine | batch_size of 10 per cycle with 60s poll interval limits throughput during backfill |
| P2 | PO-11 | Sync Engine | Sync log stored in Notion database — sync failures may prevent logging the failure |
| P2 | PO-12 | Daemon Lifecycle | No health-check endpoint or liveness probe for the MCP server daemon |
| P2 | PO-13 | Pagent DAG | No workflow-level timeout — only per-node timeout exists |
| P2 | PO-14 | Configuration | No validation of semantic consistency between sync config and pagent config |

**Verdict**: needs-changes

---

### Summary

The Sync Engine and Pagent Workflow Engine designs have sound architectural foundations (operation-log model, three-way merge, DAG execution with topological sort) but lack critical operational safety nets. The most urgent gaps are: (1) no transactional fencing around multi-step sync operations, meaning a crash mid-sync leaves entity_map and Notion in a permanently diverged state (confirms Stage 1 DI-02); (2) unbounded operation queue growth with no backpressure, meaning offline periods or API outages cause memory exhaustion (confirms Stage 1 A3); (3) no daemon restart/recovery protocol (confirms Stage 1 A7); and (4) no explicit handling of Notion 429 responses beyond the p-queue concurrency cap, which is a throttle not a backpressure mechanism. The pagent engine has additional risks around unbounded fan-out and workflow-sync coordination.

---

### Issues Found

#### PO-01. P0: No write-ahead log or transaction fencing for multi-step sync operations

**Evidence**: Section 6 (Sync Engine) describes a multi-step process: detect change -> reconcile -> push/pull to Notion -> update entity_map (last_local_hash, last_notion_ver, base_content, last_sync_ts). If the daemon crashes after pushing to Notion but before updating entity_map, the entity_map still reflects the old state. On restart, the reconciler will detect the same local change again and attempt to re-push. However, Notion's `last_edited_time` has now advanced (because we pushed), so the reconciler may interpret this as a bidirectional conflict (both sides changed since last recorded sync). The three-way merge would use stale `base_content` and could produce corrupted output.

**The dangerous sequence**:
1. Local file changes, hash differs from `last_local_hash`
2. Reconciler decides: push local to Notion
3. Push succeeds — Notion page updated, `last_edited_time` advances
4. Daemon crashes before `UPDATE entity_map SET last_local_hash=..., last_notion_ver=..., base_content=...`
5. On restart: `last_local_hash` is stale (old hash), `last_notion_ver` is stale (old Notion time)
6. Reconciler detects: local changed (hash mismatch, even though it already pushed) AND Notion changed (time advanced due to step 3)
7. Result: spurious three-way merge using wrong `base_content`

**Fix**: Implement a write-ahead log (WAL) pattern. Before beginning a sync operation, write the intended operation to a `pending_ops` table. After successful completion of all steps (including entity_map update), mark the operation complete. On restart, replay or roll back incomplete operations. Alternatively, make the push idempotent by comparing content hashes rather than relying solely on timestamp comparisons.

This directly confirms Stage 1 finding DI-02.

---

#### PO-02. P0: Operation queue is unbounded with no backpressure or shedding mechanism

**Evidence**: Section 6 describes the Operation Queue as a central component that receives events from both the FS watcher (chokidar) and the Notion poller/webhook receiver. No maximum queue size, no eviction policy, and no backpressure mechanism are specified. The configuration shows `batch_size: 10` (max API calls per cycle) and `poll_interval: 60` seconds, meaning the system can process at most 10 operations per minute.

**The failure scenario**: If the Notion API is down or rate-limited for an extended period, the FS watcher continues generating events. With chokidar watching an active projects directory, a developer session can easily generate hundreds of file events per hour. Over a multi-hour outage:
- Queue grows without bound in memory
- No priority ordering — stale operations from hours ago compete with fresh ones
- No deduplication — the same file changed 50 times queues 50 separate operations
- When the API recovers, a flood of stale operations may trigger additional rate limits

The `batch_size: 10` cap limits throughput but does not limit queue depth. This is a throttle, not backpressure.

**Fix**: (a) Implement per-entity deduplication in the queue — only the latest operation for each entity needs processing, older ones can be coalesced. (b) Set a maximum queue depth with a shedding policy (e.g., drop oldest operations for entities that have newer operations queued). (c) Track queue depth as a metric and surface it via `interkasten_sync_status`. (d) When queue depth exceeds a threshold, switch from individual-entity sync to batch/bulk sync mode.

This directly confirms Stage 1 finding A3.

---

#### PO-03. P0: No daemon crash-recovery or restart protocol defined

**Evidence**: Section 12 (Deployment) shows the daemon is started via stdio by Claude Code (`"type": "stdio"` in plugin manifest). The SessionStart hook checks if the daemon is running and reports status, but there is no mechanism to:
1. Detect that a daemon died mid-operation
2. Restart the daemon automatically
3. Recover in-flight state after a restart
4. Determine what operations were in progress when the crash occurred

The MCP server communicates via stdio, meaning it lives as long as the Claude Code session. If Claude Code exits or the session ends, the `Stop`/`SessionEnd` hook fires `interkasten sync --flush &` in the background, but this is fire-and-forget (backgrounded with `&`) and there is no confirmation that the flush completed.

**Additional concern**: The `SessionEnd` hook backgrounds the flush with `&`. The hook process exits immediately, and the backgrounded flush command may be killed if the parent process tree is cleaned up during session teardown. This means the "flush pending sync" safety net is unreliable.

**Fix**: (a) Implement a startup recovery routine that checks the `pending_ops` table (see PO-01) and replays or rolls back incomplete operations. (b) Replace the backgrounded flush with a synchronous flush with a short timeout (e.g., 5 seconds). (c) Add a `daemon_started_at` and `last_heartbeat` column to the state store so the next startup can detect unclean shutdown. (d) Consider running the daemon as a separate long-lived process (systemd/launchd) rather than tying its lifecycle to Claude Code's stdio pipe.

This directly confirms Stage 1 finding A7.

---

#### PO-04. P0: Notion 429 rate-limit handling not specified beyond p-queue concurrency cap

**Evidence**: Section 2 states "Rate-limited to 3 req/sec via `p-queue`" and Section 10 lists `p-queue` for "Rate limiting (3 req/sec for Notion)". However, `p-queue` is a concurrency/interval limiter — it controls how fast *we* send requests. It does not handle the *response*-side case where Notion returns HTTP 429 (Too Many Requests).

Notion's rate limit is documented as 3 requests/second per integration, but in practice the limit is burstier and can return 429 even at lower sustained rates during peak load. The Notion API returns a `Retry-After` header with 429 responses indicating how long to wait.

The PRD's error handling section (Section 3, Error Handling) describes `retry` with exponential backoff, but this is for the pagent workflow engine, not the sync engine's Notion API client. There is no mention of:
- Parsing `Retry-After` headers from 429 responses
- Circuit-breaker pattern to stop all requests when 429s are received (since the limit is per-integration, not per-endpoint)
- Distinguishing between transient 429s and sustained rate limiting
- Propagating backpressure from the API client to the operation queue

**The failure mode**: When 429s occur, the sync engine retries individual requests, but `p-queue` continues dispatching other queued requests at the configured rate. Each of those also gets 429'd. The retry attempts compound, creating a thundering herd against an already rate-limited endpoint.

**Fix**: (a) Wrap the Notion API client in a circuit breaker that opens on consecutive 429 responses and respects `Retry-After`. (b) When the circuit breaker opens, pause the `p-queue` entirely — not just the individual request. (c) Implement a separate `notion-client.ts` layer (already in the repo structure) that handles all retry/backoff/circuit-breaker logic so neither the sync engine nor the pagent engine need to handle it independently. (d) Log rate-limit events to the sync log for monitoring.

This directly confirms Stage 1 finding A3.

---

#### PO-05. P1: Recursive workflow expansion has no memoization or deduplication guard

**Evidence**: Section 3 states "Recursively flattens nested workflows into a single DAG" at execution time. Workflows can contain other workflows as nodes (`type: workflow`). The example shows `doc-refresh` containing `doc-staleness-check` as a sub-workflow.

The risk: If workflow A contains workflow B which contains workflow C which also contains workflow B, the recursive expansion can produce an exponentially large DAG even without cycles. The cycle detection (Step 2: "Checks for cycles at registration time and double-checked at runtime") prevents infinite recursion, but does not prevent exponential blowup from diamond dependencies. Consider: A depends on B and C, both B and C depend on D. After expansion, D appears twice in the flattened DAG. With deeper nesting, the duplication compounds.

Additionally, `max_dag_depth: 10` limits nesting depth but not the total node count after expansion. A workflow with binary fan-out at each level can expand to 2^10 = 1024 nodes.

**Fix**: (a) Track already-expanded workflow IDs during expansion and reuse the expanded sub-DAG (memoization). (b) Add a `max_expanded_nodes` limit (e.g., 100) that aborts expansion if exceeded. (c) Log the expanded node count as part of workflow execution metadata.

---

#### PO-06. P1: base_content stored inline in entity_map risks unbounded SQLite row size

**Evidence**: The `entity_map` table (Section 6) stores `base_content TEXT` — the full content of each synced document at last sync. For T1 documents (Notion-native, bidirectional sync), this could be the full markdown content of a PRD, roadmap, or architecture doc. These documents can easily be 10-50KB each.

With dozens of projects and multiple docs per project, the `entity_map` table becomes a multi-megabyte table where most of the data is in a single column. This creates several operational issues:
- SQLite page size defaults to 4096 bytes; large TEXT values cause overflow pages and fragmentation
- `SELECT * FROM entity_map` becomes expensive even for simple lookups
- Backup and WAL rotation are slower
- The reconciler reads `base_content` for three-way merge, but many operations (pure push, pure pull) don't need it

**Fix**: (a) Store `base_content` in a separate table (`entity_content`) with a foreign key to `entity_map`, so the main entity map stays compact for lookups. (b) Alternatively, store base content as files on disk (`~/.interkasten/base/{entity_id}.md`) and only store the file path in SQLite. This also makes it trivial to inspect base content for debugging. (c) Add a `base_content_hash` column to detect whether base content needs to be re-read.

---

#### PO-07. P1: Fan-out cardinality is unbounded — no max_fan_out limit

**Evidence**: Section 3 (Fan-out and Fan-in) describes how actions producing multiple outputs trigger fan-out: "the downstream action is instantiated once per output item, running in parallel." The `classify` action example fans out to `matched_projects`, which instantiates one `route` action per matched project.

No limit is specified on fan-out cardinality. If the `classify` action matches a research item to all 50 projects (conceivable with a low confidence threshold), the engine instantiates 50 parallel `route` actions, each of which may make Notion API calls. Combined with `max_concurrent_workflows: 5`, a single workflow's fan-out could monopolize the Notion API rate limit.

Worse, the `summarize` node also runs per matched project, and each summarize invocation is a `prompt` type (AI subagent call). 50 concurrent Opus/Sonnet subagent invocations would be extremely expensive and likely hit Claude API rate limits as well.

**Fix**: (a) Add a `max_fan_out` parameter (default: 10) to the workflow engine configuration. (b) If fan-out exceeds the limit, batch the parallel instances (e.g., run 10 at a time). (c) Add per-workflow rate limiting separate from the global `max_concurrent_workflows`. (d) The `classify` action should have a configurable `max_matches` or `confidence_threshold` to bound output cardinality at the source.

---

#### PO-08. P1: Polling + FS watcher + hooks produce duplicate operations for the same change

**Evidence**: Section 6 (Sync Cadence) lists three overlapping detection paths for the same local file change:
1. **FS watcher** (chokidar) — detects the change in ~1-5 seconds
2. **PostToolUse hook** (Edit/Write) — fires immediately when Claude Code edits a file
3. **Scheduled sweep** — daily full-project resync catches anything missed

For Notion-side changes, there are two overlapping paths:
1. **Poller** — catches changes every 60 seconds
2. **Webhook** (if enabled) — catches changes in ~1 minute

If a file is edited via Claude Code's Edit tool, both the PostToolUse hook AND the FS watcher will detect it and enqueue separate operations for the same entity. The reconciler must then handle both, but the PRD does not describe deduplication of operations in the queue.

**The risk**: Without deduplication, the same push-to-Notion operation executes twice, wasting API quota. Worse, if the first push updates `entity_map` and advances the Notion timestamp, the second push may see a "Notion changed" signal (from its own prior push) and incorrectly trigger a conflict.

**Fix**: (a) Dedup operations in the queue by entity — only the latest operation per entity should survive. (b) Add a short settling window (e.g., 2 seconds after the last event for an entity) before promoting the operation to the reconciler. (c) The PostToolUse hook's `notify-change` should set a flag that suppresses the FS watcher's event for the same file within a window.

---

#### PO-09. P1: Pagent workflow and sync engine share no coordination — concurrent Notion writes can conflict

**Evidence**: The Pagent Workflow Engine and Sync Engine are described as separate components (Section 2, architecture diagram) that both write to Notion. The sync engine pushes document content. Pagent actions like `route-to-projects` (adds relation properties), `notify` (sets page status, adds comments), and `update-prd` (modifies page content) also write to Notion.

No coordination mechanism is described between the two engines. If a pagent workflow updates a page's status property at the same moment the sync engine pushes content to the same page, the operations may conflict:
- Notion's block-level API is not transactional — property updates and content updates are separate API calls
- A pagent `notify` action setting status to "Processed" and a sync engine push updating the page content could interleave, with the sync engine's push accidentally overwriting the pagent's status change (if the sync engine uses the page update API for properties)
- Both engines go through `p-queue` for rate limiting, but `p-queue` serializes by concurrency/interval, not by entity

**Fix**: (a) Implement per-entity write locks so that only one engine can modify a given Notion page at a time. (b) Route all Notion writes through a single writer component that serializes per-entity operations. (c) The pagent engine should mark entities as "in workflow" in the entity_map so the sync engine skips them during active workflow execution.

---

#### PO-10. P1: batch_size of 10 per cycle with 60s poll interval limits throughput during backfill

**Evidence**: Configuration (Section 11) shows `batch_size: 10` and `poll_interval: 60`. This means the sync engine processes at most 10 API calls per 60-second cycle, or about 10 operations/minute. The rate limiter allows 3 req/sec (180 req/min), but the batch_size cap reduces effective throughput to far below the API limit.

During initial sync (`/interkasten:init`), the system must create Notion pages for every project, generate skeleton PRDs, and push all existing docs. With 20 projects averaging 5 docs each = 100 entities, at 10/min it takes 10 minutes for initial sync. During this time, any new changes queue up and compete with the backfill.

The `/interkasten:sync` command (on-demand full resync) and the "safety-net full sweep" (daily) will also be bottlenecked at 10 ops/min.

**Fix**: (a) Make `batch_size` apply only to incremental poll cycles, not to bulk operations like init and full resync. (b) For bulk operations, increase the batch size to the rate-limit ceiling (e.g., 150/min to stay within 3 req/sec with margin). (c) Add a separate `backfill_batch_size` config option. (d) Show progress indicators during bulk operations.

---

#### PO-11. P2: Sync log stored in Notion database — sync failures may prevent logging the failure

**Evidence**: Section 4 shows "Sync Log (database)" as a Notion database with properties: Timestamp, Project, Direction, Entity, Action, Status, Conflict. Every sync operation is recorded here for auditability.

If the Notion API is unavailable (network error, rate limited, token expired), sync operations fail. But the failure itself cannot be logged to the Sync Log because the log destination (Notion) is the thing that's down. This creates a logging dead zone for exactly the failure mode you most need to debug.

The PRD does mention SQLite for state storage, and there is a `sync-log.ts` in the repo structure, suggesting a local sync log exists. But the design describes the Notion Sync Log as "full auditability" and "audit trail of every sync operation" without clarifying that local logging is the primary audit trail and Notion is a convenience mirror.

**Fix**: (a) Make the SQLite sync log the authoritative audit trail. The Notion Sync Log database should be a best-effort mirror that syncs when possible. (b) Explicitly document this hierarchy. (c) Sync log entries for Notion API failures should be written to SQLite immediately and mirror to Notion on the next successful connection.

---

#### PO-12. P2: No health-check endpoint or liveness probe for the MCP server daemon

**Evidence**: The daemon communicates over stdio (Section 12). The SessionStart hook checks if the daemon is running by calling `interkasten status --json`, but this is a CLI command, not a daemon health-check. If the daemon is running but deadlocked (e.g., SQLite lock contention, event loop blocked by synchronous crypto), the `status` command may hang indefinitely.

There is no mention of:
- Internal heartbeat mechanism
- Watchdog timer
- Deadlock detection
- Memory usage monitoring
- Queue depth reporting

The SessionStart hook only runs at session start, not during the session. If the daemon degrades mid-session, there is no detection mechanism.

**Fix**: (a) The `interkasten status` tool should have a timeout (e.g., 5 seconds) and treat timeout as "unhealthy." (b) Add an internal heartbeat that writes `last_heartbeat` to SQLite every 30 seconds, so external tools can detect hangs. (c) Report queue depth, active workflows, and memory usage in the status output. (d) The MCP server should implement a periodic self-check that verifies SQLite is writable and Notion API is reachable.

---

#### PO-13. P2: No workflow-level timeout — only per-node timeout exists

**Evidence**: Section 11 configures `default_timeout_per_node: 120` seconds but does not specify a workflow-level timeout. A workflow with 20 nodes (within the `max_dag_depth: 10` limit) each taking 119 seconds would run for ~40 minutes (accounting for parallelism). With fan-out, a single workflow execution could run for hours.

Long-running workflows tie up one of the 5 `max_concurrent_workflows` slots, potentially starving other workflows. If a scheduled trigger fires while all 5 slots are occupied by slow workflows, the new workflow must wait, causing unpredictable delays.

**Fix**: (a) Add `max_workflow_duration` config (default: 30 minutes). (b) Enforce it at the engine level — kill the workflow and mark it as timed-out if exceeded. (c) Allow per-workflow override in the YAML definition. (d) When a workflow times out, cancel all in-flight nodes and run any cleanup/compensation actions.

---

#### PO-14. P2: No validation of semantic consistency between sync config and pagent config

**Evidence**: The configuration (Section 11) has separate sections for `sync` and `pagent` that interact in non-obvious ways:
- `sync.batch_size: 10` limits how many Notion API calls the sync engine makes per cycle
- `pagent.max_concurrent_workflows: 5` limits parallel workflows, each of which may also make Notion API calls
- Both share the same `p-queue` rate limit of 3 req/sec
- `sync.poll_interval: 60` determines how often the sync engine runs, but pagent workflows triggered by sync events add to the API load

No validation ensures these values are consistent. A user could set `max_concurrent_workflows: 50` with `batch_size: 100`, overwhelming the 3 req/sec rate limit. Or set `poll_interval: 5` (very aggressive) while running multiple pagent workflows, causing constant 429 errors.

**Fix**: (a) Add startup validation that warns when combined throughput (sync batch rate + pagent workflow parallelism) exceeds the API rate limit. (b) Document the relationship between these config values. (c) Consider a single "API budget" config that both engines draw from, rather than independent limits that can add up to more than the API allows.

---

### Improvements

#### IMP-01. Add a sync fence / epoch mechanism

After the entity_map is updated post-sync, write a monotonically increasing `sync_epoch` to a dedicated SQLite table. The reconciler should compare the current epoch with the operation's epoch — stale operations (from before the last successful sync of that entity) can be safely discarded. This provides cheap deduplication and stale-operation detection without a full WAL.

#### IMP-02. Implement operation coalescing in the queue

Before the reconciler processes the queue, collapse multiple operations on the same entity into a single operation (keeping only the latest). This reduces API calls, prevents duplicate pushes, and naturally handles the overlapping-detection-paths problem (PO-08). The coalesced operation should carry the original timestamps for audit purposes.

#### IMP-03. Add a circuit breaker around the Notion API client

Implement the circuit breaker pattern in `notion-client.ts`:
- **Closed** (normal): requests flow through normally
- **Open** (tripped by N consecutive 429s or 5xx errors): all requests immediately fail without hitting the API; check `Retry-After` or use exponential backoff before probing
- **Half-open** (probe): send one test request; if it succeeds, close the breaker; if it fails, re-open

This prevents thundering herd on rate limits and provides a clean integration point for monitoring.

#### IMP-04. Separate the daemon lifecycle from Claude Code's stdio pipe

The design ties the daemon to Claude Code's session via stdio MCP. Consider a two-process architecture:
- **Daemon process**: Long-lived, started as a system service (launchd/systemd) or user-space daemon. Manages sync, pagent, FS watcher. Exposes a local HTTP or Unix socket API.
- **MCP bridge**: Thin stdio process started by Claude Code that proxies MCP tool calls to the daemon's local API.

This decouples the daemon's lifetime from Claude Code sessions, enables the daemon to survive session restarts, and allows multiple Claude Code sessions to share the same daemon.

#### IMP-05. Add a "sync lock" table for entity-level write serialization

Create a `sync_locks` table in SQLite:
```sql
CREATE TABLE sync_locks (
  entity_id INTEGER PRIMARY KEY REFERENCES entity_map(id),
  locked_by TEXT NOT NULL,  -- 'sync' | 'pagent:{workflow_id}'
  locked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
```
Before any Notion write, the sync engine or pagent engine must acquire the lock. This prevents PO-09 (concurrent writes) and provides a natural mechanism for the sync engine to skip entities currently in a pagent workflow.

#### IMP-06. Implement graduated backfill mode

Instead of one `batch_size` for all operations, implement three modes:
- **Incremental** (normal poll cycle): batch_size 10, conservative
- **Bulk** (init, full resync, backfill after outage): batch_size 100+, aggressive within rate limit
- **Degraded** (after 429s / circuit breaker trip): batch_size 3, minimal

The sync engine should automatically transition between modes based on queue depth and API health.

<!-- flux-drive:complete -->
