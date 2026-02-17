# Interverse Plugins: Daemon/Persistence/Event Needs Analysis

**Date:** 2026-02-16  
**Evaluator:** Claude Opus 4.6  
**Scope:** All Interverse plugins + services, focusing on ACTUAL implementation

---

## Executive Summary

**Finding:** Only **4 of 24 modules** would benefit from a shared persistent daemon:
- **interkasten** (already has daemon-mode MCP server)
- **interject** (has MCP server, would benefit from scheduled scans)
- **tuivision** (has MCP server, session management exists)
- **interwatch** (drift detection via cron would be useful)

**Recommendation:** Do NOT build a shared daemon. Each plugin has distinct requirements better served by:
1. Per-plugin MCP servers (already in use: interkasten, interject, tuivision, interlock)
2. Optional systemd timers for scheduling (interwatch)
3. File-based sideband coordination (intermute already provides this)

---

## Current Persistent Service: Intermute

**What it provides:**
- HTTP API on port 7338
- Real-time agent coordination and messaging
- SQLite persistence (agents, messages, threads, domain entities)
- WebSocket delivery for real-time notifications
- Project-scoped multi-tenancy with bearer auth
- Event sourcing with cursor-based pagination

**Who uses it:**
- **interlock** (wraps intermute API for file reservations + negotiation)
- **clavain** (registers agents, sends/receives messages)

**What it DOESN'T provide:**
- Webhook receiver (no inbound HTTP for external services)
- Scheduled task orchestration (no cron-like scheduler)
- Event bus for plugin-to-plugin events (messaging is agent-to-agent only)

---

## Per-Plugin Analysis

### 1. interkasten (Notion sync + MCP server)

**Persistence:** SQLite via Drizzle ORM (entity_map, base_content, sync_log, sync_wal)

**MCP Server:** TypeScript daemon with 19 tools, runs continuously when Claude Code is active

**Hooks:**
- SessionStart: status summary
- Stop: warn if pending WAL ops

**Webhooks:** NO — one-way sync (filesystem → Notion), no inbound webhooks

**Scheduled tasks:** NO — sync is manual (`interkasten_sync` tool) or hook-triggered

**Events emitted:** NO — state is self-contained SQLite

**Daemon needs:** ALREADY HAS MCP SERVER (daemon-mode TypeScript process)

**Verdict:** Needs its own daemon for SQLite + Notion client. Shared daemon would NOT help.

---

### 2. interject (ambient discovery + research engine)

**Persistence:** SQLite (discoveries, promotions, feedback_signals, query_log)

**MCP Server:** Python FastMCP with 10 tools

**Hooks:** SessionStart hook for session context

**Webhooks:** NO — scans external APIs (arXiv, HN, GitHub, Anthropic, Exa), no inbound webhooks

**Scheduled tasks:** YES — would benefit from periodic scans (e.g., daily arXiv/HN ingestion)

**Events emitted:** NO — discovery flow is scan → score → promote (all synchronous)

**Daemon needs:** MCP server already runs persistently. Could add systemd timer for scheduled scans.

**Verdict:** Shared daemon NOT needed. Add optional systemd timer for scans.

---

### 3. interlock (file reservation via intermute)

**Persistence:** NO — stateless wrapper around intermute HTTP API

**MCP Server:** Go binary, wraps intermute

**Hooks:**
- PreToolUse:Edit (advisory conflict warnings)
- PostToolUse:Bash (bead-agent binding)
- git pre-commit (mandatory reservation enforcement)

**Webhooks:** NO

**Scheduled tasks:** NO

**Events consumed:** Intermute messages (release requests, negotiation threads)

**Daemon needs:** NONE — intermute is the daemon

**Verdict:** Already uses intermute. Shared daemon redundant.

---

### 4. interwatch (doc freshness monitoring)

**Persistence:** Per-project JSON state in `.interwatch/` (drift.json, history.json, last-scan.json)

**Hooks:** Library only (`lib-watch.sh`), no event hooks

**Webhooks:** NO

**Scheduled tasks:** POTENTIAL — could run drift detection on a schedule (e.g., daily scan)

**Events consumed:** File changes, bead closures, git commits (detected on-demand, not event-driven)

**Daemon needs:** Optional systemd timer for periodic drift checks

**Verdict:** Shared daemon NOT needed. Optional systemd timer sufficient.

---

### 5. interfluence (voice profile + style adaptation)

