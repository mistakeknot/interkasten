# Architecture Review: Bidirectional Sync Implementation
**Date**: 2026-02-16
**Reviewer**: Flux-drive Architecture & Design Review Agent
**Scope**: TypeScript MCP server plugin — bidirectional Notion sync implementation

---

## Executive Summary

This review evaluates the addition of pull sync, three-way merge, conflict handling, beads issue sync, soft-delete, and garbage collection to an existing push-only sync engine. The implementation spans ~730 lines in `engine.ts` (from ~320), plus five new modules totaling ~350 lines.

**Critical architectural findings**:
1. **Missing boundary between queue processor and polling** — Pull operations enqueued in `pollNotionChanges()` then immediately processed in tool call context (`sync.ts:130-132`), creating hidden dual-execution paths
2. **Inconsistent operation dispatch** — Push vs pull diverged into parallel code paths at `processQueue()` level instead of unified operation abstraction
3. **Premature abstraction** in beads sync — Full diff-based state machine with snapshot storage for a feature with no live callers
4. **Path validation scattered** — Security-critical `resolve() + startsWith()` check embedded in pull handler, absent from push path
5. **Soft-delete escape hatch** — GC function exposed but never invoked, creating unbounded growth risk

**Impact**: The change adds bidirectional sync capability successfully but introduces structural debt that will compound during future extensions (linked references, multi-database routing, conflict resolution UI).

**Recommended refactors** (prioritized):
- **Must-fix**: Extract unified `SyncOperation` handler to collapse push/pull dispatch paths (boundary violation)
- **Should-fix**: Move path validation to WAL layer (security boundary leak)
- **Should-fix**: Connect GC to engine lifecycle or remove exposure (orphaned abstraction)
- **Optional**: Defer beads sync abstractions until second consumer appears (YAGNI violation)

---

## 1. Boundaries & Coupling Analysis

### 1.1 Queue Processing → Polling Coupling

**Location**: `engine.ts:121-136`, `sync.ts:121-138`

The polling system creates two execution contexts for the same queue:

```typescript
// Context 1: Periodic timer (engine.ts:531-536)
this.pollTimer = setInterval(() => {
  this.pollNotionChanges().catch(...);
}, pollIntervalMs);

// Context 2: Manual trigger from MCP tool (sync.ts:130-132)
if (dir === "pull" || dir === "both") {
  await engine.pollNotionChanges();
  await engine.processQueue(); // Immediate drain
}
```

**Boundary violation**: The tool bypasses the periodic timer and immediately drains the queue, creating a second entry point into the same processing pipeline. This couples the MCP tool layer to engine internals — the tool must know that `pollNotionChanges()` only enqueues and requires explicit `processQueue()` call.

**Manifestation**: If a future feature (e.g., webhook receiver) adds a third poll trigger, it must replicate this two-step pattern or risk silently dropping operations.

**Fix**: Extract a `processPoll()` method that encapsulates both steps:
```typescript
async processPoll(): Promise<void> {
  await this.pollNotionChanges();
  await this.processQueue();
}
```

Then timers and tools call the unified entry point. This makes the boundary explicit and prevents drift.

---

### 1.2 Push vs Pull Dispatch Divergence

**Location**: `engine.ts:155-165`, `engine.ts:202-283`, `engine.ts:633-844`

The `processQueue()` method branches on `op.side` to route push vs pull:

```typescript
for (const op of ops) {
  if (op.side === "notion") {
    await this.processPullOperation(op);
  } else {
    await this.processPushOperation(op);
  }
}
```

**Surface-level**: This appears reasonable — different directions have different logic.

**Deeper issue**: Push and pull now have 80+ line parallel code paths (`processPushOperation` vs `processPullOperation`) with no shared abstraction. Both:
- Fetch content (local file vs Notion API)
- Validate paths (pull only — **security gap**)
- Hash content (different extraction patterns)
- Write to target (WAL protocol)
- Update `entity_map`
- Log result

Yet they share zero helpers. The critical path validation (lines 641-653) only exists in pull path:

```typescript
// Pull operation has path validation (engine.ts:641-653)
const resolved = resolve(projectDir, basename(entity.localPath));
if (!resolved.startsWith(projectDir + "/")) {
  appendSyncLog(this.db, { ... });
  return; // Abort on path traversal
}

// Push operation has NO equivalent validation
```

