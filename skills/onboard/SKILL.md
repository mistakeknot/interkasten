# interkasten:onboard — Project Onboarding & Doc Gap Fill

Orchestrate triage, doc generation, drift scanning, and sync for all registered projects.

## Trigger

Use when: user says "onboard projects", "fill doc gaps", "triage and generate docs", or invokes `/interkasten:onboard`.

## Prerequisites

- Interkasten MCP server running (tools available: `interkasten_triage`, `interkasten_sync`, `interkasten_refresh_key_docs`)
- Notion token set (`INTERKASTEN_NOTION_TOKEN`)
- Projects registered via `interkasten_init`

## Workflow

### Phase 1: Triage

1. Call `interkasten_triage(apply=true)` to classify all projects
2. Parse the JSON response — group projects by tier (Product, Tool, Inactive)
3. Report tier distribution to user before proceeding

### Phase 2: Generate Missing Docs

Read `skills/onboard/phases/generate.md` for generation order and rules.

For each **Product** project with required-missing docs:
- `cd` to the project directory
- Invoke `interpath:artifact-gen` for each missing doc in order: Vision → PRD → Roadmap → AGENTS.md → CLAUDE.md
- Each doc depends on prior docs for context, so generate sequentially

For each **Tool** project missing AGENTS.md or CLAUDE.md:
- Invoke `interdoc:interdoc` for AGENTS.md if missing
- Create a stub CLAUDE.md if missing (project name + quick start section)

Skip **Inactive** projects entirely.

### Phase 3: Drift Baseline

Read `skills/onboard/phases/watch.md` for baseline setup rules.

For each Product and Tool project:
- Invoke `interwatch:doc-watch` to establish baseline confidence scores
- This creates the initial drift reference points

### Phase 4: Sync & Report

1. Call `interkasten_sync` to push all new/updated docs to Notion
2. Call `interkasten_refresh_key_docs` to update Notion columns
3. Report summary:
   - Projects triaged (count per tier)
   - Docs generated (count per type)
   - Docs still missing (if any generation failed)
   - Drift baselines established

## Error Handling

- If a doc generation fails, log and continue with next project
- If Notion sync fails, report but don't block remaining projects
- If interwatch is unavailable, skip Phase 3 and note it in summary

## Output

Provide a structured summary table at the end:

```
| Project | Tier | Docs Generated | Gaps Remaining | Drift Baseline |
|---------|------|----------------|----------------|----------------|
| ...     | ...  | ...            | ...            | ...            |
```