**Persistence:** Per-project files in `.interfluence/` (voice-profile.md, corpus/, learnings-raw.log)

**MCP Server:** TypeScript, 11 tools (corpus CRUD, profile, config, learnings)

**Hooks:** PostToolUse:Edit (logs diffs for batch review)

**Webhooks:** NO

**Scheduled tasks:** NO

**Events:** NO

**Daemon needs:** MCP server runs when plugin loaded. No daemon needed.

**Verdict:** No daemon benefit.

---

### 6. interflux (multi-agent review + research)

**Persistence:** File-based knowledge in `config/flux-drive/knowledge/`

**Hooks:** NO

**Webhooks:** NO

**Scheduled tasks:** NO

**Events:** NO — review orchestration is synchronous (triage → launch → synthesize)

**Daemon needs:** NONE

**Verdict:** No daemon benefit.

---

### 7. interline (statusline renderer)

**Persistence:** Reads sideband files from `/tmp/` (beads, dispatch, coordination signals)

**Hooks:** NO — passive renderer

**Webhooks:** NO

**Scheduled tasks:** NO

**Events consumed:** Reads state files written by other plugins

**Daemon needs:** NONE — stateless renderer

**Verdict:** No daemon benefit.

---

### 8. interform (design patterns)

**Persistence:** NO

**Hooks:** NO

**Webhooks:** NO

**Scheduled tasks:** NO

**Events:** NO

**Daemon needs:** NONE — pure skill plugin

**Verdict:** No daemon benefit.

---

### 9. intercraft (agent-native architecture)

**Persistence:** NO

**Hooks:** NO

**Webhooks:** NO

**Scheduled tasks:** NO

**Events:** NO

**Daemon needs:** NONE — pure skill plugin

**Verdict:** No daemon benefit.

---

### 10. interdev (MCP CLI developer tooling)

**Persistence:** NO

**Hooks:** NO

**Webhooks:** NO

**Scheduled tasks:** NO

**Events:** NO

**Daemon needs:** NONE — pure skill plugin

**Verdict:** No daemon benefit.

---

### 11. intercheck (code quality guards)

**Persistence:** Session state in `/tmp/intercheck-${SESSION_ID}.json` (call count, pressure, syntax errors)

**Hooks:**
- PostToolUse:Edit/Write (syntax check, auto-format)
- PostToolUse:* (context pressure tracking)

**Webhooks:** NO

**Scheduled tasks:** NO

**Events:** NO

**Daemon needs:** NONE — session-scoped state sufficient

**Verdict:** No daemon benefit.

---

### 12. interstat (token efficiency benchmarking)

**Persistence:** SQLite at `~/.claude/interstat/metrics.db`

**Hooks:**
- PostToolUse:Task (event capture)
- SessionEnd (JSONL parsing + token backfill)

**Webhooks:** NO

**Scheduled tasks:** NO

**Events:** NO

**Daemon needs:** NONE — session-scoped capture, batch processing at session end

**Verdict:** No daemon benefit.

---

### 13. internext (work prioritization)

**Persistence:** NO — reads beads state via `bd` CLI

**Hooks:** NO

**Webhooks:** NO

**Scheduled tasks:** NO

**Events:** NO

**Daemon needs:** NONE — pure analysis skill

**Verdict:** No daemon benefit.

---

### 14. interpath (product artifact generator)

**Persistence:** NO — reads beads/brainstorms/context, writes to `docs/`

**Hooks:** NO

**Webhooks:** NO

**Scheduled tasks:** NO

**Events:** NO

**Daemon needs:** NONE — on-demand generation

**Verdict:** No daemon benefit.

---

### 15. interphase (phase tracking + gates)

**Persistence:** Sideband files in `/tmp/clavain-bead-${session_id}.json`

**Hooks:** Library only (`lib-phase.sh`, `lib-gates.sh`, `lib-discovery.sh`)

**Webhooks:** NO

**Scheduled tasks:** NO

**Events:** NO

**Daemon needs:** NONE — library functions, state in temp files

**Verdict:** No daemon benefit.

---

### 16. interslack (Slack integration)

**Persistence:** NO — uses slackcli (browser session tokens)

**Hooks:** NO

**Webhooks:** NO — send-only via slackcli

**Scheduled tasks:** NO

**Events:** NO

**Daemon needs:** NONE — pure skill plugin

**Verdict:** No daemon benefit.

---

