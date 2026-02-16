# Correctness Review: Bidirectional Notion Sync PRD

**Reviewer:** Julik (Flux-drive Correctness Reviewer)
**Document:** `/root/projects/Interverse/plugins/interkasten/docs/prds/2026-02-15-bidirectional-sync.md`
**Date:** 2026-02-15
**Context:** Interkasten syncs local markdown ↔ Notion bidirectionally. SQLite (better-sqlite3 + drizzle-orm) with WAL mode. Push working; PRD adds pull + three-way merge + webhook receiver + beads issue sync.

---

## Executive Summary

**High-severity findings:** 5 critical races, 2 data corruption scenarios, 1 transaction boundary violation
**Medium-severity findings:** 3 concurrency safety gaps, 2 beads DB integrity concerns
**Recommendation:** Block implementation until concurrency model is specified and transaction isolation strategy is defined.

**Core problem:** The PRD describes a multi-process, multi-writer system (webhook receiver service + MCP server + file watcher + beads CLI + user edits) sharing a SQLite database, but provides zero guidance on:
- Transaction isolation levels for three-way merge read-modify-write cycles
- Lock acquisition order to prevent deadlocks
- Concurrent access coordination between webhook receiver and MCP server
- Race conditions between polling cycle and webhook event processing
- Beads DB concurrent modification detection and conflict resolution

---

## Critical Findings (Data Corruption / Loss)

### C1: Three-Way Merge Read-Modify-Write Race (SEVERITY: CRITICAL)

**Location:** F3 Three-Way Merge acceptance criteria

**Invariant violated:** Three-way merge requires atomic read of (base, local, remote) → compute merge → write result. Current design has no transaction boundary spanning the read phase and write phase.

**Failure narrative:**

1. **T0:** Poller reads entity_map: `base_hash=A`, `local_hash=B`, `notion_hash=C` (both sides changed)
2. **T0+10ms:** Poller fetches base content from `base_content` table (content hash A)
3. **T0+50ms:** User saves local file → watcher detects change → push operation starts
4. **T0+60ms:** Push operation updates `entity_map.last_local_hash = D`, `base_content_id = new_base_id`
5. **T0+100ms:** Poller computes three-way merge using stale base A (now wrong — base should be the pushed-back version from step 4)
6. **T0+150ms:** Poller writes merged result, overwriting local change D with incorrectly merged content

**Result:** Local change D is silently lost. Merge result is corrupted because base was stale.

**Why SQLite WAL doesn't help:** WAL mode provides crash recovery, NOT read isolation. Better-sqlite3 runs in `PRAGMA read_uncommitted` mode by default when WAL is enabled. Concurrent readers see uncommitted writes from other connections.

**Fix required:**
- Wrap three-way merge in `BEGIN IMMEDIATE TRANSACTION` to acquire write lock BEFORE reading base/local/remote hashes
- Or use optimistic locking: read `entity_map.id` and `base_content_id`, compute merge, then `UPDATE entity_map SET ... WHERE id = ? AND base_content_id = ?` (fails if base changed)
- If update fails due to concurrent modification, retry merge with fresh base

**PRD gap:** No mention of transaction isolation, retry logic, or optimistic locking pattern.

---

### C2: Webhook Event Processing / Polling Race (SEVERITY: CRITICAL)

**Location:** F2 acceptance criteria line 38: "Poller processes webhook event queue first (drain queue before polling)"

**Invariant violated:** Webhook event for page P arrives → queued → poller drains queue → processes P → then polls all pages. If polling discovers P changed (via `last_edited_time`), it will re-process P, potentially overwriting the webhook-driven update.

**Failure narrative:**

1. **T0:** Notion page P edited remotely (last_edited_time now `2026-02-15T10:00:00Z`)
2. **T0+500ms:** Webhook event arrives, written to `webhook_events` table: `{page_id: P, timestamp: T0}`
3. **T0+5s:** Poller wakes up, drains webhook queue → processes event for P → pulls content → updates `entity_map.last_notion_hash = H1`, `last_notion_ver = 2026-02-15T10:00:00Z`
4. **T0+6s:** Poller enters polling phase, fetches all pages' `last_edited_time` from Notion API
5. **T0+7s:** Notion API returns P with `last_edited_time = 2026-02-15T10:00:00Z` (matches step 3)
6. **T0+8s:** Poller's fast-path filter: `last_notion_ver (2026-02-15T10:00:00Z) == API last_edited_time` → **should skip**, but PRD says "then content hash verification"
7. **T0+9s:** If content hash verification runs, it fetches page content from Notion API again, computes hash H2
8. **T0+10s:** If H2 == H1 (likely, since no edits happened between T0+6s and now), skip. But if Notion API returns slightly different markdown due to internal normalization variance, H2 ≠ H1 → false positive change detection → re-pull