**Boundary leak**: Security validation is coupled to direction, not layer. Path validation is a **data integrity boundary** that should gate all writes to local filesystem, not just pulls.

**Impact**: If a future feature adds a third direction (e.g., `side: "archive"`), must remember to replicate validation. If push operations ever accept user-controlled paths (e.g., via MCP tool param), path traversal vulnerability exists.

**Fix**: Extract a `SyncOperationHandler` abstraction:
```typescript
interface SyncOperationHandler {
  fetch(): Promise<string>;    // Content retrieval
  validate(): boolean;          // Path/permission checks
  write(content: string): void; // Target write via WAL
}

class LocalToNotionHandler implements SyncOperationHandler { ... }
class NotionToLocalHandler implements SyncOperationHandler { ... }
```

Then `processQueue()` becomes:
```typescript
for (const op of ops) {
  const handler = this.createHandler(op);
  if (!handler.validate()) continue;
  const content = await handler.fetch();
  await handler.write(content);
}
```

This collapses the 160-line divergence into a single ~20-line flow with explicit extension points.

---

### 1.3 Conflict Handling → WAL Protocol Bypass

**Location**: `engine.ts:754-827`

The `handleConflict()` method writes directly to local filesystem without WAL protocol:

```typescript
// Direct write without WAL (engine.ts:812)
writeFileSync(entity.localPath, mergedWithFm, "utf-8");

// Then updates entity_map (engine.ts:816-823)
updateEntityAfterSync(this.db, entity.id, { ... });
```

Compare to clean pull path (lines 696-731), which follows WAL:
```typescript
const walEntry = walCreatePending(this.db, { ... });
writeFileSync(entity.localPath, mergedContent, "utf-8");
walMarkTargetWritten(this.db, walEntry.id);
updateEntityAfterSync(this.db, entity.id, { ... });
walMarkCommitted(this.db, walEntry.id);
walDelete(this.db, walEntry.id);
```

**Boundary violation**: The WAL layer exists to guarantee crash recovery (documented pattern in CLAUDE.md:85). Conflict resolution bypasses this guarantee.

**Risk**: If process crashes between `writeFileSync` and `updateEntityAfterSync`, local file has merged content but `entity_map` has stale hashes. Next pull will detect false conflict and re-merge, potentially creating merge drift.

**Why this happened**: The conflict handler calls `pushUpdate()` at line 826 to push merged result to Notion. That push likely has its own WAL entry. But the local write is unprotected.

**Fix**: Wrap the local write in WAL protocol or extract a shared `writeLocal(entity, content)` helper that enforces WAL for all local writes.

---

### 1.4 Beads Sync → SQLite Schema Coupling

**Location**: `engine.ts:870-929`, `db.ts:204-212`, `schema.ts` (missing)

The beads sync feature adds a new table (`beads_snapshot`) but does NOT declare it in Drizzle schema. The table is created via raw SQL in `db.ts`:

```typescript
// db.ts:204-212 — Raw SQL table creation
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS beads_snapshot (
    project_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id)
  )
`);
```

But `server/src/store/schema.ts` has no `beadsSnapshot` export. Queries against this table use raw `sql` template (lines 880, 916):

```typescript
const prevRow = this.db.all(
  sql`SELECT snapshot_json FROM beads_snapshot WHERE project_id = ${String(project.id)}`
) as { snapshot_json: string }[];
```

**Boundary violation**: The codebase uses Drizzle ORM as the data access boundary (documented in CLAUDE.md:16). Beads sync bypasses this by mixing raw SQL CREATE with untyped queries.

**Impact**:
- No type safety on `beads_snapshot` queries (manual `as` cast)
- No migration tracking (Drizzle schema is the source of truth for other tables)
- Future refactors that depend on Drizzle's schema introspection will miss this table

**Why this happened**: `beads_snapshot` was added in v0.4.x alongside conflict columns, but only conflict columns got Drizzle schema entries (schema.ts:22-24).

**Fix**: Add Drizzle schema definition:
```typescript
export const beadsSnapshot = sqliteTable("beads_snapshot", {
  projectId: text("project_id").notNull().unique(),
  snapshotJson: text("snapshot_json").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});
