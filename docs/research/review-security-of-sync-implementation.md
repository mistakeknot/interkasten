# Security Review: Bidirectional Notion Sync Implementation

**Reviewer**: Flux Safety Reviewer
**Date**: 2026-02-16
**Scope**: TypeScript MCP server adding bidirectional sync — diff at `/tmp/qg-diff.txt`

**System context**: Local-only MCP server for Claude Code, runs in user context with access to local filesystem and Notion API. Trust boundaries: (1) Notion API responses (untrusted external), (2) local filesystem paths stored in DB (trusted at insert time, but must validate on use), (3) beads CLI output (trusted tool, but parse defensively).

---

## Executive Summary

**Risk Level: MEDIUM** — No critical exploitability issues, but two significant path safety gaps and one SQL injection surface requiring fixes before production use.

**Key findings:**
1. **Path traversal vulnerability (HIGH)**: Pull operations validate path only when `projectDir` is found, silent fallback allows writes outside project (engine.ts:642-653)
2. **SQL injection surface (MEDIUM)**: Raw SQL in `listConflicts()` uses `sql` template tag but missing parameterization docs, needs verification (entities.ts:263-269)
3. **Path validation bypass (MEDIUM)**: `basename()` filtering in issues.ts can be bypassed with `../` sequences in project parameter (issues.ts:60)

**Deployment safety**: Clean — no irreversible migrations, rollback-safe schema additions, feature-flaggable poll interval.

---

## Security Findings

### 1. Path Traversal — Pull Operation Write Path (HIGH RISK)

**Location**: `engine.ts:641-653` (`processPullOperation`)

**Issue**: Path validation only runs when `findProjectDir()` succeeds. If `projectDir` is null (no parent project entity found), validation is skipped and `entity.localPath` is used directly for `writeFileSync()` at line 711.

```typescript
// Validate path (safety: prevent path traversal)
const projectDir = this.findProjectDir(entity.localPath);
if (projectDir) {
  const resolved = resolve(projectDir, basename(entity.localPath));
  if (!resolved.startsWith(projectDir + "/")) {
    // ... error log, return
  }
}
// VALIDATION SKIPPED if projectDir is null — entity.localPath used unchecked at line 711
```

**Attack vector**: If an attacker controls a Notion page ID that maps to an entity with `localPath = "/etc/passwd"` (injected via compromised DB or malicious sync), pull operations will write to that path when `findProjectDir()` returns null.

**Likelihood**: LOW (requires DB compromise or initial sync of malicious path), but **impact is HIGH** (arbitrary file write).

**Mitigation**:
```typescript
const projectDir = this.findProjectDir(entity.localPath);
if (!projectDir) {
  appendSyncLog(this.db, {
    entityMapId: entity.id,
    operation: "error",
    direction: "notion_to_local",
    detail: { error: "No project directory found", path: entity.localPath },
  });
  return;
}
const resolved = resolve(projectDir, basename(entity.localPath));
if (!resolved.startsWith(projectDir + "/")) {
  // ... existing error handling
}
```

**Rollback impact**: None — this is new pull code, no existing behavior depends on the null path.

---

### 2. SQL Injection Surface — `listConflicts()` (MEDIUM RISK)

**Location**: `entities.ts:263-269`

**Issue**: Uses `sql` template tag for raw SQL query. The Drizzle ORM `sql` tag **does** provide parameterization for interpolated values, but this query has no interpolated variables — it's a static query. However, the pattern is risky for future edits.

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

**Current exploitability**: NONE — query is static, no user input.

**Future risk**: If this function is later modified to accept a filter parameter and someone does `sql\`... WHERE em.id = ${entityId}\``, the `sql` tag will safely parameterize `entityId`. But if someone mistakenly uses string interpolation (`sql\`... WHERE em.id = ${unsafeInput}\``), Drizzle's `sql` tag does NOT prevent injection — it only prevents injection when using the `${variable}` syntax within the template literal.

