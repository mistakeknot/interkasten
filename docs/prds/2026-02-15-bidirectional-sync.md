# PRD: Bidirectional Notion Sync
**Bead:** Interkasten-3wh

## Problem

Interkasten only syncs local → Notion. Edits made in Notion don't flow back to local files, and beads issues aren't visible in Notion at all. This makes Notion a read-only mirror instead of a living collaboration surface.

## Solution

Complete interkasten's bidirectional sync: pull Notion changes to local files, merge when both sides change, sync beads issues to Notion sprint boards. Polling-based change detection first; webhook receiver deferred to v2 after core sync is proven stable.

## Phasing

**This iteration (v0.4.x):** F1-F4 below — polling + pull sync, three-way merge, beads sync, production hardening.
**Next iteration (v0.5.x, deferred):** Webhook receiver + cloudflared tunnel. Adds near-instant change detection on top of proven polling sync. Requires solving multi-process SQLite coordination (webhook service + MCP server).

## Features

### F1: Notion Polling + Pull Sync

**What:** Detect Notion-side changes via polling and pull them to local markdown files.

**Acceptance criteria:**
- [ ] Poller runs every 60 seconds (configurable via `sync.poll_interval`)
- [ ] Two-phase change detection: `last_edited_time` fast-path filter, then content hash verification
- [ ] Pull operation: fetch Notion page content → convert to markdown via `notion-to-md` → write to local file
- [ ] Roundtrip normalization: base content after push is the pulled-back version (prevents phantom conflicts)
- [ ] New entities discovered via polling auto-register in entity_map
- [ ] MCP tool `interkasten_sync` extended to support `direction: "pull"` parameter
- [ ] Sync log records all pull operations with direction `notion_to_local`
- [ ] Frontmatter preserved on pull (don't overwrite local frontmatter with Notion content)
- [ ] **Path validation:** Pulled content writes only to paths within the project directory. Notion page titles must not contain path traversal sequences (`..`, absolute paths). Reject and log if validation fails.

### F2: Three-Way Merge + Conflict Resolution

**What:** When both local and Notion sides have changed since last sync, merge them intelligently using three-way merge with configurable fallback.

**Acceptance criteria:**
- [ ] Install `node-diff3` and `diff-match-patch-es` as dependencies
- [ ] Three-way merge: compute diff from base to local AND base to remote, merge non-overlapping changes automatically
- [ ] Overlapping changes: apply configured fallback strategy (default: local-wins)
- [ ] Conflict strategies: `three-way-merge` (default), `local-wins`, `notion-wins`, `conflict-file`
- [ ] `conflict-file` strategy creates `.conflict` copy with both versions (Syncthing-style)
- [ ] Overwritten version always preserved (Notion page history for remote, `.conflict` for local)
- [ ] Merge results logged to sync_log with `operation: "merge"` and details showing which sections merged/conflicted
- [ ] Base content updated to merged result after successful merge
- [ ] Config: `sync.conflict_strategy` in `~/.interkasten/config.yaml`
- [ ] **Optimistic locking:** Merge operation checks base content hasn't changed between read and write (prevents read-modify-write races within the single MCP server process across async operations)
- [ ] **Conflict notification:** SessionStart hook reports unresolved conflicts. New MCP tool `interkasten_conflicts` lists files with pending conflicts.

### F3: Beads ↔ Notion Issues Sync

**What:** Bidirectional sync between the local beads issue tracker and a Notion Issues database per project, enabling sprint boards in Notion.

**Acceptance criteria:**
- [ ] New Notion database "Issues" created per project (child of project page) during registration
- [ ] Field mapping: beads `title` → Notion `Name`, `status` → `Status` (select), `priority` → `Priority` (select), `type` → `Type` (select), `assignee` → `Assignee` (rich text), `created` → `Created` (date), `updated` → `Last Updated` (date)
- [ ] Beads `notes` → Notion page content (markdown body)
- [ ] Beads `dependencies` → Notion `Blocked By` relation property (self-referencing within Issues DB)
- [ ] New entity_type `"issue"` in entity_map (alongside existing `"project"`, `"doc"`, `"ref"`)
- [ ] **All beads access via `bd` CLI** — no direct SQLite reads. Use `bd list --format=json`, `bd show <id> --format=json`, `bd update`. Avoids schema coupling and concurrent access issues.
- [ ] Push: detect beads changes by polling `bd list --format=json` and comparing against last known state hash
- [ ] Pull: Notion issue changes (status, priority, notes) flow back to beads via `bd update`
- [ ] Conflict resolution: three-way merge for notes content; property conflicts use last-write-wins (properties are atomic, not mergeable)
- [ ] Sprint board: Notion database view filtered by status, grouped by priority (created automatically)
- [ ] MCP tool `interkasten_list_issues` returns synced issues with both beads ID and Notion page ID
- [ ] Closed beads issues sync as "Done" status in Notion (bidirectional)

### F4: Polish — Soft-Delete Safety, Linked References, Integration Tests

**What:** Production hardening: safe deletion handling, T2 doc summary cards, and end-to-end test coverage.

**Acceptance criteria:**
- [ ] **Soft-delete (local):** Deleted local file → entity_map marked `deleted`, Notion page gets `⚠️ Source Deleted` status. Hard-delete after 7 days.
- [ ] **Soft-delete (Notion):** Archived/deleted Notion page → entity_map marked `deleted`, local file untouched, warning logged. User must explicitly delete local file.
- [ ] **Linked references (T2):** Files matched by `scan_files` but not T1 → summary card in Notion: title, path, last modified timestamp, line count (no AI summary — keep it simple)
- [ ] **T2 update on sync:** Summary cards refresh when the local file's content hash changes
- [ ] **Integration tests:** Test suite that exercises real Notion API (gated behind `INTERKASTEN_TEST_TOKEN` env var)
- [ ] **Integration test coverage:** Init flow, push, pull, merge (non-overlapping), merge (conflict), issue sync, soft-delete both directions

## Deferred to v0.5.x

### Webhook Receiver + Cloudflared Tunnel
Persistent systemd service receiving Notion webhook events for near-instant change detection. Deferred because: (1) polling at 60s covers the use case adequately, (2) webhook setup requires manual Notion UI step that adds onboarding friction, (3) multi-process SQLite coordination (webhook service + MCP server) needs a proper concurrency model before implementation.

### "Ask" Conflict Strategy
Sets a conflict status in Notion and blocks sync until user resolves. Deferred because it requires additional Notion UI integration and the core strategies (three-way-merge, local-wins, notion-wins, conflict-file) cover the common cases.

## Non-goals

- Doc generation (interpath's job)
- Doc staleness detection (interwatch's job)
- Research triage (interject's job)
- Pagent/workflow DAG engine (deferred — not cancelled)
- Shared infrastructure daemon (extract when second consumer appears)
- Real-time collaborative editing (this is periodic batch sync)
- Enterprise RBAC/compliance

## Dependencies

- `node-diff3` — three-way merge (F2)
- `diff-match-patch-es` — fuzzy patch application for conflict resolution (F2)
- Existing: `@notionhq/client` v5, `@tryfabric/martian`, `notion-to-md`, `better-sqlite3`, `drizzle-orm`, `chokidar`, `p-queue`
- Notion integration token with capabilities: Read content, Update content, Insert content, Read user information
- Beads CLI (`bd`) with `--format=json` support for issue sync (F3)

## Concurrency Model

**Single-writer guarantee (this iteration):** Only the MCP server process reads/writes the interkasten SQLite database. No webhook receiver, no background daemon. This eliminates multi-process coordination issues entirely.

**Within the MCP server:** Async operations (poller + file watcher + manual sync trigger) are serialized through the existing `SyncQueue` with deduplication. The queue processes one operation at a time. Merge operations use optimistic locking: read base → compute merge → verify base unchanged → write (retry if stale).

**Beads access:** All reads/writes go through the `bd` CLI (spawned as child processes), avoiding any direct SQLite access to the beads database. This respects beads' own locking and schema versioning.

## Security Considerations

- **Path traversal prevention:** All pull operations validate that the target file path resolves within the project directory (`realpathSync` after join, verify prefix). Notion page titles containing `..` or absolute paths are rejected.
- **Content trust boundary:** Content pulled from Notion is user-editable and potentially externally shared. It is written as markdown files only — never executed, never interpolated into commands. The translator validates that Notion blocks produce well-formed markdown.
- **No new network exposure (this iteration):** Polling uses outbound HTTPS only. No listening ports, no tunnel, no webhook endpoint.

## Resolved Questions

1. **Notion webhook API availability:** Webhook subscriptions are created through the Notion integration settings UI only — no API endpoint for programmatic creation. Deferred to v0.5.x.
2. **Cloudflared tunnel persistence:** Named tunnels persist across restarts. Deferred to v0.5.x.
3. **Beads DB format stability:** Resolved — use `bd` CLI for all reads/writes. No direct SQLite access. This avoids schema coupling and concurrent access issues.

## Flux-Drive Review Findings (Addressed)

| Finding | Source | Resolution |
|---------|--------|------------|
| Multi-process SQLite contention | fd-correctness, fd-architecture | Deferred webhooks; single-writer guarantee this iteration |
| Path traversal from Notion content | fd-safety | Added path validation to F1 acceptance criteria |
| YAGNI: cloudflared auto-provisioning, "ask" strategy, AI summaries | fd-architecture, fd-user-product | Deferred webhooks and "ask"; simplified T2 refs (no AI summary) |
| Beads direct SQLite access | fd-safety, fd-correctness | Changed to `bd` CLI access only |
| Merge read-modify-write race | fd-correctness | Added optimistic locking to F2 acceptance criteria |
| Missing conflict notification UX | fd-user-product | Added SessionStart hook + `interkasten_conflicts` tool to F2 |
| Beads sync directionality unclear | fd-user-product | Clarified: fully bidirectional with last-write-wins for properties |
