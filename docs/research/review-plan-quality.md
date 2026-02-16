# Quality & Style Review: Bidirectional Notion Sync Plan

**Bead:** Interkasten-3wh (review of implementation plan)
**Reviewer:** Flux-drive Quality & Style Reviewer
**Date:** 2026-02-16
**Plan location:** `/root/projects/Interverse/plugins/interkasten/docs/plans/2026-02-15-bidirectional-sync.md`

## Executive Summary

This is a **high-quality, well-structured plan** with excellent TypeScript idioms, comprehensive test coverage, and strong adherence to project conventions. The 15-task TDD approach is exemplary. Key strengths: type safety, proper error handling, security-conscious child process usage, and WAL crash recovery patterns. Areas for improvement: missing type annotations on some functions, potential overly broad `any` types, and some edge cases in conflict handling.

**Recommended action:** Approve with minor revisions (listed below).

---

## Universal Quality Assessment

### Naming Consistency (PASS)

**Excellent.** All names align with project vocabulary and TypeScript conventions:

- **Types**: Clear, self-documenting names (`ConflictRegion`, `MergeResult`, `PageChange`, `BeadsIssue`, `BeadsDiff`)
- **Functions**: Verb-first, intention-revealing (`threeWayMerge`, `formatConflictFile`, `parseBeadsOutput`, `diffBeadsState`, `mapBeadsToNotionProperties`)
- **Modules**: Domain-aligned (`merge.ts`, `notion-poller.ts`, `beads-sync.ts`)
- **Consistency**: Matches existing patterns (`upsertEntity`, `hashContent`, `walCreatePending`)

**No action required.**

---

### File Organization (PASS)

**Excellent.** The plan extends existing architecture cleanly:

- New modules land in established directories (`server/src/sync/`, `server/src/daemon/tools/`)
- Tests colocated with features (`server/tests/sync/`, `server/tests/integration/`)
- No ad-hoc structure introduced

**No action required.**

---

### Error Handling Patterns (NEEDS WORK)

**Good overall, with gaps in propagation and swallowed errors.**

#### Strengths

1. **Circuit breaker integration implied** — existing `NotionClient` wraps all API calls
2. **WAL protocol** — crash recovery via `pending → target_written → committed` state machine (Task 6)
3. **Soft-delete safety** — no data loss on file removal (Task 12)
4. **Security-conscious child process usage** — `execFileSync` (not `execSync`) prevents shell injection (Task 10)

#### Issues

**Task 2 (Conflict Store Helpers):**

```typescript
export function listConflicts(db: DB): any[] {  // ← Missing type annotation
  return db.sqlite
    .prepare(
      `SELECT em.*, bc_local.content as local_content, bc_notion.content as notion_content
       FROM entity_map em
       LEFT JOIN base_content bc_local ON em.conflict_local_content_id = bc_local.id
       LEFT JOIN base_content bc_notion ON em.conflict_notion_content_id = bc_notion.id
       WHERE em.conflict_detected_at IS NOT NULL AND em.deleted = 0`,
    )
    .all();
}
```

**Problem:** Returns `any[]` instead of a typed result. Violates TypeScript safety principle.

**Fix:**

```typescript
export interface ConflictEntity extends EntityMap {
  local_content: string | null;
  notion_content: string | null;
}

export function listConflicts(db: DB): ConflictEntity[] {
  return db.sqlite
    .prepare(
      `SELECT em.*, bc_local.content as local_content, bc_notion.content as notion_content
       FROM entity_map em
       LEFT JOIN base_content bc_local ON em.conflict_local_content_id = bc_local.id
       LEFT JOIN base_content bc_notion ON em.conflict_notion_content_id = bc_notion.id
       WHERE em.conflict_detected_at IS NOT NULL AND em.deleted = 0`,
    )
    .all() as ConflictEntity[];
}
```

**Task 5 (NotionPoller):**

```typescript
export class NotionPoller {
  async pollDatabase(databaseId: string, since: Date): Promise<PageChange[]> {
    const dataSourceId = await this.notion.resolveDataSourceId(databaseId);
    const changes: PageChange[] = [];
    let cursor: string | undefined;

    do {
      const response: any = await this.notion.call(async (client) => {  // ← `any` type
        return client.databases.query({
          database_id: dataSourceId,
          filter: {
            timestamp: "last_edited_time",
            last_edited_time: { after: since.toISOString() },
          },
          start_cursor: cursor,
          page_size: 100,
        });
      });

      for (const page of response.results) {  // ← Untyped iteration
        changes.push({
          pageId: page.id,
          lastEdited: page.last_edited_time,
          title: this.extractTitle(page),
        });
      }

      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);

    return changes;
  }
}
```

