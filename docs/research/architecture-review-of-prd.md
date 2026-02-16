# Architecture Review: Bidirectional Notion Sync PRD

**Reviewed:** 2026-02-15
**PRD:** `/root/projects/Interverse/plugins/interkasten/docs/prds/2026-02-15-bidirectional-sync.md`
**Bead:** Interkasten-3wh

---

## Executive Summary

This PRD proposes five features to complete bidirectional sync between local project files and Notion: webhook receiver, pull sync with polling, three-way merge, beads issue sync, and production hardening. The architecture is **fundamentally sound** with strong separation of concerns across the MCP server boundary, but contains **three critical boundary violations** and **substantial accidental complexity** that will create long-term maintenance burden.

### Critical Findings

1. **Process model mismatch (MUST FIX):** Webhook receiver as persistent systemd service contradicts MCP server's session-scoped lifecycle. Creates two parallel state machines with no coordination protocol.
2. **Shared database without locking (MUST FIX):** Webhook service and MCP server both write to `webhook_events` table with no concurrency control. SQLite's default locking is insufficient for this access pattern.
3. **Pull sync violates single-direction responsibility (ARCHITECTURAL DRIFT):** SyncEngine currently owns push (local→Notion). Adding pull creates bidirectional coupling and doubles merge complexity without extracting shared merge logic.

### Structural Recommendations

- **F1 Webhook:** Eliminate systemd service. Extend MCP server with HTTP listener on separate port (stdio + HTTP multi-transport).
- **F2 Pull Sync:** Extract `MergeCoordinator` module that orchestrates push/pull/merge as separate operations. Keep SyncEngine as push-only orchestrator.
- **F3 Three-Way Merge:** Create `ContentMerger` utility (pure function: base + local + remote → merged). Reuse for both doc sync and issue note sync.
- **F4 Beads Sync:** Treat as separate entity type with its own sync coordinator. Don't overload doc sync with property merge logic.

---

## 1. Boundaries & Coupling

### 1.1 MCP Server Lifecycle vs. Persistent Service

**Current architecture:** MCP server is session-scoped (started by Claude Code via stdio, lifecycle tied to the parent process). The server starts on first tool call, stops when Claude Code exits.

**PRD proposal (F1):** Add a persistent systemd service (`interkasten-webhook.service`) that receives Notion webhook events and writes them to SQLite `webhook_events` table. The MCP server "drains the queue" during polling.

**Violation:** This creates two independent processes with no lifecycle coordination:
- MCP server: transient, stdio-bound, managed by Claude Code
- Webhook receiver: persistent, network-bound, managed by systemd

**Failure modes:**
- Webhook receiver crashes → MCP server has no detection mechanism (relies on manual `interkasten_webhook_status` call)
- MCP server stops → webhook events accumulate unbounded in SQLite (no eviction policy specified)
- Both running → SQLite write contention (webhook INSERT + MCP DELETE) with no explicit locking beyond SQLite's default page-level locks
- Cloudflared tunnel dies → webhook receiver logs warning but continues accepting invalid events (secret validation passes, but delivery to Notion subscription is dead)

**Boundary recommendation:** The webhook receiver is NOT a separate service — it's a transport concern for the MCP server. MCP servers can expose both stdio and HTTP transports simultaneously (see MCP SDK examples). The correct architecture:

```
MCP Server (single process, multi-transport)
├─ stdio transport (port 0, stdin/stdout) ← Claude Code
├─ HTTP transport (port 7339) ← Notion webhooks
├─ Shared event queue (in-memory, backed by SQLite WAL)
└─ Single SyncEngine instance (processes both watcher events and webhook events)
```

If multi-transport is truly impossible (MCP SDK limitation), the fallback is to make the webhook receiver a **dumb HTTP→filesystem bridge**: write events to `~/.interkasten/webhook-inbox/*.json`, let MCP server's existing watcher pick them up. No SQLite writes from webhook process.

**Impact:** As specified, F1 creates a distributed system where none existed. The PRD doesn't address event ordering (what if webhook arrives before watcher sees the file?), crash recovery across two processes, or resource limits on the event queue.

---

### 1.2 Entity Sync vs. Property Sync (Beads Issues)

**Current architecture:** `entity_map` tracks four entity types: `project`, `doc`, `ref`, `issues` (database). Sync engine handles content (markdown body) only. Properties (frontmatter, Notion structured fields) are write-once during registration.

