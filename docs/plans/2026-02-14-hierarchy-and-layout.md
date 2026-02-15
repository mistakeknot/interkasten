# Interkasten: Hierarchical Projects & Agent-Native Architecture

**Date**: 2026-02-14
**Status**: Approved
**Scope**: Scanner hierarchy via `.beads`, Notion parent-child + tags, agent-native tool refactoring, interactive layout skill

---

## Problem Statement

Projects moved from `~/projects/<name>` to `~/projects/Interverse/<group>/<name>`. The scanner discovers projects as a flat list and stops recursing at the first marker. It cannot represent that `clavain` is a child of `Interverse`, or that `interflux` and `intermute` are siblings within the same monorepo.

Additionally, many tool-layer decisions (triage classification, required docs, file selection, status defaults) are hardcoded when they should be agent decisions. For a product sold on Notion marketplace to beginners, the UX should be conversational — Claude Code proposes, the user confirms.

---

## Design Principles

### Agent-native: tools are CRUD, intelligence is in the agent

Tools expose raw signals and low-level operations. Claude Code interprets signals, proposes actions, and confirms with the user. This means:

- **No hardcoded classification** — tool gathers signals (LOC, commits, file types), agent proposes tiers
- **No hardcoded "required docs"** — tool lists what exists, agent recommends what's missing
- **No hardcoded tag vocabulary** — tool stores whatever tags the agent and user agree on
- **No cascade/confirmation logic in tools** — tool operates on one entity, agent orchestrates multi-step operations
- **No auto-sync of arbitrary files** — tool scans, agent presents, user picks

### Guardrails stay in tools

"Obviously correct" safety remains hardcoded:
- Exclude `node_modules`, `.cache`, `vendor`, `dist`, `build`, `.next`, `venv` from file scans
- Minimum Notion database schema: `Name` (title) + `Last Sync` (date)
- Soft-delete, never hard-delete
- Symlink deduplication via `realpathSync()`

### Hierarchy signal: `.beads` only

`.beads` is the hierarchy marker. `.git` is a project detection marker but doesn't imply parentage.

> If project A has `.beads` and project B has `.beads`, and A's path is a proper ancestor of B's path (with no closer `.beads` ancestor), then A is B's parent.

Filesystem-derived, not config-derived. Persisted in SQLite + Notion after scan.

Intermediate directories without markers (like `hub/`, `plugins/`) are transparent — traversed but not registered.

### Cross-root hierarchy

Scanner auto-detects hierarchy only within a single root directory. `set_project_parent` is permissive — can link any two registered projects regardless of location. Claude Code reviews unusual requests (cross-root links) and explains tradeoffs to the user before applying.

---

## Design Decisions (Resolved)

| Question | Decision |
|----------|----------|
| Cascade on unregister | Tool unregisters one project. Agent checks for children, explains situation, asks user, calls tool in the right order. No `--cascade` flag. |
| Tag vocabulary | No built-in vocabulary. `scan_preview` returns raw signals. Agent proposes tags conversationally. `set_project_tags` accepts any strings. Notion multi-select creates options on the fly. |
| Cross-root hierarchy | Filesystem-only auto-detection. `set_project_parent` is permissive. Agent is the gatekeeper for unusual links. |
| Scan performance | Keep it simple. Exclude list handles explosion dirs. `max_depth` in config for edge cases. No timeouts, no progressive scan. |
| Triage thresholds | Removed from tool. Tool exposes `interkasten_gather_signals`. Agent interprets and proposes tier. |
| Required docs | Removed from tool. Agent decides what docs a project needs based on signals + context. |
| File selection for sync | Tool scans and lists files. Agent presents to user. User picks what to sync. No "first 20 .md files" auto-behavior. |
| Notion schema | Tool creates minimal database (Name + Last Sync). Agent proposes additional properties. User confirms. |
| Status defaults | Tool accepts whatever status the agent provides. No hardcoded "Active" default. |

---

## Implementation Plan

### Phase 1: Schema & Migration

**Goal**: Add `parent_id` and `tags` to the data model. Backward compatible.

#### 1.1 SQLite schema migration

File: `server/src/store/db.ts`

Conditional migration (same pattern as existing `doc_tier` migration):