**Result:** Redundant API calls, wasted tokens, potential for phantom conflicts if normalization drift causes hash mismatch.

**Worse scenario (if user edited locally between T0+3s and T0+10s):**
- Webhook pull at T0+5s updated base to remote version
- User edited local file at T0+6s
- Polling re-detects P at T0+10s → triggers three-way merge
- Merge uses base from webhook pull (T0+5s), but local file has newer edit (T0+6s)
- If webhook pull didn't trigger a conflict (because local hadn't changed yet at T0+5s), but polling now sees both changed → triggers merge
- Merge result may differ from what user expects (they saved after webhook pull, expecting their edit to be on top of remote)

**Fix required:**
- After processing webhook event for page P, mark it in a "recently synced" set with expiry (e.g., 60s)
- During polling fast-path, skip pages in the "recently synced" set
- Or: store `last_webhook_processed_ts` per entity in `entity_map`, skip polling for pages where `last_webhook_processed_ts > now - poll_interval`

**PRD gap:** No deduplication strategy between webhook-driven and poll-driven change detection.

---

### C3: Webhook Receiver / MCP Server Concurrent SQLite Writes (SEVERITY: CRITICAL)

**Location:** F1 acceptance criteria line 23: "Events written to SQLite `webhook_events` table"

**Architecture gap:** Webhook receiver is a separate systemd service (persistent HTTP server). MCP server runs inside Claude Code session (process per session). Both write to the same SQLite database at `~/.interkasten/state.db`.

**SQLite concurrency model:**
- **WAL mode** (enabled in `db.ts` line 81): Allows multiple readers + one writer
- **Writer lock:** Acquired on `BEGIN IMMEDIATE` or first write in a transaction
- **Lock timeout:** better-sqlite3 default is **5 seconds**, then throws `SQLITE_BUSY`
- **Lock contention:** If webhook receiver holds write lock (inserting event), and MCP server tries to update `entity_map` during sync, one will block the other

**Failure narrative:**

1. **T0:** Webhook receiver receives event, starts writing to `webhook_events` table → acquires write lock
2. **T0+10ms:** MCP server (in Claude Code session) starts processing file watcher event → tries to update `entity_map` → blocked waiting for write lock
3. **T0+5000ms:** Lock timeout → MCP server throws `SQLITE_BUSY` error → sync operation fails
4. **T0+5001ms:** Webhook receiver completes insert, releases lock
5. **Result:** File change not synced, operation lost (unless WAL entry exists, but WAL write also requires lock)

**Deadlock scenario (if both use transactions):**
- Not applicable here — SQLite is single-writer, so deadlock is impossible (one blocks, one fails with timeout)
- But **livelock** is possible: webhook receiver retries on timeout, MCP server retries on timeout, both keep blocking each other

**Fix required:**
- **Option A (separate databases):** Webhook events go to a separate `webhook-events.db`, MCP server reads from it (read-only, no lock contention)
- **Option B (lock timeout handling):** Retry on `SQLITE_BUSY` with exponential backoff (but this adds latency to sync operations)
- **Option C (IPC queue):** Webhook receiver writes events to an IPC mechanism (file-based queue, Unix socket, shared memory), MCP server reads and processes them (no shared SQLite write contention)
- **Option D (single-process architecture):** Merge webhook receiver into MCP server (MCP SDK supports custom transports, could expose HTTP endpoint). Eliminates multi-process contention.

**PRD gap:** No mention of SQLite lock contention, timeout handling, or multi-process coordination strategy.

---

### C4: Beads DB Concurrent Access (SEVERITY: HIGH)

**Location:** F4 acceptance criteria line 70: "Push: local beads changes detected via `.beads/issues.db` modification → diff against last known state"

**Problem:** F4 proposes reading `.beads/issues.db` directly to detect changes. But:
- Beads CLI (`bd`) also writes to this database (user running `bd update`, `bd close`, etc.)
- If interkasten MCP server holds a read transaction on `issues.db` while `bd` tries to write, `bd` will block or timeout
- If interkasten caches issue state in memory and `bd` modifies the DB, interkasten's cache is stale

