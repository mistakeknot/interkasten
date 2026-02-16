# Correctness Review: Bidirectional Sync Implementation Plan

**Reviewer:** Julik (Flux-drive Correctness Reviewer)
**Target:** `/root/projects/Interverse/plugins/interkasten/docs/plans/2026-02-15-bidirectional-sync.md`
**Date:** 2026-02-15
**Priority:** High-consequence correctness failures first

---

## Executive Summary

The plan adds bidirectional Notion sync to interkasten via polling and three-way merge. Core architecture claim is "single-writer guarantee" — only the MCP server process reads and writes SQLite.

**Critical Issues Found:** 4 high-severity correctness failures
**Medium Issues:** 6 race or consistency risks
**Minor Issues:** 3 testing or observability gaps

**Blocker count:** 2 (race in optimistic locking, incomplete soft-delete semantics)

---

## Critical Issues (Blockers)

### 1. Task 7 — Optimistic Locking Race in handleConflict

**Location:** Task 7, lines 776-831 (proposed `handleConflict` implementation)

**Failure narrative:**

```
Time    Pull-A                          Pull-B
T0      Poll detects Page X changed     —
T1      Read local file (v1)            —
T2      Read entity.baseContentId → v0  —
T3      Compute merge(v0, v1, v2)       Poll detects Page X changed
T4      —                               Read local file (v1, same)
T5      —                               Read entity.baseContentId → v0
T6      Write merged to local file      —
T7      —                               Compute merge(v0, v1, v3)
T8      Push merged to Notion           —
T9      —                               Write merged to local (OVERWRITES T6)
T10     —                               Push merged to Notion (OVERWRITES T8)
```

Both pull operations start with the same base (v0) and local (v1), but Notion sent different versions (v2, v3) due to rapid edits. **Both merges succeed, but whichever writes last silently drops the other's Notion changes.**

**Plan text (Task 7, line 806):**
> "Optimistic locking for merge (Task 7) — read base → compute → verify base unchanged → write"

**Problem:** The plan describes the pattern but **the implementation code in Task 7 never performs the "verify base unchanged" step.** It reads base once (line 788), computes (line 807), then unconditionally writes (line 827). There's no re-check before the write.

**Correct sequence:**

```typescript
private async handleConflict(entity: any, localContent: string, notionContent: string): Promise<void> {
  const strategy = this.config.sync.conflict_strategy;

  // 1. Read base and record ID
  const baseSnapshot = entity.baseContentId
    ? getBaseContent(this.db, entity.baseContentId)
    : null;
  const baseContentId = entity.baseContentId;
  const base = baseSnapshot?.content ?? "";

  // 2. Compute merge
  const result = strategy === "conflict-file"
    ? { merged: localContent, hasConflicts: true, conflicts: [] }
    : threeWayMerge(base, localContent, notionContent, strategy);

  // 3. VERIFY BASE UNCHANGED before writing
  const currentEntity = getEntityById(this.db, entity.id);
  if (currentEntity.baseContentId !== baseContentId) {
    throw new Error("Base content changed during merge — concurrent modification detected");
  }

  // 4. Write merged to local file and update entity atomically
  writeFileSync(entity.localPath, result.merged, "utf-8");
  const newBaseId = upsertBaseContent(this.db, result.merged).id;
  const newHash = hashMarkdown(normalizeMarkdown(result.merged));

  updateEntityAfterSync(this.db, entity.id, {
    lastLocalHash: newHash,
    baseContentId: newBaseId,
    lastSyncTs: new Date().toISOString(),
  });

  if (result.hasConflicts) {
    const localId = upsertBaseContent(this.db, localContent).id;
    const notionId = upsertBaseContent(this.db, notionContent).id;
    markConflict(this.db, entity.id, localId, notionId);
  } else {
    clearConflict(this.db, entity.id);
  }

  // 5. Push merged result back to Notion
  await this.pushUpdate(entity.id, entity.notionId, result.merged, newHash);
}
```

**Required changes:**
- Add `getEntityById(db, id)` helper to `entities.ts`
- Add optimistic check before filesystem write
- Decide retry strategy: immediate retry (up to N times) or re-enqueue as pull operation