**Problem:** `response: any` disables type checking. `page` in loop is untyped.

**Fix:** Import Notion SDK types:

```typescript
import type { QueryDatabaseResponse } from "@notionhq/client/build/src/api-endpoints";

async pollDatabase(databaseId: string, since: Date): Promise<PageChange[]> {
  const dataSourceId = await this.notion.resolveDataSourceId(databaseId);
  const changes: PageChange[] = [];
  let cursor: string | undefined;

  do {
    const response = await this.notion.call(async (client) => {
      return client.databases.query({
        database_id: dataSourceId,
        filter: {
          timestamp: "last_edited_time",
          last_edited_time: { after: since.toISOString() },
        },
        start_cursor: cursor,
        page_size: 100,
      });
    }) as QueryDatabaseResponse;

    for (const page of response.results) {
      if ("id" in page && "last_edited_time" in page) {  // Type guard
        changes.push({
          pageId: page.id,
          lastEdited: page.last_edited_time,
          title: this.extractTitle(page),
        });
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return changes;
}
```

**Task 7 (Conflict Handling):**

```typescript
private async handleConflict(
  entity: any,  // ← Untyped parameter
  localContent: string,
  notionContent: string,
): Promise<void> {
  // ... implementation
  writeFileSync(entity.localPath, result.merged, "utf-8");  // ← Missing error handling
  await this.pushUpdate(entity.id, entity.notionId, result.merged, hashMarkdown(normalizeMarkdown(result.merged)));
}
```

**Problems:**

1. `entity: any` — should be `EntityMap`
2. `writeFileSync` can throw (EACCES, EROFS, ENOSPC) — no try/catch
3. `pushUpdate` failure after local write leaves inconsistent state

**Fix:** Type parameter + WAL protocol:

```typescript
import type { EntityMap } from "../store/schema.js";

private async handleConflict(
  entity: EntityMap,
  localContent: string,
  notionContent: string,
): Promise<void> {
  // ... merge logic ...

  // WAL protocol for atomic write
  const walId = walCreatePending(this.db, {
    entityMapId: entity.id,
    operation: "merge",
    oldBaseId: entity.baseContentId,
    newContent: result.merged,
  });

  try {
    writeFileSync(entity.localPath, result.merged, "utf-8");
    walMarkTargetWritten(this.db, walId);

    await this.pushUpdate(entity.id, entity.notionId, result.merged, hashMarkdown(normalizeMarkdown(result.merged)));
    walMarkCommitted(this.db, walId);
    walDelete(this.db, walId);
  } catch (err) {
    appendSyncLog(this.db, {
      entityMapId: entity.id,
      operation: "error",
      detail: JSON.stringify({ phase: "merge-write-push", error: String(err) }),
    });
    throw err;
  }
}
```

**Task 10 (Beads Sync):**

```typescript
export function parseBeadsOutput(jsonOutput: string): BeadsIssue[] {
  try {
    const parsed = JSON.parse(jsonOutput);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];  // ← Silently swallows parse errors
  }
}
```

**Problem:** Swallows parse errors, making debugging hard.

**Fix:**

```typescript
export function parseBeadsOutput(jsonOutput: string): BeadsIssue[] {
  try {
    const parsed = JSON.parse(jsonOutput);
    if (!Array.isArray(parsed)) {
      console.warn("[beads-sync] bd output is not an array:", parsed);
      return [];
    }
    return parsed;
  } catch (err) {
    console.error("[beads-sync] Failed to parse bd output:", err, "Raw output:", jsonOutput.slice(0, 200));
    return [];
  }
}
```

**Recommendation:**

- Add types to `listConflicts` (Task 2)
- Import Notion SDK types in `NotionPoller` (Task 5)
- Type `handleConflict` parameter as `EntityMap` and wrap `writeFileSync` in WAL protocol (Task 7)
- Log parse errors in `parseBeadsOutput` (Task 10)

---

### Test Strategy (PASS)

**Exceptional.** TDD approach with unit tests for every new function. Key highlights:

1. **Comprehensive edge cases** — empty base (Task 4), pagination (Task 5), path traversal (Task 6), orphaned content GC (Task 2)
2. **Proper mocking** — `vi.fn()` for Notion client, not actual API calls in unit tests
3. **Integration tests gated behind env var** — `INTERKASTEN_TEST_TOKEN` (Task 14)
4. **Table-driven test patterns** — conflict scenarios (Task 7), beads diff detection (Task 10)