**Failure narrative (data loss):**

1. **T0:** User runs `bd update <id> --status in_progress` → writes to `.beads/issues.db`
2. **T0+100ms:** Beads CLI commits transaction, closes DB
3. **T0+500ms:** Interkasten watcher detects `.beads/issues.db` modification (filesystem event)
4. **T0+600ms:** Interkasten reads issues.db, computes diff against last known state (stored in `~/.interkasten/state.db`)
5. **T0+700ms:** Interkasten pushes changed issue to Notion
6. **T0+5s:** User runs `bd close <id>` → writes to `.beads/issues.db` again
7. **T0+5.5s:** Interkasten watcher detects change, starts diff computation
8. **T0+5.6s:** **User runs `bd update <id> --notes "new note"` concurrently** → `bd` opens issues.db for write
9. **T0+5.7s:** Interkasten tries to read issues.db → **blocked waiting for `bd`'s write lock**
10. **T0+10.7s:** Timeout → interkasten logs error, skips sync for this change
11. **Result:** `bd close <id>` change never syncs to Notion (WAL entry might exist, but diff computation failed, so push never happened)

**Worse scenario (read-modify-write race):**

1. Interkasten reads issue state: `{id: 42, status: "in_progress", notes: "old"}`
2. User runs `bd update 42 --notes "new"` → beads writes `{id: 42, notes: "new"}`
3. Notion remotely updates issue 42 status to "blocked" (someone edited in Notion UI)
4. Interkasten poller pulls Notion change → sees `{status: "blocked"}` in Notion
5. Interkasten computes merge: local `{notes: "old"}` + remote `{status: "blocked"}` → merged result `{status: "blocked", notes: "old"}`
6. Interkasten writes back to beads via `bd update 42 --status blocked --notes "old"`
7. **User's `--notes "new"` change from step 2 is silently overwritten**

**Fix required:**
- **Do NOT read `.beads/issues.db` directly.** Go through `bd` CLI for all operations.
- Use `bd show <id> --json` for reads (no locking, beads handles concurrency)
- Use `bd update <id> --field value` for writes (beads CLI handles conflict detection and user prompts)
- Watch `issues.db` mtime for change detection, but use `bd list --json` to get full state snapshot (not a SQL SELECT)
- If beads CLI doesn't support `--json` output, add it or use beads' documented hook API (if one exists)

**PRD question (line 116):** "Is the beads SQLite schema stable enough to depend on?"
**Answer:** Irrelevant — schema stability doesn't solve concurrency. The issue is **concurrent writers**, not schema drift. Even if schema is stable, direct SQL reads bypass beads' locking and validation logic.

---

### C5: Soft-Delete Cascade Integrity (SEVERITY: MEDIUM-HIGH)

**Location:** F5 acceptance criteria lines 82-83

**Invariant violated:** Soft-delete local file → `entity_map.deleted = true`, Notion page gets `⚠️ Source Deleted` status. Hard-delete after 7 days.

**Problem:** What happens to child entities?
- If a project is soft-deleted, are its docs also marked deleted?
- If a doc is soft-deleted, what about its references in other docs (backlinks)?
- If a Notion page is archived, and it's a parent in the hierarchy, do children lose their parent?

**Failure narrative (orphaned entities):**

1. User has project `/root/projects/foo` with docs `/root/projects/foo/README.md`, `/root/projects/foo/docs/arch.md`
2. Hierarchy in `entity_map`: `project(id=1, parent_id=null)`, `doc(id=2, parent_id=1)`, `doc(id=3, parent_id=1)`
3. User deletes `/root/projects/foo/` (entire directory)
4. Watcher detects deletion of `README.md` and `arch.md` → marks `entity_map[2].deleted = true`, `entity_map[3].deleted = true`
5. **But what about entity_map[1] (the project)?** If the project's entity was registered from a `.beads` marker file, and that file is also deleted, it should be soft-deleted too.
6. If project entity is NOT marked deleted, then in 7 days when hard-delete runs, children are purged but parent remains → orphaned project in Notion with no docs

**Second scenario (notion-side cascade):**

1. User archives parent project page in Notion
2. Poller detects archive → marks `entity_map[1].deleted = true`
3. PRD says "local file untouched" → so child docs in `entity_map` still point to `parent_id = 1`
4. Notion's relation property for Parent may or may not null out (depends on Notion's cascade behavior for archived pages)
5. If Notion nulls the relation, then interkasten's local `parent_id` is now out of sync with Notion
6. Next hierarchy refresh tries to set parent relation → fails because parent page is archived