**Impact:** Without this, rapid Notion edits during merge window will silently lose data. This is a **production data corruption risk** if two agents or users edit Notion while local merge is computing.

---

### 2. Task 12 — Incomplete Soft-Delete Semantics

**Location:** Task 12, lines 1182-1228 (soft-delete implementation)

**Failure narrative:**

```
Time    Local FS                        Notion                          SQLite
T0      File exists                     Page exists                     entity tracked
T1      User deletes file               —                               processPushOperation detects file_removed
T2      —                               —                               soft-delete entity, mark page "Source Deleted"
T3      —                               User archives page in Notion    —
T4      —                               —                               pollNotionChanges detects 404
T5      —                               —                               soft-delete entity (IDEMPOTENT OK)
[7 days pass]
T6      —                               —                               gcDeletedEntities runs
T7      —                               Page still archived             entity HARD-DELETED from SQLite
T8      User restores file from backup  —                               File appears
T9      Watcher fires file_added        —                               processPushOperation runs
T10     —                               —                               No entity exists (hard-deleted)
T11     —                               —                               Plan says "new file — skip" (line 184-186)
```

**Result:** Restored file never syncs. User must manually re-register the project to re-discover the file.

**Plan text (Task 12, Step 2, line 1212):**
> "When `op.type === "file_removed"`: soft-delete entity, update Notion page status to `⚠️ Source Deleted`, log."

**Problem:** The plan doesn't specify what happens when:
1. A soft-deleted file reappears within 7 days (before GC)
2. A soft-deleted file reappears after GC (entity gone)
3. Notion page is restored from archive while entity is soft-deleted

**Correct semantics:**

- **Case 1 (file reappears before GC):** `processPushOperation` should check `entity.deleted` flag. If true and file exists, **un-delete** the entity (set `deleted=0`, `deletedAt=NULL`), resume normal push sync, clear "Source Deleted" status in Notion.

- **Case 2 (file reappears after GC):** Entity is gone. File appears as "new file" per current push logic (line 184-186). This is **correct only if new-file registration is implemented** — current code says "skip" (line 184-186). **The plan never adds new-file registration logic.** This is a **separate blocker** — see Issue 3.

- **Case 3 (Notion page restored):** `pollNotionChanges` sees page is back. If entity is soft-deleted, un-delete it. If local file is missing, pull should restore the file with content from Notion.

**Required changes:**
- Task 12 Step 2: Add un-delete logic when file reappears while soft-deleted
- Task 6 or Task 12: Add Notion-restore un-delete logic in `pollNotionChanges` or `processPullOperation`
- Document GC behavior: warn user that files or pages deleted longer than 7 days lose sync tracking

**Impact:** Data resurrection scenarios fail silently. Users lose sync state permanently after 7-day GC window with no recovery path except manual re-registration.

---

### 3. Task 6 — New File Registration Missing from Pull Path

**Location:** Task 6, lines 610-714; existing push code engine.ts:183-186

**Failure narrative:**

```
Time    Local FS                        Notion                          SQLite
T0      —                               User creates new page in DB     —
T1      —                               —                               pollNotionChanges detects page
T2      —                               —                               Enqueues pull operation
T3      —                               —                               processPullOperation starts
T4      —                               —                               getEntityByNotionId returns undefined
T5      —                               —                               Plan doesn't specify what to do
```

**Plan text (Task 6, Step 3, line 685):**
> "Add `processPullOperation()` method — fetch Notion content, compare hashes, detect conflicts, call `executePull` or `handleConflict`"

**Problem:** `processPullOperation` is only described for **existing tracked entities**. Plan never describes what happens when `pollNotionChanges` discovers a page that's not in `entity_map`.

**Current push code (engine.ts:183-186):**
```typescript
} else {
  // New file — needs a project context to determine where to create in Notion
  // For now, we only push updates to already-registered entities.
  // New entity registration happens during init or register_project.
}
```

Push explicitly defers new-file registration to manual tools. **Pull path has no equivalent.** If a user creates a Notion page in a tracked database, the plan doesn't specify:
1. Should it be pulled to a local file? (where? what path?)
2. Should it be registered in `entity_map`?
3. Should it be ignored until user manually registers?

