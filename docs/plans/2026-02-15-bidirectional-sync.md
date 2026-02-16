# Bidirectional Notion Sync — Implementation Plan
**Bead:** Interkasten-3wh
**Phase:** executing (as of 2026-02-16T07:41:33Z)

> **For Claude:** REQUIRED SUB-SKILL: Use clavain:executing-plans to implement this plan task-by-task.

**Goal:** Add pull sync, three-way merge, beads issue sync, and production hardening to interkasten.

**Architecture:** Extend the existing single-process MCP server with a Notion poller (60s interval), three-way merge via `node-diff3`, and beads sync via `bd` CLI (using `execFile`, not `exec`). All operations serialize through the existing `SyncQueue`. No new processes or network listeners.

**Tech Stack:** TypeScript, Vitest, better-sqlite3/drizzle-orm, node-diff3, diff-match-patch-es, @notionhq/client v5, notion-to-md, @tryfabric/martian

**Security note:** All child process calls MUST use `execFile`/`execFileSync` (not `exec`/`execSync`) to prevent shell injection. See `src/utils/execFileNoThrow.ts` if it exists, otherwise use Node's `child_process.execFileSync` directly.

---

## Task 1: Schema Migration — Add Conflict Tracking Columns

**Files:**
- Modify: `server/src/store/db.ts:89-105` (conditional migrations block)
- Test: `server/tests/store/entities.test.ts`

**Step 1: Write the failing test**

Add to `server/tests/store/entities.test.ts`:

```typescript
describe("conflict tracking", () => {
  it("should have conflict columns after migration", () => {
    const db = openTestDb();
    const info = db.sqlite.prepare("PRAGMA table_info(entity_map)").all() as { name: string }[];
    const columns = info.map((c) => c.name);
    expect(columns).toContain("conflict_detected_at");
    expect(columns).toContain("conflict_local_content_id");
    expect(columns).toContain("conflict_notion_content_id");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/store/entities.test.ts -t "conflict columns"`
Expected: FAIL — columns don't exist yet

**Step 3: Add conflict column migrations**

In `server/src/store/db.ts`, after the existing `parent_id` index migration (around line 105), add:

```typescript
// Conflict tracking columns
const hasConflictCol = existingCols.some((c: any) => c.name === "conflict_detected_at");
if (!hasConflictCol) {
  sqlite.exec(`ALTER TABLE entity_map ADD COLUMN conflict_detected_at TEXT`);
  sqlite.exec(`ALTER TABLE entity_map ADD COLUMN conflict_local_content_id INTEGER REFERENCES base_content(id)`);
  sqlite.exec(`ALTER TABLE entity_map ADD COLUMN conflict_notion_content_id INTEGER REFERENCES base_content(id)`);
}
```

**Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/store/entities.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add server/src/store/db.ts server/tests/store/entities.test.ts
git commit -m "feat: add conflict tracking columns to entity_map schema"
```

---

## Task 2: Conflict Store Helpers

**Files:**
- Modify: `server/src/store/entities.ts` (add functions after line 199)
- Test: `server/tests/store/entities.test.ts`

**Step 1: Write the failing tests**

Add to `server/tests/store/entities.test.ts`:

```typescript
describe("conflict operations", () => {
  it("should mark an entity as conflicted", () => {
    const db = openTestDb();
    const entityId = createTestEntity(db, "/test/file.md", "notion-abc");
    const localContentId = upsertBaseContent(db, "local version").id;
    const notionContentId = upsertBaseContent(db, "notion version").id;

    markConflict(db, entityId, localContentId, notionContentId);

    const entity = getEntityByPath(db, "/test/file.md");
    expect(entity.conflict_detected_at).toBeTruthy();
    expect(entity.conflict_local_content_id).toBe(localContentId);
    expect(entity.conflict_notion_content_id).toBe(notionContentId);
  });

  it("should clear conflict state", () => {
    const db = openTestDb();
    const entityId = createTestEntity(db, "/test/file.md", "notion-abc");
    const localId = upsertBaseContent(db, "local").id;
    const notionId = upsertBaseContent(db, "notion").id;
    markConflict(db, entityId, localId, notionId);

    clearConflict(db, entityId);

    const entity = getEntityByPath(db, "/test/file.md");
    expect(entity.conflict_detected_at).toBeNull();
    expect(entity.conflict_local_content_id).toBeNull();
    expect(entity.conflict_notion_content_id).toBeNull();
  });

  it("should list conflicted entities", () => {
    const db = openTestDb();
    const id1 = createTestEntity(db, "/a.md", "notion-a");
    const id2 = createTestEntity(db, "/b.md", "notion-b");
    const contentId = upsertBaseContent(db, "content").id;
    markConflict(db, id1, contentId, contentId);

    const conflicts = listConflicts(db);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].id).toBe(id1);
  });
});
```

**Step 2: Run test to verify they fail**

Run: `cd server && npx vitest run tests/store/entities.test.ts -t "conflict operations"`
Expected: FAIL — functions not defined

**Step 3: Implement conflict helpers**

Add to `server/src/store/entities.ts`:

```typescript
export function markConflict(
  db: DB,
  entityId: number,
  localContentId: number,
  notionContentId: number,
): void {
  db.sqlite
    .prepare(
      `UPDATE entity_map SET
        conflict_detected_at = datetime('now'),
        conflict_local_content_id = ?,
        conflict_notion_content_id = ?
      WHERE id = ?`,
    )
    .run(localContentId, notionContentId, entityId);
}

