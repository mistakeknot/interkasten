---
description: "Project Onboarding & Doc Gap Fill"
---

# interkasten:onboard — Project Onboarding & Doc Gap Fill

Orchestrate classification, doc generation, drift scanning, and sync for all registered projects.

## Trigger

Use when: user says "onboard projects", "fill doc gaps", "generate docs for my projects", or invokes `/interkasten:onboard`.

## Prerequisites

- interkasten MCP server running (tools available: `interkasten_gather_signals`, `interkasten_list_projects`, `interkasten_sync`, `interkasten_scan_files`)
- Notion token set (`INTERKASTEN_NOTION_TOKEN`)
- Projects registered (run `/interkasten:layout` first if no projects exist)

## Workflow

### Phase 0: Check Layout

1. Call `interkasten_list_projects`
2. If no projects are registered, tell the user: "No projects registered yet. Run `/interkasten:layout` first to discover and organize your projects."
3. If projects exist, continue to Phase 1.

### Phase 1: Classification

For each registered project without a doc_tier set:

1. Call `interkasten_gather_signals(project)` to get raw filesystem/git signals
2. Analyze the signals and propose a doc tier:
   - **Product**: High LOC (>1000), active commits, has manifest, has src + tests — needs full docs (Vision, PRD, Roadmap, AGENTS.md, CLAUDE.md)
   - **Tool**: Moderate LOC, has manifest, simpler structure — needs AGENTS.md + CLAUDE.md
   - **Inactive**: Low LOC or stale (last commit >6 months) — skip doc generation
3. Present the proposed classification to the user:
   ```
   Project Classification:
   Product (full docs): clavain, interflux, interkasten
   Tool (basic docs): standalone-tool, tiny-util
   Inactive (skip): old-experiment
   ```
4. Ask: "Does this look right? I can adjust any project."
5. Update doc_tier on each project via `interkasten_register_project` properties

### Phase 2: Generate Missing Docs

For each project, call `interkasten_scan_files(project, "**/*.md")` to see what docs already exist.

**Product projects** — generate missing docs in order (each builds on the previous):
1. Vision.md (if missing) — via `interpath:vision`
2. PRD.md (if missing) — via `interpath:prd`
3. Roadmap.md (if missing) — via `interpath:roadmap`
4. AGENTS.md (if missing) — via `interdoc:interdoc`
5. CLAUDE.md (if missing) — create stub with project name + quick start

**Tool projects** — generate if missing:
1. AGENTS.md — via `interdoc:interdoc`
2. CLAUDE.md — create stub if missing

**Inactive projects** — skip entirely.

Report progress as you go: "Generated Vision.md for clavain (1/5 docs)..."

### Phase 3: Drift Baseline

For each Product and Tool project:
- Invoke `interwatch:doc-watch` to establish baseline confidence scores
- This creates the initial drift reference points

If interwatch is unavailable, skip this phase and note it in the summary.

### Phase 4: Sync & Report

1. Call `interkasten_sync` to push all new/updated docs to Notion
2. Call `interkasten_refresh_key_docs` to update key doc URL columns in Notion
3. Report summary

## Error Handling

- If a doc generation fails, log and continue with next project
- If Notion sync fails, report but don't block remaining projects
- If interwatch is unavailable, skip Phase 3 and note it in summary
- If a project's path no longer exists, warn and skip it

## Output

Provide a structured summary table at the end:

```
Onboarding Complete!

| Project    | Tier    | Docs Generated        | Gaps Remaining | Drift Baseline |
|------------|---------|----------------------|----------------|----------------|
| clavain    | Product | Vision, PRD          | none           | established    |
| interflux  | Product | Roadmap              | none           | established    |
| tiny-util  | Tool    | AGENTS.md            | none           | established    |
| old-exp    | Inactive| (skipped)            | -              | -              |

Total: 4 docs generated, 0 gaps remaining, 3 baselines established
```
