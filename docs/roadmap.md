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

### P2.1 — Webhooks + Real-Time Sync
- [IKN-N1] **Webhook receiver + queueing** — Add a persistent webhook receiver with a systemd service + SQLite event queue.
- [IKN-N2] **Cloudflare edge fanout** — Introduce Cloudflared tunnel path for near-real-time Notion event push.
- [IKN-N3] **Safe polling fallback** — Demote polling to safety-net behavior when webhook transport drops.
- [IKN-N4] **Cross-session receiver pipeline** — Process queued events on startup so sync can continue across sessions.

### P2.2 — Operational Quality
- [IKN-N5] **ConflictResolver extraction** — Refactor sync engine to reduce command dispatch complexity.
- [IKN-N6] **Async beads bridge** — Replace synchronous calls with async patterns for CLI integration.
- [IKN-N7] **Configuration schema validation** — Validate conflict and polling settings before startup and sync loops.
- [IKN-N8] **Conflict-file hygiene** — Prevent watcher-side `.conflict` accumulation in long sessions.

### P2.3 — Team-Ready Workflows
- [IKN-P1] **Multi-user conflict resolution** — Add named project-specific merge strategies for coordinated editing.
- [IKN-P2] **Drift and retry observability** — Expand instrumentation for sync failures and retry quality.
- [IKN-P3] **Safer bulk workflows** — Improve selection UX and defaults for project/scoped operations.
- [IKN-P4] **Auto-routing taxonomies** — Formalize sync error classes to improve agent-triggered recovery routing.

## Not in Scope Right Now

- Hardcoded documentation policy generation
- Fully automatic triage or sync decisions without user review
- Rewriting Notion as source-of-truth for local execution state
- Pagent workflows (deferred, not cancelled — doc generation stays with interpath/interwatch)

## From Interverse Roadmap

Items from the [Interverse roadmap](../../../docs/roadmap.json) that involve this module:

No monorepo-level items currently reference this module.