**PRD proposal (F4):** Beads issues sync bidirectionally with Notion Issues database. Field mapping includes:
- Content: `notes` ↔ page body (markdown, three-way merge)
- Properties: `status`, `priority`, `type`, `assignee`, `created`, `updated` (last-write-wins)
- Relations: `dependencies` ↔ `Blocked By` (self-referencing within Issues DB)

**Violation:** This conflates two sync modes with incompatible conflict resolution:
- **Content sync:** three-way merge (F3), needs base content storage, line-level diff
- **Property sync:** last-write-wins (atomic updates, no merge)

The PRD doesn't specify:
- How to determine "last write" across local beads DB and Notion (both have `updated_at` timestamps, but clocks may be skewed)
- What happens when local marks issue as `closed` (beads) while Notion changes priority (property conflict is orthogonal to content conflict)
- How to handle relation updates (add/remove dependencies) when both sides change the set

**Boundary recommendation:** Extract property sync as a separate responsibility:

```
SyncCoordinator (orchestrates)
├─ ContentSync (markdown body, three-way merge)
├─ PropertySync (structured fields, last-write-wins with conflict detection)
└─ RelationSync (foreign keys / relation properties, set merge with tombstones)
```

Each sync type has different conflict resolution, different base-tracking (content hash vs. version vector), and different error handling (content failures are recoverable, relation failures may violate FK constraints).

**Current coupling:** The PRD proposes extending `SyncEngine.processPushOperation` to handle both doc pushes and issue pushes. This creates a 2×2 matrix (doc/issue × push/pull) inside a single method that's already 120+ lines.

---

### 1.3 Polling vs. Webhook Change Detection

**Current architecture:** Filesystem watcher (chokidar) detects local changes, queues push ops. No remote change detection (push-only).

**PRD proposal (F2):** Add polling (every 60s) for Notion-side changes. Webhook events (F1) are processed first (drain queue), then polling as fallback.

