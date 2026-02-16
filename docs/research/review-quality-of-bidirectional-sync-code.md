# Quality Review: Bidirectional Sync Implementation

Date: 2026-02-16
Reviewer: Flux-drive Quality & Style Reviewer
Target: TypeScript MCP server + Shell hook (interkasten v0.4.x bidirectional sync)

## Summary

This review covers the bidirectional sync feature addition for interkasten. The implementation is TypeScript with one shell hook. Scope includes conflict detection, three-way merge, Notion polling, beads issue sync, and soft-delete handling.

## Universal Quality Issues

### 1. Naming Inconsistency: snake_case vs camelCase (entities.ts:273-286)

**File:** `server/src/store/entities.ts`
**Lines:** 273-286

The `ConflictEntity` interface mixes naming conventions:

```typescript
export interface ConflictEntity {
  id: number;
  local_path: string;              // snake_case
  notion_id: string;               // snake_case
  entity_type: string;             // snake_case
  tier: string | null;
  last_local_hash: string | null;  // snake_case
  last_notion_hash: string | null; // snake_case
  conflict_detected_at: string | null;        // snake_case
  conflict_local_content_id: number | null;   // snake_case
  conflict_notion_content_id: number | null;  // snake_case
  local_content: string | null;    // snake_case
  notion_content: string | null;   // snake_case
}
```

**Issue:** TypeScript convention is `camelCase` for interface properties. The comment at line 272 acknowledges this ("Returns raw SQLite column names (snake_case), not Drizzle camelCase"), but the interface is used as a return type from a TypeScript function, not a direct SQLite result set.

**Recommendation:** Either:
1. Map the raw SQLite results to a proper camelCase TypeScript interface at the boundary
2. Use a separate `RawConflictRow` type for SQLite results and `ConflictEntity` as the transformed version
3. If exposing raw SQL results is intentional, rename to `ConflictEntityRow` to signal it's a database row type

**Risk:** Medium — affects API surface area; consumers must use snake_case, which breaks TypeScript conventions throughout the codebase.

---

### 2. Overly Permissive `any` Types

**Locations:**
- `beads-sync.ts:398` — `mapBeadsToNotionProperties(issue: BeadsIssue): any`
- `beads-sync.ts:415` — `mapNotionToBeadsUpdate(properties: any): Partial<BeadsIssue>`
- `linked-refs.ts:1009` — `summaryCardToNotionProperties(card: SummaryCard): any`
- `merge.ts:1038` — `ConflictStrategy` type is well-typed, but return type for conflict handlers is not

**Issue:** `any` disables all type safety. Notion API has typed SDK interfaces for properties and page objects.

**Recommendation:**
```typescript
// Import from Notion SDK
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";

// Define specific return type
type NotionProperties = Record<string,
  | { title: Array<{ text: { content: string } }> }
  | { select: { name: string } }
  | { rich_text: Array<{ text: { content: string } }> }
  | { date: { start: string } }
  | { number: number }
>;

export function mapBeadsToNotionProperties(issue: BeadsIssue): NotionProperties {
  // ...
}

export function mapNotionToBeadsUpdate(
  properties: PageObjectResponse['properties']
): Partial<BeadsIssue> {
  // ...
}
```

**Risk:** High — Runtime failures when Notion API returns unexpected shapes; no IDE assistance; no compile-time validation.

---

### 3. Silent Error Handling Without Logging Context

**File:** `beads-sync.ts`
**Lines:** 337-360

```typescript
export function parseBeadsOutput(jsonOutput: string): BeadsIssue[] {
  try {
    const parsed = JSON.parse(jsonOutput);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];  // Silent failure, no context
  }
}

export function fetchBeadsIssues(projectDir: string): BeadsIssue[] {
  try {
    const output = execFileSync("bd", ["list", "--format=json"], {
      cwd: resolve(projectDir),
      encoding: "utf-8",
      timeout: 10000,
    });
    return parseBeadsOutput(output);
  } catch {
    return [];  // Silent failure on exec error OR JSON parse error
  }
}
```

**Issue:** These functions swallow errors without logging or distinguishing between:
- JSON parse failure (bad output from `bd`)
- `bd` command not found
- Permission errors
- Timeout (10s limit)
- Invalid project directory

Returning an empty array is indistinguishable from "no issues" vs "fetch failed".

