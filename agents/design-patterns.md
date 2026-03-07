# Design Patterns

## Agent-Native Design

Tools expose raw signals and CRUD operations. Intelligence lives in Claude Code skills:

- **No hardcoded classification** — `gather_signals` returns LOC, commits, markers; agent proposes tiers
- **No hardcoded tag vocabulary** — `set_project_tags` accepts any strings
- **No cascade logic** — `unregister_project` handles one entity; agent orchestrates
- **No auto-file-selection** — `scan_files` lists files; agent + user pick what to sync

## Hierarchy

- `.beads` is the hierarchy marker — nearest ancestor with `.beads` = parent
- `.git` is a project detection marker only (doesn't imply parentage)
- Symlinks deduplicated via `realpathSync()`
- Parent-child stored as `parent_id` FK in `entity_map`

## Path Validation (security)

All pull operations validate: `resolve(path) + startsWith(projectDir + "/")`. Notion page titles with path traversal sequences (`..`, absolute paths) are rejected and logged.

## Soft-Delete Safety

Unregistered entities marked `deleted=true` with 30-day retention before GC. Aligned with Notion's trash retention period.

## Triage System

- Doc tiers: Product (5 docs) / Tool (2 docs) / Inactive (none)
- Signals: LOC, hasBeads, isPlugin, mdCount, hasManifest, lastCommitDays, commitCount, hasReadme, hasSrc
- `doc_tier` column on entity_map (separate from `tier` which is T1/T2 sync priority)