```sql
ALTER TABLE entity_map ADD COLUMN parent_id INTEGER REFERENCES entity_map(id);
ALTER TABLE entity_map ADD COLUMN tags TEXT DEFAULT '[]';
CREATE INDEX IF NOT EXISTS idx_entity_map_parent_id ON entity_map(parent_id);
```

`parent_id` nullable — null means top-level. Self-referential FK.
`tags` is JSON text (`["claude-plugin", "mcp-server"]`).

#### 1.2 Drizzle schema update

File: `server/src/store/schema.ts`

```typescript
parentId: integer("parent_id").references(() => entityMap.id),
tags: text("tags").default("[]"),
```

#### 1.3 Entity map operations

File: `server/src/sync/entity-map.ts`

- `registerProject()` gains optional `parentId?: number` and `tags?: string[]`
- New query functions:
  - `getProjectChildren(db, parentId)` — direct children only
  - `getProjectParent(db, projectId)` — parent or null
  - `getProjectAncestors(db, projectId)` — path to root
  - `setProjectTags(db, projectId, tags)` — replace tags
  - `setProjectParent(db, projectId, parentId)` — reparent
- `listProjects()` returns `parentId` and `tags` in results

---

### Phase 2: Scanner Hierarchy

**Goal**: `discoverProjects()` returns a tree. Hierarchy derived from `.beads` nesting.

#### 2.1 Discovery function rewrite

File: `server/src/daemon/tools/init.ts`

New return type:

```typescript
interface DiscoveredProject {
  path: string;
  markers: string[];           // which markers found ([".git"], [".beads"], [".git", ".beads"])
  children: DiscoveredProject[];
}
```

New behavior:
1. Scan directory entries
2. If dir has the hierarchy marker (`.beads`): register as project, **continue recursing** for nested projects
3. If dir has only non-hierarchy markers (`.git` without `.beads`): register as leaf project, don't recurse
4. Intermediate directories without any marker: don't register, but do recurse
5. Parent-child: nearest ancestor with `.beads` is the parent

#### 2.2 Config changes

File: `server/src/config/schema.ts` and `defaults.ts`

```typescript
export const ProjectDetectionSchema = z.object({
  markers: z.array(z.string()).default([".git", ".beads"]),
  exclude: z.array(z.string()).default(["node_modules", ".cache", "vendor", "dist", "build", ".next", "venv"]),
  max_depth: z.number().int().min(1).max(10).default(5),
  hierarchy_marker: z.string().default(".beads"),
});
```

#### 2.3 Symlink deduplication

Resolve paths with `realpathSync()` before registering. If resolved path already seen, skip.

---

### Phase 3: Agent-Native Tool Refactoring

**Goal**: Move classification, selection, and schema decisions from tools to the agent layer.

#### 3.1 Replace `interkasten_triage` with `interkasten_gather_signals`

Current tool classifies projects into Product/Tool/Inactive with hardcoded thresholds.

New tool returns raw signals only:

```typescript
{
  name: "interkasten_gather_signals",
  description: "Gather filesystem and git signals for a project. Returns raw data for the agent to interpret — does NOT classify or recommend.",
  inputSchema: {
    properties: {
      project: { type: "string", description: "Project name or path" },
    },
    required: ["project"],
  },
}
```

Returns:
```json
{
  "loc": 4523,
  "has_beads": true,
  "has_plugin_json": true,
  "has_go_mod": false,
  "has_dockerfile": true,
  "md_count": 12,
  "has_manifest": true,
  "manifest_type": "package.json",
  "last_commit_days": 3,
  "commit_count": 247,
  "has_readme": true,
  "has_src": true,
  "has_tests": true,
  "existing_docs": ["CLAUDE.md", "AGENTS.md", "PRD-MVP.md"],
  "file_count": 89,
  "directory_structure": ["src/", "docs/", "tests/", "scripts/"]
}
```

The `classifyProject()` function and `TIER_DOC_REQUIREMENTS` map are removed from the tool. The agent reads the signals, considers the project context, and proposes a tier + required docs.

#### 3.2 Replace `interkasten_refresh_key_docs` with `interkasten_scan_files`

Current tool searches for 5 hardcoded doc types in hardcoded locations.

New tool scans for all files and returns them:

```typescript
{
  name: "interkasten_scan_files",
  description: "Scan a project directory for files. Returns file list with metadata. Does not decide which files matter — that's the agent's job.",
  inputSchema: {
    properties: {
      project: { type: "string" },
      pattern: { type: "string", description: "Glob pattern (default: '**/*.md')" },
      include_size: { type: "boolean", description: "Include file sizes" },
    },
    required: ["project"],
  },
}
```

The agent looks at the file list, identifies key docs, and calls existing registration tools for the ones that matter.

#### 3.3 Simplify `interkasten_init`

Current init does everything: creates databases, discovers projects, auto-registers, auto-syncs files, auto-triages.

New init does the minimum:
1. Validate Notion token
2. Create minimal database (Name + Last Sync) — or find existing one
3. Store database ID in config
4. Return success with database info

Everything else (discovering projects, choosing what to register, setting tiers, selecting files to sync) is orchestrated by the agent via the layout skill.

#### 3.4 Make `interkasten_register_project` accept agent-specified properties

Current tool hardcodes `Status: "Active"` and creates a fixed set of Notion properties.

New tool accepts whatever properties the agent provides:

```typescript
{
  name: "interkasten_register_project",
  inputSchema: {
    properties: {
      path: { type: "string" },
      parent_project: { type: "string", description: "Parent project name or path (optional)" },
      properties: {
        type: "object",
        description: "Notion page properties to set (Status, Tags, Doc Tier, etc.)",
      },
    },
    required: ["path"],
  },
}
```

#### 3.5 Add `interkasten_add_database_property`

New tool for the agent to evolve the Notion schema:

```typescript
{
  name: "interkasten_add_database_property",
  description: "Add a property to the Projects database. Idempotent — skips if property already exists.",
  inputSchema: {
    properties: {
      name: { type: "string" },
      type: { type: "string", enum: ["select", "multi_select", "url", "date", "number", "rich_text", "relation", "checkbox"] },
      options: { type: "array", description: "For select/multi_select: initial options" },
    },
    required: ["name", "type"],
  },
}
```

This lets the agent build up the schema conversationally: "Want to track Tech Stack? Health Score? Custom fields?"

#### 3.6 New tool: `interkasten_scan_preview`

Non-destructive discovery that returns the full tree with signals:

```typescript
{
  name: "interkasten_scan_preview",
  description: "Preview what projects would be discovered. Returns hierarchy tree with raw signals for each project. Writes nothing to SQLite or Notion.",
  inputSchema: {
    properties: {
      root_dir: { type: "string" },
      max_depth: { type: "number" },
    },
  },
}
```

Returns:
```json
{
  "root": "~/projects",
  "projects": [
    {
      "path": "/root/projects/Interverse",
      "markers": [".beads"],
      "signals": { "loc": 0, "md_count": 3, ... },
      "children": [
        {
          "path": "/root/projects/Interverse/hub/clavain",
          "markers": [".git", ".beads"],
          "signals": { "loc": 15000, "has_plugin_json": true, ... },
          "children": []
        }
      ]
    },
    {
      "path": "/root/projects/standalone-tool",
      "markers": [".git"],
      "signals": { ... },
      "children": []
    }
  ],
  "symlinks_skipped": [
    { "link": "/root/projects/clavain", "target": "/root/projects/Interverse/hub/clavain" }
  ]
}
```

#### 3.7 New tools: `interkasten_set_project_parent` and `interkasten_set_project_tags`

Simple CRUD for hierarchy and tags:

```typescript
// Set parent (null to make top-level)
interkasten_set_project_parent(project: string, parent: string | null)

// Set tags (replaces all tags)
interkasten_set_project_tags(project: string, tags: string[])
```

No merge logic, no auto-detection. Agent decides, tool applies.

---

### Phase 4: Downstream Fixes

**Goal**: Replace all `startsWith` path containment with parent_id queries.

#### 4.1 Replace path-based containment (4 locations)

Current pattern:
```typescript
allEntities.filter(e => e.localPath.startsWith(project.localPath))
```

Problem: With hierarchy, Interverse's path is a prefix of clavain's path, but clavain's docs belong to clavain, not Interverse.