**Likely intention (from context):** Ignore new Notion pages until user runs `interkasten_register_project` or `interkasten_scan_files` to explicitly opt-in. But this means **pull sync only updates existing tracked files, never creates new ones.**

**Required changes:**
- Task 6 Step 3: Add explicit "new page" branch in `processPullOperation`:
  ```typescript
  const entity = getEntityByNotionId(this.db, pageChange.pageId);
  if (!entity) {
    // New page in Notion not yet tracked locally — skip for now.
    // User must run scan or register to opt-in to pulling new pages.
    appendSyncLog(this.db, {
      operation: "pull_skipped",
      detail: { notionId: pageChange.pageId, reason: "not_tracked" },
    });
    return;
  }
  ```

**Impact:** Without this, `processPullOperation` will throw when `entity` is undefined. Poller will log errors on every cycle for untracked pages. Not a data loss issue, but **crashes the pull path** until fixed.

---

### 4. Task 1 — Migration Reversibility Violated

**Location:** Task 1, lines 17-69 (conflict tracking migration)

**Plan text (Task 1, Step 3, lines 48-56):**
```sql
ALTER TABLE entity_map ADD COLUMN conflict_detected_at TEXT;
ALTER TABLE entity_map ADD COLUMN conflict_local_content_id INTEGER REFERENCES base_content(id);
ALTER TABLE entity_map ADD COLUMN conflict_notion_content_id INTEGER REFERENCES base_content(id);
```

**Problem:** SQLite doesn't support `DROP COLUMN` until version 3.35.0 (2021). Older SQLite versions (common in Ubuntu 20.04, Debian 11) can't reverse this migration without recreating the entire table.

**Current db.ts pattern (line 92-94):**
```typescript
if (!colNames.has("doc_tier")) {
  sqlite.exec("ALTER TABLE entity_map ADD COLUMN doc_tier TEXT");
}
```

Same problem exists for existing migrations — they're irreversible on older SQLite.

**Implication:** Not a runtime failure, but **violates migration hygiene**. If Task 1 deploys and conflicts turn out to be the wrong data model (e.g., need conflict history, not just latest), rolling back requires:
1. Export all entity_map data
2. Drop table
3. Recreate with old schema
4. Reimport (losing conflict state)

**Mitigation:** Document in `CLAUDE.md` that schema migrations are append-only. For reversibility, use a versioned table approach:
- `entity_map_v2` with new columns
- `entity_map_v1` (current table)
- Migration: `INSERT INTO entity_map_v2 SELECT *, NULL, NULL, NULL FROM entity_map_v1`
- Keep v1 table until confirmed v2 is stable

**Impact:** Medium severity. Not a production failure, but creates rollback risk if conflict semantics are wrong.

---

## High-Risk Race Conditions

### 5. Task 5-6 — Poll Interval Race with Queue Processing

**Location:** Task 6, Step 3, lines 691-699 (poll interval setup)

**Plan text (line 691-699):**
```typescript
const pollInterval = setInterval(async () => {
  try {
    await syncEngine.pollNotionChanges();
  } catch (err) {
    console.error("Poll error:", err);
  }
}, (config.sync?.poll_interval ?? 60) * 1000);
```

**Problem:** `pollNotionChanges()` is async and takes unbounded time (pagination, large databases). If poll takes longer than 60s, the next poll interval fires **while the previous poll is still running**.

**Failure narrative:**

```
Time    Poll-1                                    Poll-2
T0      Start poll, fetch page 1/100              —
T30     Still fetching...                         —
T60     Still fetching page 50/100                Start poll (poll-1 not done)
T70     Enqueue pull ops for pages 1-50           Fetch page 1/100 (duplicate)
T80     Enqueue pull ops for pages 51-100         Fetch page 2/100
T90     Done                                      Enqueue duplicate pull ops
T120    —                                         Still running... (T180 poll-3 starts)
```

**Result:** Poll operations pile up, queue fills with duplicates (deduped by entity key, so not catastrophic, but wastes CPU and API quota).

**Correct pattern (from existing engine timer, line 78-82):**
```typescript
let pollInProgress = false;
const pollInterval = setInterval(async () => {
  if (pollInProgress) return; // Skip if previous poll still running
  pollInProgress = true;
  try {
    await syncEngine.pollNotionChanges();
  } catch (err) {
    console.error("Poll error:", err);
  } finally {
    pollInProgress = false;
  }
}, 60000);
```

