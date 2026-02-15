# Brainstorm: Onboarding Polish + Doctor Command

**Date:** 2026-02-15
**Prompt:** Option E from /internext:next-work — improve first-run experience and add self-diagnosis
**Status:** Complete — ready for planning

## Context

Interkasten has 19 MCP tools, 2 skills (layout, onboard), 1 command, and 79 tests. The original scope referenced 4 closed beads from a flux-drive review:

| Bead | Title | Status |
|------|-------|--------|
| Interkasten-4pc | Hooks in wrong directory | Already fixed (hooks/ at root, hooks.json exists but empty) |
| Interkasten-pdr | Config not auto-generated | Already fixed (`ensureConfigFile()` in loader.ts) |
| Interkasten-k48 | Validate Notion token before setup | Already fixed (`validateToken()` in init.ts) |
| Interkasten-nu0 | No doctor/help command | **Not implemented** |

## What We're Actually Building

### 1. `/interkasten:doctor` Skill

A user-facing diagnostic command that checks every precondition for a working interkasten installation. Wraps the existing `interkasten_health` MCP tool but adds checks the tool can't do (environment, filesystem, plugin wiring).

**Checks:**
- Config file exists at `~/.interkasten/config.yaml`
- Notion token set (`INTERKASTEN_NOTION_TOKEN`)
- Notion token valid (via `interkasten_health` tool if MCP server running, or direct API call)
- MCP server reachable (the interkasten server is running and responding)
- SQLite database exists and is connectable
- Projects database exists in Notion (init has been run)
- At least one project registered
- Circuit breaker state (closed = healthy)
- WAL pending entries (0 = clean, >0 = pending work)
- Hooks configuration (hooks.json populated vs empty)

**Output format:**
```
interkasten doctor

 Config file         ~/.interkasten/config.yaml
 Notion token        INTERKASTEN_NOTION_TOKEN set
 Notion connection   API reachable, circuit closed
 MCP server          Running (PID 12345, uptime 4h)
 SQLite              Connected at ~/.interkasten/interkasten.db
 Notion workspace    Projects database found (18 projects)
 WAL                 Clean (0 pending)
 Hooks               Empty (no hooks defined)

7/8 checks passed. 1 warning.
```

### 2. Lifecycle Hooks (populate empty hooks.json)

The hooks.json is empty. Two hooks make sense for interkasten:

**SessionStart hook:** Print a one-line status when a Claude Code session starts in a project that has interkasten configured. Something like "interkasten: 18 projects synced, 0 pending, last sync 2h ago".

**Stop hook:** If there are pending WAL entries or unsaved changes when the session ends, warn the user.

### 3. `/interkasten:doctor` Command (thin wrapper)

A command entry that invokes the doctor skill, following the same pattern as the existing `onboard` command.

## Why This Approach

- **Doctor skill pattern** matches other Interverse plugins (clavain has `/clavain:doctor`)
- **Hooks provide ambient awareness** — the user doesn't need to remember to check health manually
- **Building on existing infrastructure** — `interkasten_health` MCP tool already does the heavy lifting; the skill orchestrates and formats

## Key Decisions

1. **Doctor is a skill, not an MCP tool** — it needs to run agent-side logic (calling multiple tools, formatting output) rather than server-side
2. **SessionStart hook is informational only** — no blocking, just a status line
3. **Stop hook warns but doesn't block** — pending WAL is information, not an error
4. **Check order matters** — early checks (config, token) gate later checks (MCP, Notion) to avoid cascading failures

## Open Questions

None — scope is narrow enough to proceed directly to planning.