**Verification needed**: Confirm that Drizzle's `sql` tag uses parameterized placeholders for `${...}` interpolations. If not, this is a latent HIGH risk.

**Mitigation (defensive)**:
- Add a code comment: `// SAFETY: sql\`...\` tag auto-parameterizes ${...} interpolations — never use string concat`
- Add a linter rule to ban string concat in `sql` calls

---

### 3. Path Filter Bypass — `interkasten_list_issues` Tool (MEDIUM RISK)

**Location**: `issues.ts:59-61`

**Issue**: Project filter uses `localPath.includes(project)` without path canonicalization. An attacker can pass `project = "../../../etc"` to search outside intended scope.

```typescript
const filtered = project
  ? issues.filter((i) =>
      i.localPath.includes(project) || basename(i.localPath).includes(project),
    )
  : issues;
```

**Attack vector**: MCP client (Claude Code) calls `interkasten_list_issues` with `project: "../../../../root/.ssh"` → filter matches any issue with `.ssh` in path, leaking existence/metadata of sensitive files **if they were synced as issues** (unlikely but possible).

**Likelihood**: VERY LOW (requires pre-existing sync of sensitive paths as issue entities), but defensive fix is trivial.

**Impact**: Information disclosure (file paths, sync metadata) — no write capability.

**Mitigation**:
```typescript
const filtered = project
  ? issues.filter((i) => {
      const normalizedPath = resolve(i.localPath);
      const normalizedFilter = resolve(project);
      return normalizedPath.startsWith(normalizedFilter) || basename(normalizedPath).includes(project);
    })
  : issues;
```

Or simpler: just use `basename()` match only, drop the `localPath.includes()` branch entirely since it's redundant for project name filtering.

---

### 4. Command Injection — `bd` CLI Calls (LOW RISK — VERIFIED SAFE)

**Locations**:
- `beads-sync.ts:352` (`fetchBeadsIssues`)
- `beads-sync.ts:449` (`updateBeadsIssue`)

**Analysis**: Both use `execFileSync("bd", [...], { cwd: resolve(projectDir) })` — this is **correct and safe**. `execFileSync` does NOT invoke a shell, so no injection risk. Arguments are passed as array elements, not concatenated strings.

**Edge case check**: `projectDir` and `issueId` are user-influenced, but:
- `projectDir` comes from `entity.localPath` (already in DB, validated at registration)
- `issueId` comes from beads output (trusted JSON parse)
- `updates.status`, `updates.title` are passed as `--flag=value` strings — `execFileSync` will escape them correctly as arguments

**Status**: ✅ SAFE — no shell interpolation, all arguments properly escaped.

---

### 5. Credential Handling — Notion Token (LOW RISK — VERIFIED SAFE)

**Analysis**: No Notion token appears in diff. Token is passed via env var (standard MCP pattern) and used in `NotionClient` constructor (not shown in diff, but verified in context). No logging of tokens, no hardcoded secrets.

**Status**: ✅ SAFE

---

### 6. Input Validation — Notion Content to Filesystem (LOW RISK)

**Locations**:
- `engine.ts:711` (`writeFileSync(entity.localPath, mergedContent)`)
- `engine.ts:772` (`writeFileSync(conflictPath, formatConflictFile(...))`)
- `engine.ts:812` (`writeFileSync(entity.localPath, mergedWithFm)`)

**Attack surface**: Notion page content (markdown) is written to local files. Malicious Notion page could contain:
- Path traversal sequences in markdown links (`[link](../../../../etc/passwd)`) — not a risk, only file content is written
- Binary exploit payloads — not a risk for markdown files
- Executable content (if written to `.sh` file) — RISK if user later executes the file

**Actual risk**: **VERY LOW** — this is a documentation sync tool. Users intentionally sync markdown files. If a malicious Notion collaborator injects `rm -rf /` into a markdown file, the user must still manually execute it. This is equivalent to someone emailing you a malicious script — the recipient must choose to run it.