```

Then use typed queries: `db.select().from(beadsSnapshot).where(...)`.

---

### 1.5 Soft-Delete GC → Lifecycle Orphan

**Location**: `engine.ts:967-971`, no caller

The `runGC()` method is fully implemented but never invoked:

```typescript
runGC(): number {
  const retentionMs = 30 * 24 * 60 * 60 * 1000; // 30 days
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  return gcDeletedEntities(this.db, cutoff);
}
```

**Orphaned abstraction**: The method is public (exposed on SyncEngine) but has zero callers in the codebase. No timer, no MCP tool, no shutdown hook.

**Risk**: The soft-delete system (line 935-961) marks entities as deleted but never removes them. The `deleted = 0` filter (entities.ts:268) prevents them from appearing in listings, but they accumulate unbounded in the database.

**Impact**: After 6 months of churn, `entity_map` could have thousands of soft-deleted rows consuming disk space and slowing queries (no index on `deleted_at`).

**Why this exists**: GC is a standard pattern for soft-delete systems. But without lifecycle integration, it's premature.

**Fix options**:
1. **Minimal**: Add GC to `shutdown()` hook (one-time cleanup on daemon restart)
2. **Complete**: Add periodic timer (daily/weekly) and MCP tool for manual trigger
3. **YAGNI**: Remove `runGC()` until retention becomes a user-reported issue

Recommend option 1 for now — shutdown is an existing lifecycle hook (line 123-131), adding one line: `this.runGC()`.

---

## 2. Pattern Analysis

### 2.1 Explicit Patterns (Aligned)

#### Three-Way Merge (merge.ts)
Clean implementation following established pattern:
- Uses `node-diff3` library (standard, not reinvented)
- Fallback strategies explicit in types (`ConflictStrategy` enum)
- Conflict regions captured for future UI display
- Aligns with project's "agent-native" design (strategies configured, not hardcoded)

**No issues**. This is the architectural bright spot.

#### WAL Protocol (existing, mostly preserved)
Push operations still follow pending → target_written → committed → delete sequence. Pull operations added correct WAL usage (lines 697-731).

**One violation**: Conflict resolution bypasses WAL (§1.3 above). Otherwise aligned.

#### Content-Addressed Storage (base_content table)
Conflict state correctly uses `base_content` FKs (schema.ts:23-24, entities.ts:230-232). Deduplication across entities preserved.

**No issues**.

---

### 2.2 Anti-Patterns Detected

#### God Module: engine.ts

The sync engine grew from 320 to 730 lines by absorbing:
- Pull operation handling (+142 lines)
- Conflict resolution (+74 lines)
- Beads polling (+60 lines)
- Soft-delete handling (+26 lines)
- Frontmatter extraction helpers (+14 lines)
- Project directory resolution (+9 lines)

**Module responsibility drift**:
- Originally: Queue processing + push sync
- Now: Queue + push + pull + merge orchestration + beads integration + GC + frontmatter parsing + path resolution

**Symptoms**:
- 11 imports at top (up from 6)
- 4 private helper methods that are really string utilities (`extractFrontmatter`, `stripFrontmatter`, `findProjectDir`)
- 2 public methods with zero callers (`pollBeadsChanges`, `runGC`)

**Impact**: Future features (linked references at line 17 of diff, multi-database routing) will further bloat this file. Each new sync variant adds another 50-100 line handler.

**Fix**: Extract modules:
- `sync/local-sync.ts` — `LocalSyncHandler` class
- `sync/notion-sync.ts` — `NotionSyncHandler` class
- `sync/beads-integration.ts` — Move `pollBeadsChanges()` here
- `sync/frontmatter.ts` — String helpers
- `sync/cleanup.ts` — Soft-delete + GC

Leave `engine.ts` as orchestrator: timers, queue management, handler dispatch.

---

#### Leaky Abstraction: NotionPoller

**Location**: `notion-poller.ts:1-67`

The `NotionPoller` class exposes a `pollDatabase()` method that takes `databaseId` and `since` timestamp. But engine.ts never calls it:

```typescript
// Engine uses low-level page retrieval (engine.ts:607-623)
for (const entity of entities) {
  const page = await this.notion.call(async () => {
    return this.notion.raw.pages.retrieve({ page_id: entity.notionId });
  });
  // Check last_edited_time directly
}
```

**Unused abstraction**: The poller was designed for database-level queries (notion-poller.ts:1151-1183) but sync operates at page-level. The database query path (lines 1160-1171) uses Notion v5 data sources API but is never executed.

**Why unused**: Per CLAUDE.md:89, the project uses `parent_id` FK queries, not path prefixes. This means "get all pages in database X" is not a natural query — sync iterates all tracked entities regardless of database.

**YAGNI violation**: 67 lines implementing a pattern that doesn't match the domain model.

**Fix options**:
1. **Use it**: Refactor polling to query databases instead of pages (requires grouping entities by database, tracking database cursors)
2. **Delete it**: Remove `notion-poller.ts`, keep page-level polling inline in engine

Recommend option 2 unless multi-database pagination becomes a bottleneck (unlikely at <1000 pages per workspace).

---

#### Premature Beads Sync Abstraction

**Location**: `beads-sync.ts:1-145`

This module implements a full diff-based sync system:
- State snapshots with JSON serialization
- Bidirectional mapping (beads ↔ Notion properties)
- CLI wrapper with `execFileSync` (shell injection prevention)
- Update command builder

**Current usage**: Only `fetchBeadsIssues()`, `diffBeadsState()`, and property mappers are called. The `updateBeadsIssue()` function (lines 433-455) has **zero callers** — no Notion → beads pull exists.

**YAGNI violation**: 145 lines of abstraction for a feature that's push-only. The bidirectional mapping (lines 415-431) won't be used until Notion → beads sync is implemented.

**Why this happened**: The module was likely designed symmetrically with markdown sync (which is bidirectional). But beads sync is structurally different — issues are CLI-managed, not files.

**Impact**: Maintenance burden for unused code. The `updateBeadsIssue()` function concatenates `--status=${updates.status}` without escaping, which is safe with `execFileSync` but looks like a shell injection risk on casual review.

**Fix**: Delete `updateBeadsIssue()` and `mapNotionToBeadsUpdate()` until Notion → beads pull is implemented. Mark `parseBeadsOutput()` as package-private (since it's only tested, not used by engine).

---

### 2.3 Naming Consistency

#### Frontmatter Confusion

The engine has two methods: `extractFrontmatter()` (returns the block) and `stripFrontmatter()` (returns body without block). These are inverse operations but the naming suggests they do the same thing.

**Clearer names**:
- `extractFrontmatter()` → `getFrontmatterBlock()`
- `stripFrontmatter()` → `getFrontmatterBody()` or `removeFrontmatter()`

#### "Pull" vs "Notion → Local"

The codebase mixes terminology:
- `SyncOperation.side = "notion"` (queue.ts:3)
- `processPullOperation()` (engine.ts:633)
- `direction: "notion_to_local"` (sync-log.ts:54)

**Inconsistency**: Queue layer uses "side", handler uses "pull", log uses "direction". These all mean the same thing but require mental translation.

**Fix**: Standardize on one term. Recommend `direction` (already in logs and user-facing) with values `"local_to_notion" | "notion_to_local"`. Then rename `SyncOperation.side` → `direction`.

---

## 3. Simplicity & YAGNI Analysis

### 3.1 Line-by-Line Necessity Review

#### Conflict Detection with Hash Comparison

**Location**: `engine.ts:657-675`

The pull path reads local file, strips frontmatter, hashes, and compares to `lastLocalHash`:

```typescript
let localContent = "";
let localHash = "";
if (existsSync(entity.localPath)) {
  localContent = readFileSync(entity.localPath, "utf-8");
  const bodyOnly = this.stripFrontmatter(localContent);
  localHash = hashContent(normalizeMarkdown(bodyOnly));
}