**Required changes:**
- Task 6 Step 3: Add `pollInProgress` guard flag
- Or: use `setTimeout` instead of `setInterval` and reschedule at end of poll

**Impact:** CPU and API quota waste. Not a data corruption issue, but degrades under load.

---

### 6. Task 7 — Merge and Push Not Atomic

**Location:** Task 7, lines 827-831 (proposed handleConflict)

**Plan text (line 827-831):**
```typescript
// Write merged to local
writeFileSync(entity.localPath, result.merged, "utf-8");

// Push merged to Notion (reuse existing push logic)
await this.pushUpdate(entity.id, entity.notionId, result.merged, hashMarkdown(normalizeMarkdown(result.merged)));
```

**Problem:** Two writes (local file and Notion) with no atomicity. If `pushUpdate` throws (circuit breaker open, 401, etc.), local file is updated but Notion is stale.

**Failure narrative:**

```
Time    handleConflict                          Watcher
T0      Write merged to local file              —
T1      Call pushUpdate()                       —
T2      pushUpdate throws CircuitOpenError      —
T3      handleConflict propagates error         —
T4      —                                       Watcher sees file change (new hash)
T5      —                                       Enqueues push operation
T6      —                                       processPushOperation runs
T7      —                                       Reads new hash, sees it != lastLocalHash
T8      —                                       Pushes again (duplicate push)
```

**Result:** Not a corruption, but **double-push** if first push fails. WAL protects the second push, but wastes API calls.

**Correct pattern:** Use WAL for the local write too, or defer push to next queue cycle:

```typescript
// Write merged to local
writeFileSync(entity.localPath, result.merged, "utf-8");

// Enqueue push instead of immediate call
this.queue.enqueue({
  side: "local",
  type: "file_modified",
  entityKey: entity.localPath,
  timestamp: new Date(),
});
```

Watcher will detect the change and push normally, with full WAL protection.

**Impact:** Low severity. Wastes API quota but doesn't corrupt data.

---

### 7. Task 11 — Beads Diff State Storage Missing

**Location:** Task 11, lines 1148-1177 (beads integration in engine)

**Plan text (Task 11, Step 1, line 1155):**
> "Add `pollBeadsChanges()` that calls `fetchBeadsIssues` for each project, diffs against last known state, and enqueues push operations for changes."

**Problem:** Plan doesn't specify where "last known state" is stored. `entity_map` tracks files, not beads issues.

**Options:**
1. Store last-known beads state in a new table `beads_snapshot(project_id, issue_id, state_json)`
2. Store in `entity_map.tags` or a new JSON column
3. Recompute from Notion every cycle (expensive: N Notion fetches per project)

**Without persistent state:**

```
Time    Beads State       pollBeadsChanges           Notion
T0      [issue A: open]   Fetch, no previous → treat all as "added"   Create page for A
T60     [issue A: open]   Fetch, no previous → treat all as "added"   Duplicate page for A
```

**Result:** Every poll cycle treats all beads issues as new, creating duplicate Notion pages.

**Correct approach:**
- Add `beads_snapshot` table in Task 1 migration
- `pollBeadsChanges` stores current state after diff
- Or: use Notion as source-of-truth (fetch all pages, match by Beads ID property)

**Required changes:**
- Task 1: Add `beads_snapshot` table
- Task 11 Step 1: Store snapshot after diff

**Impact:** High. Without state persistence, beads sync creates duplicate Notion pages on every poll.

---

## Medium-Risk Consistency Issues

### 8. Task 6 — Path Validation Missing for Pull

**Location:** Task 6, lines 622-647 (path validation tests)

**Plan includes test (line 629-636):**
```typescript
it("should reject paths with traversal sequences", () => {
  const projectDir = "/root/projects/test";
  const malicious = "../../../etc/passwd";
  const resolved = resolve(projectDir, malicious);
  expect(resolved.startsWith(projectDir)).toBe(false);
});
```