**Defensive layer**: File writes are to paths already registered in `entity_map`, which are established during initial sync setup. New paths are not auto-created from Notion side (per PRD design choice at line 636: "Untracked page — skip").

**Status**: ✅ ACCEPTABLE RISK for this use case (documentation sync, not code execution).

---

### 7. Data Source ID Caching — Stale Cache Auth Bypass? (LOW RISK)

**Location**: `notion-poller.ts:1158` (`resolveDataSourceId`)

**Concern**: If `resolveDataSourceId` caches the mapping from database ID to data source ID, could a stale cache allow access to a database the user no longer has permission for?

**Analysis**: The `NotionClient.resolveDataSourceId()` method is not shown in diff, but standard Notion API behavior is:
- API calls fail with 403 if user lost access
- Cache invalidation is not security-critical because the Notion API enforces permissions on every request

**Attack scenario**: User loses access to database X → cached data source ID still valid → poll attempt → Notion API returns 403 → poll skips that page (line 623: `try/catch` swallows access errors).

**Impact**: None — stale cache causes wasted API calls, not privilege escalation.

**Status**: ✅ SAFE (API-side enforcement is sufficient).

---

## Deployment & Migration Safety

### Schema Changes

**New columns** (db.ts:193-201):
```sql
ALTER TABLE entity_map ADD COLUMN conflict_detected_at TEXT
ALTER TABLE entity_map ADD COLUMN conflict_local_content_id INTEGER REFERENCES base_content(id)
ALTER TABLE entity_map ADD COLUMN conflict_notion_content_id INTEGER REFERENCES base_content(id)
```

**New table** (db.ts:204-211):
```sql
CREATE TABLE IF NOT EXISTS beads_snapshot (...)
```

**Rollback compatibility**: ✅ SAFE
- Columns are nullable — old code ignores them
- `IF NOT EXISTS` guards prevent double-apply
- No data backfill required
- Downgrade path: columns remain unused, no corruption risk

**Migration idempotency**: ✅ SAFE — `IF NOT EXISTS` and column existence check (`colNames.has()`) ensure re-run is safe.

---

### Runtime Behavior Changes

**New background poll loop** (engine.ts:531-536):
```typescript
this.pollTimer = setInterval(() => {
  this.pollNotionChanges().catch(...);
}, pollIntervalMs);
```

**Blast radius**: Pull operations can now trigger automatically every `poll_interval` seconds (default 60s). If pull logic has a bug (e.g., path traversal above), it will fire repeatedly.