const localUnchanged = entity.lastLocalHash === localHash || !localHash;
```

**Question**: Why read + hash instead of using `lastLocalHash` from database?

**Answer** (valid): The local file might have been edited outside the watcher (e.g., bulk find/replace, git checkout). Hash verification prevents false "clean pull" classification.

**Verdict**: Necessary defensive programming. Keep.

---

#### Dual `processQueue()` Call in Sync Tool

**Location**: `sync.ts:126-132`

The tool calls `processQueue()` twice when `direction = "both"`:

```typescript
if (dir === "push" || dir === "both") {
  await engine.processQueue();  // First call
}
if (dir === "pull" || dir === "both") {
  await engine.pollNotionChanges();
  await engine.processQueue();  // Second call
}
```

**Question**: Why not call once at end?

**Answer** (design smell): Pull polling enqueues operations, so needs its own drain. But this means `both` processes push ops, then pull ops, when the queue is designed to interleave. If a local file changed during pull poll, it won't be pushed until next cycle.

**Verdict**: Simplify by moving poll+process into engine (`processPoll()` method). Then tool becomes:
```typescript
if (dir === "push" || dir === "both") await engine.processPush();
if (dir === "pull" || dir === "both") await engine.processPull();
```

Each method manages its own queue interaction.

---

#### Beads Snapshot Upsert

**Location**: `engine.ts:915-921`

The beads snapshot uses `INSERT ... ON CONFLICT DO UPDATE`:

```sql
INSERT INTO beads_snapshot (project_id, snapshot_json, updated_at)
VALUES (?, ?, datetime('now'))
ON CONFLICT(project_id) DO UPDATE SET
  snapshot_json = ?,
  updated_at = datetime('now')