New pattern:
```typescript
getDocsForProject(db, projectId)  // WHERE parent_id = projectId AND entity_type = 'doc'
```

Affected locations:
1. `server/src/sync/key-docs.ts` — `enrichWithNotionIds()`
2. `server/src/daemon/tools/projects.ts` — `interkasten_get_project`
3. `server/src/daemon/tools/projects.ts` — `interkasten_unregister_project`
4. `server/src/daemon/tools/sync.ts` — sync doc discovery

#### 4.2 Update project display tools

**`interkasten_list_projects`** — include hierarchy and tags in output:

```json
[
  {
    "name": "Interverse",
    "parent": null,
    "children": ["clavain", "interflux", "intermute"],
    "tags": ["monorepo"],
    "doc_tier": "Product",
    "notion_url": "...",
    "last_sync": "..."
  },
  {
    "name": "clavain",
    "parent": "Interverse",
    "children": [],
    "tags": ["claude-plugin"],
    "doc_tier": "Product",
    "notion_url": "...",
    "last_sync": "..."
  }
]
```

**`interkasten_get_project`** — add parent, children, tags, and raw signals:

```json
{
  "name": "clavain",
  "parent": { "name": "Interverse", "notion_url": "..." },
  "children": [],
  "tags": ["claude-plugin"],
  "signals": { "loc": 15000, "commit_count": 247, ... },
  "docs": [...],
  ...
}
```

---

### Phase 5: Interactive Layout Skill

**Goal**: Claude Code guides the user through discovering and confirming their project layout.

#### 5.1 Layout skill

New file: `skills/layout/SKILL.md`

Workflow:

**Step 1: Scan**
Call `interkasten_scan_preview`. Present the discovered tree to the user.

**Step 2: Hierarchy Review**
Walk through the tree with the user:
- "I found Interverse at ~/projects/Interverse with 12 subprojects. Does this grouping look right?"
- "These 3 projects appear standalone: [list]. Are any related to each other?"
- "I see symlinks that point into Interverse — I'll use the real paths and skip the symlinks."

**Step 3: Classification**
For each project, look at signals and propose:
- Tier (Product/Tool/Inactive) with reasoning ("15,000 LOC, 247 commits, has beads — this looks like a Product project")
- Tags ("has plugin.json → I'd tag this 'claude-plugin'")
- Status ("last commit 2 years ago → this might be archived")

User confirms, adjusts, or skips.

**Step 4: Notion Schema**
Ask what the user wants to track:
- "Want to track Status, Doc Tier, Tags, and key doc links? Or keep it simpler?"
- Call `interkasten_add_database_property` for each confirmed property

**Step 5: Register**
Register confirmed projects with confirmed properties. Parent-first, children after.

**Step 6: File Selection**
For each project, scan files and ask:
- "Found 8 markdown files. These look like project docs: [CLAUDE.md, AGENTS.md, PRD-MVP.md]. These look like notes: [scratch.md, TODO.md]. Which should sync to Notion?"

#### 5.2 Conversational patterns

The skill handles these user intents:
- "These are all part of the same project" → set parent-child
- "This one is standalone" → parent=null
- "Skip this" → don't register
- "These are all plugins" → batch-tag
- "Re-scan" → re-run scan_preview
- "This project moved" → update path, preserve Notion link
- "I reorganized everything" → full re-scan with orphan detection
- "Add a custom field" → call add_database_property

#### 5.3 Config persistence

Save confirmed layout preferences to config for future scans:

```yaml
layout:
  resolve_symlinks: true
  overrides:
    - path: "~/projects/Interverse/experiments"
      skip: true
    - path: "~/projects/standalone-tool"
      parent: null
```

---

### Phase 6: Onboard Skill Updates

**Goal**: `/interkasten:onboard` uses the new agent-native tools and hierarchy.

File: `skills/onboard/SKILL.md`

Changes:
1. Run layout skill as first step (or skip if layout already configured)
2. Triage uses `gather_signals` → agent proposes tiers → user confirms
3. Doc gap analysis is agent-driven (no hardcoded required docs)
4. Results displayed as tree
5. File sync is opt-in per project

---

## Migration & Backward Compatibility

### Existing installations