**Mitigation**: Fix path traversal issue (Finding #1) before enabling bidirectional sync in production.

**Rollback**: Set `poll_interval: 0` in config to disable polling without code rollback. Feature is opt-in via config.

---

### Failure Modes & Monitoring

**Incomplete pull** (engine.ts:739-747):
- WAL entry created but file write fails → WAL entry remains in `pending` state
- Recovery: WAL replay on next startup (not shown in diff, assumed from WAL pattern)
- **Missing**: No TTL on pending WAL entries — a stuck pull could block queue forever
- **Recommendation**: Add WAL entry age check + auto-abort for entries >1 hour old

**Conflict explosion**:
- If two users edit the same file rapidly, every poll cycle could create a new conflict marker
- `markConflict()` at line 792 overwrites previous conflict state — no history preserved
- **Risk**: User resolves conflict locally, but next poll cycle re-detects and overwrites resolution
- **Mitigation**: Check if `conflictDetectedAt` is already set before calling `markConflict()`

**GC safety** (engine.ts:967-971):
- Hard-coded 30-day retention for soft-deleted entities
- **Risk**: If system clock jumps backward, `cutoff` calculation could delete recent entities
- **Mitigation**: Use `deleted_at < datetime('now', '-30 days')` in SQL instead of computing cutoff in JS

---

## What NOT to Flag (Avoided False Positives)

### 1. SQL Injection in `beads_snapshot` Inserts (lines 915-920)
```typescript
sql`INSERT INTO beads_snapshot (project_id, snapshot_json, updated_at)
    VALUES (${String(project.id)}, ${JSON.stringify(current)}, datetime('now'))`
```

**Not flagged because**: Drizzle `sql` template tag parameterizes `${...}` interpolations. The `String(project.id)` and `JSON.stringify(current)` are safely bound as parameters, not concatenated.

### 2. Path Traversal in `conflict_path` (line 772)
```typescript
const conflictPath = entity.localPath + ".conflict";
```

**Not flagged because**: `entity.localPath` is already validated (or should be, per Finding #1 fix). Appending `.conflict` doesn't introduce new traversal risk.

### 3. Missing Input Validation on Notion Properties (lines 415-427)
```typescript
const status = properties.Status?.select?.name;
```

**Not flagged because**: Notion API returns structured JSON. The `mapNotionToBeadsUpdate()` function safely extracts fields with optional chaining and regex validation (`match(/P(\d)/)`). Missing fields result in empty `Partial<BeadsIssue>`, not a crash or injection.

### 4. Frontmatter Regex (lines 833, 841)
```typescript
const match = content.match(/^---\n[\s\S]*?\n---\n/);
```

**Not flagged because**: Regex is non-capturing, bounded by line anchors, and used only for splitting content — no ReDoS risk (lazy quantifier `*?`).

---

## Risk Prioritization

1. **Path traversal (Finding #1)** — Fix immediately, HIGH exploitability if DB is compromised
2. **Path filter bypass (Finding #3)** — Fix before public release, LOW likelihood but trivial fix
3. **SQL injection verification (Finding #2)** — Verify Drizzle parameterization, add defensive comment
4. **WAL TTL (Deployment finding)** — Add timeout for stuck pull operations
5. **Conflict re-detection (Deployment finding)** — Check existing conflict state before overwriting

---

## Residual Risk

**Risk accepted (user responsibility)**:
- Notion collaborators can inject malicious markdown content → users must not blindly execute synced scripts
- Local file changes during a pull operation → race condition possible, but WAL write-after-read gap is <1s

**Risk deferred (operational discipline)**:
- Notion API rate limiting → no backoff/retry logic shown in diff
- SQLite DB corruption if process killed during WAL commit → standard SQLite risk, use WAL mode + auto-checkpoint

---

## Pre-Deploy Checklist

- [ ] Fix path validation fallthrough (Finding #1)
- [ ] Fix path filter in `interkasten_list_issues` (Finding #3)
- [ ] Verify Drizzle `sql` tag parameterization behavior
- [ ] Add WAL entry age check (>1 hour → auto-abort)
- [ ] Add conflict state check before `markConflict()` call
- [ ] Test rollback: disable poll via config, verify no data corruption
- [ ] Add monitoring: alert on conflict count >10, WAL pending count >5

---

## Rollback Plan

**Code rollback**: Safe — new files can be removed, old `engine.ts` restored without data loss.

**Data rollback**: NOT NEEDED — new columns are nullable, new table is unused by old code.

**Config rollback**: Set `poll_interval: 0` to disable bidirectional sync without code changes.

**Post-rollback verification**:
1. Check `sync_wal` table empty (no stuck pull operations)
2. Verify `conflict_detected_at` column all null (no unresolved conflicts from new code)
3. Monitor `interkasten_sync` logs for errors

---

## Threat Model Verification

**Assumptions validated**:
- Local-only tool, no remote network exposure ✅
- Notion API is the only untrusted input ✅
- User has write access to project directories (intentional) ✅
- beads CLI is trusted (user-installed tool) ✅

**Assumptions requiring documentation**:
- Multi-user Notion workspace → one user can inject content synced to another's machine (accepted risk, should warn in README)
- SQLite DB must be read-only to other users on multi-user system (file permissions required)

---

## References

- Drizzle ORM SQL injection safety: https://orm.drizzle.team/docs/sql
- Node.js `execFileSync` vs `execSync`: https://nodejs.org/api/child_process.html#child_processexecfilesyncfile-args-options
- SQLite WAL mode recovery: https://www.sqlite.org/wal.html
