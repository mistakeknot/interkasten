# Correctness Review: Interkasten Bidirectional Sync

**Reviewer:** Julik (Flux-drive Correctness Reviewer)
**Date:** 2026-02-16
**Scope:** TypeScript MCP server adding bidirectional Notion sync (diff at `/tmp/qg-diff.txt`)

## Executive Summary

**Critical findings:** 5 data corruption risks, 3 race conditions, 2 transaction safety gaps
**Status:** BLOCK — merge discipline failures will wake someone at 3 AM

The core three-way merge path is structurally sound, but multiple concurrency and edge-case bugs create corruption windows. The WAL protocol is correctly ordered for pull operations, but beads snapshot logic has race-prone INSERT OR REPLACE semantics, and conflict detection can lose updates under concurrent poll/push.

---

## Critical Issues (Ship-Blockers)

### C1. Concurrent Poll + Push → Lost Conflict Detection
**File:** `server/src/sync/engine.ts` (lines 590-627, 754-826)
**Severity:** Data loss — silent overwrite of local changes

**Failure narrative:**
1. Local file changes → `processPushOperation` reads local, computes hash H1
2. Poll cycle starts → `pollNotionChanges` fetches page, finds remote edit
3. Poll enqueues pull op with `entityKey: entity.notionId` (line 618)
4. Push operation commits, updates `lastLocalHash = H1`, `lastSyncTs = T1`
5. Pull operation reads `entity` from DB, sees `lastLocalHash = H1`
6. Pull compares local file hash (now H1) with `lastLocalHash` (H1) → `localUnchanged = true` (line 676)
7. Pull executes clean overwrite (lines 678-679), discarding the local change that just synced

**Root cause:** Poll checks `lastSyncTs` outside the queue processing transaction. Between the poll decision and pull execution, a push can commit, making the staleness check invalid.

**Minimal fix:**
```typescript
// In processPullOperation (line 633+), re-check remote version before executing pull:
const freshEntity = getEntityByNotionId(this.db, op.entityKey);
const page: any = await this.notion.call(async () => {
  return this.notion.raw.pages.retrieve({ page_id: freshEntity.notionId });
});
const remoteEditTime = new Date(page.last_edited_time);
if (remoteEditTime <= new Date(freshEntity.lastSyncTs)) {
  // Another operation already synced this version
  return;
}
// Then proceed with conflict detection using fresh entity hashes
```

Require: Poll-time stale check is advisory only. Pull execution MUST re-validate with current entity state.

---

### C2. Beads Snapshot Race → Stale Diff Detection
**File:** `server/src/sync/engine.ts` (lines 870-928)
**Severity:** Duplicate/missed updates to Notion

**Failure narrative:**
1. Poll cycle A reads snapshot S1 from DB (line 879-881)
2. Poll cycle B (overlapping, `pollInProgress` only guards `pollNotionChanges`, not `pollBeadsChanges`) reads same S1
3. Both cycles compute diff against S1, detect same change C
4. Both try to push C to Notion → duplicate API calls (lines 890-905)
5. Cycle A saves snapshot S2 (line 915-920)
6. Cycle B saves snapshot S3 (overwrites S2 via ON CONFLICT), but S3 was computed from stale S1
7. Changes in [S2 - S1] are now invisible in next poll cycle (S3 baseline is wrong)

**Root cause:** `INSERT OR REPLACE` is not transactional with the diff computation. `pollBeadsChanges` has no concurrency guard.

**Minimal fix:**
```typescript
private beadsPollInProgress = false; // Add field to class

async pollBeadsChanges(): Promise<void> {
  if (this.beadsPollInProgress) return;
  this.beadsPollInProgress = true;
  try {
    // existing logic
  } finally {
    this.beadsPollInProgress = false;
  }
}
```

Also: Use a transaction around fetch snapshot → compute diff → push changes → save snapshot.

---

### C3. WAL Cleanup Before Notion Push Completes
**File:** `server/src/sync/engine.ts` (lines 725-730, 826)
**Severity:** Irrecoverable state if Notion push fails after local commit