**No action required.** Test quality is exemplary.

---

### API Design Consistency (PASS)

**Excellent.** All new functions follow existing patterns:

- `DB` as first parameter for store functions (matches `upsertEntity`, `getEntityByPath`)
- `sqlite.prepare().run()` for raw SQL (matches `db.ts` migrations)
- Circuit breaker wrapping via `notion.call(fn)` (matches existing `NotionClient` API)
- WAL protocol for crash recovery (matches existing push sync in `engine.ts`)

**No action required.**

---

### Complexity Budget (PASS)

**Well-managed.** No gratuitous abstractions. Key decisions:

1. **Single-process architecture** — poll intervals on main thread, not separate workers (correct for MCP server)
2. **node-diff3 for merge** — battle-tested library, not custom diff algorithm
3. **Content-addressed base storage** — efficient deduplication without premature optimization
4. **Soft-delete with GC sweep** — safe, auditable, matches industry practice

**No action required.**

---

### Dependency Discipline (MINOR CONCERN)

**Good.** Two new deps, both justified:

- `node-diff3` — three-way merge (Task 3)
- `diff-match-patch-es` — unused? (Task 3)

**Action:** Verify `diff-match-patch-es` is actually used. If not, remove from Task 3.

---

## TypeScript-Specific Assessment

### Type Safety (NEEDS WORK)

**Good overall, with gaps noted above.**

#### Strengths

1. **Explicit interface definitions** — `ConflictRegion`, `MergeResult`, `PageChange`, `BeadsIssue`, `BeadsDiff`
2. **Discriminated union for strategies** — `ConflictStrategy = "local-wins" | "notion-wins" | "three-way-merge" | "conflict-file"`
3. **Proper imports from existing schema** — `EntityMap`, `BaseContent`, `DB`
4. **Readonly tuples for state machines** — `state: 'pending' | 'target_written' | 'committed'` (implied via WAL types)

#### Gaps (already noted above)

- `any[]` return type on `listConflicts` (Task 2)
- `response: any` in `NotionPoller` (Task 5)
- `entity: any` parameter in `handleConflict` (Task 7)

---

### Type Guards (NEEDS WORK)

**Missing in several places.**

**Task 5 (extractTitle):**

```typescript
private extractTitle(page: any): string {
  const props = page.properties || {};
  const nameCol = props.Name || props.name || props.Title || props.title;
  if (nameCol?.title?.[0]?.plain_text) {
    return nameCol.title[0].plain_text;
  }
  return "Untitled";
}
```

**Problem:** `page: any` — no validation that `page` is actually a Notion page object.

**Fix:**

```typescript
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";

private extractTitle(page: PageObjectResponse | { properties?: unknown }): string {
  const props = ("properties" in page && page.properties) || {};
  if (typeof props !== "object" || props === null) return "Untitled";

  const nameCol = (props as Record<string, any>).Name || (props as Record<string, any>).name;
  if (nameCol?.title?.[0]?.plain_text) {
    return nameCol.title[0].plain_text;
  }
  return "Untitled";
}
```

**Recommendation:** Add type guards in `extractTitle` (Task 5) and anywhere else page objects are accessed.

---

### Naming Consistency (PASS)

**Excellent.** TypeScript conventions followed:

- `PascalCase` for types/interfaces/classes (`NotionPoller`, `BeadsIssue`)
- `camelCase` for functions/variables (`threeWayMerge`, `parseBeadsOutput`)
- `SCREAMING_SNAKE_CASE` for constants (`STATUS_MAP`, `TYPE_MAP`)

**No action required.**

---

### Test Tooling (PASS)

**Correct.** Uses `vitest` (existing project standard), not Jest. Tests use async/await properly, no promise anti-patterns.

**No action required.**

---

## Security Assessment

### Shell Injection Prevention (PASS)

**Excellent.** Plan explicitly mandates `execFileSync` (not `execSync`):

> All child process calls MUST use `execFile`/`execFileSync` (not `exec`/`execSync`) to prevent shell injection.

**Task 10 implementation follows this:**

```typescript
execFileSync("bd", ["list", "--format=json"], {
  cwd: resolve(projectDir),
  encoding: "utf-8",
  timeout: 10000,
});
```

**No action required.** This is a model example.

---

### Path Traversal (NEEDS WORK)

**Good, with one gap.**

**Task 6 includes path validation tests:**

```typescript
describe("path validation", () => {
  it("should reject paths with traversal sequences", () => {
    const projectDir = "/root/projects/test";
    const malicious = "../../../etc/passwd";
    const resolved = resolve(projectDir, malicious);
    expect(resolved.startsWith(projectDir)).toBe(false);
  });
});
```

