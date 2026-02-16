# Safety Review: Bidirectional Notion Sync Implementation Plan

**Plan:** `/root/projects/Interverse/plugins/interkasten/docs/plans/2026-02-15-bidirectional-sync.md`
**Review Date:** 2026-02-16
**Reviewer:** Flux-Drive Safety Reviewer
**Threat Model:** Local network-facing MCP server, untrusted input from Notion API, trusted input from local filesystem

---

## Executive Summary

**Overall Risk:** Medium
**Go/No-Go Decision Gates Required:** 2
**Irreversible Operations:** 1 (Task 12 hard-delete GC)
**Key Mitigations:** 4 high-priority, 7 medium-priority

### High-Risk Findings

1. **Path traversal defense incomplete** (Task 6) — test exists but implementation spec is vague
2. **Soft-delete GC lacks safeguards** (Task 12) — 7-day timer is arbitrary, no confirmation flow
3. **Conflict file writes unbounded** (Task 7) — `.conflict` files accumulate with no cleanup policy
4. **Beads command injection surface** (Task 10) — `execFileSync` args not validated

### Medium-Risk Findings

1. Three-way merge performance unbounded (memory risk on large docs)
2. Notion poll interval lacks backoff on repeated failures
3. Missing rollback plan for schema migrations
4. No validation of Notion property structure before SQL insert
5. Soft-delete markers can be weaponized for DoS
6. No monitoring/alerting for conflict accumulation
7. Integration tests require live Notion token (credential exposure risk in CI)

---

## Security Review

### Trust Boundaries

**External untrusted sources:**
- Notion API responses (page content, property values, titles, timestamps)
- User-editable Notion pages (can contain malicious markdown, path traversal attempts in titles)

**Trusted sources:**
- Local filesystem (files within `projects_dir`)
- SQLite database (entity_map, base_content, sync_log)
- `bd` CLI output (assumed trusted — runs locally)

**Entry points for untrusted input:**
1. `NotionPoller.pollDatabase()` → page titles, lastEdited timestamps
2. `processPullOperation()` → Notion page content (markdown)
3. `handleConflict()` → Notion content in merge
4. Beads sync (Task 11) → Notion property values mapped to `bd` commands

---

## Finding 1: Path Traversal — Incomplete Defense (HIGH)

**Location:** Task 6, lines 626-646
**Risk:** Notion page titles or local_path mappings could escape project directory

### Current State

Plan includes unit tests for path validation:
```typescript
const resolved = resolve(projectDir, malicious);
expect(resolved.startsWith(projectDir)).toBe(false);
```

**Problem:** Test demonstrates the check, but implementation spec (lines 678-688) does NOT explicitly require this check in `executePull()` or `processPullOperation()`.

### Attack Vector

1. Attacker edits Notion page title to `../../../etc/cron.d/evil`
2. Pull sync fetches page, uses title as filename
3. `executePull()` writes content to resolved path
4. If `resolve(projectDir, title)` is used WITHOUT `startsWith(projectDir)` check → arbitrary file write

### Exploitability

- **Likelihood:** Medium — requires attacker to control Notion page title (trivial if integration has shared pages)
- **Impact:** High — arbitrary file write outside project sandbox
- **Blast radius:** Single project directory initially, but can write to `.git/hooks`, cron dirs, SSH authorized_keys if uid matches

### Mitigation (REQUIRED)

**Code change:**
In `executePull()` and any function that writes pulled content:

```typescript
private validatePathWithinProject(projectDir: string, localPath: string): boolean {
  const resolved = resolve(projectDir, localPath);
  // Must be strict prefix (not equal, to prevent /root/projects/../evil)
  return resolved.startsWith(projectDir + '/') || resolved === projectDir;
}

// Before writeFileSync:
if (!this.validatePathWithinProject(projectRoot, targetPath)) {
  throw new Error(`Path traversal blocked: ${targetPath}`);
}
```