**Failure narrative:**
1. Pull operation writes local file, marks `target_written`, updates entity, marks `committed`, deletes WAL (lines 702-730)
2. Post-merge push to Notion (line 826) throws (rate limit, network partition, permission change)
3. Local entity now has `lastNotionHash = H` (line 822) but Notion still has old content
4. Next poll sees old Notion content → re-detects "conflict" → infinite merge/push loop

**Root cause:** WAL cleanup happens before the compensating Notion push in conflict resolution path. The pull is committed to local state, but the convergence push is not WAL-protected.

**Minimal fix:**
```typescript
// In handleConflict (line 826), wrap Notion push in WAL:
const pushWal = walCreatePending(this.db, {
  entityMapId: entity.id,
  operation: "push-after-merge",
  newContent: result.merged,
});

await this.pushUpdate(entity.id, entity.notionId, result.merged, notionHash);

walMarkCommitted(this.db, pushWal.id);
walDelete(this.db, pushWal.id);
```

Or: Change semantic — `lastNotionHash` should only update after Notion push succeeds. Move line 819 update after line 826 push completes.

---

### C4. Path Traversal Prevention — Incomplete Guard
**File:** `server/src/sync/engine.ts` (lines 641-653)
**Severity:** Arbitrary file write via malicious Notion page metadata

**Failure narrative:**
1. Attacker with Notion DB write access changes a page's local_path metadata to `../../../../etc/cron.d/backdoor`
2. Poll detects change, enqueues pull with `entityKey = <notion-page-id>`
3. `processPullOperation` reads entity, sees `localPath = "/root/projects/../../etc/cron.d/backdoor"`
4. `findProjectDir` walks up, returns `/root/projects/Foo` (line 850-856)
5. `resolve(projectDir, basename(entity.localPath))` → `/root/projects/Foo/backdoor` (line 643)
6. Guard checks `!resolved.startsWith(projectDir + "/")` → passes (line 644)
7. Write proceeds, but to wrong location (should have rejected `../` in path)

**Root cause:** `resolve(projectDir, basename(localPath))` uses `basename`, which strips parent references AFTER they've been stored. But the guard uses the original `entity.localPath` for logging, not for validation. Also, `entity.localPath` should never contain `../` — validation should happen at registration time, not pull time.

**Minimal fix:**
```typescript
// At entity registration time (in upsertEntity), add:
if (localPath.includes("..") || !resolve(localPath).startsWith(expectedProjectRoot)) {
  throw new Error("Invalid path: traversal detected");
}

// In processPullOperation, guard becomes redundant but keep as defense-in-depth
```

---

### C5. Soft-Delete Retention Enforcement — Missing GC Trigger
**File:** `server/src/sync/engine.ts` (lines 967-971)
**Severity:** Unbounded DB growth, eventual query timeout

**Failure narrative:**
1. System runs for 6 months, accumulates 10k soft-deleted entities (30-day retention)
2. `gcDeletedEntities` is defined but never called — no cron, no startup hook, no timer (grep diff for `runGC()` calls → none)
3. Every `listEntities()` call still filters `deleted = 0` (line 268), but deleted rows bloat indexes
4. Eventually `idx_entity_map_parent_id` scan slows, sync lag spikes, users file "slow startup" bugs

**Root cause:** GC function exists but is orphaned.

**Minimal fix:**
```typescript
// In start() method (line 105+), add GC timer:
this.gcTimer = setInterval(() => {
  const removed = this.runGC();
  if (removed > 0) {
    console.log(`GC: removed ${removed} expired soft-deletes`);
  }
}, 24 * 60 * 60 * 1000); // Daily

// In stop() method, clear this.gcTimer
```

---

## High-Priority Issues (Correctness, Not Emergencies)

### H1. Conflict Detection Race — Hash-Then-Check-Time-Of-Update (HCTOU)
**File:** `server/src/sync/engine.ts` (lines 656-680)
**Severity:** False negatives for conflict detection

**Interleaving:**
1. Pull reads local file, computes hash H1 (lines 665-669)
2. User edits file → hash becomes H2
3. Pull reads entity.lastLocalHash = H1 from DB (line 676)
4. Comparison `H1 === H1` → `localUnchanged = true`, executes clean pull
5. User's edit is overwritten