**Problem:** Test exists, but **implementation in `executePull` is not shown**. Task 6 Step 3 says "add `executePull()` private method" but doesn't include the path validation code.

**Failure scenario:** Malicious Notion page with property `local_path: "../../../.ssh/authorized_keys"` could write outside project directory.

**Required validation in executePull:**
```typescript
private async executePull(entity: any, notionContent: string): Promise<void> {
  const projectDir = findProjectDir(entity.localPath); // walk up to .git or .beads
  const resolved = resolve(projectDir, entity.localPath);

  if (!resolved.startsWith(projectDir)) {
    throw new Error(`Path traversal detected: ${entity.localPath}`);
  }

  // ... rest of pull logic
}
```

**Impact:** Medium. Requires attacker to have Notion write access, but **arbitrary file write is a security vulnerability**.

---

### 9. Task 6 — Frontmatter Preservation Race

**Location:** Task 6, lines 649-670 (frontmatter preservation tests)

**Plan text (line 651-657):**
```typescript
const fmMatch = localContent.match(/^---\n[\s\S]*?\n---\n/);
const frontmatter = fmMatch ? fmMatch[0] : "";
const merged = frontmatter + "\n" + notionContent;
```

**Problem:** Pull reads local file, extracts frontmatter, merges with Notion content, writes back. **Not atomic.** If local file is edited between read and write:

```
Time    Pull                        User/Watcher
T0      Read local (v1, FM="A")     —
T1      Extract frontmatter "A"     —
T2      Fetch Notion content        User edits file, changes FM to "B"
T3      Merge: FM="A" + Notion      —
T4      Write merged                Frontmatter reverts to "A" (USER EDIT LOST)
```

**Result:** Local frontmatter edits are silently dropped during pull.

**Correct approach:**
- Re-read local file immediately before write in `executePull`, re-extract frontmatter
- Or: WAL-protect the pull operation with a local file lock
- Or: use hash comparison (read local hash before fetch, compare before write, abort if changed)

**Required changes:**
- Task 6 Step 3, `executePull`: Add pre-write hash check:
  ```typescript
  const preWriteHash = hashContent(readFileSync(entity.localPath, "utf-8"));
  if (preWriteHash !== preReadHash) {
    // Local file changed during pull — abort and re-enqueue
    throw new Error("Local file modified during pull");
  }
  ```

**Impact:** Medium. Rare (requires user edit during 1-2s pull window), but silently loses data.

---

### 10. Task 10 — Beads Command Blocks Event Loop

**Location:** Task 10, lines 1040-1050 (beads sync module)

**Plan text (line 1042-1046):**
```typescript
const output = execFileSync("bd", ["list", "--format=json"], {
  cwd: resolve(projectDir),
  encoding: "utf-8",
  timeout: 10000,
});
```

**Problem:** The execFileSync call is synchronous and blocks the Node.js event loop for up to 10s. If bd list hangs (large beads database, corrupted index), the entire MCP server stalls.

**Failure narrative:**

```
Time    Beads Poll              MCP Server              Client
T0      execFileSync("bd")      Event loop blocked      —
T5      Still waiting...        Event loop blocked      MCP tool call arrives
T8      Still waiting...        Event loop blocked      Client timeout (no response)
T10     Timeout → throw         Event loop resumes      —
```

**Result:** All MCP tool calls timeout during beads poll. User sees "server not responding" for 10 seconds.

**Correct approach:**
```typescript
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export async function fetchBeadsIssues(projectDir: string): Promise<BeadsIssue[]> {
  try {
    const { stdout } = await execFileAsync("bd", ["list", "--format=json"], {
      cwd: resolve(projectDir),
      encoding: "utf-8",
      timeout: 10000,
    });
    return parseBeadsOutput(stdout);
  } catch {
    return [];
  }
}
```

**Required changes:**
- Task 10 Step 3: Use async `execFile` instead of `execFileSync`
- Task 11 Step 1: Make `pollBeadsChanges` async (already is)

**Impact:** High UX degradation. Server appears hung during beads sync.

---

### 11. Task 7 — Conflict Strategy from Stale Config

**Location:** Task 7, line 785 (handleConflict reads config)

**Plan text (line 785):**
```typescript
const strategy = (this.config.sync?.conflict_strategy || "three-way-merge") as ConflictStrategy;
```