**Additional safeguards:**
- Sanitize Notion page titles before using as filenames: strip `../`, leading `/`, null bytes
- Log all path validation failures for monitoring
- Add integration test with malicious title to verify block

**Decision gate:** Do NOT proceed with Task 6 implementation until path validation is explicitly added to spec.

---

## Finding 2: Soft-Delete GC — Irreversible Data Loss (HIGH)

**Location:** Task 12, lines 1220-1223
**Risk:** 7-day auto-delete can destroy recoverable data without user confirmation

### Current State

Plan specifies:
```typescript
gcDeletedEntities(db, new Date(Date.now() - 7 * 86400000))
```

Runs on "daily or on each poll cycle" — spec is ambiguous.

### Problems

1. **No user confirmation** — silent hard-delete of entity mappings
2. **7 days is arbitrary** — no justification for threshold
3. **No Notion-side coordination** — entity deleted locally, but Notion page may still be "⚠️ Source Deleted" (orphaned state)
4. **No dry-run mode** — cannot preview what will be deleted
5. **Trigger timing unclear** — "daily or on each poll cycle" could mean 60s interval (aggressive)

### Attack Vector (Operational, not security)

1. User accidentally deletes local file
2. Sync marks entity soft-deleted, updates Notion status
3. User notices within hours, expects to restore from Notion
4. 7 days pass before user checks Notion
5. GC hard-deletes entity mapping
6. User can no longer sync the file (mapping lost, must re-register)

This is not a data loss issue (Notion page still exists), but **operational trust violation** — users expect longer retention for "deleted" items.

### Mitigation (REQUIRED)

