# interkasten:layout — Interactive Project Discovery & Layout

Guide the user through discovering, organizing, and registering their projects for Notion sync.

## Trigger

Use when: user says "set up projects", "discover projects", "organize my projects", "layout", or invokes `/interkasten:layout`.

## Prerequisites

- interkasten MCP server running (tools available: `interkasten_scan_preview`, `interkasten_register_project`, `interkasten_set_project_parent`, `interkasten_set_project_tags`, `interkasten_add_database_property`, `interkasten_gather_signals`)
- Notion token set and `interkasten_init` completed (database exists)

## Workflow

### Step 1: Scan

Call `interkasten_scan_preview` with no arguments (uses configured `projects_dir`).

Present the discovered tree to the user as a visual hierarchy:

```
Found 14 projects:

~/projects/Interverse/          [.beads]
  hub/clavain/                  [.git, .beads]  15,000 LOC  247 commits
  plugins/interflux/            [.git, .beads]   3,200 LOC   89 commits
  plugins/interkasten/          [.git, .beads]   4,500 LOC  156 commits
  plugins/intermute/            [.git, .beads]   2,100 LOC   63 commits
  ...

~/projects/standalone-tool/     [.git]            800 LOC   12 commits

Symlinks skipped: ~/projects/clavain → (duplicate of hub/clavain)
```

Ask: "Does this look right? Any projects missing or incorrectly grouped?"

### Step 2: Hierarchy Review

Walk through the tree with the user:

- **Parent-child from `.beads` nesting**: "Interverse is the parent of clavain, interflux, etc. because they're nested inside its `.beads` boundary. Does this grouping look correct?"
- **Standalone projects**: "These projects appear standalone (no parent): [list]. Are any of them actually related?"
- **Cross-root links**: If the user says two projects in different roots are related, explain: "I can link them in the database, but the scanner won't detect this automatically on re-scan. You'd need to confirm it each time."
- **Corrections**: Use `interkasten_set_project_parent` to adjust hierarchy per user feedback.

### Step 3: Classification

For each project (or batch of similar ones), look at the signals from `interkasten_gather_signals` and propose:

- **Doc tier** with reasoning:
  - "clavain: 15,000 LOC, 247 commits, has beads, has plugin.json, active development — this looks like a **Product** project that needs full documentation (Vision, PRD, Roadmap, AGENTS.md, CLAUDE.md)"
  - "standalone-tool: 800 LOC, 12 commits, no recent activity — this looks like a **Tool** that just needs AGENTS.md and CLAUDE.md"
  - "old-experiment: 200 LOC, last commit 2 years ago — this might be **Inactive**. Want to skip it?"

- **Tags** based on signals:
  - `has_plugin_json` → suggest "claude-plugin"
  - `has_go_mod` → suggest "go"
  - `has_dockerfile` → suggest "deployable"
  - Always ask: "Any other tags you'd use for this project?"

- **Status**: "Active" for recent commits, "Archived" for stale projects. Let the user override.

Present proposals in batches (3-5 projects at a time) to avoid overwhelming the user. Group similar projects together.

### Step 4: Notion Schema

Before registering projects, set up the database schema:

Ask: "Your Projects database currently has Name and Last Sync. I'd recommend adding these properties — want all of them, or just some?"

Recommended properties:
- **Status** (select): Active, Planning, Paused, Archived
- **Doc Tier** (select): Product, Tool, Inactive
- **Tags** (multi_select): (populated from Step 3)
- **Parent Project** (relation): Self-referential for hierarchy
- **Key doc columns** (url): Vision, PRD, Roadmap, AGENTS.md, CLAUDE.md

Optional properties (suggest if relevant signals exist):
- **Tech Stack** (multi_select): Based on detected manifests
- **LOC** (number): Lines of code
- **Health** (select): Healthy, Needs Attention, Stale

Call `interkasten_add_database_property` for each confirmed property.

### Step 5: Register

Register confirmed projects with their confirmed properties. **Parent-first, children after** to ensure parent_id references are valid.

For each project:
1. Call `interkasten_register_project` with `path`, `parent_project` (if applicable), and `properties` (Status, Doc Tier, etc.)
2. Call `interkasten_set_project_tags` with the confirmed tags
3. Report the Notion URL so the user can verify

Show progress: "Registered 5/14 projects..."

### Step 6: File Selection

For each registered project, scan for syncable files:

1. Call `interkasten_scan_files` with `pattern: "**/*.md"` and `include_size: true`
2. Categorize files for the user:
   - **Key docs** (CLAUDE.md, AGENTS.md, Vision.md, PRD*.md, Roadmap.md) — recommend syncing
   - **Project docs** (in docs/ directory) — recommend syncing
   - **Notes/scratch** (TODO.md, scratch.md, CHANGELOG.md) — let user decide
   - **Generated/large** (>50KB) — warn, let user decide

Present: "Found 8 markdown files in clavain. I'd sync these 5 key/project docs. The other 3 look like working notes — want to include them?"

Register selected files for sync via the existing doc registration flow.

## Conversational Patterns

Handle these user intents naturally:

| User says | Action |
|-----------|--------|
| "These are all part of the same project" | `set_project_parent` to group them |
| "This one is standalone" | Register with `parent: null` |
| "Skip this" / "Don't register this one" | Skip registration, move to next |
| "These are all plugins" | Batch-tag with `set_project_tags` |
| "Re-scan" / "Scan again" | Re-run `scan_preview` |
| "Add a custom field" | `add_database_property` with user's spec |
| "What does this project do?" | Read its README.md or CLAUDE.md and summarize |
| "Show me the Notion page" | Provide the Notion URL from the entity |
| "I reorganized my projects" | Full re-scan, detect orphans (registered but path missing) |
| "Just register everything" | Batch-register all with reasonable defaults, minimal prompting |

## Batch Mode

If the user has many projects (>10), offer batch mode:

"You have 23 projects. Want me to:
1. Walk through each one (thorough but slower)
2. Auto-classify based on signals and just show you the summary for confirmation (faster)
3. Register everything with defaults, you can adjust later"

For option 2: classify all projects, present a summary table, ask for corrections, then batch-register.

## Config Persistence

After layout is confirmed, save layout preferences to config via `interkasten_config_set`:

```yaml
layout:
  resolve_symlinks: true
  overrides:
    - path: "~/projects/Interverse/experiments"
      skip: true
```

This ensures future re-scans respect the user's decisions.

## Error Handling

- If `scan_preview` finds no projects: suggest checking `projects_dir` in config
- If Notion token is invalid: guide user to set `INTERKASTEN_NOTION_TOKEN`
- If a registration fails: log, continue with next project, report at end
- If database property creation fails: warn but continue (property may already exist)

## Output

End with a summary:

```
Layout complete!

Registered: 12 projects (3 Product, 7 Tool, 2 Inactive)
Hierarchy: 1 monorepo (Interverse) with 10 children, 2 standalone
Tags: claude-plugin (5), go (2), deployable (3), mcp-server (4)
Files selected for sync: 47 docs across 12 projects
Notion database: https://notion.so/...

Next steps:
- Run /interkasten:onboard to generate missing docs and establish drift baselines
- Run interkasten_sync to push selected files to Notion
```