**Problem:** Test is correct, but **implementation is not shown in Task 6**. The plan says "Add `findProjectDir()` private method" but doesn't show path validation being enforced in `executePull`.

**Recommendation:** Add path validation enforcement in `executePull` (Task 6).

---

## Consistency with Existing Codebase

### Database Patterns (PASS)

**Perfect adherence.**

**Existing pattern (from `db.ts`):**

```typescript
const entityMapCols = sqlite.pragma("table_info(entity_map)") as Array<{ name: string }>;
const colNames = new Set(entityMapCols.map((c) => c.name));

if (!colNames.has("doc_tier")) {
  sqlite.exec("ALTER TABLE entity_map ADD COLUMN doc_tier TEXT");
}
```

**Plan pattern (Task 1):**

```typescript
const hasConflictCol = existingCols.some((c: any) => c.name === "conflict_detected_at");
if (!hasConflictCol) {
  sqlite.exec(`ALTER TABLE entity_map ADD COLUMN conflict_detected_at TEXT`);
}
```

**Match:** Yes. Uses same `PRAGMA table_info` check, same conditional migration pattern.

---

### Circuit Breaker Wrapping (PASS)

**Implied, not explicit.** The plan says all Notion API calls should use `this.notion.call(fn)`. This matches existing `NotionClient` patterns.

---

### WAL Protocol (PASS)

**Correct implementation** in Tasks 6 and 7. Matches existing pattern:

1. `walCreatePending`
2. Perform operation
3. `walMarkTargetWritten`
4. Update entity_map
5. `walMarkCommitted`
6. `walDelete`

---

## Missing from Plan

### Config Schema Updates (MISSING)

**Task 7 references `this.config.sync?.conflict_strategy`**, but no config schema update is shown. The plan should include:

**Task 0.5: Update Config Schema**

Add to `server/src/config/schema.ts`:

```typescript
sync: z.object({
  // ... existing fields
  conflict_strategy: z
    .enum(["three-way-merge", "local-wins", "notion-wins", "conflict-file"])
    .default("three-way-merge"),
  poll_interval: z.number().default(60),
}),
```

**Recommendation:** Add config schema task before Task 6.

---

### Shutdown Cleanup (INCOMPLETE)

**Task 6 adds a poll interval** but only mentions cleanup in a comment. The plan should show the actual shutdown hook.

---

### Beads Snapshot Storage (MISSING)

**Task 11 says:**

> Add `pollBeadsChanges()` that calls `fetchBeadsIssues` for each project, diffs against last known state...

**Missing:** Where is "last known state" stored? Needs a new table or JSON column.

**Recommendation:** Add `beads_snapshot` table schema.

---

## Summary of Recommendations

| Priority | Task | Issue | Fix |
|----------|------|-------|-----|
| **High** | 2 | `listConflicts` returns `any[]` | Add `ConflictEntity` interface, type return |
| **High** | 5 | `pollDatabase` uses `response: any` | Import `QueryDatabaseResponse`, add type guard |
| **High** | 6 | Path traversal validation missing | Add `startsWith` check in `executePull` |
| **High** | 7 | `handleConflict` has `entity: any` param | Type as `EntityMap`, wrap `writeFileSync` in WAL |
| **Medium** | Config | `conflict_strategy` not in schema | Add Task 0.5: update config schema + defaults |
| **Medium** | 6 | Shutdown cleanup only in comment | Show actual `clearInterval` in shutdown hook |
| **Medium** | 10 | `parseBeadsOutput` swallows errors | Log parse failures |
| **Medium** | 11 | Beads snapshot storage undefined | Add `beads_snapshot` table, update `pollBeadsChanges` |
| **Low** | 3 | `diff-match-patch-es` unused? | Verify usage or remove |
| **Low** | 5 | `extractTitle` lacks type guard | Use `PageObjectResponse` type |

---

## Overall Assessment

**This is a production-grade plan** with excellent attention to:

- **Type safety** (with noted gaps)
- **Security** (child process usage, path validation)
- **Crash recovery** (WAL protocol)
- **Testing** (TDD with edge cases)
- **Project consistency** (follows all existing patterns)

**Estimated quality score: 8.5/10**

Deductions for:
- Missing type annotations (Tasks 2, 5, 7)
- Swallowed errors (Task 10)
- Incomplete edge case handling (Task 6 path validation)
- Missing schema updates (config, beads snapshot)

**Recommended action:** Address the High priority fixes before implementation. Medium/Low fixes can be deferred to a hardening iteration.
