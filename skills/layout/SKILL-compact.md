# interkasten:layout (compact)

Interactive project discovery, organization, and registration for Notion sync.

## When to Invoke

"set up projects", "discover projects", "organize my projects", "layout", or `/interkasten:layout`.

## Prerequisites

interkasten MCP server running, Notion token set, `interkasten_init` completed.

## Workflow

1. **Scan** — `interkasten_scan_preview` to discover projects. Show visual hierarchy with LOC/commits. Ask user to confirm.
2. **Hierarchy review** — Parent-child from `.beads` nesting. Walk through standalone vs grouped projects. Adjust with `interkasten_set_project_parent`.
3. **Classification** — Use `interkasten_gather_signals` per project. Propose:
   - **Doc tier**: Product (>1000 LOC, active, full docs), Tool (moderate, AGENTS.md+CLAUDE.md), Inactive (stale, skip)
   - **Tags**: from signals (claude-plugin, go, deployable, etc.)
   - **Status**: Active/Archived based on recency
   - Present in batches of 3-5 projects
4. **Notion schema** — Add database properties: Status, Doc Tier, Tags, Parent Project, key doc URLs. Use `interkasten_add_database_property`.
5. **Register** — Parent-first, then children. `interkasten_register_project` + `interkasten_set_project_tags`. Show progress.
6. **File selection** — `interkasten_scan_files` per project. Categorize: key docs (recommend sync), project docs (recommend), notes/scratch (ask), generated/large >50KB (warn).

## Conversational Patterns

| User says | Action |
|-----------|--------|
| "These are all part of the same project" | `set_project_parent` |
| "Skip this" | Skip, move to next |
| "Just register everything" | Batch with defaults |
| "Re-scan" | Re-run `scan_preview` |

## Batch Mode (>10 projects)

Offer: 1) Walk through each, 2) Auto-classify + summary for confirmation, 3) Register all with defaults.

## Output

Summary: registered count by tier, hierarchy, tags, files selected, Notion URL. Next steps: run `/interkasten:onboard`, then `interkasten_sync`.

---
*For config persistence, error handling, and full conversational patterns, read SKILL.md.*