**Recommendation:**
```typescript
interface FetchResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export function fetchBeadsIssues(projectDir: string): FetchResult<BeadsIssue[]> {
  try {
    const output = execFileSync("bd", ["list", "--format=json"], {
      cwd: resolve(projectDir),
      encoding: "utf-8",
      timeout: 10000,
    });
    const parsed = parseBeadsOutput(output);
    if (parsed === null) {
      return { success: false, error: "Invalid JSON from bd CLI" };
    }
    return { success: true, data: parsed };
  } catch (err) {
    return {
      success: false,
      error: `Failed to fetch beads: ${(err as Error).message}`
    };
  }
}
```

Alternatively, if empty-on-error is intentional, add a comment explaining why and log to `appendSyncLog` with the error details.

**Risk:** High — Debugging issues in production is impossible without error context. Users won't know if beads sync is failing silently.

---

### 4. Error Handling Gap in Poll Loop (engine.ts:591-628)

**File:** `engine.ts`
**Lines:** 608-623

```typescript
for (const entity of entities) {
  if (!entity.notionId || !entity.lastSyncTs) continue;

  const since = new Date(entity.lastSyncTs);

  try {
    const page: any = await this.notion.call(async () => {
      return this.notion.raw.pages.retrieve({ page_id: entity.notionId });
    });

    const remoteEditTime = new Date(page.last_edited_time);
    if (remoteEditTime <= since) continue;

    this.queue.enqueue({
      side: "notion",
      type: "page_updated",
      entityKey: entity.notionId,
      timestamp: remoteEditTime,
    });
  } catch {
    // Skip pages we can't access (deleted, permission changed, etc.)
  }
}
```

**Issue:** The comment says "Skip pages we can't access" but this also catches:
- Network failures (should retry)
- Rate limit errors (should back off)
- Transient API errors (should log)
- Malformed responses (should log)

Silent skipping is appropriate for 404/403 (deleted/no access), but not for other errors.

**Recommendation:**
```typescript
try {
  const page: any = await this.notion.call(async () => {
    return this.notion.raw.pages.retrieve({ page_id: entity.notionId });
  });
  // ... existing logic
} catch (err) {
  const statusCode = (err as any).status ?? (err as any).code;
  if (statusCode === 404 || statusCode === 403) {
    // Page deleted or access revoked — skip silently
    continue;
  }
  // Log unexpected errors for debugging
  console.error(`Poll failed for ${entity.notionId}:`, err);
}
```

**Risk:** Medium — Silent failures during network issues or API outages will cause sync to silently lag behind without operator visibility.

---

### 5. Path Validation Incompleteness (engine.ts:641-653)

**File:** `engine.ts`
**Lines:** 641-653

```typescript
// Validate path (safety: prevent path traversal)
const projectDir = this.findProjectDir(entity.localPath);
if (projectDir) {
  const resolved = resolve(projectDir, basename(entity.localPath));
  if (!resolved.startsWith(projectDir + "/")) {
    appendSyncLog(this.db, {
      entityMapId: entity.id,
      operation: "error",
      direction: "notion_to_local",
      detail: { error: "Path validation failed", path: entity.localPath },
    });
    return;
  }
}
```

**Issues:**
1. `basename(entity.localPath)` only validates the filename, not parent directories. If `entity.localPath` is `/project/docs/../../../etc/passwd`, `basename` returns `passwd`, which then resolves to `projectDir/passwd` (safe). But the original `entity.localPath` is still written to the log and could be used elsewhere.
2. The check `!resolved.startsWith(projectDir + "/")` fails for the project root itself (if `resolved === projectDir`). Should be `projectDir` OR `projectDir + "/"`.
3. Validation only happens if `projectDir` is found. If `findProjectDir` returns null, no validation occurs, and the code proceeds (line 656).

**Recommendation:**
```typescript
const projectDir = this.findProjectDir(entity.localPath);
if (!projectDir) {
  appendSyncLog(this.db, {
    entityMapId: entity.id,
    operation: "error",
    direction: "notion_to_local",
    detail: { error: "No project directory found for entity", path: entity.localPath },
  });
  return;
}

// Use the stored local path directly (it was validated at registration time)
const resolved = resolve(entity.localPath);
if (!resolved.startsWith(projectDir) || resolved.includes("..")) {
  appendSyncLog(this.db, {
    entityMapId: entity.id,
    operation: "error",
    direction: "notion_to_local",
    detail: { error: "Path validation failed", path: entity.localPath },
  });
  return;
}
```