export function clearConflict(db: DB, entityId: number): void {
  db.sqlite
    .prepare(
      `UPDATE entity_map SET
        conflict_detected_at = NULL,
        conflict_local_content_id = NULL,
        conflict_notion_content_id = NULL
      WHERE id = ?`,
    )
    .run(entityId);
}

export function listConflicts(db: DB): any[] {
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

**Step 4: Run tests**

Run: `cd server && npx vitest run tests/store/entities.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add server/src/store/entities.ts server/tests/store/entities.test.ts
git commit -m "feat: add conflict mark/clear/list helpers to entity store"
```

---

## Task 3: Install Merge Dependencies

**Files:**
- Modify: `server/package.json`

**Step 1: Install packages**

```bash
cd server && npm install node-diff3 diff-match-patch-es
npm install -D @types/node-diff3
```

**Step 2: Verify installation**

```bash
cd server && node -e "const d3 = require('node-diff3'); console.log('diff3:', typeof d3.diff3Merge)"
```

Expected: `diff3: function`

**Step 3: Commit**

```bash
git add server/package.json server/package-lock.json
git commit -m "deps: add node-diff3 and diff-match-patch-es for three-way merge"
```

---

## Task 4: Three-Way Merge Module

**Files:**
- Create: `server/src/sync/merge.ts`
- Test: `server/tests/sync/merge.test.ts`

**Step 1: Write the failing tests**

Create `server/tests/sync/merge.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { threeWayMerge, formatConflictFile } from "../src/sync/merge.js";

describe("threeWayMerge", () => {
  it("should return unchanged when all three are identical", () => {
    const result = threeWayMerge("hello world", "hello world", "hello world");
    expect(result.merged).toBe("hello world");
    expect(result.conflicts).toHaveLength(0);
    expect(result.hasConflicts).toBe(false);
  });

  it("should accept local-only changes", () => {
    const base = "line 1\nline 2\nline 3";
    const local = "line 1\nmodified locally\nline 3";
    const remote = "line 1\nline 2\nline 3";
    const result = threeWayMerge(base, local, remote);
    expect(result.merged).toBe("line 1\nmodified locally\nline 3");
    expect(result.hasConflicts).toBe(false);
  });

  it("should accept remote-only changes", () => {
    const base = "line 1\nline 2\nline 3";
    const local = "line 1\nline 2\nline 3";
    const remote = "line 1\nmodified remotely\nline 3";
    const result = threeWayMerge(base, local, remote);
    expect(result.merged).toBe("line 1\nmodified remotely\nline 3");
    expect(result.hasConflicts).toBe(false);
  });

  it("should merge non-overlapping changes from both sides", () => {
    const base = "line 1\nline 2\nline 3\nline 4";
    const local = "line 1\nlocal edit\nline 3\nline 4";
    const remote = "line 1\nline 2\nline 3\nremote edit";
    const result = threeWayMerge(base, local, remote);
    expect(result.merged).toBe("line 1\nlocal edit\nline 3\nremote edit");
    expect(result.hasConflicts).toBe(false);
  });

  it("should detect overlapping changes as conflicts", () => {
    const base = "line 1\nline 2\nline 3";
    const local = "line 1\nlocal version\nline 3";
    const remote = "line 1\nremote version\nline 3";
    const result = threeWayMerge(base, local, remote);
    expect(result.hasConflicts).toBe(true);
    expect(result.conflicts.length).toBeGreaterThan(0);
  });

  it("should apply local-wins fallback for conflicts", () => {
    const base = "line 1\nline 2\nline 3";
    const local = "line 1\nlocal version\nline 3";
    const remote = "line 1\nremote version\nline 3";
    const result = threeWayMerge(base, local, remote, "local-wins");
    expect(result.merged).toContain("local version");
    expect(result.merged).not.toContain("remote version");
  });

  it("should apply notion-wins fallback for conflicts", () => {
    const base = "line 1\nline 2\nline 3";
    const local = "line 1\nlocal version\nline 3";
    const remote = "line 1\nremote version\nline 3";
    const result = threeWayMerge(base, local, remote, "notion-wins");
    expect(result.merged).toContain("remote version");
    expect(result.merged).not.toContain("local version");
  });

  it("should handle empty base (new file on both sides)", () => {
    const result = threeWayMerge("", "local content", "remote content");
    expect(result.hasConflicts).toBe(true);
  });
});

describe("formatConflictFile", () => {
  it("should include both versions with headers", () => {
    const output = formatConflictFile("local ver", "remote ver", "docs/test.md");
    expect(output).toContain("Local Version");
    expect(output).toContain("Notion Version");
    expect(output).toContain("local ver");
    expect(output).toContain("remote ver");
    expect(output).toContain("docs/test.md");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/sync/merge.test.ts`
Expected: FAIL — module not found

**Step 3: Implement three-way merge**

Create `server/src/sync/merge.ts`:

```typescript
import { diff3Merge } from "node-diff3";

export interface ConflictRegion {
  baseStart: number;
  baseEnd: number;
  localContent: string;
  remoteContent: string;
}

export interface MergeResult {
  merged: string;
  hasConflicts: boolean;
  conflicts: ConflictRegion[];
}

export type ConflictStrategy = "local-wins" | "notion-wins" | "three-way-merge" | "conflict-file";

/**
 * Three-way merge using node-diff3.
 *
 * @param base - Common ancestor content
 * @param local - Local version
 * @param remote - Notion version
 * @param conflictFallback - Strategy for overlapping changes
 */
export function threeWayMerge(
  base: string,
  local: string,
  remote: string,
  conflictFallback: ConflictStrategy = "three-way-merge",
): MergeResult {
  const baseLines = base.split("\n");
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");

  const result = diff3Merge(localLines, baseLines, remoteLines);

  const mergedLines: string[] = [];
  const conflicts: ConflictRegion[] = [];
  let lineCounter = 0;

  for (const chunk of result) {
    if ("ok" in chunk) {
      mergedLines.push(...chunk.ok);
      lineCounter += chunk.ok.length;
    } else if ("conflict" in chunk) {
      const conflict: ConflictRegion = {
        baseStart: lineCounter,
        baseEnd: lineCounter + (chunk.conflict.o?.length ?? 0),
        localContent: chunk.conflict.a.join("\n"),
        remoteContent: chunk.conflict.b.join("\n"),
      };
      conflicts.push(conflict);

      switch (conflictFallback) {
        case "local-wins":
          mergedLines.push(...chunk.conflict.a);
          break;
        case "notion-wins":
          mergedLines.push(...chunk.conflict.b);
          break;
        case "three-way-merge":
        case "conflict-file":
        default:
          // local-wins as ultimate fallback within three-way-merge
          mergedLines.push(...chunk.conflict.a);
          break;
      }
      lineCounter += chunk.conflict.a.length;
    }
  }

  return {
    merged: mergedLines.join("\n"),
    hasConflicts: conflicts.length > 0,
    conflicts,
  };
}

/**
 * Generate a .conflict file with both versions.
 */
export function formatConflictFile(
  localContent: string,
  remoteContent: string,
  filePath: string,
): string {
  return [
    `# Sync Conflict: ${filePath}`,
    `# Detected: ${new Date().toISOString()}`,
    `# Resolve by keeping one version and deleting this file.`,
    "",
    "## Local Version",
    "",
    localContent,
    "",
    "## Notion Version",
    "",
    remoteContent,
  ].join("\n");
}
```

**Step 4: Run tests**

Run: `cd server && npx vitest run tests/sync/merge.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add server/src/sync/merge.ts server/tests/sync/merge.test.ts
git commit -m "feat: add three-way merge module with node-diff3"
```

---

## Task 5: Notion Poller

**Files:**
- Create: `server/src/sync/notion-poller.ts`
- Test: `server/tests/sync/notion-poller.test.ts`

**Step 1: Write the failing tests**

Create `server/tests/sync/notion-poller.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { NotionPoller } from "../src/sync/notion-poller.js";

