# interkasten:onboard (compact)

Orchestrate classification, doc generation, drift scanning, and sync for all registered projects.

## When to Invoke

"onboard projects", "fill doc gaps", "generate docs for my projects", or `/interkasten:onboard`.

## Prerequisites

interkasten MCP running, Notion token set, projects registered (run `/interkasten:layout` first if none).

## Workflow

1. **Check layout** — `interkasten_list_projects`. If none registered, redirect to `/interkasten:layout`.
2. **Classify** — For projects without doc_tier: `interkasten_gather_signals`, propose tier:
   - **Product** (>1000 LOC, active): Vision, PRD, Roadmap, AGENTS.md, CLAUDE.md
   - **Tool** (moderate): AGENTS.md + CLAUDE.md
   - **Inactive** (stale): skip
   - Confirm with user, update tiers.
3. **Generate missing docs** — Product: Vision -> PRD -> Roadmap -> AGENTS.md -> CLAUDE.md (each builds on previous). Tool: AGENTS.md -> CLAUDE.md. Inactive: skip. Report progress.
4. **Drift baseline** — `interwatch:doc-watch` per Product/Tool project. Skip if unavailable.
5. **Sync & report** — `interkasten_sync` + `interkasten_refresh_key_docs`.

## Key Rules

- Always log and continue on failure (never block remaining projects)
- Output summary table: Project | Tier | Docs Generated | Gaps | Drift Baseline
- If interwatch unavailable, skip drift baselines and note in summary

---
*For full phase details and doc generation delegation, read SKILL.md.*