**Immediate:**
- Increase retention to 30 days minimum (matches Notion's trash retention)
- Run GC daily at most, NOT on every poll cycle
- Add `--dry-run` flag to preview GC sweep

**Future (v0.5):**
- Expose `interkasten_gc` MCP tool so user can trigger manually
- Add config setting for retention period
- Log GC sweeps to sync_log for audit trail
- Before hard-delete, check if Notion page is in trash → if not, warn and skip

**Decision gate:** Task 12 GC implementation must include dry-run mode and 30-day retention before merge.

---

## Finding 3: Beads Command Injection Surface (HIGH)

**Location:** Task 10, lines 1114-1131
**Risk:** Notion property values passed to `bd` CLI without validation

### Current State

Plan uses `execFileSync("bd", args, ...)` which prevents shell injection, but args are constructed from Notion data:

```typescript
if (updates.status) args.push(`--status=${updates.status}`);
if (updates.title) args.push(`--title=${updates.title}`);
```

### Attack Vector

1. Attacker edits Notion issue Status property to include shell metacharacters: `in_progress; rm -rf /`
2. `mapNotionToBeadsUpdate()` extracts status string
3. `updateBeadsIssue()` constructs: `["update", "Test-abc", "--status=in_progress; rm -rf /"]`
4. `execFileSync` passes this to `bd` as a single argument
5. **If `bd` CLI itself uses `sh -c` internally** → command injection

### Exploitability

- **Likelihood:** Low — requires `bd` to have shell-exec vulnerability (not confirmed)
- **Impact:** High if exploitable — arbitrary command execution in project context
- **Blast radius:** Project directory + filesystem permissions of `bd` process

### Current Defense

Using `execFileSync` instead of `execSync` prevents direct shell interpretation by Node. Args are passed as array, not concatenated string.

### Residual Risk

1. `bd` CLI may internally exec shell commands with user input
2. No validation of Notion property values before CLI call
3. Injection via `--title` flag if `bd` doesn't escape properly

### Mitigation (MEDIUM priority, defense-in-depth)

**Add input validation in `mapNotionToBeadsUpdate()`:**

```typescript
function sanitizeBeadsValue(value: string): string {
  // Allow only alphanumeric, space, dash, underscore
  return value.replace(/[^a-zA-Z0-9 _-]/g, '');
}

export function mapNotionToBeadsUpdate(properties: any): Partial<BeadsIssue> {
  const result: Partial<BeadsIssue> = {};

  const status = properties.Status?.select?.name;
  if (status) {
    const rev = Object.entries(STATUS_MAP).find(([, v]) => v === status);
    if (rev) result.status = sanitizeBeadsValue(rev[0]); // ← sanitize here
  }
  // ... same for title, assignee
}
```

**Add integration test:**
Create Notion issue with `Status = "open; echo hacked"` and verify `bd` receives sanitized value.

---

## Finding 4: Conflict File Accumulation — No Cleanup (MEDIUM)

**Location:** Task 7, lines 792-801
**Risk:** `.conflict` files accumulate unbounded, clutter project directory

### Current State

When `conflict_strategy = "conflict-file"`, writes `localPath + ".conflict"` and marks conflict in DB.

**Missing:**
- No automatic cleanup of `.conflict` files after user resolves
- No warning if conflict count exceeds threshold
- `.conflict` files not ignored by watcher → could trigger new sync events

### Mitigation

1. **Add `.conflict` to watcher ignore patterns** (config default)
2. **Add MCP tool `interkasten_resolve_conflict(entityId, resolution: "local"|"notion")`:**
   - Deletes `.conflict` file
   - Clears conflict state in DB
   - Writes resolved content to local file
   - Triggers push sync
3. **Session hook warns if conflicts exceed 10**

---

## Finding 5: Missing Schema Migration Rollback Plan (MEDIUM)

**Location:** Task 1, lines 48-56
**Risk:** Failed migration leaves DB in broken state, no recovery path

### Current State

Plan adds columns via `ALTER TABLE` with conditional check. No rollback mechanism.

### Scenarios

1. Migration runs, adds columns, then process crashes before tests pass → columns exist but code doesn't use them
2. User downgrades plugin version → old code sees extra columns, may fail queries

### Mitigation

**Pre-deploy check:**
```typescript
const REQUIRED_SCHEMA_VERSION = 4;

function validateSchema(sqlite: Database.Database): void {
  const userVersion = sqlite.pragma('user_version', { simple: true }) as number;
  if (userVersion < REQUIRED_SCHEMA_VERSION) {
    throw new Error(`Schema migration required. Run: interkasten migrate`);
  }
}
```

**Add `PRAGMA user_version = 4` after Task 1 migration.**

**Rollback plan:**
- Document that downgrading plugin requires manual `ALTER TABLE ... DROP COLUMN` (SQLite limitation)
- Add `interkasten_schema_info` MCP tool to show current version

---

## Finding 6: Three-Way Merge Memory Unbounded (MEDIUM)

**Location:** Task 4, lines 352-397
**Risk:** Large Notion pages (100k+ lines) cause OOM during merge

### Current State

`node-diff3` operates on line arrays in memory. No size limit.

### Attack Vector

1. User syncs a 10MB markdown file (e.g., exported SQL dump)
2. Notion API returns 10MB content
3. Pull triggers merge → `split("\n")` creates 200k element array × 3 versions = 600k strings in memory
4. Merge algorithm is O(n²) worst-case → minutes of CPU, GBs of RAM
5. Node process OOMs, MCP server crashes

### Mitigation

**Add size guard in `threeWayMerge()`:**

```typescript
const MAX_MERGE_SIZE = 1_000_000; // 1MB per version

export function threeWayMerge(...) {
  if (base.length > MAX_MERGE_SIZE || local.length > MAX_MERGE_SIZE || remote.length > MAX_MERGE_SIZE) {
    return {
      merged: local, // fallback to local-wins
      hasConflicts: true,
      conflicts: [{
        baseStart: 0, baseEnd: 0,
        localContent: "File too large for automatic merge",
        remoteContent: "Use conflict-file strategy"
      }]
    };
  }
  // ... existing logic
}
```

**Add config setting:**
```yaml
sync:
  max_merge_size_bytes: 1000000
```

---

## Deployment Review

### Rollout Strategy

**Current plan:** None specified. Assumes direct merge to main, single-step deploy.

**Recommended:**

1. **Feature flag for pull sync** (Task 6-7):
   ```yaml
   sync:
     pull_enabled: false  # default off for v0.4.0
   ```
   - Users opt-in via config
   - Allows push-only users to continue working
   - Reduces blast radius of pull bugs

2. **Staged enablement:**
   - Week 1: Push-only (existing flow)
   - Week 2: Pull enabled for maintainer testing (single project)
   - Week 3: Pull enabled by default, conflict-file strategy
   - Week 4: Enable three-way-merge by default

3. **Monitoring triggers:**
   - Alert if conflict count > 10 per project
   - Alert if poll failures > 5 consecutive
   - Alert if merge duration > 5 seconds

### Pre-Deploy Checks (REQUIRED)

| Check | Pass Criteria | How to Verify |
|-------|---------------|---------------|
| Path traversal block | Malicious title rejected | Integration test with `../../../etc/passwd` |
| SQL injection immunity | All queries parameterized | `grep -r "prepare.*+" server/src` returns 0 |
| execFileSync only | No shell=true calls | `grep -r "exec\(" server/src \| grep -v execFile` returns 0 |
| Conflict accumulation | Hook warns at 10+ | Manual test: create 11 conflicts |
| Schema migration idempotent | Re-run migration succeeds | `npm test` after 2× migration |

### Rollback Feasibility

| Component | Rollback Method | Data Impact | Time to Rollback |
|-----------|----------------|-------------|------------------|
| Schema (Task 1-2) | **IRREVERSIBLE** — SQLite ALTER TABLE cannot drop columns without rebuild | Conflict columns remain (harmless) | N/A |
| Pull sync (Task 6-7) | Disable `pull_enabled` flag, restart MCP | None (local files unchanged if pull disabled) | < 1 min |
| Beads sync (Task 10-11) | Remove beads poll from `index.ts`, restart | Notion pages remain, no auto-sync | < 1 min |
| Soft-delete GC (Task 12) | **IRREVERSIBLE** after 7 days | Lost entity mappings (Notion pages still exist) | N/A (must restore from backup) |

**Critical finding:** Schema migration (Task 1) is irreversible. Must test thoroughly before production deploy.

**Mitigation:** Backup `.interkasten/state.db` before upgrade. Document restore procedure.

---

## Rollback Decision Tree

```
Incident detected
├─ Pull sync writing to wrong paths?
│  └─ Set pull_enabled=false, restart MCP (< 1 min)
│
├─ Conflicts accumulating (>100)?
│  └─ Set conflict_strategy=notion-wins, restart (< 1 min)
│
├─ Beads sync breaking bd CLI?
│  └─ Comment out beads poll in index.ts, restart (< 5 min)
│
├─ Merge causing OOM?
│  └─ Set max_merge_size_bytes=100000, restart (< 1 min)
│
└─ Schema migration failed mid-apply?
   └─ HARD ROLLBACK: restore state.db from backup, downgrade plugin (< 10 min)
      Requires: pre-deploy backup exists
```

---

## Monitoring & Observability

### First-Hour Failure Modes

1. **Path traversal exploit** → watch for `writeFileSync` outside `projects_dir`
2. **Notion API rate limit** → circuit breaker opens immediately
3. **Merge OOM** → Node heap exceeds 512MB
4. **Poll loop thrashing** → 10+ poll cycles in 1 minute

### Day-1 Metrics (required)

| Metric | Threshold | Alert Action |
|--------|-----------|--------------|
| Conflicts created | > 5/hour | Warn user, suggest reviewing conflict_strategy |
| Poll failures | > 10 consecutive | Disable pull, notify user to check token |
| Merge duration p95 | > 2 seconds | Log large files, consider size limit |
| Disk usage (conflict files) | > 100 files | Suggest cleanup via MCP tool |

### Runbook Additions

**Symptom:** User reports local files overwritten with Notion content
**Diagnosis:** Check `sync_log` for `operation=pull` + `operation=conflict`
**Mitigation:**
1. Restore from git (`git checkout HEAD -- <file>`)
2. Set `conflict_strategy=local-wins` for that project
3. Review base_content for last known good state

**Symptom:** MCP server crashes during sync
**Diagnosis:** Check logs for `out of memory` or `diff3Merge`
**Mitigation:**
1. Identify large file via `sync_log`
2. Add file to `watcher.ignore_patterns`
3. Set `max_merge_size_bytes=500000`

---

## Risk Prioritization

### Must-Fix Before Merge (Blocking)

1. **Path traversal validation** (Finding 1) — explicit check in executePull()
2. **GC retention increase** (Finding 2) — 7 days → 30 days
3. **Pre-deploy backup procedure** — document state.db snapshot

### Should-Fix Before v0.4 Release

4. **Beads input sanitization** (Finding 3) — defense-in-depth
5. **Merge size limit** (Finding 6) — prevent OOM
6. **Conflict file cleanup tool** (Finding 4) — user-facing ergonomics

### Nice-to-Have (v0.5)

7. **Feature flag for pull sync** — staged rollout
8. **Schema version tracking** — easier downgrades
9. **Monitoring integration** — Prometheus metrics for conflict rate

---

## What NOT to Flag (Avoided False Positives)

1. **SQL injection via Notion content** — Content is stored in `base_content.content` as blob, never interpolated into SQL. All queries use Drizzle ORM or parameterized `.prepare()`.
2. **Credential leakage in logs** — `INTERKASTEN_NOTION_TOKEN` is env-only, never logged. `NotionClient` circuit breaker does not log request bodies.
3. **Markdown XSS in Notion** — Markdown is written to local `.md` files, never rendered as HTML by this plugin. Out of scope.
4. **Race conditions in WAL** — WAL protocol (pending → target_written → committed → delete) is serial within SyncQueue (concurrency=1). No shared state across queue items.
5. **Notion webhook auth** — Not implemented in this plan (deferred to v0.5 per Task 15).

---

## Final Recommendations

### Go Decision

**Conditional GO** — proceed with implementation AFTER:

1. Task 6 spec updated to include explicit path validation check
2. Task 12 GC retention changed to 30 days
3. Pre-deploy backup procedure documented in CLAUDE.md

### No-Go Triggers

- Path traversal test fails after implementation
- Integration tests require production Notion token (use test workspace instead)
- Schema migration is not idempotent

### Post-Deploy Validation

**Week 1 checkpoints:**
- No path traversal attempts logged
- Conflict rate < 1% of pull operations
- No OOM incidents
- Circuit breaker trip rate < 5% of polls

**Success criteria for v0.4 stable:**
- 100 pull operations with 0 path escapes
- Merge performance p95 < 500ms
- User can resolve conflict via MCP tool
- Rollback tested and < 5 minutes

---

## Appendix: Threat Model Summary

**System:** Local TypeScript MCP server, single-user, no network listeners (stdio only)

**Untrusted inputs:**
- Notion API responses (content, titles, properties)
- User-editable Notion pages

**Trusted inputs:**
- Local filesystem (projects_dir)
- SQLite database
- bd CLI output

**Assets:**
- Local markdown files (confidentiality, integrity)
- Notion sync state (availability)
- Project hierarchy metadata (integrity)

**Threat actors:**
- Malicious Notion collaborator (can edit shared pages)
- Compromised Notion integration token (can modify pages)

**Out of scope:**
- Network-based attacks (no listeners)
- Multi-user authorization (single-user tool)
- Notion API compromise (trust Notion's backend security)
