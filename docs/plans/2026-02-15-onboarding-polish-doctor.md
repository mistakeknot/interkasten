# Plan: Onboarding Polish + Doctor Command

**Date:** 2026-02-15
**Brainstorm:** `docs/brainstorms/2026-02-15-onboarding-polish-doctor-brainstorm.md`
**Beads:** Interkasten-axb (doctor skill), Interkasten-l8q (hooks), Interkasten-aha (doctor command)

## Overview

Add `/interkasten:doctor` diagnostic skill + command, and populate the empty `hooks/hooks.json` with SessionStart and Stop lifecycle hooks.

## Module 1: Doctor Skill (Interkasten-axb)

**File:** `skills/doctor/SKILL.md`

Create a skill that runs a cascading diagnostic checklist. Each check gates the next to avoid cascading failures.

### Check sequence:

1. **Config file** — `~/.interkasten/config.yaml` exists? If not: "Run `interkasten_init` to create it."
2. **Notion token** — `INTERKASTEN_NOTION_TOKEN` env var set? If not: step-by-step setup instructions.
3. **MCP server** — Call `interkasten_health` tool. If it fails: "MCP server not running. Check plugin installation."
4. **Parse health response** — Extract from JSON:
   - SQLite connected (bool)
   - Notion circuit state (closed/open/half-open)
   - Notion last success time
   - Consecutive failures count
   - WAL pending entries
   - Uptime, version, memory
5. **Project count** — Call `interkasten_list_projects`. Report count and any orphaned projects (path doesn't exist).
6. **Hooks status** — Read `hooks/hooks.json` and report whether hooks are defined.

### Output format:

Formatted checklist with pass/fail/warn status per check. Summary line at bottom: "N/M checks passed. K warnings."

### Gating logic:

If check 1 or 2 fails, stop and show remediation. Don't attempt MCP calls without valid config/token. If check 3 fails, report remaining checks as "skipped (MCP unavailable)".

## Module 2: Lifecycle Hooks (Interkasten-l8q)

**File:** `hooks/hooks.json` + `hooks/session-status.sh` + `hooks/session-end-warn.sh`

### SessionStart hook: `session-status.sh`

- **Event:** Notification on SessionStart
- **What it does:** Call `interkasten_health` MCP tool (if reachable), parse response, print one-line status
- **Output format:** `interkasten: N projects, M pending WAL, circuit {state}, last sync {time}`
- **Failure mode:** If MCP not reachable, print nothing (silent skip). Sessions shouldn't be delayed by interkasten issues.
- **Implementation:** Shell script that reads stdin JSON (per hook API), calls the health tool via `curl` or simply uses `additionalContext` to inject status.

Actually — hooks can't call MCP tools directly (they're shell scripts, not MCP clients). The right approach:

**Revised SessionStart hook:** Read `~/.interkasten/config.yaml` to check if interkasten is configured. If yes, print a brief "interkasten configured" message. Don't try to query the MCP server from a shell hook.

**Revised Stop hook:** Same limitation. Check if `~/.interkasten/interkasten.db` exists, use `sqlite3` to query WAL count. If >0, warn "N pending sync operations".

### hooks.json structure:

```json
{
  "hooks": [
    {
      "event": "Notification",
      "matcher": "SessionStart",
      "script": "hooks/session-status.sh",
      "timeout": 5000
    },
    {
      "event": "Notification",
      "matcher": "Stop",
      "script": "hooks/session-end-warn.sh",
      "timeout": 5000
    }
  ]
}
```

## Module 3: Doctor Command (Interkasten-aha)

**File:** `commands/doctor.md`

Thin wrapper that loads and executes the doctor skill. Follow the existing `commands/onboard.md` pattern.

**Also update:** `.claude-plugin/plugin.json` to register the new skill and command.

## Execution Order

1. Module 1 (doctor skill) — no dependencies
2. Module 2 (hooks) — no dependencies, parallel with Module 1
3. Module 3 (doctor command + plugin.json update) — depends on Module 1

## Testing

- Build passes (`cd server && npm run build`)
- Existing 79 tests still pass (`npm test`)
- Manual: `/interkasten:doctor` produces formatted output
- Manual: Session start shows interkasten status line (if configured)

## Files Changed

| File | Action |
|------|--------|
| `skills/doctor/SKILL.md` | Create |
| `commands/doctor.md` | Create |
| `hooks/hooks.json` | Edit (populate) |
| `hooks/session-status.sh` | Create |
| `hooks/session-end-warn.sh` | Create |
| `.claude-plugin/plugin.json` | Edit (add skill + command) |