**Fix required:**
- Specify cascade behavior: when parent is soft-deleted, recursively mark all descendants as deleted (or: move them to top-level with `parent_id = null`)
- Specify Notion relation integrity: if parent page is archived, children's Parent relation should be cleared (both in Notion and in `entity_map`)
- Specify hard-delete cascade: when parent is hard-deleted after 7 days, recursively hard-delete children or orphan them with explicit user confirmation
- Add referential integrity check in sync engine: before setting `parent_id = X`, verify `entity_map[X].deleted = false`

**PRD gap:** No cascade rules, no referential integrity validation.

---

## Medium-Severity Findings (Concurrency Safety)

### M1: File Watcher Debounce vs Rapid Edit Race

**Location:** F2 acceptance criteria line 34: "Poller runs every 60 seconds", watcher debounce config at 500ms (inferred from existing code)

**Problem:** User makes rapid edits to a file (save, edit, save, edit) within 1 second. Watcher debounces to the last event (500ms after last save). But between the last save and the debounced sync, the poller wakes up and sees the file changed.

**Interleaving:**

1. **T0:** User saves file (hash = H1)
2. **T0+200ms:** User saves again (hash = H2)
3. **T0+400ms:** User saves again (hash = H3)
4. **T0+700ms:** Watcher debounce timer fires → enqueues sync for file (hash = H3)
5. **T0+900ms:** Watcher sync operation reads file → hash = H3, pushes to Notion
6. **T0+60s:** Poller wakes up, checks file → `last_local_hash` in entity_map is now H3 (from step 5), file hash is H3 → no change, skip
7. **No issue here** — debounce worked correctly.

**But if poller runs during debounce window:**

1. **T0:** User saves file (hash = H1)
2. **T0+200ms:** User saves again (hash = H2)
3. **T0+400ms:** Poller wakes up (60s timer from previous cycle) → reads file → hash = H2, `last_local_hash` is H1 (pre-edit) → detects change, enqueues push
4. **T0+500ms:** User saves again (hash = H3)
5. **T0+700ms:** Watcher debounce fires → enqueues sync for file (hash = H3)
6. **T0+800ms:** Queue processor runs:
   - First dequeued op: poller's push for H2 → writes to Notion, updates `last_local_hash = H2`
   - Second dequeued op: watcher's push for H3 → writes to Notion, updates `last_local_hash = H3`
7. **Result:** Two sequential pushes, second one is correct. Minor inefficiency, but no corruption.

**Actual issue (if queue deduplicates incorrectly):**

Looking at `queue.ts` line 46: deduplication key is `${operation.side}:${operation.entityKey}`.
- Poller's op: `{side: "local", entityKey: "/path/to/file"}` → key = `"local:/path/to/file"`
- Watcher's op: `{side: "local", entityKey: "/path/to/file"}` → key = `"local:/path/to/file"`
- **Same key** → watcher's op replaces poller's op in the queue (line 55: `pending.set(key, operation)`)

**New interleaving:**

1. **T0+400ms:** Poller enqueues push (hash = H2, timestamp = T0+400ms)
2. **T0+700ms:** Watcher enqueues push (hash = H3, timestamp = T0+700ms) → **replaces** poller's op
3. **T0+2000ms:** Queue processor drains, processes only watcher's op (H3)
4. **Result:** H2 never syncs (skipped)

**Is this a bug?** No — this is correct behavior. H2 is stale; H3 is the latest. Deduplication prevents redundant pushes.

**But what if local file changed to H4 between enqueue (T0+700ms) and process (T0+2000ms)?**
- Watcher detects change, enqueues new op with timestamp T0+1500ms (hash = H4)
- Dedup key is the same → replaces H3 op
- Processor runs at T0+2000ms → processes H4 → correct

**Conclusion:** No race here — deduplication is safe. Marking this as informational, not a defect.

---

### M2: Notion Webhook Aggregation Delay → Stale Fast-Path Filter

**Location:** F1 resolved questions line 111: "Key event: `page.content_updated` (aggregated, may be delayed to batch rapid edits)"

