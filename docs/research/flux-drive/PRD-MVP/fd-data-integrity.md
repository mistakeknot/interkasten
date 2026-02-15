# Data Integrity Review: interkasten PRD-MVP

> **Reviewer**: fd-data-integrity (data pipeline reliability)
> **Document**: `/root/projects/interkasten/docs/PRD-MVP.md`
> **Date**: 2026-02-14
> **Mode**: Generic (no CLAUDE.md or AGENTS.md in project root; assumptions marked)

---

### Findings Index

| Severity | ID | Section | Title |
|----------|-----|---------|-------|
| P0 | DI-01 | Sync Engine | base_content stored inline in entity_map risks unbounded table growth and SQLite row-size pressure |
| P0 | DI-02 | Sync Engine | No crash-recovery protocol for partial sync: entity_map and Notion can diverge permanently |
| P0 | DI-03 | Sync Engine | Notion `last_edited_time` is second-granularity and non-monotonic under rapid edits |
| P1 | DI-04 | Entity Mapping | No ON CONFLICT clause specified for UNIQUE constraints; upsert behavior undefined |
| P1 | DI-05 | Sync Engine | Change detection asymmetry: local uses content hash, Notion uses timestamp -- phantom conflicts on roundtrip lossy conversions |
| P1 | DI-06 | Conflict Resolution | base_content update timing not specified: failure between write and base update creates stale-base merge corruption |
| P1 | DI-07 | Entity Mapping | No cascade/orphan handling when a project is unregistered or a local file is deleted |
| P1 | DI-08 | Pagent System | DAG `depends_on` references are string-based with no foreign-key enforcement; dangling references silently break workflows |
| P1 | DI-09 | Sync Engine | Operation queue has no deduplication: rapid FS events can enqueue redundant operations for the same entity |
| P2 | DI-10 | Sync Engine | Beads-to-Notion issue sync has no duplicate-prevention mechanism described |
| P2 | DI-11 | Entity Mapping | entity_type is unconstrained TEXT with no CHECK constraint or enum validation |
| P2 | DI-12 | Sync Engine | Sync log stored as Notion database -- Notion API rate limits throttle audit trail writes |
| P2 | DI-13 | Temporal Data | Timezone handling for last_sync_ts and last_notion_ver not specified (TEXT columns, no format constraint) |
| P2 | DI-14 | Pagent System | Fan-out cardinality is unbounded: a classify action returning 100 matches spawns 100 parallel instances |
| P3 | DI-15 | Configuration | batch_size=10 with poll_interval=60s creates a hard ceiling of 600 operations/hour regardless of backlog |
| P3 | DI-16 | Sync Engine | No content-hash validation on the Notion side after push to confirm write integrity |

**Verdict: needs-changes**

---

### Summary

The PRD describes a well-thought-out bidirectional sync architecture that correctly identifies the key challenges (three-way merge, operation tracking, entity mapping). However, from a data integrity standpoint, the design has significant gaps in crash recovery, idempotency, and consistency guarantees. The most critical issues are: (1) no transactional boundary around the sync-write-then-update-base-content sequence, meaning a crash mid-sync leaves stale merge bases that will produce incorrect future merges; (2) storing `base_content` (full document text) inline in the entity_map table, which creates unbounded growth and performance degradation; and (3) relying on Notion's `last_edited_time` for change detection without acknowledging its known limitations (second-granularity, non-monotonic under concurrent API writes). The pagent DAG system lacks referential integrity enforcement for node dependencies. These issues are all addressable at design time before code is written.

---

### Issues Found

**DI-01. P0: base_content inline storage creates unbounded table growth and performance risk**

The `entity_map` table stores `base_content TEXT` -- the full text of every synced document -- in the same row as the mapping metadata. For a workspace with 50 projects averaging 10 synced docs each at 10KB per doc, this is 5MB of content in the entity_map table. As documents grow (PRDs can easily reach 50-100KB), the table balloons. SQLite handles this, but queries that scan entity_map for mapping lookups (e.g., "find the entity for this local_path") must skip over megabytes of base_content data. This is both a performance issue and a backup/migration risk. Evidence: Section 6, entity_map schema (line 551-563 of PRD). The `base_content` column sits alongside lightweight mapping columns (`local_path`, `notion_id`, `tier`) in a single table with no separation.