describe("NotionPoller", () => {
  it("should detect pages updated after last sync", async () => {
    const mockNotion = {
      call: vi.fn().mockImplementation(async (fn: any) => {
        // Simulate what the fn would return
        return {
          results: [
            {
              id: "page-1",
              last_edited_time: "2026-02-15T10:00:00Z",
              properties: { Name: { title: [{ plain_text: "Test Doc" }] } },
            },
          ],
          has_more: false,
        };
      }),
      resolveDataSourceId: vi.fn().mockResolvedValue("ds-123"),
    };

    const poller = new NotionPoller(mockNotion as any);
    const changes = await poller.pollDatabase("db-123", new Date("2026-02-15T09:00:00Z"));

    expect(changes).toHaveLength(1);
    expect(changes[0].pageId).toBe("page-1");
  });

  it("should return empty array when no changes", async () => {
    const mockNotion = {
      call: vi.fn().mockResolvedValue({ results: [], has_more: false }),
      resolveDataSourceId: vi.fn().mockResolvedValue("ds-123"),
    };

    const poller = new NotionPoller(mockNotion as any);
    const changes = await poller.pollDatabase("db-123", new Date());
    expect(changes).toHaveLength(0);
  });

  it("should handle pagination", async () => {
    const mockNotion = {
      call: vi.fn()
        .mockResolvedValueOnce({
          results: [{
            id: "page-1",
            last_edited_time: "2026-02-15T10:00:00Z",
            properties: { Name: { title: [{ plain_text: "Doc 1" }] } },
          }],
          has_more: true,
          next_cursor: "cursor-1",
        })
        .mockResolvedValueOnce({
          results: [{
            id: "page-2",
            last_edited_time: "2026-02-15T10:01:00Z",
            properties: { Name: { title: [{ plain_text: "Doc 2" }] } },
          }],
          has_more: false,
        }),
      resolveDataSourceId: vi.fn().mockResolvedValue("ds-123"),
    };

    const poller = new NotionPoller(mockNotion as any);
    const changes = await poller.pollDatabase("db-123", new Date("2026-02-15T09:00:00Z"));
    expect(changes).toHaveLength(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/sync/notion-poller.test.ts`
Expected: FAIL — module not found

**Step 3: Implement NotionPoller**

Create `server/src/sync/notion-poller.ts`:

```typescript
import type { NotionClient } from "./notion-client.js";

export interface PageChange {
  pageId: string;
  lastEdited: string;
  title: string;
}

export class NotionPoller {
  private notion: NotionClient;

  constructor(notion: NotionClient) {
    this.notion = notion;
  }

  /**
   * Poll a Notion database for pages updated after `since`.
   * Uses last_edited_time filter for fast-path, paginated.
   */
  async pollDatabase(databaseId: string, since: Date): Promise<PageChange[]> {
    const dataSourceId = await this.notion.resolveDataSourceId(databaseId);
    const changes: PageChange[] = [];
    let cursor: string | undefined;

    do {
      const response: any = await this.notion.call(async (client) => {
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

      for (const page of response.results) {
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

  private extractTitle(page: any): string {
    const props = page.properties || {};
    const nameCol = props.Name || props.name || props.Title || props.title;
    if (nameCol?.title?.[0]?.plain_text) {
      return nameCol.title[0].plain_text;
    }
    return "Untitled";
  }
}
```

**Step 4: Run tests**

Run: `cd server && npx vitest run tests/sync/notion-poller.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add server/src/sync/notion-poller.ts server/tests/sync/notion-poller.test.ts
git commit -m "feat: add NotionPoller for detecting remote page changes"
```

---

## Task 6: Pull Sync in Engine

**Files:**
- Modify: `server/src/sync/engine.ts` (add `pollNotionChanges`, `processPullOperation`, `executePull`, modify `processQueue`)
- Modify: `server/src/index.ts` (add poll interval)
- Test: `server/tests/sync/engine-pull.test.ts`

**Step 1: Write the failing tests**

Create `server/tests/sync/engine-pull.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolve } from "path";

describe("path validation", () => {
  it("should reject paths with traversal sequences", () => {
    const projectDir = "/root/projects/test";
    const malicious = "../../../etc/passwd";
    const resolved = resolve(projectDir, malicious);
    expect(resolved.startsWith(projectDir)).toBe(false);
  });

  it("should accept valid subpaths", () => {
    const projectDir = "/root/projects/test";
    const valid = "docs/readme.md";
    const resolved = resolve(projectDir, valid);
    expect(resolved.startsWith(projectDir)).toBe(true);
  });

  it("should reject absolute paths", () => {
    const projectDir = "/root/projects/test";
    const absolute = "/etc/passwd";
    const resolved = resolve(projectDir, absolute);
    expect(resolved.startsWith(projectDir)).toBe(false);
  });
});

describe("frontmatter preservation", () => {
  it("should preserve local frontmatter on pull", () => {
    const localContent = "---\ntags: [test]\n---\n\n# Title\n\nBody text";
    const notionContent = "# Title\n\nUpdated body text";

    const fmMatch = localContent.match(/^---\n[\s\S]*?\n---\n/);
    const frontmatter = fmMatch ? fmMatch[0] : "";
    const merged = frontmatter + "\n" + notionContent;

    expect(merged).toContain("tags: [test]");
    expect(merged).toContain("Updated body text");
  });

  it("should handle content without frontmatter", () => {
    const localContent = "# Title\n\nBody text";
    const notionContent = "# Title\n\nUpdated body";

    const fmMatch = localContent.match(/^---\n[\s\S]*?\n---\n/);
    expect(fmMatch).toBeNull();
    // No frontmatter = use notion content directly
  });
});
```

**Step 2: Run test to verify it fails/passes**

Run: `cd server && npx vitest run tests/sync/engine-pull.test.ts`
Expected: PASS (these are unit tests for the contracts)

**Step 3: Add pull sync methods to SyncEngine**

Modify `server/src/sync/engine.ts`. Key additions:

1. Import `NotionPoller` and new store functions
2. Add `poller` field to constructor
3. Add `pollNotionChanges()` method — queries Notion for updated pages, enqueues pull ops
4. Add `processPullOperation()` method — fetch Notion content, compare hashes, detect conflicts, call `executePull` or `handleConflict`
5. Add `executePull()` private method — WAL protocol for pull: pending → write local file (preserving frontmatter) → target_written → update entity_map → committed → delete WAL
6. Add `findProjectDir()` private method — walk up to find project root for path validation
7. Modify `processQueue()` to route `op.side === "notion"` to `processPullOperation`

Add poll interval to `server/src/index.ts` after engine start:

```typescript
const pollInterval = setInterval(async () => {
  try {
    await syncEngine.pollNotionChanges();
  } catch (err) {
    console.error("Poll error:", err);
  }
}, (config.sync?.poll_interval ?? 60) * 1000);

// Add to shutdown: clearInterval(pollInterval);
```

**Step 4: Run all tests**

Run: `cd server && npx vitest run`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add server/src/sync/engine.ts server/src/index.ts server/tests/sync/engine-pull.test.ts
git commit -m "feat: add pull sync with Notion polling, path validation, frontmatter preservation"
```

---

## Task 7: Conflict Handling + Merge Integration

**Files:**
- Modify: `server/src/sync/engine.ts` (add `handleConflict` method)
- Test: `server/tests/sync/engine-merge.test.ts`

**Step 1: Write the failing tests**

Create `server/tests/sync/engine-merge.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { threeWayMerge, formatConflictFile } from "../src/sync/merge.js";

describe("engine merge scenarios", () => {
  it("should auto-merge non-overlapping doc changes", () => {
    const base = "# Title\n\nIntro.\n\n## Section A\n\nContent A.\n\n## Section B\n\nContent B.";
    const local = "# Title\n\nIntro.\n\n## Section A\n\nLocal edit A.\n\n## Section B\n\nContent B.";
    const remote = "# Title\n\nIntro.\n\n## Section A\n\nContent A.\n\n## Section B\n\nNotion edit B.";

    const result = threeWayMerge(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.merged).toContain("Local edit A.");
    expect(result.merged).toContain("Notion edit B.");
  });

  it("should detect overlapping and apply local-wins", () => {
    const base = "# Title\n\nSame paragraph.";
    const local = "# Title\n\nLocal rewrite of paragraph.";
    const remote = "# Title\n\nNotion rewrite of paragraph.";

    const result = threeWayMerge(base, local, remote, "local-wins");
    expect(result.hasConflicts).toBe(true);
    expect(result.merged).toContain("Local rewrite");
    expect(result.merged).not.toContain("Notion rewrite");
  });

  it("should detect overlapping and apply notion-wins", () => {
    const base = "# Title\n\nSame paragraph.";
    const local = "# Title\n\nLocal rewrite of paragraph.";
    const remote = "# Title\n\nNotion rewrite of paragraph.";

    const result = threeWayMerge(base, local, remote, "notion-wins");
    expect(result.hasConflicts).toBe(true);
    expect(result.merged).toContain("Notion rewrite");
  });
});
```

**Step 2: Run tests**

Run: `cd server && npx vitest run tests/sync/engine-merge.test.ts`
Expected: PASS (merge module already works from Task 4)

**Step 3: Add handleConflict to engine**

Add to `SyncEngine` class in `server/src/sync/engine.ts`:

```typescript
import { threeWayMerge, formatConflictFile, type ConflictStrategy } from "./merge.js";
import { markConflict, clearConflict, getBaseContent } from "../store/entities.js";

private async handleConflict(
  entity: any,
  localContent: string,
  notionContent: string,
): Promise<void> {
  const strategy = (this.config.sync?.conflict_strategy || "three-way-merge") as ConflictStrategy;

  const base = entity.baseContentId
    ? getBaseContent(this.db, entity.baseContentId)?.content ?? ""
    : "";

  if (strategy === "conflict-file") {
    const conflictPath = entity.localPath + ".conflict";
    writeFileSync(conflictPath, formatConflictFile(localContent, notionContent, entity.localPath), "utf-8");
    const localId = upsertBaseContent(this.db, localContent).id;
    const notionId = upsertBaseContent(this.db, notionContent).id;
    markConflict(this.db, entity.id, localId, notionId);
    appendSyncLog(this.db, {
      entityMapId: entity.id,
      operation: "conflict",
      detail: JSON.stringify({ strategy: "conflict-file", conflictPath }),
    });
    return;
  }

  // Three-way merge with fallback
  const fallback = strategy === "three-way-merge" ? "local-wins" : strategy;
  const result = threeWayMerge(base, localContent, notionContent, fallback as ConflictStrategy);

  if (result.hasConflicts) {
    const localId = upsertBaseContent(this.db, localContent).id;
    const notionId = upsertBaseContent(this.db, notionContent).id;
    markConflict(this.db, entity.id, localId, notionId);
    appendSyncLog(this.db, {
      entityMapId: entity.id,
      operation: "merge",
      detail: JSON.stringify({
        strategy: fallback,
        conflictCount: result.conflicts.length,
        autoResolved: true,
      }),
    });
  } else {
    clearConflict(this.db, entity.id);
  }

  // Write merged to local
  writeFileSync(entity.localPath, result.merged, "utf-8");

  // Push merged to Notion (reuse existing push logic)
  await this.pushUpdate(entity.id, entity.notionId, result.merged, hashMarkdown(normalizeMarkdown(result.merged)));
}
```

**Step 4: Run all tests**

Run: `cd server && npx vitest run`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add server/src/sync/engine.ts server/tests/sync/engine-merge.test.ts
git commit -m "feat: integrate three-way merge with conflict strategies in sync engine"
```

---

## Task 8: Conflict + Pull MCP Tools

**Files:**
- Modify: `server/src/daemon/tools/sync.ts`

**Step 1: Add interkasten_conflicts tool**

```typescript
server.tool(
  "interkasten_conflicts",
  "List files with unresolved sync conflicts",
  {},
  async () => {
    const conflicts = listConflicts(ctx.db);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          conflicts.map((c: any) => ({
            entityId: c.id,
            localPath: c.local_path,
            notionId: c.notion_id,
            detectedAt: c.conflict_detected_at,
            localPreview: (c.local_content || "").slice(0, 200),
            notionPreview: (c.notion_content || "").slice(0, 200),
          })),
          null,
          2,
        ),
      }],
    };
  },
);
```

**Step 2: Extend interkasten_sync with direction parameter**

Add `direction` to the existing tool's Zod schema:

```typescript
direction: z.enum(["push", "pull", "both"]).optional().describe("Sync direction (default: both)"),
```

Route accordingly in the handler: `push` calls existing push logic, `pull` calls `engine.pollNotionChanges()`, `both` calls both.

**Step 3: Run tests, commit**

```bash
git add server/src/daemon/tools/sync.ts
git commit -m "feat: add interkasten_conflicts tool and direction param to interkasten_sync"
```

---

## Task 9: Conflict Notification in SessionStart Hook

**Files:**
- Modify: `hooks/session-status.sh`

**Step 1: Add conflict check**

After the existing project count output in `hooks/session-status.sh`, add:

```bash
# Check for unresolved conflicts
CONFLICTS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM entity_map WHERE conflict_detected_at IS NOT NULL AND deleted = 0" 2>/dev/null || echo "0")
if [ "$CONFLICTS" -gt 0 ] 2>/dev/null; then
  MSG="$MSG, ⚠️ $CONFLICTS unresolved conflicts"
fi
```

**Step 2: Test manually** — verify hook output includes conflict count.

**Step 3: Commit**

```bash
git add hooks/session-status.sh
git commit -m "feat: show unresolved conflict count in session start hook"
```

---

## Task 10: Beads Sync Module

**Files:**
- Create: `server/src/sync/beads-sync.ts`
- Test: `server/tests/sync/beads-sync.test.ts`

**Step 1: Write the failing tests**

Create `server/tests/sync/beads-sync.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseBeadsOutput, diffBeadsState, mapBeadsToNotionProperties } from "../src/sync/beads-sync.js";

describe("parseBeadsOutput", () => {
  it("should parse bd list --format=json output", () => {
    const bdOutput = JSON.stringify([
      { id: "Test-abc", title: "Fix bug", status: "open", priority: 2, type: "bug" },
      { id: "Test-def", title: "Add feature", status: "in_progress", priority: 1, type: "feature" },
    ]);
    const issues = parseBeadsOutput(bdOutput);
    expect(issues).toHaveLength(2);
    expect(issues[0].id).toBe("Test-abc");
  });

  it("should return empty array on invalid JSON", () => {
    expect(parseBeadsOutput("not json")).toEqual([]);
    expect(parseBeadsOutput("")).toEqual([]);
  });
});

describe("diffBeadsState", () => {
  it("should detect new issues", () => {
    const prev = [{ id: "Test-abc", title: "Old", status: "open", priority: 2, type: "bug" }];
    const curr = [
      { id: "Test-abc", title: "Old", status: "open", priority: 2, type: "bug" },
      { id: "Test-def", title: "New", status: "open", priority: 1, type: "feature" },
    ];
    const diff = diffBeadsState(prev, curr);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].id).toBe("Test-def");
  });

  it("should detect modified issues", () => {
    const prev = [{ id: "Test-abc", title: "Fix bug", status: "open", priority: 2, type: "bug" }];
    const curr = [{ id: "Test-abc", title: "Fix bug", status: "in_progress", priority: 2, type: "bug" }];
    const diff = diffBeadsState(prev, curr);
    expect(diff.modified).toHaveLength(1);
  });

  it("should detect removed issues", () => {
    const prev = [{ id: "Test-abc", title: "Fix bug", status: "open", priority: 2, type: "bug" }];
    const diff = diffBeadsState(prev, []);
    expect(diff.removed).toHaveLength(1);
  });
});

describe("mapBeadsToNotionProperties", () => {
  it("should map beads fields to Notion property format", () => {
    const issue = { id: "Test-abc", title: "Fix bug", status: "open", priority: 2, type: "bug" };
    const props = mapBeadsToNotionProperties(issue);
    expect(props.Name.title[0].text.content).toBe("Fix bug");
    expect(props.Status.select.name).toBe("Open");
    expect(props.Priority.select.name).toBe("P2");
    expect(props.Type.select.name).toBe("Bug");
  });
});
```

**Step 2: Run test to verify failure**

Run: `cd server && npx vitest run tests/sync/beads-sync.test.ts`
Expected: FAIL — module not found

**Step 3: Implement beads sync module**

Create `server/src/sync/beads-sync.ts`. Use `execFileSync` (NOT `execSync`) for all bd CLI calls:

```typescript
import { execFileSync } from "child_process";
import { resolve } from "path";

export interface BeadsIssue {
  id: string;
  title: string;
  status: string;
  priority: number;
  type: string;
  assignee?: string;
  created?: string;
  updated?: string;
  notes?: string;
  dependencies?: string[];
}

export interface BeadsDiff {
  added: BeadsIssue[];
  modified: BeadsIssue[];
  removed: BeadsIssue[];
}

export function parseBeadsOutput(jsonOutput: string): BeadsIssue[] {
  try {
    const parsed = JSON.parse(jsonOutput);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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
    return [];
  }
}

export function diffBeadsState(previous: BeadsIssue[], current: BeadsIssue[]): BeadsDiff {
  const prevMap = new Map(previous.map((i) => [i.id, i]));
  const currMap = new Map(current.map((i) => [i.id, i]));

  const added = current.filter((i) => !prevMap.has(i.id));
  const removed = previous.filter((i) => !currMap.has(i.id));
  const modified = current.filter((i) => {
    const prev = prevMap.get(i.id);
    if (!prev) return false;
    return JSON.stringify(prev) !== JSON.stringify(i);
  });

  return { added, modified, removed };
}

const STATUS_MAP: Record<string, string> = {
  open: "Open",
  in_progress: "In Progress",
  closed: "Done",
  blocked: "Blocked",
};

const TYPE_MAP: Record<string, string> = {
  bug: "Bug",
  feature: "Feature",
  task: "Task",
  epic: "Epic",
};

export function mapBeadsToNotionProperties(issue: BeadsIssue): any {
  return {
    Name: { title: [{ text: { content: issue.title } }] },
    Status: { select: { name: STATUS_MAP[issue.status] || issue.status } },
    Priority: { select: { name: `P${issue.priority}` } },
    Type: { select: { name: TYPE_MAP[issue.type] || issue.type } },
    ...(issue.assignee
      ? { Assignee: { rich_text: [{ text: { content: issue.assignee } }] } }
      : {}),
    ...(issue.created ? { Created: { date: { start: issue.created } } } : {}),
    ...(issue.updated ? { "Last Updated": { date: { start: issue.updated } } } : {}),
  };
}

export function mapNotionToBeadsUpdate(properties: any): Partial<BeadsIssue> {
  const result: Partial<BeadsIssue> = {};

  const status = properties.Status?.select?.name;
  if (status) {
    const rev = Object.entries(STATUS_MAP).find(([, v]) => v === status);
    if (rev) result.status = rev[0];
  }

  const priority = properties.Priority?.select?.name;
  if (priority) {
    const match = priority.match(/P(\d)/);
    if (match) result.priority = parseInt(match[1]);
  }

  return result;
}

export function updateBeadsIssue(
  projectDir: string,
  issueId: string,
  updates: Partial<BeadsIssue>,
): void {
  const args = ["update", issueId];
  if (updates.status) args.push(`--status=${updates.status}`);
  if (updates.priority !== undefined) args.push(`--priority=${updates.priority}`);
  if (updates.title) args.push(`--title=${updates.title}`);

  if (args.length > 2) {
    execFileSync("bd", args, {
      cwd: resolve(projectDir),
      encoding: "utf-8",
      timeout: 10000,
    });
  }
}
```

**Step 4: Run tests**

Run: `cd server && npx vitest run tests/sync/beads-sync.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add server/src/sync/beads-sync.ts server/tests/sync/beads-sync.test.ts
git commit -m "feat: add beads sync module with diff detection and Notion property mapping"
```

---

## Task 11: Beads Sync Integration in Engine + Issues Tool

**Files:**
- Modify: `server/src/sync/engine.ts` (add `pollBeadsChanges`, beads push/pull handling)
- Create: `server/src/daemon/tools/issues.ts` (interkasten_list_issues tool)
- Modify: `server/src/index.ts` (register issues tools, add beads poll interval)

**Step 1: Add beads polling to engine**

In `SyncEngine`, add `pollBeadsChanges()` that calls `fetchBeadsIssues` for each project, diffs against last known state, and enqueues push operations for changes.

**Step 2: Create issues tool**

Create `server/src/daemon/tools/issues.ts` with `interkasten_list_issues` tool that returns synced issues with beads ID + Notion page ID.

**Step 3: Wire beads poll into index.ts**

Add a separate interval (or piggyback on the Notion poll interval) that calls `engine.pollBeadsChanges()`.

**Step 4: Run all tests**

Run: `cd server && npx vitest run`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add server/src/sync/engine.ts server/src/daemon/tools/issues.ts server/src/index.ts
git commit -m "feat: integrate beads-to-Notion issue sync with polling and MCP tool"
```

---

## Task 12: Soft-Delete Safety

**Files:**
- Modify: `server/src/sync/engine.ts` (handle `file_removed` events)
- Test: `server/tests/sync/soft-delete.test.ts`

**Step 1: Write failing tests**

```typescript
describe("soft delete", () => {
  it("should soft-delete entity when local file removed", () => {
    // Setup entity, simulate file_removed event
    // Assert: entity.deleted = true, deletedAt set
  });

  it("should mark Notion page as Source Deleted", () => {
    // Assert: Notion API called with Status = "⚠️ Source Deleted"
  });

  it("should gc entities deleted >7 days ago", () => {
    // Setup old soft-deleted entity, run gcDeletedEntities
    // Assert: entity hard-deleted
  });

  it("should not delete local file when Notion page archived", () => {
    // Setup entity, simulate Notion returning 404/archived
    // Assert: local file still exists, entity soft-deleted
  });
});
```

**Step 2: Implement file_removed handling in processPushOperation**

When `op.type === "file_removed"`: soft-delete entity, update Notion page status to `⚠️ Source Deleted`, log.

**Step 3: Implement Notion-side deletion detection in pollNotionChanges**

When polling detects a page is archived: soft-delete entity, log warning, don't touch local file.

**Step 4: Add GC sweep**

Add a periodic `gcDeletedEntities(db, new Date(Date.now() - 7 * 86400000))` call (daily or on each poll cycle).

**Step 5: Test, commit**

```bash
git commit -m "feat: add soft-delete safety for local and Notion-side deletions"
```

---

## Task 13: Linked References (T2 Summary Cards)

**Files:**
- Create: `server/src/sync/linked-refs.ts`
- Test: `server/tests/sync/linked-refs.test.ts`

**Step 1: Write failing tests**

```typescript
describe("linked references", () => {
  it("should generate summary card properties for a local file", () => {
    // Input: file path, stat info
    // Expected: Notion properties with title, path, lastModified, lineCount
  });
});
```

**Step 2: Implement**

T2 files get a Notion page with: title (filename), Path (rich_text), Last Modified (date), Line Count (number). Page body is empty (or single line: "View locally at {path}").

**Step 3: Integrate into push sync**

When pushing a T2 entity, use linked-refs format instead of full content sync.

**Step 4: Test, commit**

```bash
git commit -m "feat: add T2 linked reference summary cards in Notion"
```

---

## Task 14: Integration Tests

**Files:**
- Create: `server/tests/integration/sync-integration.test.ts`

Gated behind `INTERKASTEN_TEST_TOKEN`. Tests real Notion API.

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_TOKEN = process.env.INTERKASTEN_TEST_TOKEN;

describe.skipIf(!TEST_TOKEN)("integration: bidirectional sync", () => {
  it("should push a local doc and pull it back unchanged", async () => { /* ... */ });
  it("should detect Notion-side edit and pull to local", async () => { /* ... */ });
  it("should merge non-overlapping changes", async () => { /* ... */ });
  it("should apply local-wins on overlapping conflict", async () => { /* ... */ });
  it("should sync a beads issue to Notion", async () => { /* ... */ });
  it("should soft-delete when local file removed", async () => { /* ... */ });
});
```

**Step 1-5: Implement, test, commit**

```bash
git commit -m "test: add integration tests for bidirectional sync"
```

---

## Task 15: Update Documentation

**Files:**
- Modify: `CLAUDE.md` — add new tools to MCP tools table, update architecture description
- Modify: `docs/vision.md` — update to reflect bidirectional sync capability
- Modify: `docs/roadmap.md` — mark v0.4.x features as shipped, add v0.5.x (webhooks)

**Step 1: Update CLAUDE.md**

Add to MCP tools table: `interkasten_conflicts`, `interkasten_list_issues`. Update sync tool description to mention pull direction. Update architecture section to describe polling + merge.

**Step 2: Update vision.md**

Change "push sync" references to "bidirectional sync." Add section on conflict resolution.

**Step 3: Update roadmap.md**

Move v0.3.x items to "What's Working." Add v0.4.x (this iteration) as current. Add v0.5.x (webhooks + cloudflared).

**Step 4: Commit**

```bash
git add CLAUDE.md docs/vision.md docs/roadmap.md
git commit -m "docs: update vision, roadmap, and CLAUDE.md for bidirectional sync"
```

---

## Summary

| Task | Feature | New Files | Modified Files |
|------|---------|-----------|----------------|
| 1 | Schema | — | db.ts, entities.test.ts |
| 2 | Store | — | entities.ts, entities.test.ts |
| 3 | Deps | — | package.json |
| 4 | Merge | merge.ts, merge.test.ts | — |
| 5 | Poller | notion-poller.ts, notion-poller.test.ts | — |
| 6 | Pull | engine-pull.test.ts | engine.ts, index.ts |
| 7 | Merge | engine-merge.test.ts | engine.ts |
| 8 | Tools | — | tools/sync.ts |
| 9 | Hook | — | session-status.sh |
| 10 | Beads | beads-sync.ts, beads-sync.test.ts | — |
| 11 | Beads | tools/issues.ts | engine.ts, index.ts |
| 12 | Delete | soft-delete.test.ts | engine.ts, entities.ts |
| 13 | T2 | linked-refs.ts, linked-refs.test.ts | — |
| 14 | Tests | sync-integration.test.ts | — |
| 15 | Docs | — | CLAUDE.md, vision.md, roadmap.md |

**Dependency chain:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Tasks 10-11 (beads) are independent of 4-9 (merge) and can run in parallel after Task 2. Tasks 12-15 depend on 6+7 being complete.

**Parallelizable groups (revised after flux-drive review):**
- Group A (Tasks 1-2): Schema → store (serial, fast)
- Group B (Tasks 3-5, 10): Deps + merge + poller + beads module (parallel after Task 2)
- Group C (Tasks 6-9): Pull → conflict → tools → hook (serial after Group B)
- Group D (Tasks 11-15): Beads integration + polish (after Groups B+C)

---

## Flux-Drive Plan Review Findings (2026-02-16)

Review reports saved to `docs/research/review-plan-{architecture,correctness,safety,quality}.md`.

### BLOCKERS (must address during implementation)

| # | Finding | Fix |
|---|---------|-----|
| B1 | **Optimistic locking not implemented** — `handleConflict` must verify base hasn't changed between read and write | Task 7: Add `getBaseContent` check before merge write; abort + re-enqueue if stale |
| B2 | **Beads state storage missing** — no `beads_snapshot` table means every poll treats all issues as new | Task 1: Add `beads_snapshot(project_id TEXT, snapshot_json TEXT, updated_at TEXT)` table. Task 11: Persist snapshot after diff |
| B3 | **Path validation coded in tests but not in `executePull`** — spec says "preserving frontmatter" but doesn't show path check | Task 6: `executePull` MUST include `resolve() + startsWith(projectDir + '/')` check before any `writeFileSync`. Reject + log on failure |

### HIGH Priority (address during implementation)

| # | Finding | Fix |
|---|---------|-----|
| H1 | Poll overlap — no `pollInProgress` guard | Task 6: Add `let pollInProgress = false` guard in `setInterval` callback |
| H2 | `execFileSync` blocks event loop 10s | Task 10: Use `promisify(execFile)` (async) instead of `execFileSync` |
| H3 | Untracked Notion pages crash pull | Task 6: `processPullOperation` must skip + log when `getEntityByNotionId` returns undefined |
| H4 | Engine.ts god object (318→650 LOC) | Task 7: Extract `ConflictResolver` class to `sync/conflict-resolver.ts` |
| H5 | `any` types in Tasks 2, 5, 7 | Add `ConflictEntity` interface (Task 2), `QueryDatabaseResponse` import (Task 5), `EntityMap` type (Task 7) |
| H6 | GC retention 7d too aggressive | Task 12: Change to 30 days, run daily not per-poll |

### MEDIUM Priority (fix during implementation or follow-up)

| # | Finding | Fix |
|---|---------|-----|
| M1 | Merge fallback semantics confusing | Task 4: `threeWayMerge` always returns conflicts; resolution moves to ConflictResolver |
| M2 | Frontmatter preservation race | Task 6: Pre-write hash check in `executePull` |
| M3 | Merge + push not atomic | Task 7: Enqueue push via queue instead of immediate `pushUpdate` call |
| M4 | Config schema missing `conflict_strategy`/`poll_interval` | Add config schema update to Task 3 |
| M5 | Beads input sanitization | Task 10: Sanitize Notion property values before passing to `bd` CLI args |
| M6 | `.conflict` file accumulation | Task 8: Add watcher ignore pattern for `.conflict` files |
| M7 | `diff-match-patch-es` possibly unused | Task 3: Verify usage; remove if not needed |