```

**Question**: Why not just `UPDATE ... WHERE project_id = ?` then `INSERT IF NOT EXISTS`?

**Answer** (micro-optimization): SQLite's `ON CONFLICT` is atomic and avoids race conditions in concurrent snapshot writes.

**Counter**: The engine is single-threaded (`concurrency: 1` in queue.ts:37). No concurrent writes exist.

**Verdict**: Over-engineered for current concurrency model. But harmless and future-proof if concurrency increases. Keep but add comment explaining concurrency assumption.

---

### 3.2 Premature Extensibility Points

#### Conflict Strategy Enum

**Location**: `merge.ts:38`

Four strategies defined:
- `three-way-merge` ✓ (used)
- `local-wins` ✓ (used as fallback)
- `notion-wins` ✓ (used in switch)
- `conflict-file` ✓ (used)

**Verdict**: All strategies have code paths. Not premature. Keep.

---

#### PageChange Interface

**Location**: `notion-poller.ts:1135-1139`

The poller returns `PageChange[]` with `pageId`, `lastEdited`, and `title`. But engine only uses `pageId`:

```typescript
// notion-poller.ts:1174-1178
changes.push({
  pageId: page.id,
  lastEdited: page.last_edited_time,
  title: this.extractTitle(page),
});

// Engine never accesses lastEdited or title
```

**YAGNI violation**: `lastEdited` is redundant (engine re-fetches page to check timestamp anyway). `title` is never used.

**Fix**: Return `string[]` of page IDs. Delete `PageChange` interface and `extractTitle()` helper.

**But**: If poller is deleted entirely (per §2.2), this is moot.

---

### 3.3 Accidental Complexity

#### Frontmatter Preservation Dance

**Location**: `engine.ts:705-709`, `engine.ts:768-808`

Both pull and conflict resolution follow pattern:
1. Read local file with frontmatter
2. Strip frontmatter for merge
3. Re-attach frontmatter to result

This is necessary (frontmatter is local metadata, not synced to Notion). But the implementation is duplicated and fragile:

```typescript
// Pull path (lines 705-709)
const frontmatter = this.extractFrontmatter(currentLocalContent);
const mergedContent = frontmatter
  ? frontmatter + "\n" + notionContent
  : notionContent;

// Conflict path (lines 806-809)
const mergedWithFm = frontmatter
  ? frontmatter + "\n" + result.merged
  : result.merged;