**Separation concern:** The PRD treats webhook and polling as redundant change detection mechanisms, but they have different guarantees:
- **Webhooks:** near-instant, requires public endpoint, events may be lost (Notion doesn't guarantee delivery), events are aggregated (rapid edits batched)
- **Polling:** delayed, works without public endpoint, never misses changes (exhaustive scan), expensive for large workspaces

The PRD specifies "drain queue before polling" (F2) but doesn't explain:
- What happens if the same page is changed via webhook AND detected by polling in the same cycle? (Duplicate pull attempt, or deduplication based on `last_edited_time`?)
- Does polling skip pages that were recently updated via webhook? (Avoids redundant work, but requires in-memory state of "recently processed" pages)
- How to detect new entities via webhook? (Webhook payload has `page_id` but no parent context — how to determine which project owns the new page?)

**Boundary recommendation:** Treat webhook and polling as separate **change event sources** that feed a unified **change detector**:

```
ChangeDetector (deduplicates and filters)
├─ WebhookEventSource (page_id + event_type)
├─ PollingEventSource (last_edited_time scan)
└─ OutputQueue (deduplicated, ordered by priority: webhook > polling)
```

The change detector maintains a 5-minute sliding window of `(page_id, last_processed_timestamp)` pairs to suppress duplicate processing. Webhook events bypass the window (priority), polling events are filtered by it.

---

### 1.4 Three-Way Merge as Shared Utility vs. Inline Logic

**Current architecture:** Push operation (SyncEngine.pushUpdate) does: local content → translate → Notion write → pull back → update base. No merge logic (local always wins).

**PRD proposal (F3):** When both local and Notion changed since last sync, perform three-way merge:
1. Compute `diff(base, local)` and `diff(base, remote)`
2. Merge non-overlapping changes automatically
3. Apply fallback strategy for overlapping regions

**Coupling risk:** The PRD specifies installing `node-diff3` and `diff-match-patch-es` but doesn't specify WHERE the merge logic lives. Likely location (based on existing code): inside `SyncEngine.processPushOperation` or a new `SyncEngine.processPullOperation`.

**Problem:** Merge is a pure content transformation (base + local + remote → merged), but SyncEngine is an orchestrator (database writes, WAL protocol, Notion API calls, watcher coordination). Embedding merge logic couples the orchestrator to content-level decisions (what counts as a "conflict", how to split sections, whitespace normalization).

**Boundary recommendation:** Extract merge as a pure utility module:

```typescript
// src/sync/content-merger.ts
export interface MergeResult {
  merged: string;
  conflicts: ConflictRegion[];
  strategy: 'auto' | 'local-wins' | 'notion-wins';
  sections: { base: string; local: string; remote: string; resolution: string }[];
}

export function mergeMarkdown(
  base: string,
  local: string,
  remote: string,
  strategy: ConflictStrategy
): MergeResult;
```

This utility:
- Is testable in isolation (no database, no Notion API, no WAL)
- Can be reused for both doc sync (F2) and issue note sync (F4)
- Keeps SyncEngine focused on orchestration (when to merge, what to do with conflicts)

**Naming drift:** The PRD uses "three-way merge" (git terminology) but also "conflict-file" (Syncthing terminology) and "ask" (interactive resolution). These are different strategies at different abstraction layers:
- **Merge algorithm:** three-way diff (always applied)
- **Conflict resolution:** auto / local-wins / notion-wins / conflict-file / ask (fallback when merge produces conflicts)

The config `sync.conflict_strategy` conflates these. Recommended split:
- `sync.merge_mode`: `three-way` | `local-only` | `remote-only` (whether to merge at all)
- `sync.conflict_fallback`: `local-wins` | `notion-wins` | `conflict-file` | `ask` (when merge produces conflicts)

---

## 2. Pattern Analysis

### 2.1 WAL Protocol Extension for Pull Operations

**Current pattern (push):** pending → target_written → committed → delete

**PRD proposal (F2):** Same WAL protocol for pull operations.

**Analysis:** The WAL protocol is asymmetric:
- **Push:** local content is durable (in git), Notion is volatile (API may fail). WAL protects Notion write + entity_map update atomicity.
- **Pull:** Notion content is durable (Notion's DB), local file is volatile (write may fail, file may be deleted). WAL protects file write + entity_map update atomicity.

The current `sync_wal` schema (schema.ts:63-76) is push-oriented:
- `newContent` field holds the content to write (makes sense for push, awkward for pull where "new content" is pulled from Notion)
- `oldBaseId` references the base before the operation (used for rollback, but pull doesn't need rollback — if file write fails, local file is unchanged)

**Recommendation:** Generalize WAL schema to support bidirectional ops:

```typescript
export const syncWal = sqliteTable("sync_wal", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entityMapId: integer("entity_map_id").notNull().references(() => entityMap.id),
  operation: text("operation").notNull(), // 'push' | 'pull' | 'merge'
  direction: text("direction").notNull(), // 'local_to_notion' | 'notion_to_local'
  state: text("state").notNull(), // 'pending' | 'target_written' | 'committed' | 'rolled_back'
  sourceContentHash: text("source_content_hash"), // hash of content being pushed/pulled
  targetContentHash: text("target_content_hash"), // expected hash after write
  baseContentId: integer("base_content_id").references(() => baseContent.id),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  completedAt: text("completed_at"),
});
```

This removes `oldBaseId` and `newContent` (redundant with entity_map + base_content) and adds `direction` to make protocol symmetric.

---

### 2.2 Soft-Delete Asymmetry

**PRD proposal (F5):**
- **Local delete:** mark entity as deleted in entity_map, set Notion status to `⚠️ Source Deleted`, hard-delete after 7 days
- **Notion delete:** mark entity as deleted in entity_map, leave local file untouched, log warning, user must manually delete

**Asymmetry:** Why the different handling? Likely reasoning:
- Local deletes are often accidental (git reset, file moved) → protect Notion side
- Notion deletes are intentional (user archived the page) → protect local side

**Problem:** This creates divergent state that's never reconciled:
- User deletes local file → Notion page gets warning status → 7 days pass → entity_map row deleted → Notion page orphaned (still has warning status, no longer tracked)
- User archives Notion page → entity_map marked deleted → local file untouched → future edits to local file won't sync (entity is deleted) → silent desync

**Pattern recommendation:** Introduce explicit **delete intentions**:

```typescript
export const entityMap = sqliteTable("entity_map", {
  // ... existing fields
  deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
  deletedAt: text("deleted_at"),
  deletedSide: text("deleted_side"), // 'local' | 'notion' | 'both'
  deletedBy: text("deleted_by"), // 'user' | 'cascade' | 'policy'
});
```

Deletion flow:
1. **Detect delete** (local file missing OR Notion page archived)
2. **Record intention** (deletedSide = 'local'/'notion', deletedBy = 'user')
3. **Apply soft-delete policy** (set status property, leave other side intact)
4. **Wait for user confirmation** (via MCP tool `interkasten_confirm_delete` or auto-confirm after 7 days)
5. **Hard delete both sides** (delete Notion page, delete local file, delete entity_map row)

This makes deletion **symmetric** (both sides end up deleted) and **explicit** (user confirms before data loss).

---

### 2.3 Entity Type Explosion

**Current entity types:** `project`, `doc`, `ref`, `issues`

**PRD additions:**
- `issue` (individual beads issue, child of `issues` database)

**Future roadmap (from PRD.md):**
- Pagent workflows (separate database per project)
- Research inbox (shared database)
- Changelogs (generated doc)
- ADRs (separate database per project)

**Pattern drift:** The entity_map schema conflates:
- **Sync entities** (things that sync content: `project`, `doc`, `ref`, `issue`)
- **Container entities** (things that hold other entities: `issues` database, but NOT individual issues)

The PRD proposes adding `issue` as an entity type, but `issues` (the database) is already an entity. This creates ambiguity:
- Is `issues` (database) synced? (No, it's just a container)
- Is `issue` (individual row) synced? (Yes, bidirectionally)
- Can an `issue` entity have children? (Not in the PRD, but `project` entities can have children)

**Recommendation:** Split entity_map into two tables:

```typescript
// Sync units (things with content that syncs)
export const syncEntities = sqliteTable("sync_entities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  localPath: text("local_path").notNull().unique(),
  notionId: text("notion_id").notNull().unique(),
  entityType: text("entity_type").notNull(), // 'doc' | 'issue'
  contentType: text("content_type").notNull(), // 'markdown' | 'json'
  syncDirection: text("sync_direction").notNull(), // 'push' | 'pull' | 'bidirectional'
  lastLocalHash: text("last_local_hash"),
  lastNotionHash: text("last_notion_hash"),
  baseContentId: integer("base_content_id").references(() => baseContent.id),
  // ... sync metadata
});

// Hierarchy (things that contain other things)
export const hierarchy = sqliteTable("hierarchy", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  nodeType: text("node_type").notNull(), // 'project' | 'database'
  localPath: text("local_path").notNull().unique(),
  notionId: text("notion_id").notNull().unique(),
  parentId: integer("parent_id").references(() => hierarchy.id),
  tags: text("tags").default("[]"),
  // ... hierarchy metadata
});
```

This separates:
- **What syncs** (sync_entities: docs, issues, refs) from **what organizes** (hierarchy: projects, databases)
- **Content operations** (hash, merge, translate) from **structural operations** (parent/child, tags)

---

## 3. Simplicity & YAGNI

### 3.1 Cloudflared Tunnel Auto-Provisioning

**PRD proposal (F1):** Cloudflared tunnel provisions automatically, maps public URL → local port. Named tunnels persist across restarts.

**Complexity introduced:**
- Download `cloudflared` binary (platform detection, binary verification, auto-update)
- Manage Cloudflare credentials (store tunnel UUID, account token, DNS record)
- Handle Cloudflare API failures (quota exceeded, DNS record collision, account suspended)
- Monitor tunnel health (tunnel connected but traffic not flowing)
- Expose tunnel URL to user (so they can paste it into Notion webhook settings)

**Necessity check:** The PRD states "Webhook subscriptions are created through the Notion integration settings UI only — no API endpoint for programmatic creation." This means the user MUST manually:
1. Get the tunnel URL (from MCP tool output or config file)
2. Open Notion integration settings
3. Create webhook subscription
4. Paste tunnel URL

Given manual setup is required anyway, is auto-provisioning the tunnel worth the complexity?

**Alternatives:**
- **User-provided webhook URL:** Config option `sync.tunnel.url`. User provisions their own tunnel (Cloudflare, ngrok, Tailscale Funnel, public VPS). Interkasten listens on localhost, user maps URL → localhost.
- **Polling-only mode:** Skip webhooks entirely (F1 becomes optional). Polling every 60s is acceptable for doc sync (not chat/collaboration).

**Recommendation:** Make tunnel provisioning OPTIONAL:
- If `sync.tunnel.url` is set → bind HTTP listener, validate webhook secret
- If `sync.tunnel.url` is unset → polling-only mode, no HTTP listener
- Auto-provisioning (F1 full spec) deferred to F6 (convenience feature)

This cuts ~300 lines of tunnel management code (40% of F1) and removes the Cloudflare dependency.

---

### 3.2 Conflict Strategy: "Ask"

**PRD proposal (F3):** Conflict strategy `ask` sets a `⚠️ Conflict` status property in Notion and skips sync until user resolves.

**Implementation complexity:**
- How does user "resolve" the conflict? (Notion UI doesn't support this workflow — user would edit the page, but we don't know WHICH edit is the "resolution")
- How long does conflict state persist? (Until next push? Until user calls a tool? Forever?)
- What happens if user edits local file while conflict is pending? (Another conflict on top of unresolved conflict?)

**Current fallback strategies:**
- `three-way-merge`: Always try to merge, use local-wins for overlaps (0 user actions)
- `local-wins`: Local content overwrites Notion (0 user actions)
- `notion-wins`: Notion content overwrites local (0 user actions)
- `conflict-file`: Create `.conflict` file with both versions (1 user action: manually merge and delete `.conflict`)

The `ask` strategy introduces:
- Persistent conflict state (new database table: `conflicts`)
- User interaction protocol (new MCP tool: `interkasten_resolve_conflict`)
- Notion-side conflict UI (new page property: `Conflict Status`)

**YAGNI check:** Is there a real scenario where `ask` is better than `conflict-file`?
- `conflict-file`: User sees conflict immediately (file appears in IDE), merges in editor, deletes conflict file, next sync is clean
- `ask`: User must check Notion for conflict status, call MCP tool to see diff, manually decide which side wins, call another MCP tool to resolve

The `conflict-file` strategy is **already interactive** and uses tools the user already has (text editor, file manager). The `ask` strategy requires building a conflict resolution UI from scratch.

**Recommendation:** Drop `ask` strategy from F3. If user wants interactive resolution, `conflict-file` provides it with zero additional code. If user data demonstrates demand for a richer conflict UI (phase 2), add it then.

---

### 3.3 Beads DB Direct Access vs. CLI Wrapper

**PRD Open Question 1:** "F4 reads `.beads/issues.db` directly. Is the beads SQLite schema stable enough to depend on, or should we go through the `bd` CLI for all reads/writes?"

**Current PRD spec (F4):** "Pull: Notion issue changes (status, priority, notes) flow back to beads via `bd update`"

**Inconsistency:** Pull uses CLI (`bd update`), push uses direct DB read (implied by "local beads changes detected via `.beads/issues.db` modification").

**Complexity analysis:**

| Approach | Push | Pull | Pros | Cons |
|----------|------|------|------|------|
| Direct DB | Read `.beads/issues.db` | Write to `.beads/issues.db` | Fast, no subprocess overhead | Breaks if beads schema changes, bypasses beads validation |
| CLI wrapper | `bd list --format json` | `bd update <id> --status=...` | Schema-stable, validation included | Slow (subprocess per issue), parsing overhead, CLI args are awkward for structured data |
| Hybrid | Direct DB read | CLI write | Read perf + write safety | Asymmetric, complex |

**Recommendation:** Use **CLI wrapper exclusively** (push AND pull). Reasons:
1. **Schema stability:** Beads is actively developed (recent commit: `2d1e0c5 fix: make interbump resilient to version drift`). Direct DB access WILL break.
2. **Validation:** Beads CLI validates issue state transitions (can't close an issue with open dependencies). Direct DB writes bypass this.
3. **Audit trail:** Beads CLI writes to `.beads/log`. Direct DB writes are invisible to beads tooling.

Performance mitigation: Batch CLI calls (`bd update <id1> <id2> <id3> --status=...` if beads supports batch mode, or `bd import issues.json` for bulk sync).

If beads doesn't support batch mode, add it (1-day task, benefits all beads consumers).

---

### 3.4 T2 Linked References (Automatic Summaries)

**PRD proposal (F5):** Files matched by `scan_files` but not T1 → summary card in Notion: title, path, 1-2 sentence AI summary, last modified timestamp, line count.

**Complexity:**
- AI summarization (which model? which prompt? cost per file?)
- Summary staleness (when to regenerate? on every content change? on timer?)
- File selection heuristic (user picks via `scan_files`, but what if they pick 500 files? summarize all of them?)

**YAGNI check:** The PRD treats T2 as "second-tier documentation" (referenced but not actively maintained). Automatic summaries imply:
- Summaries are valuable (user wants to see them in Notion)
- Summaries stay current (refresh when file changes)
- Summaries are cheap (acceptable to regenerate on every sync)

Reality: If file is not T1 (actively maintained doc), why does it need an AI summary? The value of T2 is **discoverability** (knowing the file exists, where it lives, when it changed). The 1-2 sentence summary is:
- Expensive (LLM call per file, 500 files × $0.01 = $5 per full scan)
- Stale (file changes, summary is regenerated, Notion page edit history is polluted)
- Low-value (user can `cmd+click` the file path and read the actual file)

**Recommendation:** T2 cards should be **metadata-only** (no AI summary):
- Title (filename or first H1)
- Path (absolute, clickable if Notion supports file:// URLs)
- Last modified (mtime)
- Size (lines, bytes)
- Content preview (first 3 lines, plain text)

AI summarization becomes an **on-demand feature** (user calls `interkasten_summarize_file` if they want a summary for a specific file).

This cuts F5 scope by ~50% and eliminates ongoing LLM cost.

---

## 4. Open Risks

### 4.1 Notion API Rate Limits

The PRD doesn't specify rate limit handling. Notion API limits (as of 2024):
- **3 requests/second** average
- Burst allowance: unclear (Notion docs don't specify)

Current architecture (NotionClient, index.ts:44-51):
- Circuit breaker after N consecutive failures
- Exponential backoff (1s → 32s)

**Missing:** Rate limit detection (HTTP 429) and backoff strategy. If polling scans 50 projects × 10 docs = 500 pages, that's 500 API calls every 60s = 8.3 req/s (exceeds limit by 2.7×).

**Recommendation:** Add rate limiter to NotionClient:
- Track request timestamps (sliding 1s window)
- Delay requests to maintain 2.5 req/s average (buffer below 3 req/s)
- Detect 429 responses, back off for `Retry-After` duration

---

### 4.2 Roundtrip Content Fidelity

**Current architecture (push flow, engine.ts:240-251):** After pushing content to Notion, pull it back immediately and use pulled version as base content.

**Rationale:** Notion's markdown→blocks→markdown conversion is lossy (example: `**bold**` may become `__bold__`, extra whitespace added). Using pulled-back content as base prevents phantom conflicts on next sync.

**PRD impact (F2 pull sync):** Pull operations also need roundtrip normalization, but in reverse:
1. Pull from Notion → markdown
2. Write to local file
3. Read back from local file (normalization applied by file write)
4. Use read-back version as base

Without this, phantom conflicts appear when:
- Notion has `__bold__`, local has `**bold**` → base is `**bold**` → next pull sees diff (base vs. pulled) → spurious conflict

**Missing from PRD:** Specification of roundtrip testing. The PRD includes "Integration test coverage" (F5) but doesn't call out:
- Idempotence test: push → pull → compare (should be identical)
- Stability test: push → pull → push → pull (should converge, not oscillate)
- Whitespace preservation: trailing newlines, indentation, blank lines

**Recommendation:** Add F5 acceptance criterion:
- [ ] **Roundtrip tests:** For each supported markdown feature (headings, lists, code blocks, tables, bold/italic, links), verify push→pull→push produces identical Notion state.

---

### 4.3 Beads Dependencies as Relations

**PRD proposal (F4):** Beads `dependencies` → Notion `Blocked By` relation property (self-referencing within Issues DB).

**Complexity:** Beads stores dependencies as JSON array of issue IDs (local beads IDs). Notion stores relations as array of page IDs (Notion page IDs). Sync requires bidirectional ID mapping:
- Local→Notion: `["bead-1", "bead-2"]` → lookup entity_map → `["notion-abc", "notion-def"]`
- Notion→Local: `["notion-abc", "notion-def"]` → lookup entity_map → `["bead-1", "bead-2"]`

**Failure modes:**
- Dependency on unsynced issue (bead exists locally, not yet in Notion) → lookup fails → drop dependency? create placeholder?
- Dependency on deleted issue (bead closed and purged) → lookup fails → orphaned relation
- Circular dependencies (A blocks B, B blocks A) → Notion allows, beads may reject

**Missing from PRD:**
- Dependency sync order (must sync issues before relations, or use two-pass sync)
- Orphaned relation cleanup (detect + remove relations to deleted issues)
- Cycle detection (validate before writing to beads)

**Recommendation:** Defer relation sync to F6. F4 scope should be:
- Content sync (issue notes)
- Property sync (status, priority, type, assignee)

Relations are a separate feature with separate complexity. The PRD bundles them into F4 because the schema supports it, but implementation complexity is non-trivial.

---

## 5. Migration Path

If all recommendations are accepted, the refactored architecture:

```
plugins/interkasten/
├── server/src/
│   ├── index.ts (MCP entry, multi-transport if possible)
│   ├── sync/
│   │   ├── coordinator.ts (orchestrates push/pull/merge, NEW)
│   │   ├── content-merger.ts (pure merge utility, NEW)
│   │   ├── engine.ts (push-only, SIMPLIFIED)
│   │   ├── poller.ts (Notion polling, NEW)
│   │   ├── change-detector.ts (deduplicates events, NEW)
│   │   └── webhook-receiver.ts (optional HTTP listener, NEW)
│   ├── beads/
│   │   ├── sync.ts (beads-specific sync, NEW)
│   │   └── cli.ts (bd wrapper, NEW)
│   └── store/
│       ├── sync-entities.ts (split from entity_map, NEW)
│       └── hierarchy.ts (split from entity_map, NEW)
```

**Phase 1 (F2 + F3):** Pull sync + merge, without webhook or beads
- Extract `ContentMerger` utility (testable in isolation)
- Add `SyncCoordinator` that delegates to existing `SyncEngine` (push) and new `Poller` (pull)
- Extend WAL schema for bidirectional ops
- 79 existing tests + ~40 new tests (merge, pull, roundtrip)

**Phase 2 (F1):** Webhook receiver (optional)
- Add HTTP listener to MCP server (if SDK supports) OR file-based inbox (if not)
- Extend `ChangeDetector` to consume webhook events
- ~20 new tests (webhook validation, event deduplication)

**Phase 3 (F4):** Beads sync (content + properties only)
- Create `beads/` module with CLI wrapper
- Extend `SyncCoordinator` to handle `issue` entity type
- Reuse `ContentMerger` for note sync
- ~30 new tests (beads sync, property conflicts)

**Phase 4 (F5):** Soft-delete + integration tests
- Implement symmetric soft-delete with user confirmation
- Add Notion API integration tests (gated behind env var)
- Add roundtrip fidelity tests

**Deferred:**
- Cloudflared auto-provisioning (F1 optional)
- Conflict strategy "ask" (F3 YAGNI)
- T2 AI summaries (F5 YAGNI)
- Beads dependency relations (F4 complexity)

---

## 6. Summary of Recommendations

| Finding | Severity | Recommendation | Impact |
|---------|----------|----------------|--------|
| Webhook as systemd service | MUST FIX | Multi-transport MCP server OR file-based inbox | Eliminates distributed system, removes SQLite contention |
| Pull in SyncEngine | SHOULD FIX | Extract SyncCoordinator, keep SyncEngine push-only | Reduces coupling, enables reuse of merge logic |
| Three-way merge inline | SHOULD FIX | Extract ContentMerger utility | Testable, reusable for beads notes |
| Beads DB direct access | SHOULD FIX | Use `bd` CLI exclusively | Schema stability, validation, audit trail |
| Cloudflared auto-provision | DEFER | Make webhook optional, user-provided URL | Cuts 40% of F1 complexity |
| Conflict strategy "ask" | DEFER | Drop from F3, rely on conflict-file | Avoids building conflict resolution UI |
| T2 AI summaries | DEFER | Metadata-only cards, on-demand summarization | Cuts 50% of F5, eliminates LLM cost |
| Beads dependency relations | DEFER | F4 content+properties only, relations in F6 | Reduces F4 complexity |

---

## Conclusion

The PRD is **architecturally ambitious but structurally unsound**. The core idea (bidirectional sync with three-way merge) is correct, but the execution plan introduces:
- A distributed system where a single process suffices (webhook receiver)
- Coupled responsibilities where extraction is straightforward (merge logic, beads sync)
- Speculative features that add complexity without validated demand (auto-tunnel, "ask" strategy, AI summaries)

**With refactoring:** This is a clean 4-phase build (F2→F3→F1→F4) that extends the existing architecture without breaking its boundaries.

**Without refactoring:** This becomes a maintenance burden within 6 months (webhook service drift, merge logic duplication, beads schema breakage).

**Recommended action:** Revise PRD to split F1 (webhook optional), extract merge utility (F3), defer YAGNI features (auto-tunnel, "ask", T2 summaries, relations). Target 4-week implementation (1 week per phase) instead of rushing all 5 features.