**Root cause:** File read and entity lookup are not atomic. Classic TOCTOU (time-of-check-time-of-use).

**Recommended fix:** Add file modification timestamp check:
```typescript
const stat = statSync(entity.localPath);
const mtime = stat.mtime;

// ... compute hash ...

// After acquiring WAL lock, re-check mtime:
const stat2 = statSync(entity.localPath);
if (stat2.mtime > mtime) {
  // File changed during hash — abort pull, re-enqueue for conflict detection
  return;
}
```

---

### H2. Database Migration — No Transaction Wrapper
**File:** `server/src/store/db.ts` (lines 193-211)
**Severity:** Partial schema corruption on ALTER failure

**Failure narrative:**
1. First ALTER succeeds, adds `conflict_detected_at` (line 194)
2. Second ALTER fails (disk full, SQLite locked by another process) (line 195-197)
3. Third ALTER skipped (error propagates)
4. Schema now has `conflict_detected_at` but not `conflict_local_content_id`
5. Next startup: `!colNames.has("conflict_detected_at")` → false, migration skipped
6. Code tries to INSERT with `conflict_local_content_id` → column not found, crash

**Root cause:** Multi-statement migration outside a transaction.

**Minimal fix:**
```typescript
if (!colNames.has("conflict_detected_at")) {
  sqlite.exec("BEGIN TRANSACTION");
  try {
    sqlite.exec("ALTER TABLE entity_map ADD COLUMN conflict_detected_at TEXT");
    sqlite.exec(
      "ALTER TABLE entity_map ADD COLUMN conflict_local_content_id INTEGER REFERENCES base_content(id)",
    );
    sqlite.exec(
      "ALTER TABLE entity_map ADD COLUMN conflict_notion_content_id INTEGER REFERENCES base_content(id)",
    );
    sqlite.exec("COMMIT");
  } catch (err) {
    sqlite.exec("ROLLBACK");
    throw err;
  }
}
```

---

### H3. Frontmatter Regex — Greedy Multiline Capture
**File:** `server/src/sync/engine.ts` (lines 832-834, 839-842)
**Severity:** Incorrect frontmatter extraction for nested `---` in content

**Failure case:**
```markdown
---
title: My Doc
---
Some intro.

---
subtitle: A subsection
---
More content.
```

Regex `/^---\n[\s\S]*?\n---\n/` matches first `---` to **first** `\n---\n`, which is correct (non-greedy `*?`). But if content contains:
```markdown
---
title: Code
---

```python
def foo():
    """
    Docstring with delimiter:
    ---
    """
```

Regex stops at the embedded `---` inside the code block → extracts partial frontmatter, corrupts merge base.

**Recommended fix:** Use a proper YAML frontmatter parser (e.g., `gray-matter` npm package):
```typescript
import matter from "gray-matter";

private extractFrontmatter(content: string): string {
  const parsed = matter(content);
  return parsed.matter ? `---\n${parsed.matter}\n---\n` : "";
}

private stripFrontmatter(content: string): string {
  const parsed = matter(content);
  return parsed.content;
}
```

---

### H4. Normalized Hash Comparison — Missing Normalization on One Side
**File:** `server/src/sync/engine.ts` (line 658)
**Severity:** Spurious conflict detection on whitespace-only diffs

**Code:**
```typescript
const notionHash = hashContent(normalizeMarkdown(notionContent)); // Line 658
```

But entity hashes are stored from denormalized content (check `updateEntityAfterSync` calls — no normalization before hash). If normalization changes (trailing newline, CRLF→LF), stored hash never matches fetched hash → every pull triggers false conflict.

**Verification needed:** Grep for all `hashContent(` calls, ensure all use `normalizeMarkdown(...)` wrapper.

**Minimal fix:** Audit all hash storage points:
```typescript
// In processPushOperation (line 242+), ensure:
const localHash = hashContent(normalizeMarkdown(content));

// In executePull (line 718), ensure:
const localHash = hashContent(normalizeMarkdown(mergedContent));
```

---

### H5. Poll Safety Valve — MAX_PAGES in NotionPoller Has No Error Signaling
**File:** `server/src/sync/notion-poller.ts` (lines 1132-1183)
**Severity:** Silent truncation of large database polls

**Failure narrative:**
1. User has 5000 pages in Notion DB, all modified since last poll (bulk edit operation)
2. Poll fetches 20 pages (MAX_PAGES limit, line 1156-1183)
3. Remaining 4980 changes are silently ignored (loop exits, no log, no error)
4. User reports "changes not syncing" — no diagnostic trace

**Recommended fix:**
```typescript
} while (cursor && pages < MAX_PAGES);

