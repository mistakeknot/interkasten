# Bidirectional Sync for Interkasten
**Bead:** Interkasten-3wh

> **Date:** 2026-02-15
> **Status:** Complete
> **Participants:** Claude + human

---

## Problem Statement

Interkasten currently supports push-only sync (local → Notion). The user wants to edit project docs in Notion and have those edits flow back locally, plus sync beads issues to Notion sprint boards. The original PRD bundled sync with a pagent workflow engine, research triage, and doc generation — scope that belongs to other Interverse modules.

## Scope Decisions

### In scope (interkasten's job)
1. **Bidirectional doc sync** — push local docs to Notion, pull Notion edits back, merge when both change
2. **Beads ↔ Notion issues sync** — sprint boards, issue status, priorities, dependencies
3. **Reliable plumbing** — WAL, circuit breaker, conflict resolution, webhook receiver, polling fallback

### Out of scope (other modules' jobs)
- **Doc generation** → interpath (PRDs, roadmaps, changelogs)
- **Doc freshness/drift** → interwatch
- **Research triage** → interject
- **Workflow DAG engine (pagent)** → deferred, not cancelled. Trigger: when user repeatedly wishes "I want this sequence to happen automatically when X changes"
- **Shared infrastructure daemon (intercore)** → deferred. Only 1 consumer today (interkasten). Extract when a second plugin needs persistent HTTP/event bus.

## What's Built (v0.3.13)
- Push sync with WAL, circuit breaker, rate limiting
- 19 MCP tools (all functional, push-only)
- Entity mapping, content translation (martian + notion-to-md)
- File watcher (chokidar), queue with dedup
- 3 skills (layout, onboard, doctor), 3 hooks, 79 unit tests
- Project discovery, hierarchy, tags, signals

## Architecture Decisions

### Webhook receiver
- Persistent systemd service (tiny HTTP server) on ethics-gradient server
- Cloudflared tunnel maps public URL → local port
- Notion webhooks deliver page change events near-instantly
- Events written to SQLite event queue
- MCP server (session-scoped) processes queue on startup
- Between sessions, changes queue up — no sync until Claude Code starts
- 60-second polling as safety net for missed webhook events

### Conflict resolution
- Default: three-way merge with local-wins fallback
- Install `node-diff3` + `diff-match-patch-es` (not currently in package.json)
- When both sides change same paragraph: local version wins, Notion version preserved in page history
- Configurable strategies: local-wins, notion-wins, conflict-file, ask

### Beads sync
- Map beads fields → Notion properties: title, status, priority, type, assignee, created, updated
- Beads notes → Notion page content
- Beads dependencies → Notion relation property
- Sprint board as a Notion database view

## Build Order (dependency-driven)

1. **Webhook receiver + cloudflared tunnel** — persistent systemd service, event queue
2. **Notion polling + pull sync** — detect remote changes, pull to local (polling as webhook fallback)
3. **Three-way merge + conflict resolution** — handle both-sides-changed correctly
4. **Beads ↔ Notion issues** — new sync domain, different entity type/schema
5. **Polish** — soft-delete safety, linked references (T2 summary cards), integration tests

## Alternatives Considered

### Pagent as part of interkasten
Rejected. The DAG workflow engine is general-purpose infrastructure, not sync. The Interverse already has interpath, interwatch, and interject providing the outcomes pagent was designed for. The agent itself acts as the orchestrator via skills.

### Shared intercore daemon
Rejected for now. Only interkasten needs persistent HTTP + event bus. Interject and interwatch could use scheduled tasks but systemd timers suffice. Extract when a second consumer appears — the interface is simple (receive HTTP → write to queue → plugins poll).

### Polling-only (no webhooks)
Rejected. User wants near-instant sync. Cloudflared tunnels are free and the server is always on. Polling remains as a safety net.

### Persistent MCP server (always-running, sessions connect via HTTP)
Considered but rejected. The webhook receiver is a tiny HTTP server (~200 lines). The MCP server stays session-scoped (simpler lifecycle). Changes queue between sessions and process on startup.