### 17. interpub (plugin publishing)

**Persistence:** NO

**Hooks:** NO (discovered in plugin dirs, no hooks in source)

**Webhooks:** NO

**Scheduled tasks:** NO

**Events:** NO

**Daemon needs:** NONE — pure command plugin

**Verdict:** No daemon benefit.

---

### 18. intersearch (shared Exa + embedding library)

**Persistence:** NO — library only (path dependency for interject + interflux)

**Hooks:** NO

**Webhooks:** NO

**Scheduled tasks:** NO

**Events:** NO

**Daemon needs:** NONE — library

**Verdict:** No daemon benefit.

---

### 19. interdoc (AGENTS.md generator)

**Persistence:** NO — reads repo, writes AGENTS.md

**Hooks:** Optional git post-commit (advisory reminder)

**Webhooks:** NO

**Scheduled tasks:** NO

**Events:** NO

**Daemon needs:** NONE — on-demand generation

**Verdict:** No daemon benefit.

---

### 20. interlens (cognitive augmentation lenses)

**Persistence:** NO (monorepo with MCP server + API + web, but not a Claude Code plugin per se)

**Hooks:** NO

**Webhooks:** NO

**Scheduled tasks:** NO (external project, not integrated)

**Events:** NO

**Daemon needs:** NONE (has own Flask API + Railway deployment)

**Verdict:** Out of scope (not a Claude Code plugin).

---

### 21. tldr-swinton (token-efficient code context)

**Persistence:** SQLite in `.tldrs/state.sqlite3` (delta mode session tracking)

**MCP Server:** YES (`tldr-code` MCP server)

**Hooks:**
- SessionStart (setup, index check, project summary)
- PreToolUse:Serena (impact analysis before edits)
- PostToolUse:Read (compact extract on large files)

**Webhooks:** NO

**Scheduled tasks:** NO (index builds are manual or hook-triggered)

**Events:** NO

**Daemon needs:** MCP server runs when plugin loaded. SQLite is session-scoped.

**Verdict:** No daemon benefit.

---

### 22. tool-time (tool usage analytics)

**Persistence:** Local stats in `~/.claude/tool-time/stats.json`, remote D1 database (Cloudflare)

**Hooks:** NO (skill-invoked)

**Webhooks:** NO — uploads to Cloudflare Worker, no inbound webhooks

**Scheduled tasks:** NO (user invokes `/tool-time` manually or via skill)

**Events:** NO

**Daemon needs:** NONE — batch analysis on-demand

**Verdict:** No daemon benefit.

---

### 23. tuivision (TUI automation + visual testing)

**Persistence:** Session state for spawned TUI processes (tmux session tracking)

**MCP Server:** Python MCP server with 8 tools (spawn, send_input, get_screen, etc.)

**Hooks:** NO

**Webhooks:** NO

**Scheduled tasks:** NO

**Events:** NO

**Daemon needs:** MCP server already manages TUI sessions persistently

**Verdict:** No daemon benefit (MCP server is the daemon).

---

### 24. Clavain (hub: multi-agent rig)

**Persistence:** File-based (upstream-versions.json, routing-overrides.json, interspect SQLite)

**Hooks:** 12 hooks (SessionStart, PostToolUse, Stop, SessionEnd)

**Webhooks:** NO

**Scheduled tasks:** NO (GitHub Actions for upstream checks, not local daemon)

**Events:** NO

**Daemon needs:** NONE — hooks sufficient, GitHub Actions for scheduled upstream checks

**Verdict:** No daemon benefit.

---

## Conclusion

**Total plugins analyzed:** 24  
**Plugins needing webhooks:** 0  
**Plugins needing scheduled tasks:** 2 (interject, interwatch — both solvable with systemd timers)  
**Plugins with event bus needs:** 0 (intermute messaging sufficient)  
**Plugins with persistence needs:** 6 (interkasten, interject, interlock, interstat, tldr-swinton, tuivision — all solved with SQLite or MCP servers)

**Recommendation:** Do NOT build a shared daemon. The ecosystem is well-served by:

1. **MCP servers** for stateful plugins (4 already have them)
2. **Intermute** for agent coordination (already deployed)
3. **File-based sideband** for statusline/phase state (already working)
4. **Systemd timers** for optional scheduled tasks (2 plugins max)

A shared daemon would introduce coupling, single-point-of-failure risk, and migration overhead for marginal benefit.