**Problem:** `this.config` is loaded once at startup (index.ts:28). If user runs `interkasten_config_set conflict_strategy=notion-wins`, the change is written to YAML but **not reloaded into `SyncEngine.config`**.

**Failure narrative:**

```
Time    User                            SyncEngine
T0      interkasten_config_set          config.yaml updated
T1      —                               Next conflict uses OLD strategy (from startup)
T10     Restart MCP server              New strategy loaded
```

**Result:** Config changes don't take effect until server restart.

**Correct approach:**
- Make `DaemonContext.config` a getter that reloads from disk on each access
- Or: `interkasten_config_set` broadcasts to running engine via event emitter
- Or: document in Task 8 that conflict_strategy changes require restart

**Impact:** Low. Confusing UX, but not a data loss issue.

---

### 12. Task 12 — GC Runs on Every Poll (Performance)

**Location:** Task 12, Step 4, lines 1220-1223

**Plan text (line 1220-1223):**
> "Add a periodic `gcDeletedEntities(db, new Date(Date.now() - 7 * 86400000))` call (daily or on each poll cycle)."

**Problem:** "on each poll cycle" means every 60 seconds. GC does a table scan with date comparison:

```sql
DELETE FROM entity_map WHERE deleted = 1 AND deleted_at < ?
```

For a database with 10,000 tracked entities, this is 10,000 row checks per minute which equals 600,000 checks per hour.

**Correct approach:**
- Run GC daily, not per-poll
- Use a separate `setInterval` with 24-hour period
- Or: piggyback on an existing daily cron (if one exists)

**Required changes:**
- Task 12 Step 4: Change "or on each poll cycle" to "daily via separate timer"
- Add to index.ts shutdown: clear GC interval

**Impact:** Low data risk, but CPU and SQLite I/O waste.

---

### 13. Task 6 — WAL Pull States Incomplete

**Location:** Task 6, Step 3, lines 685-689 (executePull description)

**Plan text (line 685-689):**
> "Add `executePull()` private method — WAL protocol for pull: pending → write local file (preserving frontmatter) → target_written → update entity_map → committed → delete WAL"

**Problem:** WAL states for pull don't match push semantics. Push WAL tracks:
- `pending`: operation queued
- `target_written`: Notion write succeeded
- `committed`: entity_map updated
- `deleted`: WAL cleaned up

Pull "target" is the local filesystem. If `write local file` succeeds but `update entity_map` throws (unique constraint violation, FK error), WAL is in `target_written` state. **Crash recovery would re-write the local file on startup**, even though it's already written.

**Existing push code (engine.ts:199-265):**
```typescript
const walEntry = walCreatePending(this.db, { entityMapId, operation: "push", newContent });
// ... write to Notion ...
walMarkTargetWritten(this.db, walEntry.id);
// ... update entity_map ...
walMarkCommitted(this.db, walEntry.id);
walDelete(this.db, walEntry.id);
```

Push target is Notion (idempotent: re-writing same content is safe). Pull target is local file (also idempotent if content is same, but watcher will fire again → duplicate push).