Better: validate paths at insertion time (when `entity.localPath` is first stored in `entity_map`), not at pull time.

**Risk:** High — Path traversal attacks if Notion page metadata can manipulate `entity.localPath` (though this requires DB corruption or malicious inserts, not just API exploitation).

---

### 6. Missing Timezone Handling (linked-refs.ts:996-1003)

**File:** `linked-refs.ts`
**Lines:** 996-1003

```typescript
export function generateSummaryCard(filePath: string, lineCount: number): SummaryCard {
  const stat = statSync(filePath);
  return {
    title: basename(filePath),
    path: filePath,
    lastModified: stat.mtime.toISOString(),  // Local filesystem time → ISO string
    lineCount,
  };
}
```

**Issue:** `stat.mtime` is the local filesystem modification time, which is system-timezone-dependent. When synced to Notion (which stores timestamps in UTC), this can cause confusion if the server's timezone doesn't match the user's expected timezone.

**Recommendation:** Either:
1. Document that all times are server-local (acceptable if server timezone is fixed)
2. Add timezone to property name: `"Last Modified (Server)"`
3. Convert to UTC explicitly: `stat.mtime.toISOString()` already does this, so this is actually fine — but the property should clarify it's UTC

**Risk:** Low — Mostly cosmetic, but could confuse users comparing Notion timestamps to filesystem times.

---

## TypeScript-Specific Issues

### 7. Unsafe Type Assertion Without Validation (engine.ts:879-881)

**File:** `engine.ts`
**Lines:** 879-881

```typescript
const prevRow = this.db.all(
  sql`SELECT snapshot_json FROM beads_snapshot WHERE project_id = ${String(project.id)}`,
) as { snapshot_json: string }[];
```

**Issue:** The `as { snapshot_json: string }[]` assertion bypasses type checking. If the query returns `NULL` for `snapshot_json`, or if the column is renamed, the assertion still claims it's a `string`.

**Recommendation:**
```typescript
const prevRow = this.db.all(
  sql`SELECT snapshot_json FROM beads_snapshot WHERE project_id = ${String(project.id)}`
);

// Runtime validation
const previous: BeadsIssue[] = prevRow.length > 0 && typeof prevRow[0].snapshot_json === "string"
  ? JSON.parse(prevRow[0].snapshot_json)
  : [];
```

**Risk:** Medium — Runtime crashes if database schema changes or returns unexpected nulls.

---

### 8. Missing Null Check on Config Access (engine.ts:531-537, 759-768)

**File:** `engine.ts`
**Lines:** 531, 759

```typescript
const pollIntervalMs = (this.config.sync?.poll_interval ?? 60) * 1000;
```

```typescript
const strategy = (this.config.sync?.conflict_strategy || "three-way-merge") as ConflictStrategy;
```

**Issue:** While the code uses optional chaining (`this.config.sync?.`), the fallback values are not type-checked. If `conflict_strategy` is set to an invalid string in the config file, the cast to `ConflictStrategy` will succeed at compile time but cause runtime issues.

**Recommendation:**
```typescript
const rawStrategy = this.config.sync?.conflict_strategy || "three-way-merge";
const validStrategies = ["local-wins", "notion-wins", "three-way-merge", "conflict-file"];
const strategy = validStrategies.includes(rawStrategy)
  ? (rawStrategy as ConflictStrategy)
  : "three-way-merge";
```

Or use Zod validation at config load time (appears to already exist in `config/` dir — verify this is applied).

**Risk:** Low if Zod validation exists; Medium if config is loaded without validation.

---

### 9. Drizzle Query Result Types Not Validated (entities.ts:263-269)

**File:** `entities.ts`
**Lines:** 263-269

```typescript
export function listConflicts(db: DB): ConflictEntity[] {
  return db.all(
    sql`SELECT em.*, bc_local.content as local_content, bc_notion.content as notion_content
        FROM entity_map em
        LEFT JOIN base_content bc_local ON em.conflict_local_content_id = bc_local.id
        LEFT JOIN base_content bc_notion ON em.conflict_notion_content_id = bc_notion.id
        WHERE em.conflict_detected_at IS NOT NULL AND em.deleted = 0`,
  ) as ConflictEntity[];
}
```