**DI-02. P0: No crash-recovery protocol for the sync-write-update-base cycle**

A single sync operation requires multiple steps: (1) read both sides, (2) compute merge, (3) write result to target (Notion API call or local file write), (4) update `base_content`, `last_local_hash`, `last_notion_ver`, and `last_sync_ts` in entity_map. If the process crashes after step 3 but before step 4, the entity_map still holds the old base_content. On the next sync cycle, the engine will re-detect a "change" (because the hash/timestamp don't match) and attempt another merge using the stale base. If the other side has also changed in the interim, the three-way merge will use the wrong ancestor and produce a silently incorrect result. The PRD does not describe any journaling, write-ahead log, or idempotency token to make sync operations recoverable. Evidence: Section 6 (Operation Log Model) describes tracking operations but not making them atomic; Section 7 (Three-Way Merge Process, step 4: "Update the base version in the state store to the merged result") is described as a separate step with no transactional guarantee tying it to the write.

**DI-03. P0: Notion `last_edited_time` is unreliable for precise change detection**

The PRD uses `last_edited_time` comparison as the sole change detection mechanism for Notion pages (Section 6, Change Detection table). Notion's `last_edited_time` has known limitations: (a) it is rounded to the nearest second, so multiple rapid edits within the same second are invisible; (b) Notion's internal write pipeline can update `last_edited_time` non-monotonically when multiple API requests modify the same page concurrently (e.g., the sync engine pushing blocks while a pagent workflow updates a property); (c) Notion may coalesce rapid edits into a single `last_edited_time` update. Using this as the sole change signal means: missed edits when changes happen within the same second, and false "no change" results when the timestamp hasn't updated despite content changing. The design acknowledges the polling safety net but does not address the timestamp precision issue.

**DI-04. P1: UNIQUE constraint conflict handling is unspecified**

The entity_map schema declares `UNIQUE(local_path)` and `UNIQUE(notion_id)` but does not specify what happens on conflict. SQLite's default behavior on UNIQUE violation is to abort the transaction and return SQLITE_CONSTRAINT. The PRD does not describe whether INSERT uses `ON CONFLICT REPLACE`, `ON CONFLICT IGNORE`, or relies on explicit check-then-insert logic. This matters critically during: (a) re-registration of a previously unregistered project, (b) Notion page ID reuse (if a page is deleted and recreated), (c) file moves where `local_path` changes but the Notion page remains the same. Without explicit ON CONFLICT behavior, any of these scenarios will throw runtime errors. Evidence: Section 6, entity_map CREATE TABLE (lines 551-563).

**DI-05. P1: Asymmetric change detection creates phantom conflicts from conversion loss**

Local changes are detected via SHA-256 content hash; Notion changes are detected via `last_edited_time`. This asymmetry means: when the engine pushes a local file to Notion (markdown -> Notion blocks), then on the next cycle polls Notion and sees `last_edited_time` has updated (because we just wrote to it), it will detect a "Notion change." Meanwhile, the local file hasn't changed, so the engine correctly identifies "only remote changed" and pulls. But pulling converts Notion blocks back to markdown, and the conversion is ~95% lossless (Section 6, Roundtrip fidelity). The pulled content will differ slightly from the original local content (whitespace normalization, H4->H3 flattening, callout formatting). The local file is overwritten with this slightly-different content, its hash changes, and on the next cycle the engine detects a "local change." This creates an infinite ping-pong of phantom syncs. The PRD mentions "Diff against existing Notion blocks to minimize API calls" for push but does not describe how to break this roundtrip-lossy feedback loop.

**DI-06. P1: base_content update timing gap enables merge corruption**

The three-way merge process (Section 7) describes step 4: "Update the base version in the state store to the merged result." This update must happen atomically with the write to the target side. If the write to Notion succeeds but the base_content update fails (crash, disk full, SQLite lock timeout), the next sync cycle will use the old base for merging. With the old base, changes that were already merged will appear as "new changes from the other side," leading to duplicate insertions or conflicting merge results. This is the most common data corruption pattern in sync engines. The fix is straightforward (SQLite transaction wrapping the write confirmation + base update), but the PRD does not specify this.

**DI-07. P1: No orphan handling for entity_map when projects are removed**

The PRD describes `interkasten_unregister_project` (Section 8) but does not specify what happens to entity_map rows for that project's documents. If the entity_map rows are not cleaned up: (a) the entities become orphans with no local files to sync, (b) the next poll cycle will detect "local file deleted" and attempt to handle it, but the expected behavior is undefined, (c) base_content for those entities wastes storage. Similarly, if a Notion page is deleted outside of the sync engine, the entity_map still references it, and the next sync cycle will get 404 errors. The PRD mentions the Sync Log for auditability but does not describe orphan detection or cleanup.

**DI-08. P1: Pagent DAG node dependencies have no referential integrity enforcement**

Workflow YAML files reference actions by name string (e.g., `depends_on: classify`, `action: fetch-content`). There is no schema validation that referenced actions exist at registration time beyond cycle detection (Section 3, DAG Execution: "Validates -- Checks for cycles at registration time"). A workflow that references `depends_on: clasify` (typo) or `action: fetch-conten` will pass cycle detection (no cycle exists) but fail at execution time. The PRD describes cycle detection but not existence validation for action names or depends_on targets. This is a referential integrity gap that will surface as runtime errors in production.

**DI-09. P1: Operation queue lacks deduplication for rapid filesystem events**

The filesystem watcher uses chokidar with a 500ms debounce (Section 11, watcher config). However, many editors perform atomic writes by writing to a temp file and renaming, which generates multiple events (create temp, write temp, rename temp to target, possibly delete old). Even with 500ms debounce, a single logical edit can produce multiple operation queue entries for the same file. The PRD describes debouncing at the watcher level but does not describe deduplication at the operation queue level. Without deduplication, the reconciler processes the same entity multiple times per cycle, wasting Notion API quota and potentially causing race conditions if two sync operations for the same entity run concurrently.

**DI-10. P2: Beads-to-Notion issue sync has no duplicate prevention**

Section 6 describes mapping beads fields to Notion properties, but the mechanism for ensuring a beads issue is not duplicated in Notion on re-sync is not specified. The entity_map provides UNIQUE constraints on local_path and notion_id, but beads issues are identified by beads IDs (e.g., `beads-abc`), and the mapping between beads ID and entity_map local_path is not defined. If the beads database path changes (e.g., `.beads/issues.db` is rebuilt), the entity_map may not recognize existing issues, creating duplicates in Notion.

**DI-11. P2: entity_type column has no validation constraint**

The entity_map schema defines `entity_type TEXT NOT NULL` with a comment listing valid values (`'project' | 'doc' | 'ref' | 'issues'`), but no CHECK constraint enforces this at the database level. Application-level validation with Zod (mentioned in Section 10) would catch this at the ORM layer, but if any code path writes directly to SQLite (migrations, manual fixes, import scripts), invalid entity_type values can enter the table and cause undefined behavior in the sync engine's type-dispatch logic.

**DI-12. P2: Sync log as Notion database creates a write-amplification bottleneck**

The Sync Log is described as a Notion database (Section 4). Every sync operation writes a log entry to Notion via the API, consuming from the same 3 req/sec rate limit used for actual sync operations. During a full project resync touching 50 entities, the sync log alone would consume 50 API calls (~17 seconds at 3 req/sec), doubling the total sync time. The sync log should be local-first (SQLite) with optional Notion mirroring, not Notion-primary.

**DI-13. P2: Timestamp format and timezone handling unspecified**

The entity_map stores `last_sync_ts TEXT NOT NULL` and `last_notion_ver TEXT`. The TEXT type imposes no format constraint. If different code paths write timestamps in different formats (ISO 8601 with/without timezone, Unix epoch, Notion's format), comparisons will produce incorrect results. Notion's API returns timestamps in ISO 8601 with timezone (e.g., `2026-02-14T12:00:00.000Z`), but the PRD does not specify that all internal timestamps should follow the same format. This is a latent consistency risk.

**DI-14. P2: Fan-out cardinality is unbounded and could exhaust resources**

The pagent system's fan-out mechanism (Section 3) instantiates one downstream action per output item. If a `classify` action returns 50 matched projects (e.g., a broadly relevant research article), 50 parallel `route-to-project` instances are created. Each may spawn subagent AI calls (if the downstream action is a `prompt` type). With `max_concurrent_workflows: 5` but no per-workflow fan-out limit, a single workflow could spawn hundreds of action instances. The PRD specifies `max_dag_depth: 10` but no `max_fan_out_cardinality`.

**DI-15. P3: batch_size ceiling limits catch-up throughput**

The configuration specifies `batch_size: 10` and `poll_interval: 60` (Section 11). At most 10 API calls per cycle, one cycle per minute, yields a hard ceiling of 600 API calls per hour. Initial sync of a workspace with 30 projects and 10 docs each (300 entities, each needing at least 2 API calls for push) would take at minimum 1 hour. The PRD does not describe a "catch-up mode" or dynamic batch sizing for initial sync vs. steady-state.

**DI-16. P3: No write-verification after Notion push**

After pushing content to Notion, the engine updates entity_map with the new `last_notion_ver` based on the assumed write. It does not re-read the page to verify the content was correctly applied. If Notion's API silently truncates content (e.g., exceeding the 100-block append limit per request) or drops blocks due to a transient error, the entity_map records a successful sync with a content mismatch. A periodic verification sweep (read-back and hash-compare) would catch these silent failures.

---

### Improvements

**IMP-01. Separate base_content into a dedicated table** -- Move `base_content` out of entity_map into a `base_versions` table keyed by entity_map.id. This keeps entity_map queries fast (small rows) and allows base_content to be vacuumed or compressed independently.

**IMP-02. Wrap sync-write + base-update in a SQLite transaction with a sync journal** -- Before writing to the target, record the intended operation in a `sync_journal` table. After successful write, update entity_map and mark the journal entry complete. On startup, replay incomplete journal entries. This makes sync operations idempotent and crash-recoverable.

**IMP-03. Use content-hash comparison for Notion change detection as a supplement** -- After fetching Notion content (which is necessary for three-way merge anyway), compute its hash and compare against a stored `last_notion_hash`. This catches changes that `last_edited_time` misses due to second-granularity rounding, and breaks the phantom-conflict loop from DI-05 by comparing actual content, not timestamps.

**IMP-04. Add a normalized-content hash to break roundtrip-lossy feedback loops** -- Before comparing hashes, normalize both local and Notion-derived markdown (strip trailing whitespace, normalize heading levels, standardize callout format). Store the normalized hash alongside the raw hash. Use normalized hash for change detection, raw hash for integrity verification.

**IMP-05. Define explicit ON CONFLICT behavior in entity_map schema** -- Specify `INSERT OR REPLACE` or `INSERT ... ON CONFLICT(local_path) DO UPDATE` semantics in the schema migration. Document the expected behavior for each conflict scenario (re-registration, page ID reuse, file moves).

**IMP-06. Add a max_fan_out configuration parameter to pagent workflows** -- Default to a sensible limit (e.g., 10) with per-workflow override. Truncate fan-out results beyond the limit with a logged warning. This prevents resource exhaustion from unexpectedly broad classifications.

**IMP-07. Make the sync log local-first** -- Store the sync log in SQLite as the primary store and mirror it to Notion asynchronously in batches. This decouples audit logging from the sync engine's rate-limited API budget and ensures log entries are never lost due to API failures.

**IMP-08. Add entity_map orphan detection sweep** -- On each daily scheduled sweep, query entity_map for rows where: (a) local_path does not exist on disk, or (b) Notion API returns 404 for notion_id. Flag these as orphans in the sync log and optionally clean up after a configurable retention period (e.g., 7 days, to allow for temporary file moves or Notion trash recovery).

<!-- flux-drive:complete -->