**Problem:** Notion webhook API aggregates rapid edits into a single event with a delay (unspecified, could be 5-30 seconds). During this delay:
- Poller may detect the change via `last_edited_time` (which updates immediately)
- Poller pulls content, updates `entity_map`
- Webhook event arrives later, gets queued
- Next poller cycle drains webhook queue, processes the now-stale event → redundant pull

**Mitigation in PRD:** F2 line 38 says "Poller processes webhook event queue first (drain queue before polling)". This prevents double-processing within the same cycle, but doesn't prevent processing a stale webhook from a previous cycle.

**Fix required:**
- When processing webhook event, check `entity_map.last_sync_ts` — if it's newer than the webhook event's timestamp, skip the event (already processed via polling)
- Or: check `entity_map.last_notion_ver` — if it matches the `last_edited_time` from the webhook event, skip (idempotent)

**PRD gap:** No staleness check for webhook events.

---

### M3: Three-Way Merge Determinism with Fuzzy Patch Application

**Location:** F3 dependencies line 103: "`diff-match-patch-es` — fuzzy patch application for conflict resolution"

**Concern:** Fuzzy patch application is non-deterministic when context lines don't match exactly. If base content has drifted (due to roundtrip normalization), fuzzy patching may apply changes to the wrong location.

**Example:**

Base:
```
# Section A
Line 1
Line 2

# Section B
Line 3
```

Local edit (changes Line 2 → Line 2a):
```
# Section A
Line 1
Line 2a

# Section B
Line 3
```

Notion edit (adds Line 4 in Section B):
```
# Section A
Line 1
Line 2

# Section B
Line 3
Line 4
```

Three-way merge:
- Diff base→local: `Line 2` changed to `Line 2a`
- Diff base→remote: `Line 4` added after `Line 3`
- Merge: non-overlapping → apply both → `Line 2a` + `Line 4 added`

**Result:**
```
# Section A
Line 1
Line 2a

# Section B
Line 3
Line 4
```

**But if base content is stale (e.g., stored base is actually an older version with different line numbers):**
- Stored base:
```
Line 1
Line 2
Line 3
```
- Local:
```
Line 1
Line 2a
Line 3
```
- Remote (current Notion, with section headers added):
```
# Section A
Line 1
Line 2

# Section B
Line 3
Line 4
```

- Diff base→local: `Line 2` → `Line 2a`
- Diff base→remote: added `# Section A` before Line 1, added `# Section B` and Line 4
- Fuzzy patch tries to apply "change Line 2 to Line 2a" to the remote version (which has `# Section A` above it)
- If fuzzy patch context match fails, it might apply the change to the wrong line or fail entirely

**Fix required:**
- **Never allow stale base.** Enforce optimistic locking (see C1 fix).
- After every successful push, pull back the content and store that as the new base (PRD already specifies this in F2 line 37 "roundtrip normalization")
- Add a staleness check: before starting merge, compare `base_content.created_at` to `entity_map.last_sync_ts` — if base is older than last sync, reject merge and re-pull both sides

**PRD gap:** No staleness validation for base content before merge.

---

## Low-Severity / Design Questions

### L1: Frontmatter Preservation on Pull (F2 Line 42)

**Acceptance criteria:** "Frontmatter preserved on pull (don't overwrite local frontmatter with Notion content)"

**Question:** How is frontmatter preserved if Notion doesn't store it?
- Local file has YAML frontmatter: `---\ntitle: foo\ntags: [a, b]\n---\nBody`
- Push to Notion converts body only (frontmatter stripped, stored in Notion properties if mapped)
- Pull from Notion converts Notion page to markdown → no frontmatter in the pulled content
- If we "preserve frontmatter", we need to:
  1. Parse local file, extract frontmatter
  2. Parse pulled Notion content, extract body
  3. Merge: keep local frontmatter + replace body with Notion body

**Edge case:** What if local frontmatter has a `title` field, and Notion page title changed? Do we update the frontmatter `title`, or keep it as-is?

**Fix required:** Specify frontmatter merge rules:
- Which frontmatter fields are synced to Notion properties (and pulled back)?
- Which frontmatter fields are local-only (never touched by pull)?
- If a frontmatter field is synced, does pull update it (local-wins vs notion-wins)?

**PRD gap:** Frontmatter merge semantics unspecified.

---

### L2: Conflict File Naming Collision (F3 Line 53)

**Acceptance criteria:** "`conflict-file` strategy creates `.conflict` copy with both versions (Syncthing-style)"

