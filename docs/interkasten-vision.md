# Interkasten: Vision and Philosophy

**Version:** 0.4.0
**Date:** 2026-02-16
**Status:** Active

Interkasten is a bidirectional Notion sync plugin for Claude Code. It keeps project documentation, hierarchy, and status synchronized between local repositories and Notion with three-way merge conflict resolution, beads issue tracking, and an agent-native interface.

## What Interkasten Is

Interkasten has three core layers:

- A Claude Code plugin experience (skills + command)
  - `layout` skill: discovery, hierarchy, registration, metadata selection
  - `onboard` skill: triage, docs baseline generation, drift baseline setup, sync
  - `onboard` command: same workflow for non-skill execution
- One MCP server that exposes tooling for project lifecycle and sync control
- A local SQLite state layer that tracks entity mapping, sync state, and operation history

## Why Notion-to-Local Sync Matters for Agents

For agents working across many projects, local context becomes the source of truth for execution, but Notion often becomes the destination for planning and documentation. Interkasten removes that split by making Notion and local docs part of a single bidirectional information loop.

This matters because agents can:

1. Read live project metadata from Notion before touching files.
2. Detect drift between docs, code, and workspace state without brittle heuristics.
3. Act on reliable signals (commits, file counts, existing docs, hierarchy, tags) rather than guesses.
4. Keep humans in control by proposing actions instead of enforcing hidden automation.

## Design Philosophy

### SQLite for durable coordination state

Interkasten stores synchronization metadata in local SQLite so the MCP tools can recover from interruptions, replay pending operations, and maintain explicit source-of-truth mapping between file locations and Notion entity IDs.

### MCP as an operational boundary

The MCP layer is intentionally low-level and explicit. Tools provide deterministic actions (`register`, `scan`, `sync`, `status`, `log`, `set_parent`, `set_tags`, etc.) and avoid hidden orchestration. Intelligence lives above MCP in skills and agent prompts.

### Triage as first-class signal, not control flow

`interkasten_gather_signals` returns raw signals (structure, activity, existing docs, markers) and lets the agent interpret them. The plugin avoids hardcoded tiering rules or required-doc policies so agents can reason context-sensitively and users can override safely.

### Minimal hard rules, maximum observable behavior

Interkasten only hardcodes operational guardrails (for example, directory exclusions and safe defaults). Everything that changes project meaning—classification, required documentation, schema choices, sync selection—is delegated to agent logic and user confirmation.

## Conflict Resolution

When both local and Notion sides change, interkasten uses three-way merge via `node-diff3`:
- Non-overlapping changes merge automatically
- Overlapping conflicts use a configurable strategy: `three-way-merge` (default with local-wins fallback), `local-wins`, `notion-wins`, or `conflict-file`
- Conflicts are tracked in the database and surfaced via `interkasten_conflicts`

## Beads Integration

Beads issues sync bidirectionally with Notion pages. The engine diffs local beads state against a stored snapshot, pushes new/modified issues to Notion, and can pull Notion-side status changes back to beads via `bd` CLI.

## End State

Interkasten should feel like a living interface: Notion is still usable as a collaboration surface, and local files remain execution-critical. The plugin's job is to keep both surfaces coherent and let agents turn coherence into action.