**Correct approach:**
- Skip WAL for pull (it's a read-modify-write on local file, already atomic via filesystem)
- Or: use WAL but add `pull` operation type, crash recovery skips re-write if file hash matches

**Impact:** Low. Duplicate watcher events on crash recovery, but no data loss.

---

## Minor Issues (Testing and Observability)

### 14. Task 5 — NotionPoller Pagination Cursor Safety

**Location:** Task 5, lines 556-581 (NotionPoller.pollDatabase)

**Plan text (line 559-580):**
```typescript
do {
  const response: any = await this.notion.call(async (client) => {
    return client.databases.query({
      database_id: dataSourceId,
      filter: { timestamp: "last_edited_time", last_edited_time: { after: since.toISOString() } },
      start_cursor: cursor,
      page_size: 100,
    });
  });

  for (const page of response.results) { /* ... */ }
  cursor = response.has_more ? response.next_cursor : undefined;
} while (cursor);
```

**Problem:** No max-page safety limit. If Notion returns infinite pagination (API bug, corrupted DB), loop runs forever, consuming memory and API quota.

**Correct pattern:**
```typescript
let pageCount = 0;
const MAX_PAGES = 1000; // 100,000 results max

do {
  if (++pageCount > MAX_PAGES) {
    console.error(`Pagination limit reached for database ${databaseId} — results truncated`);
    break;
  }
  // ... existing code ...
} while (cursor);
```

**Impact:** Low. Unlikely, but defends against runaway API loops.

---

### 15. Task 14 — Integration Tests Don't Cover Crash Recovery

**Location:** Task 14, lines 1264-1291 (integration test suite)

**Plan lists tests (lines 1277-1283):**
- push and pull roundtrip
- merge scenarios
- beads sync
- soft-delete

**Missing:** WAL crash recovery. No test verifies:
- Crash after `target_written` but before `committed` → recovery completes
- Crash during merge → local file and Notion consistency
- Crash during beads sync → no duplicate pages

**Required test:**
```typescript
it("should recover from crash mid-push", async () => {
  const db = openTestDb();
  const entity = createTestEntity(db, "test.md", "page-123");

  // Simulate crash: create WAL entry in target_written state, then exit
  walCreatePending(db, { entityMapId: entity.id, operation: "push", newContent: "new" });
  walMarkTargetWritten(db, 1);

  // Restart: engine should complete the operation
  const engine = new SyncEngine({ config, db, notion });
  await engine.recoverWAL(); // need this method

  const updatedEntity = getEntityById(db, entity.id);
  expect(updatedEntity.lastSyncTs).toBeTruthy();
});
```

**Impact:** Medium. Without crash recovery tests, WAL guarantees are unverified.

---

### 16. Task 9 — Conflict Notification Doesn't Show File Paths

**Location:** Task 9, lines 900-926 (session start hook)

**Plan text (line 913-917):**
```bash
CONFLICTS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM entity_map WHERE conflict_detected_at IS NOT NULL AND deleted = 0" 2>/dev/null || echo "0")
if [ "$CONFLICTS" -gt 0 ] 2>/dev/null; then
  MSG="$MSG, ⚠️ $CONFLICTS unresolved conflicts"
fi
```

**Problem:** Shows count, not file paths. User sees "3 unresolved conflicts" but doesn't know which files.

**Better version:**
```bash
CONFLICT_PATHS=$(sqlite3 "$DB_PATH" "SELECT local_path FROM entity_map WHERE conflict_detected_at IS NOT NULL AND deleted = 0 LIMIT 3" 2>/dev/null || echo "")
if [ -n "$CONFLICT_PATHS" ]; then
  CONFLICT_COUNT=$(echo "$CONFLICT_PATHS" | wc -l)
  MSG="$MSG, ⚠️ $CONFLICT_COUNT conflicts: $(echo "$CONFLICT_PATHS" | head -1)"
  [ "$CONFLICT_COUNT" -gt 1 ] && MSG="$MSG +$((CONFLICT_COUNT - 1)) more"
fi
```

**Impact:** Low. UX improvement, not a correctness issue.

---

## Single-Writer Guarantee Verification

**Plan claim (Architecture section, line 9):**
> "Extend the existing single-process MCP server with a Notion poller (60s interval), three-way merge via `node-diff3`, and beads sync via `bd` CLI (using `execFile`, not `exec`). All operations serialize through the existing `SyncQueue`. No new processes or network listeners."

**Verification:**
- All SQLite access goes through `DaemonContext.db` (single better-sqlite3 connection)
- Notion writes go through `NotionClient.queue` (PQueue with concurrency=1 per operation)
- File writes go through `SyncEngine.processQueue()` (processes one op at a time)
- WAL provides crash recovery without multi-writer coordination

**Single-writer guarantee HOLDS** — no multi-process SQLite access, no IPC, no shared filesystem locking needed.

**Exception:** Beads CLI (`bd`) writes to `.beads/index.db` **outside interkasten's control**. If user runs `bd update` manually while interkasten's `pollBeadsChanges` is reading, **bd's SQLite lock protects the beads database**, but interkasten has no visibility into whether a read is stale.

**Mitigation:** Beads sync reads at T0, diffs, pushes to Notion at T60. If user runs `bd update` at T30, change won't be detected until next poll (T60). This is **eventual consistency by design**, not a violation of single-writer. Documented in Task 11.

---

## Required Changes Summary

| Issue | Task | Change | Priority |
|-------|------|--------|----------|
| 1. Optimistic locking race | 7 | Add base verification before merge write | **BLOCKER** |
| 2. Soft-delete semantics | 12 | Add un-delete logic for file or page restoration | **BLOCKER** |
| 3. New page registration | 6 | Add "not tracked" skip logic in processPullOperation | HIGH |
| 4. Migration reversibility | 1 | Document append-only migrations or use versioned tables | MEDIUM |
| 5. Poll overlap | 6 | Add pollInProgress guard flag | HIGH |
| 6. Merge and push atomicity | 7 | Enqueue push instead of immediate call | MEDIUM |
| 7. Beads state storage | 1, 11 | Add beads_snapshot table and persistence | **BLOCKER** |
| 8. Path validation | 6 | Add resolve and startsWith check in executePull | HIGH |
| 9. Frontmatter race | 6 | Add pre-write hash check | MEDIUM |
| 10. Beads sync blocks | 10 | Use async execFile instead of execFileSync | HIGH |
| 11. Config reload | 7, 8 | Document restart requirement or add hot-reload | LOW |
| 12. GC frequency | 12 | Change to daily timer instead of per-poll | LOW |
| 13. WAL pull states | 6 | Skip WAL or handle idempotent re-write | LOW |
| 14. Pagination safety | 5 | Add MAX_PAGES limit | LOW |
| 15. Crash recovery tests | 14 | Add WAL recovery integration test | MEDIUM |
| 16. Conflict notification UX | 9 | Show file paths, not just count | LOW |

---

## Testing Gaps

1. **No concurrency tests** — Task 4-7 tests verify merge logic, but no tests for:
   - Concurrent pull operations on same entity
   - Pull during push
   - Watcher fire during merge

2. **No beads CLI failure tests** — Task 10 tests parse and diff logic, but not:
   - `bd` command not found
   - `bd` returns invalid JSON
   - `bd` timeout

3. **No Notion API pagination edge cases** — Task 5 tests pagination with 2 pages, but not:
   - Empty database
   - 1000+ pages
   - API returns `has_more: true` with `next_cursor: null` (API bug)

4. **No filesystem permission tests** — Task 6 tests path validation, but not:
   - Local file is read-only during pull
   - Project directory doesn't exist
   - Disk full during write

**Recommendation:** Add property-based tests for merge (QuickCheck-style), stress tests for polling (1000 entities, rapid Notion edits), and failure injection tests (ENOSPC, EPERM).

---

## Recommended Implementation Order

**Phase 1 (Fix blockers):**
1. Task 1 and fix Issue 7 (add beads_snapshot table)
2. Task 7 and fix Issue 1 (add optimistic locking)
3. Task 12 and fix Issue 2 (add un-delete logic)

**Phase 2 (Core functionality):**
4. Tasks 2-6 (schema → merge → poller → pull) and fix Issue 3, 5, 8, 9
5. Task 10 and fix Issue 10 (beads async)
6. Task 11 (beads integration)

**Phase 3 (Polish):**
7. Tasks 8-9 (tools and hooks) and fix Issue 11, 16
8. Task 13 (T2 linked refs)
9. Task 14 (integration tests) and fix Issue 15
10. Task 15 (docs)

**Do NOT merge Task 7 without fixing Issue 1** — optimistic locking race will cause production data loss.

---

## Positive Observations

1. **WAL protocol is sound** — crash recovery logic from existing push path is robust
2. **Circuit breaker and backoff in NotionClient** — production-grade API resilience
3. **Content-addressed base_content** — deduplication prevents storage bloat
4. **Soft-delete with GC** — safer than immediate hard-delete
5. **Per-page mutex in NotionClient** — prevents concurrent writes to same page
6. **Three-way merge with fallback strategies** — flexible conflict resolution
7. **Comprehensive test coverage plan** — 79 existing tests plus 15 new test files

The plan's architecture is solid. The correctness issues are fixable before implementation. Prioritize blockers (Issues 1, 2, 7) before starting Task 7 or Task 11.