1. **Schema**: Conditional `ALTER TABLE`. New columns default to null/`[]`. No data loss.
2. **Notion**: `databases.update()` adds new properties. Existing rows get empty values. No data loss.
3. **Flat projects**: Continue working. `parent_id = null` = top-level. No behavioral change until user runs layout.
4. **Config**: New fields have defaults. Old configs work unchanged.
5. **Old tools**: `interkasten_triage` becomes `interkasten_gather_signals`. `interkasten_refresh_key_docs` becomes `interkasten_scan_files`. Old tool names return deprecation message pointing to new names.

### Re-init behavior

Running `interkasten_init` after upgrade:
- Validates token + ensures database exists (minimal)
- Does NOT auto-discover or auto-register (that's the layout skill now)
- Agent prompts user to run `/interkasten:layout` if no projects registered

---

## Task Breakdown

### Phase 1: Schema (no dependencies)
| # | Task | Complexity |
|---|------|------------|
| 1 | SQLite migration: `parent_id` + `tags` columns + index | Small |
| 2 | Drizzle schema: add columns to entityMap | Small |
| 3 | Entity map: hierarchy query functions (`getChildren`, `getParent`, `setParent`, `setTags`) | Medium |

### Phase 2: Scanner (depends on Phase 1)
| # | Task | Depends On | Complexity |
|---|------|------------|------------|
| 4 | Config: `hierarchy_marker`, `max_depth` default → 5, expanded exclude list | — | Small |
| 5 | Scanner: rewrite `discoverProjects()` → returns `DiscoveredProject` tree | 4 | Medium |
| 6 | Scanner: symlink dedup via `realpathSync()` | 5 | Small |

### Phase 3: Agent-Native Refactoring (depends on Phase 1)
| # | Task | Depends On | Complexity |
|---|------|------------|------------|
| 7 | New tool: `interkasten_gather_signals` (replaces triage classification) | — | Medium |
| 8 | New tool: `interkasten_scan_files` (replaces key doc hardcoding) | — | Small |
| 9 | New tool: `interkasten_scan_preview` (non-destructive tree scan) | 5, 7 | Medium |
| 10 | New tool: `interkasten_add_database_property` | — | Small |
| 11 | New tool: `interkasten_set_project_parent` | 3 | Small |
| 12 | New tool: `interkasten_set_project_tags` | 3 | Small |
| 13 | Simplify `interkasten_init` (token + minimal DB only) | 10 | Medium |
| 14 | Update `interkasten_register_project` (accept agent-specified properties) | 3 | Small |
| 15 | Notion schema: `Parent Project` relation + `Tags` multi-select (via add_database_property) | 10 | Small |
| 16 | Deprecation wrappers for old tool names | 7, 8 | Small |

### Phase 4: Downstream Fixes (depends on Phase 1)
| # | Task | Depends On | Complexity |
|---|------|------------|------------|
| 17 | Replace `startsWith` in `key-docs.ts` | 3 | Small |
| 18 | Replace `startsWith` in `projects.ts` (2 locations) | 3 | Small |
| 19 | Replace `startsWith` in `sync.ts` | 3 | Small |
| 20 | Update `list_projects` output (hierarchy + tags) | 3 | Medium |
| 21 | Update `get_project` output (parent, children, tags, signals) | 3, 7 | Small |

### Phase 5: Skills (depends on Phase 3)
| # | Task | Depends On | Complexity |
|---|------|------------|------------|
| 22 | Layout skill: `skills/layout/SKILL.md` | 9, 11, 12, 14 | Medium |
| 23 | Update onboard skill for agent-native workflow | 7, 8, 20, 22 | Medium |
| 24 | Config: layout overrides (skip, force-parent) | 4 | Small |

### Phase 6: Polish
| # | Task | Depends On | Complexity |
|---|------|------------|------------|
| 25 | Notion database upgrade path for existing workspaces | 15 | Medium |
| 26 | Remove dead code: `classifyProject()`, `TIER_DOC_REQUIREMENTS`, old triage logic | 7, 16 | Small |

**Critical path**: 1-3 → 5 → 9 → 22 (schema → scanner → preview → skill)
**Parallel tracks**: 7-8 (signal/file tools), 10 (db property tool), 17-19 (startsWith fixes)
**Total**: 26 tasks, ~15 medium, ~11 small