if (cursor) {
  // Truncation occurred
  throw new Error(`Poll truncated at ${MAX_PAGES} pages (database too large for single poll cycle)`);
  // Or: log warning and return partial results with flag
}

return changes;
```

---

## Medium-Priority Issues (Robustness)

### M1. execFileSync Timeout — No Retry Logic for Transient Beads Failures
**File:** `server/src/sync/beads-sync.ts` (lines 350-360, 438-454)
**Severity:** Missed sync on transient bd CLI hang

`execFileSync` with 10s timeout will throw on slow beads operations (large repos, NFS lag). Caller catches and returns empty array (line 358), which looks identical to "no issues" case → diff becomes [removed: all issues].

**Recommended fix:** Distinguish timeout from no-issues:
```typescript
} catch (err) {
  if ((err as any).code === 'ETIMEDOUT') {
    throw new Error("Beads CLI timeout — sync aborted");
  }
  return []; // Only return empty for "bd not found" or "not a beads repo"
}
```

---

### M2. Beads Snapshot — No Compression for Large Issue Sets
**File:** `server/src/sync/engine.ts` (lines 915-920)
**Severity:** DB bloat for projects with 1000+ issues

Snapshot stored as JSON string. For large projects, this is 100KB+ per project, stored twice (old + new during transaction). No evidence of VACUUM or auto-optimization.

**Recommended:** Add snapshot size limit or compression:
```typescript
const snapshotJson = JSON.stringify(current);
if (snapshotJson.length > 100_000) {
  console.warn(`Beads snapshot for ${project.localPath} exceeds 100KB — consider pagination`);
}
```

Or use zlib compression before INSERT.

---

### M3. listConflicts Query — No Pagination for Large Conflict Sets
**File:** `server/src/store/entities.ts` (lines 262-269)
**Severity:** OOM on `SELECT *` with 1000+ conflicts

MCP tool `interkasten_conflicts` (line 159) calls `listConflicts()` which returns unbounded result set. If user has 1000 conflicts, tool response is 200KB+ JSON.

**Recommended fix:**
```typescript
export function listConflicts(db: DB, limit = 100): ConflictEntity[] {
  return db.all(
    sql`SELECT em.*, bc_local.content as local_content, bc_notion.content as notion_content
        FROM entity_map em
        LEFT JOIN base_content bc_local ON em.conflict_local_content_id = bc_local.id
        LEFT JOIN base_content bc_notion ON em.conflict_notion_content_id = bc_notion.id
        WHERE em.conflict_detected_at IS NOT NULL AND em.deleted = 0
        ORDER BY em.conflict_detected_at DESC
        LIMIT ${limit}`,
  ) as ConflictEntity[];
}
```

---

### M4. Soft-Delete Notion Update — No Retry on Failure
**File:** `server/src/sync/engine.ts` (lines 940-953)
**Severity:** Inconsistent state (local deleted, Notion still active)

Soft-delete updates Notion page status (line 942-950) but catches and ignores all failures (line 951-953). If Notion is down for 5 minutes, deleted files never get marked in Notion.

**Recommended fix:** Enqueue a retry-able "mark-deleted" WAL entry instead of fire-and-forget:
```typescript
walCreatePending(this.db, {
  entityMapId: entity.id,
  operation: "mark-deleted-in-notion",
  newContent: null,
});
// Process this in queue with retry logic
```

---

### M5. Conflict Strategy — "conflict-file" Path Not Validated
**File:** `server/src/sync/engine.ts` (lines 771-772)
**Severity:** Conflict file can overwrite unrelated .conflict files

`entity.localPath + ".conflict"` → if `localPath = "/foo/bar.md"`, writes `/foo/bar.md.conflict`. If two entities have `localPath = /foo/bar.md` and `/foo/bar.md.conflict` (unlikely but possible), second conflict overwrites first.

**Recommended fix:** Use entity ID in conflict filename:
```typescript
const conflictPath = `${entity.localPath}.conflict-${entity.id}`;
```

---

## Low-Priority / Style

### L1. ConflictEntity Interface — Redundant Comment
**File:** `server/src/store/entities.ts` (lines 260, 272)
**Comment duplicates interface purpose.** Harmless but noisy.

### L2. session-status.sh — Typo in Column Name
**File:** `hooks/session-status.sh` (line 9)
Uses `deleted = 0` in WHERE clause (line 9), but schema has `deleted` as boolean INTEGER. Should be `deleted = 0` (works in SQLite) but inconsistent with boolean mode in Drizzle schema (line 302).

### L3. Unused Import in beads-sync.ts
**File:** `server/src/sync/beads-sync.ts` (line 312)
`resolve` imported but only used in `execFileSync cwd` (safe, but linter will flag).

---

## Testing Recommendations

### T1. Concurrency Tests
- **Test:** Start two poll cycles with 100ms offset, verify snapshot integrity
- **Test:** Enqueue push + pull for same entity, verify conflict detection fires
- **Test:** Simulate WAL cleanup race (kill process between `target_written` and `committed`)

### T2. Edge Cases
- **Test:** Frontmatter with code block containing `---` delimiter
- **Test:** Path traversal attempts (`localPath = "../../etc/passwd"`)
- **Test:** MAX_PAGES truncation (mock 1000-page database poll)

### T3. Beads Integration
- **Test:** bd CLI timeout simulation (mock slow command)
- **Test:** Concurrent `pollBeadsChanges` calls (verify guard prevents races)

---

## Invariants Summary

For posterity, here are the core invariants that MUST hold:

1. **Monotonic Sync:** If entity.lastSyncTs = T, all syncs after T are based on content with hash entity.lastLocalHash (for local) and entity.lastNotionHash (for Notion). Violated by C1.

2. **Conflict Convergence:** After conflict resolution, both local and Notion must reflect merged content. Violated by C3 (Notion push can fail after local commit).

3. **Snapshot Atomicity:** Beads snapshot S[N] must be computed from successfully pushed state S[N-1]. Violated by C2 (concurrent snapshot updates).

4. **Path Containment:** All local file writes via pull must satisfy `resolve(path).startsWith(projectRoot)`. Partially violated by C4 (registration-time bypass).

5. **WAL Completeness:** Any state-changing operation must have a WAL entry until committed. Violated by C3 (merge push not WAL-protected).

---

## Recommendations

### Immediate (before merge)
1. Add `pollBeadsChanges` concurrency guard (C2)
2. Wrap DB migrations in transaction (H2)
3. Re-check entity state in `processPullOperation` before executing pull (C1)
4. Add GC timer to `start()` method (C5)

### Short-term (next sprint)
5. Add mtime check for TOCTOU mitigation (H1)
6. Switch frontmatter parsing to `gray-matter` library (H3)
7. Add path validation at entity registration (C4)
8. Audit all `hashContent` calls for normalization consistency (H4)

### Long-term (tech debt)
9. Replace fire-and-forget Notion updates with WAL-backed retries (M4)
10. Add pagination to conflict/snapshot queries (M3)
11. Instrument poll truncation with warnings (H5)

---

## Conclusion

The three-way merge logic (using node-diff3) is sound. The WAL protocol for pull is correctly ordered. But concurrency discipline is inconsistent — `pollInProgress` guards one poll path but not another, snapshot updates are not transactional, and conflict detection has a hash-then-check race.

Prioritize C1-C5 fixes before production deployment. The cost of a missed conflict or lost update is high (user data corruption), and the probability is non-negligible under moderate concurrency (multiple Claude Code sessions editing the same project).

Focus testing on interleaving scenarios: two sessions syncing the same file, poll+push overlap, and WAL recovery paths.

Be specific about failure modes. "Works in single-user testing" is not evidence of correctness under concurrency.
