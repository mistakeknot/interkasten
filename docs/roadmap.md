# Interkasten Roadmap

**Version:** 0.4.0
**Last updated:** 2026-02-16
**Vision:** [`docs/vision.md`](vision.md)
**PRD:** [`docs/PRD.md`](PRD.md)

---

## Where We Are

Interkasten currently ships as:

- 1 MCP server (`interkasten`) with 21 tools for project lifecycle, bidirectional sync, conflicts, and issues
- 3 user-invocable skills: `layout`, `onboard`, `interkasten-doctor`
- Bidirectional Notion sync with three-way merge conflict resolution
- Beads issue sync with diff-based state tracking
- Local SQLite state + Notion integration + triage workflows

## What's Working

### v0.3.x (push sync)
- Project discovery and registration with explicit parent/tags support
- SQLite-backed mapping between local projects/files and Notion entities
- Push sync: local file changes → Notion pages via WAL protocol
- Tool-level triage signal capture via `interkasten_gather_signals`
- File scanning and sync preview before mutation actions
- Health, configuration, and sync log tooling
- Circuit breaker + exponential backoff for Notion API resilience
- 19 MCP tools, 3 skills, 2 hooks

### v0.4.0 (bidirectional sync) — current
- Pull sync: 60-second Notion polling detects remote changes, pulls to local files
- Three-way merge via `node-diff3` with configurable conflict strategies
- Conflict tracking in database with `interkasten_conflicts` tool
- Beads ↔ Notion issue sync with snapshot-based diff detection
- Soft-delete safety: 30-day GC retention aligned with Notion trash
- T2 linked references: lightweight summary cards for secondary files
- Path traversal prevention on all pull operations
- 21 MCP tools, 130 tests (121 unit + 9 integration)

## What's Next

### v0.5.0: Webhooks + Real-Time Sync
- Persistent webhook receiver (systemd service, tiny HTTP server + SQLite event queue)
- Cloudflared tunnel for near-instant Notion change notifications
- Polling demoted to safety net (fallback when webhooks miss events)
- Sync happens between Claude Code sessions (receiver queues events, MCP server processes on startup)

### v0.5.x: Operational Quality
- Extract `ConflictResolver` class from engine (reduce god-object complexity)
- Async beads CLI calls (replace `execFileSync` with `promisify(execFile)`)
- Config schema validation for `conflict_strategy` and `poll_interval`
- `.conflict` file accumulation prevention (watcher ignore patterns)

### v0.6.0: Team-Ready Workflows
- Multi-user conflict resolution with named merge strategies per project
- Stronger observability signals for drift and retry quality
- Bulk operations and safer defaults for project selection workflows
- Formalized error taxonomies for agent auto-routing

## Not in Scope Right Now

- Hardcoded documentation policy generation
- Fully automatic triage or sync decisions without user review
- Rewriting Notion as source-of-truth for local execution state
- Pagent workflows (deferred, not cancelled — doc generation stays with interpath/interwatch)