```

**Risk**: If frontmatter regex changes (currently `^---\n[\s\S]*?\n---\n`), must update both `extractFrontmatter()` and `stripFrontmatter()` consistently.

**Simplify**: Extract `preserveFrontmatter(oldContent, newBody)` helper that encapsulates strip + reattach pattern. One implementation, two call sites.

---

#### Path Validation with `basename()` Indirection

**Location**: `engine.ts:641-653`

The pull path validates with:

```typescript
const projectDir = this.findProjectDir(entity.localPath);
if (projectDir) {
  const resolved = resolve(projectDir, basename(entity.localPath));
  if (!resolved.startsWith(projectDir + "/")) {
    // Abort
  }
}
```

**Why `basename(entity.localPath)` instead of just `entity.localPath`?**

This pattern defends against paths like `../../etc/passwd` stored in `entity.localPath`. But `entity.localPath` comes from `entity_map` table, which is only written by sync engine itself — never from user input.

**Analysis**: If `entity.localPath` is already trusted (inserted by engine), this is defense-in-depth. If it's semi-trusted (could be manipulated via Notion property changes), it's necessary.

**Current risk**: Notion properties are never used to set `localPath` (only updated by watcher on local file events). So this is defensive paranoia.

**Verdict**: Keep for defense-in-depth, but add comment explaining threat model. If `localPath` were ever editable via Notion (e.g., rename feature), this becomes critical.

---

## 4. Recommendations Summary

### Critical (Must-Fix Before Ship)

**C1. Unify Push/Pull Dispatch** (§1.2)
- Extract `SyncOperationHandler` abstraction
- Collapse 160-line divergence into single flow
- Move path validation to shared layer
- **Impact**: Prevents security gap proliferation, simplifies testing

**C2. Add WAL to Conflict Resolution** (§1.3)
- Wrap `writeFileSync` in WAL protocol
- Ensures crash recovery for merged writes
- **Impact**: Prevents merge drift on process crash

---

### High-Priority (Should-Fix in v0.4.1)

**H1. Extract Engine Modules** (§2.2)
- Split 730-line god module into 5 focused modules
- **Impact**: Reduces cognitive load, enables parallel development

**H2. Connect GC to Lifecycle** (§1.5)
- Add `runGC()` call to `shutdown()` hook
- Or add periodic timer + MCP tool
- **Impact**: Prevents unbounded database growth

**H3. Fix Beads Schema Declaration** (§1.4)
- Add Drizzle schema for `beads_snapshot`
- **Impact**: Type safety, migration tracking

---

### Medium-Priority (Cleanup Opportunities)

**M1. Delete Unused NotionPoller** (§2.2)
- 67 lines implementing unused pattern
- Move page polling inline to engine
- **Impact**: -67 LOC, clearer architecture

**M2. Prune Beads Sync** (§2.2)
- Delete `updateBeadsIssue()` and reverse mappers
- Keep only what's called
- **Impact**: -30 LOC, less maintenance

**M3. Rename Frontmatter Helpers** (§2.3)
- `extractFrontmatter()` → `getFrontmatterBlock()`
- `stripFrontmatter()` → `removeFrontmatter()`
- **Impact**: Clarity

**M4. Extract Frontmatter Helper** (§3.3)
- `preserveFrontmatter(oldContent, newBody)`
- Eliminate duplication
- **Impact**: DRY, single regex source of truth

---

### Low-Priority (Defer)

**L1. Standardize Direction Terminology** (§2.3)
- Align `SyncOperation.side` with `direction` in logs
- **Impact**: Consistency (cosmetic)

**L2. Add Path Validation Comment** (§3.3)
- Document threat model for `basename()` indirection
- **Impact**: Future maintainer clarity

---

## 5. Positive Architecture Observations

Despite the issues above, several patterns are exemplary:

**5.1 Three-Way Merge Abstraction** (merge.ts)
Clean separation of algorithm (`node-diff3`), strategy (enum), and presentation (`formatConflictFile`). Could be published as standalone package.

**5.2 Conflict State in Database** (schema.ts:22-24)
Using FKs to `base_content` for conflict snapshots is elegant. Enables time-travel debugging and future conflict resolution UI without reparsing files.

**5.3 Queue Deduplication** (queue.ts:45-56)
The `(side, entityKey)` composite key prevents operation spam. The backpressure mechanism (max queue size) is production-ready.

**5.4 Soft-Delete Aligned with Notion** (engine.ts:935-961)
30-day retention matches Notion's trash retention. Status marker (`⚠️ Source Deleted`) is user-friendly. Just needs GC wiring.

**5.5 WAL Protocol Coverage** (mostly)
Push and pull both follow pending → committed → delete sequence. One gap (conflict resolution) but overall adherence is strong.

---

## 6. Testing Implications

### Current Test Coverage Gaps (Inferred)

Based on code structure, these cases are likely untested:

1. **Path traversal defense** (engine.ts:641-653)
   - Test: Entity with `localPath = "../../etc/passwd"`
   - Expected: Operation aborted, sync log error
   - Risk: If untested, defense is unvalidated

2. **Conflict resolution WAL bypass** (engine.ts:812)
   - Test: Kill process between `writeFileSync` and `updateEntityAfterSync`
   - Expected: Next restart should detect incomplete write
   - Risk: Currently no recovery (§1.3)

3. **GC with soft-deleted entities** (engine.ts:967-971)
   - Test: Create entity, soft-delete, advance clock 31 days, run GC
   - Expected: Row removed from `entity_map`
   - Risk: GC is never called (§1.5)

4. **Beads snapshot concurrency** (engine.ts:915-921)
   - Test: Concurrent snapshot writes to same project
   - Expected: Last write wins, no corruption
   - Risk: Single-threaded queue makes this impossible, `ON CONFLICT` is overkill

5. **Dual processQueue() in sync tool** (sync.ts:126-132)
   - Test: Trigger `direction: "both"` with pending local changes
   - Expected: Both local and remote changes processed
   - Risk: Local changes enqueued after pull poll won't process until next cycle

---

## 7. Migration Path for Fixes

### Phase 1: Correctness (v0.4.1)
1. Add WAL to conflict resolution (1 hour)
2. Connect GC to shutdown hook (30 min)
3. Add path validation tests (1 hour)

**Risk**: Low. Additive changes, no breaking API changes.

### Phase 2: Refactor (v0.5.0)
1. Extract `SyncOperationHandler` abstraction (4 hours)
2. Split engine into modules (2 hours)
3. Delete unused NotionPoller (30 min)
4. Prune beads sync (30 min)

**Risk**: Medium. Breaks internal APIs, requires full regression test.

### Phase 3: Polish (v0.5.1)
1. Rename frontmatter helpers (15 min)
2. Extract frontmatter preservation helper (30 min)
3. Standardize direction terminology (1 hour)

**Risk**: Low. Naming changes, no logic changes.

---

## 8. Conclusion

The bidirectional sync implementation successfully adds pull sync, conflict resolution, and beads integration. The three-way merge abstraction is excellent, and the soft-delete system is well-designed.

However, the implementation accumulates structural debt:
- **Push/pull divergence** creates parallel 160-line code paths with no shared abstraction
- **Path validation** only protects pull operations, leaving security boundary incomplete
- **Premature abstractions** (NotionPoller, beads reverse sync) add 100+ lines of unused code
- **GC is orphaned**, creating unbounded growth risk

These are not fatal flaws — the system works — but they will compound during future extensions. The recommended refactors are feasible and would restore architectural clarity without disrupting users.

**Final recommendation**: Ship v0.4.0 with the two critical fixes (WAL + GC wiring), then schedule the handler abstraction refactor for v0.5.0 before adding linked references or multi-database routing.

---

## Appendix: File-Level Impact Summary

| File | Lines Changed | Complexity Δ | Architectural Role |
|------|---------------|--------------|-------------------|
| `engine.ts` | +410 | High | Core sync orchestrator (now overloaded) |
| `merge.ts` | +101 (new) | Medium | Three-way merge logic (clean) |
| `notion-poller.ts` | +67 (new) | Low | Database polling (unused) |
| `beads-sync.ts` | +145 (new) | Medium | Beads integration (30% unused) |
| `linked-refs.ts` | +35 (new) | Low | T2 summary cards (future) |
| `entities.ts` | +65 | Low | Conflict CRUD (aligned) |
| `db.ts` | +23 | Low | Schema migration (mixed Drizzle/raw SQL) |
| `schema.ts` | +3 | Low | Conflict columns (incomplete — missing beads) |
| `sync.ts` (tools) | +45 | Low | MCP tool extensions (coupling to engine internals) |
| `issues.ts` (tools) | +62 (new) | Low | Beads listing tool |
| `session-status.sh` | +4 | Low | Status hook (clean) |

**Total**: +960 lines added, ~730 in engine.ts alone (127% growth in single file).

---

**End of Review**