**Question:** What if a `.conflict` file already exists (from a previous conflict)?
- User has `doc.md` and `doc.md.conflict` (from a past conflict, unresolved)
- New conflict occurs → tries to create `doc.md.conflict` again
- Options:
  1. Overwrite existing `.conflict` file (loses old conflict data)
  2. Create `doc.md.conflict.1`, `doc.md.conflict.2`, etc.
  3. Timestamp suffix: `doc.md.conflict.2026-02-15T10:00:00Z`
  4. Fail the operation and set `ask` strategy (force user to resolve old conflict first)

**Recommendation:** Use timestamp suffix (option 3) for auditability.

**PRD gap:** Conflict file naming collision strategy unspecified.

---

### L3: `ask` Strategy UX Flow (F3 Line 54)

**Acceptance criteria:** "`ask` strategy sets a `⚠️ Conflict` status property in Notion and skips sync until resolved"

**Questions:**
1. How does user resolve the conflict? Edit in Notion and change status back to normal? Edit locally and re-sync?
2. What happens when user changes Notion status from `⚠️ Conflict` to `Active` (or removes the conflict marker)?
   - Does interkasten re-attempt the merge? With the same base (stale)? Or re-fetch both sides and retry?
3. What if both Notion and local changed again after conflict was flagged? Do we re-merge with the new content, or require user to manually pick a winner?

**Recommendation:**
- When conflict is flagged, store both conflicting versions (local and remote) in a staging area (separate table or `.conflict` files for both)
- User resolves by editing one side (e.g., Notion) and removing the conflict marker
- When conflict marker is removed, interkasten detects resolution, uses the edited Notion version as the winner, updates local file and base

**PRD gap:** Conflict resolution UX flow unspecified.

---

### L4: Webhook Secret Rotation

**Location:** F1 line 21: "Webhook secret (32-byte random) generated at setup, stored in `~/.interkasten/webhook-secret`"

**Security concern:** If webhook secret is leaked (e.g., logged in plaintext, exposed in process list, or stored in a world-readable file), an attacker can forge webhook events.