**Issue:** The `as ConflictEntity[]` assertion assumes the query structure matches the interface. If columns are added/removed from `entity_map` or `base_content`, the runtime type will differ from the assertion.

**Recommendation:** Use Drizzle's typed query builder instead of raw SQL:

```typescript
import { eq, isNotNull, and } from "drizzle-orm";

export function listConflicts(db: DB): ConflictEntity[] {
  return db
    .select({
      id: entityMap.id,
      local_path: entityMap.localPath,
      notion_id: entityMap.notionId,
      entity_type: entityMap.entityType,
      tier: entityMap.tier,
      last_local_hash: entityMap.lastLocalHash,
      last_notion_hash: entityMap.lastNotionHash,
      conflict_detected_at: entityMap.conflictDetectedAt,
      conflict_local_content_id: entityMap.conflictLocalContentId,
      conflict_notion_content_id: entityMap.conflictNotionContentId,
      local_content: baseContent.content, // from LEFT JOIN
      notion_content: baseContent.content, // need alias for second join
    })
    .from(entityMap)
    .leftJoin(baseContent, eq(entityMap.conflictLocalContentId, baseContent.id))
    .leftJoin(baseContent, eq(entityMap.conflictNotionContentId, baseContent.id))
    .where(and(
      isNotNull(entityMap.conflictDetectedAt),
      eq(entityMap.deleted, false)
    ))
    .all();
}
```

This gives compile-time type safety and automatic mapping to camelCase.

**Risk:** Medium — Schema drift will cause silent type mismatches.

---

### 10. Missing Async Error Propagation (engine.ts:525-537)

**File:** `engine.ts`
**Lines:** 525-537

```typescript
this.processTimer = setInterval(() => {
  this.processQueue().catch((err) => {
    console.error("Queue processing error:", err);
  });
}, 2000);

this.pollTimer = setInterval(() => {
  this.pollNotionChanges().catch((err) => {
    console.error("Poll error:", err);
  });
}, pollIntervalMs);
```

**Issue:** Errors are logged but not propagated. If `processQueue()` or `pollNotionChanges()` fail repeatedly, the intervals continue running with no circuit breaker or backoff. The engine will spam errors every 2 seconds.

**Recommendation:** Add exponential backoff or pause interval on repeated failures:

```typescript
private processFailureCount = 0;
private pollFailureCount = 0;

this.processTimer = setInterval(async () => {
  try {
    await this.processQueue();
    this.processFailureCount = 0; // Reset on success
  } catch (err) {
    this.processFailureCount++;
    console.error(`Queue processing error (${this.processFailureCount} failures):`, err);
    if (this.processFailureCount >= 5) {
      console.error("Too many queue failures, pausing processing");
      clearInterval(this.processTimer!);
      this.processTimer = null;
    }
  }
}, 2000);
```

**Risk:** Medium — Runaway error logging and resource exhaustion if sync enters a failure loop.

---

## Shell Script Issues

### 11. Emoji in Shell Output (session-status.sh:14-16)

**File:** `hooks/session-status.sh`
**Lines:** 14-16

```bash
if [[ "$conflict_count" != "0" ]]; then
    parts+=("⚠️ ${conflict_count} unresolved conflicts")
fi
```

**Issue:** Emoji rendering depends on terminal encoding and font support. In environments without UTF-8 or emoji fonts, this will render as `\u26A0\uFE0F` or a box character, breaking alignment in status lines.

**Recommendation:**
```bash
if [[ "$conflict_count" != "0" ]]; then
    parts+=("! ${conflict_count} unresolved conflicts")  # Use ASCII fallback
fi
```

Or detect emoji support:
```bash
if [[ -n "$INTERKASTEN_EMOJI" ]] && [[ "$conflict_count" != "0" ]]; then
    parts+=("⚠️ ${conflict_count} unresolved conflicts")
elif [[ "$conflict_count" != "0" ]]; then
    parts+=("! ${conflict_count} unresolved conflicts")
fi
```

**Risk:** Low — Cosmetic only, but can confuse users in non-UTF-8 terminals.

---

### 12. Missing `set -e` in Shell Hook (session-status.sh)

**File:** `hooks/session-status.sh`
**Lines:** 1-19 (entire file)