**Recommendations:**
- File permissions: `chmod 600 ~/.interkasten/webhook-secret` (owner-read-only)
- Secret rotation: provide a tool to regenerate secret and update Notion webhook subscription (requires manual re-registration since Notion API doesn't support programmatic subscription updates)
- Rate limiting: webhook receiver should rate-limit requests per IP to prevent DoS

**PRD gap:** No mention of secret permissions, rotation, or rate limiting.

---

### L5: Cloudflared Tunnel Failure → Fallback Behavior

**Location:** F1 line 27: "Graceful degradation: if tunnel fails, log warning and fall back to polling-only"

**Question:** What triggers fallback?
- Tunnel binary not found?
- Tunnel fails to start (Cloudflare API error)?
- Tunnel starts but becomes unreachable (network partition)?

**Runtime detection:** How does the webhook receiver know the tunnel is down?
- Cloudflared process crash → systemd auto-restart
- Cloudflared running but tunnel unreachable → no way to detect from inside the receiver (external monitoring needed)

**Recommendation:**
- If cloudflared process crashes, systemd should restart it (already implied by "auto-restart on failure")
- If tunnel provisioning fails at setup time, log error and disable webhook receiver (systemd unit fails to start)
- No need for runtime tunnel health checks (adds complexity, low ROI)

**PRD gap:** Tunnel failure detection strategy unspecified (but low impact — systemd auto-restart is sufficient).

---

## Transaction Boundary Analysis

### Current WAL Protocol (Push Operation)

From `engine.ts` lines 199-283:

```
1. walCreatePending (write to sync_wal)
2. Translate markdown → Notion blocks
3. Write to Notion API (delete old blocks, append new blocks)
4. walMarkTargetWritten (update sync_wal)
5. Pull back content for roundtrip base (read from Notion API)
6. upsertBaseContent (write to base_content)
7. updateEntityAfterSync (update entity_map)
8. walMarkCommitted (update sync_wal)
9. walDelete (delete from sync_wal)
10. appendSyncLog (write to sync_log)
```

**Transaction boundaries:**
- Each DB write is a separate transaction (drizzle-orm auto-commits by default)
- No explicit `BEGIN...COMMIT` wrapping the entire sequence

**Crash recovery:**
- If crash after step 3 (Notion written, local DB not updated):
  - WAL entry remains in `target_written` state
  - On restart, replay logic should: skip Notion write (already done), proceed to step 5 (pull back + update entity_map)
- If crash after step 1 (WAL pending, Notion not written):
  - WAL entry remains in `pending` state
  - On restart, replay logic should: re-read local file, re-write to Notion (idempotent if content unchanged)

**Problem:** No crash recovery logic is implemented. WAL entries accumulate but are never replayed.

**Evidence:**
- `walQueryIncomplete` function exists (line 80 in `wal.ts`) but is never called in `engine.ts`
- No startup routine to replay incomplete WAL entries
- `index.ts` (MCP server startup) doesn't call WAL recovery

**Fix required:**
- Add `recoverWAL()` function that runs at startup:
  - Query `walQueryIncomplete()`
  - For each entry in `pending` state: retry the operation (re-read file, re-push)
  - For each entry in `target_written` state: skip remote write, pull back content, update entity_map, mark committed
  - Delete committed entries
- Call `recoverWAL()` in `index.ts` after DB is opened, before starting the sync engine

**PRD gap:** No mention of crash recovery or WAL replay.

---

### Required Transaction Boundaries for Pull + Merge

**Pull operation (new in PRD, not yet implemented):**

```
1. Fetch Notion page content (API call)
2. Convert to markdown
3. Compute content hash
4. Read entity_map (get current local_hash, base_content_id)
5. Compare hashes:
   - If local unchanged: overwrite local file, update entity_map
   - If local changed: trigger three-way merge (see below)
6. Update entity_map (last_notion_hash, last_sync_ts)
7. Append sync_log
```

**Transaction boundary needed:**
- Steps 4-6 must be atomic (read entity_map, decide action, write entity_map)
- If another process updates entity_map between step 4 and step 6, merge decision is stale

**Fix:** Wrap steps 4-6 in `BEGIN IMMEDIATE TRANSACTION`.

---

**Three-way merge operation:**

```
1. Read entity_map (get local_hash, notion_hash, base_content_id)
2. Read base_content (using base_content_id)
3. Read local file (compute hash, verify matches entity_map.local_hash)
4. Fetch Notion page (compute hash, verify matches entity_map.notion_hash)
5. Run three-way merge algorithm (diff base→local, diff base→remote, merge)
6. Decide winner (merge result, conflict file, ask user, etc.)
7. Write result to local file (if local-wins or merged)
8. Write result to Notion (if notion-wins or merged)
9. Upsert new base_content (merged result or winner)
10. Update entity_map (new hashes, new base_content_id, last_sync_ts)
11. Append sync_log (with merge details)
```

**Transaction boundary needed:**
- Steps 1-11 must appear atomic from other sync operations' perspective
- Two approaches:
  1. **Pessimistic lock:** `BEGIN IMMEDIATE` before step 1 → holds write lock for entire operation (blocks other syncs, high latency)
  2. **Optimistic lock:** Read at step 1, compute merge, then at step 10 use `UPDATE entity_map SET ... WHERE id = ? AND base_content_id = ? AND local_hash = ? AND notion_hash = ?` (fails if any hash changed)

**Recommendation:** Use optimistic locking with retry:
- If `UPDATE` affects 0 rows (hashes changed), re-read entity_map and restart merge
- Limit retries to 3, then fail with conflict error

**PRD gap:** No transaction strategy specified.

---

## Recommendations

### Immediate Actions (Block Implementation)

1. **Specify concurrency model:**
   - Single-process or multi-process?
   - If multi-process (webhook receiver + MCP server), how do they coordinate?
   - Recommendation: Merge webhook receiver into MCP server (MCP SDK supports custom transports). Eliminates SQLite lock contention.

2. **Specify transaction isolation:**
   - Use `BEGIN IMMEDIATE TRANSACTION` for all read-modify-write sequences (three-way merge, pull decision, entity registration)
   - Or use optimistic locking with `WHERE` clause validation + retry

3. **Implement WAL replay:**
   - Add crash recovery logic to replay incomplete WAL entries at startup
   - Test with forced crashes (kill -9) at each step of push/pull/merge

4. **Specify beads DB access strategy:**
   - Do NOT read `.beads/issues.db` directly
   - Go through `bd` CLI for all reads/writes
   - If `bd` doesn't support JSON output, add it or use a documented hook API

5. **Specify deduplication between webhook and polling:**
   - After processing webhook event for page P, skip polling P for N seconds
   - Or: compare webhook event timestamp to `entity_map.last_sync_ts`, skip stale events

6. **Specify soft-delete cascade rules:**
   - When parent deleted, do children get deleted, orphaned, or moved to top-level?
   - When Notion page archived, does local file get marked deleted or left as-is?

---

### Before Merging Any PR

1. Add integration tests for concurrent scenarios:
   - Webhook event arrives during polling cycle
   - User saves file during pull operation
   - Beads CLI writes issue while interkasten is diffing
   - Two Claude Code sessions running interkasten simultaneously (multi-MCP-server scenario)

2. Add property-based tests for three-way merge:
   - Generate random base/local/remote edits
   - Verify merge is deterministic and doesn't lose data
   - Verify idempotence: `merge(merge(base, local, remote), local, remote) == merge(base, local, remote)`

3. Add WAL replay tests:
   - Create WAL entries in each state (`pending`, `target_written`, `committed`)
   - Kill process, restart, verify replay correctness

4. Add SQLite lock contention tests:
   - Spawn webhook receiver and MCP server in separate processes
   - Send concurrent webhook events and file changes
   - Verify no deadlocks, no lost operations, no corrupt state

---

## Risk Assessment

**Likelihood of data loss if shipped as-is:** HIGH
- Three-way merge race (C1) will occur on every conflict where both sides changed within 60s (common in active collaboration)
- Beads DB race (C4) will occur when user runs `bd update` during sync cycle (common if interkasten runs in background)

**Likelihood of sync failure if shipped as-is:** MEDIUM-HIGH
- Webhook/polling deduplication gap (C2) causes redundant API calls, may trigger Notion rate limits
- SQLite lock contention (C3) will occur when webhook receiver and MCP server write simultaneously (depends on webhook event frequency)

**Likelihood of silent corruption:** MEDIUM
- Stale base content (C1) → incorrect merge result → wrong content written to both sides → user doesn't notice until hours later
- Soft-delete cascade gap (C5) → orphaned entities → broken links → gradual data rot

**User impact at 3 AM:**
- "Why did my Notion edit get overwritten?" → C1 (three-way merge race)
- "Why is interkasten stuck in `SQLITE_BUSY` loop?" → C3 (multi-process lock contention)
- "Why did my beads issue status revert?" → C4 (beads DB read-modify-write race)

---

## Summary Table

| ID | Finding | Severity | Impact | Fix Effort |
|----|---------|----------|--------|------------|
| C1 | Three-way merge read-modify-write race | CRITICAL | Data loss (local edits overwritten) | Medium (add optimistic locking) |
| C2 | Webhook/polling deduplication gap | CRITICAL | Redundant syncs, rate limit risk, phantom conflicts | Low (add staleness check) |
| C3 | Webhook receiver / MCP server SQLite lock contention | CRITICAL | Sync failures, `SQLITE_BUSY` errors | High (merge into single process or use separate DB) |
| C4 | Beads DB concurrent access | HIGH | Data loss (beads edits overwritten), sync failures | Medium (switch to `bd` CLI) |
| C5 | Soft-delete cascade integrity | MEDIUM-HIGH | Orphaned entities, broken hierarchy | Medium (specify cascade rules) |
| M1 | File watcher debounce race | INFO | No issue (dedup works correctly) | None |
| M2 | Notion webhook aggregation delay | MEDIUM | Redundant pulls, wasted API calls | Low (add timestamp check) |
| M3 | Three-way merge base staleness | MEDIUM | Incorrect merge results | Low (enforce base freshness) |
| L1 | Frontmatter preservation semantics | LOW | Unclear behavior | Low (document merge rules) |
| L2 | Conflict file naming collision | LOW | Overwrites old conflicts | Low (add timestamp suffix) |
| L3 | `ask` strategy UX flow | LOW | Unclear resolution path | Medium (design UX flow) |
| L4 | Webhook secret rotation | LOW | Security risk if leaked | Low (chmod 600 + docs) |
| L5 | Cloudflared tunnel failure fallback | LOW | Unclear behavior | None (systemd restart sufficient) |
| TX1 | No WAL replay on startup | HIGH | Incomplete operations orphaned | Medium (add recovery logic) |
| TX2 | No transaction boundaries for merge | CRITICAL | Stale reads, race conditions | Medium (add `BEGIN IMMEDIATE` or optimistic locking) |

**Verdict:** Do NOT proceed with implementation until C1, C2, C3, C4, and TX2 are addressed in the PRD. Ship the fixes in the first PR, not as follow-up work.