**Issue:** The script does not use `set -euo pipefail`, which is a best practice for Bash scripts (per Shell review guidelines). However, this script is sourced from a Claude Code hook context where failures should not exit the parent shell.

**Current behavior is correct** — `|| echo "?"` and `|| echo "0"` handle SQLite errors gracefully without exiting. Adding `set -e` would break this pattern.

**Recommendation:** Add a comment explaining why `set -e` is omitted:

```bash
#!/bin/bash
# NOTE: set -e is intentionally omitted — this script is sourced from a hook
# and should never exit the parent shell. All commands use || fallbacks.
```

**Risk:** None — current implementation is correct for this use case.

---

## What Was NOT Flagged (Out of Scope)

The following patterns were observed but are **not issues** for this review:

1. **No JSDoc on many functions** — Project does not enforce JSDoc coverage (not established in CLAUDE.md or AGENTS.md)
2. **Minimal inline comments in merge.ts** — Code is clear enough; over-commenting would be cosmetic
3. **Magic numbers** (e.g., `MAX_PAGES = 20`, `timeout: 10000`) — These are reasonable defaults with clear context
4. **No explicit test file in diff** — Tests are mentioned in CLAUDE.md (130 tests exist), this review is code-only
5. **Direct SQLite `sql` template usage** — Acceptable for complex joins; Drizzle builder can be verbose for multi-table queries
6. **No TypeScript strict mode enforcement** — Not mentioned in project conventions

---

## Priority Findings

### Critical (Address Before Merge)
1. **Path validation gaps (Issue 5)** — Security risk for path traversal
2. **Overly permissive `any` types (Issue 2)** — Runtime failures without type safety
3. **Silent error handling (Issue 3)** — Debugging production issues is impossible

### High (Address Soon)
4. **Error handling in poll loop (Issue 4)** — Silent failures during outages
5. **Unsafe type assertions (Issues 7, 9)** — Schema drift will cause crashes
6. **Naming inconsistency (Issue 1)** — Breaks TypeScript conventions across API surface

### Medium (Consider for Next Iteration)
7. **Missing async error propagation (Issue 10)** — Runaway error logging
8. **Config validation (Issue 8)** — Invalid config strings bypass type system

### Low (Nice to Have)
9. **Timezone handling (Issue 6)** — Cosmetic, document behavior
10. **Emoji in shell script (Issue 11)** — Terminal compatibility

---

## Positive Patterns Observed

1. **Consistent use of `execFileSync` instead of `execSync`** in `beads-sync.ts` — Prevents shell injection (lines 352, 449)
2. **Path safety via `resolve()` and `basename()`** in `engine.ts` — Correct intent, just needs completion
3. **WAL protocol consistency** in `executePull()` (lines 691-730) — Matches established pattern
4. **Frontmatter preservation** in conflict handling (lines 768-810) — Correct separation of concerns
5. **Circuit breaker references** in `session-status.sh` and health checks — Good operational visibility
6. **Clear separation** between raw SQL results and TypeScript interfaces (acknowledged in comment, just needs follow-through)

---

## Recommendations Summary

1. **Map raw SQL results to camelCase interfaces** at store boundaries (entities.ts)
2. **Replace `any` with Notion SDK types** for property mappings (beads-sync.ts, linked-refs.ts)
3. **Add error context to silent catch blocks** — log to `appendSyncLog` or return `Result<T, E>` types
4. **Distinguish 404/403 from transient errors** in poll loop (engine.ts:608-623)
5. **Complete path validation** — reject null `projectDir` and validate at entity insertion time
6. **Use Drizzle query builder** for complex SELECTs to enforce type safety (entities.ts:263-269)
7. **Add backoff or circuit breaker** to timer-based async error handlers (engine.ts:525-537)
8. **Use ASCII fallback for status indicators** or detect emoji support (session-status.sh:14-16)

---

## Conclusion

The implementation demonstrates solid architectural patterns (WAL protocol, circuit breaker awareness, path safety intent) but has **type safety gaps** and **error handling blind spots** that would make production debugging difficult. The most critical issue is **incomplete path validation** (security), followed by **`any` types** and **silent error swallowing** (operational visibility).

TypeScript conventions are mostly followed, with the notable exception of the `ConflictEntity` interface's snake_case naming. Shell script is correct but should document why `set -e` is omitted.

Recommended action: Address Critical and High priority findings before merging. Medium/Low can be deferred to follow-up iterations.
