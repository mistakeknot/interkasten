# Interkasten: Design Document

> **Date**: 2026-02-14
> **Status**: Draft
> **Author**: Brainstorm session — Claude + human

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Pagent System](#3-pagent-system)
4. [Notion Workspace Structure](#4-notion-workspace-structure)
5. [Document Model](#5-document-model)
6. [Sync Engine](#6-sync-engine)
7. [Conflict Resolution](#7-conflict-resolution)
8. [MCP Server Tool Surface](#8-mcp-server-tool-surface)
9. [Plugin Layer](#9-plugin-layer)
10. [Technology Stack](#10-technology-stack)
11. [Configuration](#11-configuration)
12. [Deployment & Distribution](#12-deployment--distribution)
13. [Monetization](#13-monetization)
14. [Competitive Position](#14-competitive-position)

---

## 1. Overview

### What Is Interkasten?

Interkasten is a Claude Code plugin + MCP server that creates a **living bridge between a local projects folder and a Notion workspace**. It:

1. **Discovers** local projects (any directory with `.git/` or `.beads/`)
2. **Mirrors** each project as a Notion page/database with auto-generated documentation
3. **Syncs bidirectionally** — local docs, beads state, and git metadata flow to Notion; Notion edits flow back to local files
4. **Runs pagent workflows** — autonomous AI agents that react to page events, classify research, generate documents, and maintain project health
5. **Grows documentation adaptively** — starts with a skeleton PRD, adds roadmaps, ADRs, changelogs, and sprint boards as projects mature

### Core Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Truth flow | Bidirectional merge | Both sides can make changes; three-way merge resolves most conflicts automatically, local-wins as fallback |
| Sync trigger | Continuous daemon | MCP server process watches both sides; filesystem watcher + Notion polling/webhooks |
| Research triage | Generalized as pagent actions | Not hardcoded — research classification is one instance of the pagent workflow system |
| Doc generation | Adaptive with full suite ceiling | Starts minimal, grows as project matures; thresholds configurable per-project |
| User scope | Open source / general | Designed for anyone to install and configure; not hardcoded to any specific environment |

---

## 2. Architecture

### The Three Layers

```
┌───────────────────────────────────────────────────────────┐
│                      Claude Code                           │
│                                                            │
│  ┌──────────────┐  ┌───────────┐  ┌─────────────────────┐ │
│  │    Plugin     │  │  Skills   │  │     Subagents       │ │
│  │    Hooks      │  │  (auto)   │  │  (PRD writer,       │ │
│  │  (lifecycle)  │  │           │  │   classifier, etc.) │ │
│  └──────┬────────┘  └─────┬─────┘  └──────────┬──────────┘ │
│         │                 │                    │            │
│  ┌──────┴─────────────────┴────────────────────┴─────────┐ │
│  │               MCP Server (daemon)                      │ │
│  │                                                        │ │
│  │  ┌────────────┐ ┌────────────┐ ┌───────────────────┐   │ │
│  │  │ Filesystem │ │   Sync     │ │  Pagent Workflow  │   │ │
│  │  │  Watcher   │ │  Engine    │ │     Engine        │   │ │
│  │  └─────┬──────┘ └─────┬──────┘ └────────┬──────────┘   │ │
│  │        │              │                  │              │ │
│  │  ┌─────┴──────────────┴──────────────────┴───────────┐  │ │
│  │  │            State Store (SQLite)                    │  │ │
│  │  │            ~/.interkasten/state.db                 │  │ │
│  │  └───────────────────────────────────────────────────┘  │ │
│  └─────────────────────────┬──────────────────────────────┘ │
└────────────────────────────┼────────────────────────────────┘
                             │ HTTPS (Notion API)
                             ▼
                     ┌──────────────┐
                     │  Notion API   │
                     └──────────────┘
```

### Layer 1: MCP Server (the daemon)

A long-running process started by Claude Code via stdio. Four internal components:

**Filesystem Watcher** — Uses `chokidar` to monitor the projects directory:
- New/removed project directories (has `.git/` or `.beads/`)
- Doc file changes (`.md` files, `docs/` folders)
- Beads database changes (`.beads/*.db`)
- Git events (new commits via `.git/refs/heads/` changes)

**Sync Engine** — Manages bidirectional state flow:
- Tracks operations on each side since last sync
- Reconciles changes using three-way merge (with local-wins fallback)
- Batches operations to minimize Notion API calls
- Rate-limited to 3 req/sec via `p-queue`

**Pagent Workflow Engine** — Executes autonomous page-level agent workflows:
- Evaluates triggers (condition, page-type, pipeline, schedule, event)
- Executes DAGs of pagent actions with fan-out/fan-in
- Tracks execution via beads issues

**State Store (SQLite)** — Persists all sync and workflow metadata:
- Entity map (local path ↔ Notion page ID)
- Base versions for three-way merge
- Sync operation log
- Workflow execution history
- Project registry

### Layer 2: Plugin (Claude Code integration)

Hooks, skills, commands — the integration surface that makes the MCP server feel native to Claude Code. Hooks fire on lifecycle events (session start, file edits, session end). Skills auto-activate when the conversation context matches. Commands provide explicit user-invoked operations.

### Layer 3: Subagents (AI-powered generation)

Isolated agents with independent context windows for document generation and research classification. Each agent has a specific model assignment optimized for its task's complexity-to-frequency ratio.

---

## 3. Pagent System

The pagent system is the core differentiator. It generalizes "research triage" into a universal automation engine for Notion pages.

### Core Concepts

- **Pagent Action** — a single atomic operation (fetch, classify, summarize, set status, etc.)
- **Pagent Workflow** — a DAG of actions. Fully recursive: a workflow can contain other workflows as nodes.

```
PagentAction = AtomicAction | PagentWorkflow
PagentWorkflow = DAG<PagentAction>
```

A workflow node can be an atomic action *or* another workflow, which expands into its own sub-DAG at execution time. The primitive and the composite share the same interface.

### Action Types

| Type | Description | Example |
|---|---|---|
| `prompt` | AI agent executes a natural language prompt | Classify research, generate PRD |
| `script` | Shell command receives page data as JSON on stdin | Run linter, call external API |
| `transform` | Built-in data transformation | Fetch URL, set status, copy page, add relation |
| `workflow` | A nested PagentWorkflow (recursive) | `doc-refresh` workflow containing evaluate + update |

### Action Interface

Every action conforms to the same interface:

```typescript
interface PagentAction {
  name: string
  description: string

  input: PageRef | PageRef[]

  output: {
    pages_created?: PageRef[]
    pages_modified?: PageRef[]
    properties_set?: Record<string, any>
    data?: any                           // passed to downstream actions
  }

  type: "prompt" | "script" | "transform" | "workflow"
  config: PromptConfig | ScriptConfig | TransformConfig | WorkflowConfig
}
```

### Trigger Patterns

Five trigger types, all syntactic sugar over **condition → agent action**:

**Condition triggers** (rule-based):
```yaml
trigger:
  type: condition
  match:
    database: "Research Inbox"
    property: "Status"
    equals: "New"
```

**Page-type triggers** (convention-based):
```yaml
trigger:
  type: page_type
  template: "PRD"
  event: parent_project_changed
```

**Pipeline triggers** (status-driven):
```yaml
trigger:
  type: pipeline
  database: "Research Inbox"
  status_transition:
    from: "New"
    to: "Processing"
```

**Scheduled triggers** (time-based):
```yaml
trigger:
  type: schedule
  cron: "0 9 * * 1"
  scope: all_projects
```

**Event triggers** (from the sync engine):
```yaml
trigger:
  type: event
  event: milestone_reached
  milestone: first_release
```

### DAG Execution

When a workflow triggers, the engine:

1. **Expands** — Recursively flattens nested workflows into a single DAG
2. **Validates** — Checks for cycles (at registration time and double-checked at runtime)
3. **Schedules** — Topologically sorts nodes, identifies parallelizable groups
4. **Executes** — Runs nodes in dependency order, passing output→input between connected nodes

### Fan-out and Fan-in

Actions that produce multiple outputs (like `classify` returning 3 matched projects) trigger **fan-out**: the downstream action is instantiated once per output item, running in parallel. A **fan-in** node can collect results from all branches.

```yaml
nodes:
  - name: classify
    action: classify-research
    fan_out: matched_projects

  - name: route
    action: route-to-project
    depends_on: classify
    each: matched_projects         # one instance per matched project

  - name: summary-report
    action: generate-intake-report
    fan_in: route                  # waits for ALL route instances
```

### Error Handling

| Policy | Behavior |
|---|---|
| `stop` (default) | Halt workflow. Downstream nodes don't run. Page gets `error` status. |
| `retry` | Retry N times with exponential backoff. Then `stop`. |
| `skip` | Log error, mark node skipped, continue downstream with partial data. |
| `fallback` | Run an alternative action instead. |

Failed workflows are tracked in the Pagent Workflows database and as beads issues.

### Built-in Actions

| Action | Type | Description |
|---|---|---|
| `fetch-content` | transform | HTTP fetch + readable text extraction |
| `classify` | prompt | AI matches content against project descriptions |
| `route-to-projects` | transform | Adds relation property linking to matched projects |
| `summarize` | prompt | Project-contextualized summary |
| `generate-prd` | prompt | PRD from project source + docs |
| `update-prd` | prompt | Revise PRD based on recent changes |
| `generate-roadmap` | prompt | Roadmap from beads + git history |
| `update-roadmap` | prompt | Revise roadmap |
| `generate-adr` | prompt | Architecture decision record |
| `generate-changelog` | prompt | Changelog from git log |
| `refresh-doc` | prompt | Evaluate staleness and update if needed |
| `notify` | transform | Set page status, add comment |

### Custom Actions

Users define custom actions as:
- **Prompt-based** — system prompt + allowed tools, executed by a subagent
- **Script-based** — shell command with JSON stdin/stdout
- **Composite** — a named DAG of existing actions (i.e., a workflow)

### Workflow Definition Format

Workflows are YAML files in the plugin's `workflows/` directory:

```yaml
name: research-intake
description: "Classify, route, and summarize research links"
version: 1

trigger:
  type: condition
  match:
    database: "Research Inbox"
    property: "Status"
    equals: "New"

nodes:
  - name: fetch
    action: fetch-content
    type: transform
    config:
      transform: http_fetch
      extract: readable_text
    on_error: stop

  - name: classify
    action: classify-research
    type: prompt
    depends_on: fetch
    config:
      prompt: |
        Given this content and the following project descriptions,
        determine which project(s) this research is relevant to.
        Return a JSON array of project names with confidence scores.
      context:
        - all_project_descriptions
    fan_out: matched_projects
    on_error: stop

  - name: route
    action: route-to-project
    type: transform
    depends_on: classify
    each: matched_projects
    config:
      transform: add_relation
      target_property: "Projects"

  - name: summarize
    action: summarize-for-project
    type: prompt
    depends_on: route
    config:
      prompt: |
        Summarize this research for the {{project_name}} project.
        Focus on what's actionable and relevant to the project's current goals.
      context:
        - project_prd
        - project_roadmap

  - name: doc-refresh
    action: doc-refresh
    type: workflow
    depends_on: summarize
    config:
      workflow: doc-staleness-check
```

---

## 4. Notion Workspace Structure

```
Notion Workspace
│
├── 📊 Projects (database)
│   │
│   │  Properties: Name, Status, Last Sync, Health Score,
│   │              Tech Stack, Beads Open/Closed, Last Commit
│   │
│   ├── Project A (page, auto-created from local dir)
│   │   ├── 📄 PRD
│   │   ├── 📄 Roadmap
│   │   ├── 📄 Architecture Overview
│   │   ├── 📄 Decision Log (ADRs)
│   │   ├── 📄 Changelog
│   │   ├── 📊 Issues (database, synced from .beads/)
│   │   │   ├── Issue: "Add auth middleware"  ←→  beads-abc
│   │   │   └── Issue: "Fix rate limiter"     ←→  beads-def
│   │   └── 📊 Sprint Board (database view of Issues)
│   │
│   ├── Project B (page)
│   │   └── ... (docs grow adaptively)
│   │
│   └── Project C (page)
│       └── 📄 PRD  ← only doc so far (new project)
│
├── 📊 Research Inbox (database)
│   │
│   │  Properties: Title, URL, Status, Projects (relation),
│   │              Summary, Source Type, Added By, Date
│   │
│   │  Status flow: New → Processing → Classified → Done
│   │
│   ├── "Rust async patterns article"  → tagged [Project A]
│   ├── "OAuth2 best practices"        → tagged [Project A, Project B]
│   └── "New SQLite feature"           → tagged [Project C]
│
├── 📊 Pagent Workflows (database)
│   │
│   │  Properties: Name, Trigger, Status (active/paused),
│   │              Last Run, Run Count, Error Count
│   │
│   ├── "research-intake" (workflow)
│   ├── "default-project-sync" (workflow)
│   └── "weekly-roadmap-refresh" (workflow)
│
└── 📊 Sync Log (database)
    │
    │  Properties: Timestamp, Project, Direction, Entity,
    │              Action, Status, Conflict?
    │
    └── (audit trail of every sync operation)
```

### Key Design Choices

**Projects database as the hub** — Properties auto-populated from local state:
- `Health Score`: Computed from days since last commit, open/closed beads ratio, doc coverage
- `Tech Stack`: Detected from lockfiles (package.json → Node, pyproject.toml → Python, etc.)
- `Last Sync` and `Beads Open/Closed`: Updated on every sync cycle

**Research Inbox uses a Relation property** to link to Projects. A single research item can relate to multiple projects. Per-project filtered views require no data duplication.

**Pagent Workflows database** is both a registry and a control surface. Users can pause a workflow by changing its status in Notion.

**Sync Log** provides full auditability. Every operation is recorded.

---

## 5. Document Model

### Two Tiers

The default pagent workflow ships with a two-tier document model. This is the **demo workflow** — users can modify, replace, or build entirely different workflows.

**Tier 1: Notion-native** — Documents live primarily in Notion, collaboratively editable, bidirectional sync with local markdown:

| Doc Type | Trigger | Notes |
|---|---|---|
| PRD | Project detected | Skeleton → fleshed out as project matures |
| Roadmap | 10+ commits or 5+ beads | Built from beads + git history |
| Brainstorms | User-initiated | Created via command or directly in Notion |
| Research | Inbox workflow | AI-classified, routed, summarized |
| Reviews / Feedback | Pagent workflow or scheduled | AI-generated project health reviews |
| Vision / North Star | User-initiated | High-level direction |
| Sprint Board | First beads issue | Database view synced from `.beads/` |
| Decision Log (ADRs) | Major refactor or user-initiated | Architectural decisions with context |
| Changelog | Git tag / version bump | Generated from git log |

**Tier 2: Linked references** — Documents live locally but appear in Notion as summary cards:

| Doc Type | What Appears in Notion |
|---|---|
| CLAUDE.md | Summary card: title, line count, last modified |
| AGENTS.md | Summary card with section headings extracted |
| Implementation Plans | Title + status + date, linked to local `docs/plans/` |
| Solutions / Troubleshooting | Title + category, linked to local `docs/solutions/` |
| CLI / API Reference | Title + summary, linked to local file |
| Handoff Notes | Latest content as a Notion callout block |
| TODO files | Extracted items as a checklist, linked to source |

A linked reference contains:
- The doc's title and path
- An AI-generated 1-2 sentence summary
- Last modified timestamp
- A "View locally" path reference

These update automatically on sync but are **read-only in Notion** — edits flow local→Notion only.

### Adaptive Doc Generation

The system starts minimal and grows:

| Project Signal | Docs Generated |
|---|---|
| Directory with `.git/` or `.beads/` detected | PRD (skeleton) |
| First 5 commits | PRD updated with actual project context |
| First beads issue created | Issues database + Sprint Board |
| 10+ commits or 5+ beads closed | Roadmap |
| Dependency file detected | Architecture Overview (skeleton) |
| Major refactor detected (high file churn) | ADR suggested |
| Git tag / version bump | Changelog |
| 50+ commits or 20+ beads closed | Full suite available |

Each threshold is configurable per-project.

### Pagent Workflow Override

Any default can be overridden:

```yaml
# Promote solutions docs to Notion-native for a specific project
- name: solutions-to-notion
  trigger:
    condition: "project == 'Autarch' AND file_path matches 'docs/solutions/*'"
  action: sync-bidirectional
```

### Trigger Model (Layered)

Document generation uses four trigger layers:

1. **Event-driven**: File changes, commits, beads events trigger immediate evaluation
2. **Milestone-based**: First commit, first release, Nth issue closed → auto-generate new doc types
3. **Scheduled**: Daily/weekly sweeps catch drift and update stale docs
4. **User-initiated**: Agent suggests updates, user approves via Notion status or slash command

---

## 6. Sync Engine

### Operation Log Model

The engine tracks **operations** (discrete changes on each side since last sync), not state snapshots.

```
┌──────────────┐                          ┌──────────────┐
│   Local       │                          │   Notion      │
│   Filesystem  │                          │   Workspace   │
└──────┬───────┘                          └──────┬───────┘
       │                                         │
       ▼                                         ▼
┌──────────────┐                          ┌──────────────┐
│  FS Watcher   │                          │  Poller /     │
│  (chokidar)   │                          │  Webhook Rx   │
└──────┬───────┘                          └──────┬───────┘
       │  file events                            │  page events
       ▼                                         ▼
┌────────────────────────────────────────────────────────┐
│                    Operation Queue                      │
│                                                        │
│  { side: "local", type: "file_modified",               │
│    path: "docs/PRD.md", hash: "a3f...", ts: ... }      │
│                                                        │
│  { side: "notion", type: "page_updated",               │
│    page_id: "abc-123", version: 42, ts: ... }          │
│                                                        │
└───────────────────────┬────────────────────────────────┘
                        │
                        ▼
               ┌────────────────┐
               │  Reconciler     │
               └────────┬───────┘
                        │
                ┌───────┴───────┐
                ▼               ▼
        ┌────────────┐  ┌────────────┐
        │ Push to     │  │ Pull from  │
        │ Notion      │  │ Notion     │
        └────────────┘  └────────────┘
```

### Entity Mapping (SQLite)

```sql
CREATE TABLE entity_map (
  id              INTEGER PRIMARY KEY,
  local_path      TEXT NOT NULL,
  notion_id       TEXT NOT NULL,
  entity_type     TEXT NOT NULL,  -- 'project' | 'doc' | 'ref' | 'issues'
  tier            TEXT,           -- 'T1' | 'T2'
  last_local_hash TEXT,           -- SHA-256 of file contents
  last_notion_ver TEXT,           -- Notion last_edited_time
  base_content    TEXT,           -- Last-synced content (for three-way merge)
  last_sync_ts    TEXT NOT NULL,
  UNIQUE(local_path),
  UNIQUE(notion_id)
);
```

The `base_content` column stores the last-synced version of each document — the common ancestor needed for three-way merge.

### Change Detection

| Source | Method |
|---|---|
| Local files | SHA-256 content hash compared to `last_local_hash` in entity map |
| Notion pages | `last_edited_time` compared to `last_notion_ver` in entity map |

### Content Translation

**Local → Notion (push):**
- Parse markdown with `@tryfabric/martian` → Notion block objects
- Diff against existing Notion blocks to minimize API calls (patch, don't full-replace)

**Notion → Local (pull):**
- Fetch Notion blocks via `@notionhq/client`
- Convert to markdown via `notion-to-md` (with custom transformers for better fidelity)
- Write to local file, preserving any frontmatter

**Roundtrip fidelity:**
- Standard content (text, headers, lists, code, links, images): ~95%+ lossless
- Rich Notion content (callouts, toggles, columns, colors): ~70-80%, improvable with custom transformers and metadata comments

**Beads ↔ Notion Issues database:**
- Map beads fields → Notion properties: `title`, `status`, `priority`, `type`, `assignee`, `created`, `updated`
- Beads `notes` → Notion page content
- Beads `dependencies` → Notion relation property

### Notion Change Detection

Two modes, configurable:

**Polling (default):**
- Poll the Projects database and Research Inbox every N seconds (default: 60)
- Use `last_edited_time` filter to fetch only changed pages
- Safety-net full sweep on a longer interval (default: daily)

**Webhooks (optional, requires tunnel):**
- Auto-provision a cloudflared tunnel exposing a local webhook receiver
- Subscribe to Notion webhook events (23 event types available)
- Most events delivered within ~1 minute
- Delivery is at-most-once — polling safety net catches missed events

### Sync Cadence

| Trigger | What Syncs | Latency |
|---|---|---|
| FS watcher event | Changed file only | ~1-5 seconds |
| PostToolUse hook (Edit/Write) | Changed file (fast-path) | Immediate |
| Poll cycle (default 60s) | All Notion changes since last poll | ≤ poll interval |
| Webhook (if tunnel enabled) | Changed Notion page only | ~1 minute |
| `/interkasten:sync` command | Full project resync | On demand |
| Scheduled sweep (default daily) | All projects, stale doc detection | Batch |
| Milestone detection | Doc generation triggers | Event-driven |

---

## 7. Conflict Resolution

### Strategy: Three-Way Merge with Local-Wins Fallback

Follows the same approach as **Obsidian Sync**, using Google's `diff-match-patch` algorithm (via `node-diff3` and `diff-match-patch-es`).

### How It Works

For each synced entity, the state store keeps three versions:

1. **Base** — the content at last successful sync (`base_content` in entity map)
2. **Local** — current content of the local file
3. **Remote** — current content of the Notion page (fetched via API)

The reconciler asks:

| Local Changed? | Remote Changed? | Action |
|---|---|---|
| No | No | Skip — nothing to do |
| Yes | No | Push local → Notion |
| No | Yes | Pull Notion → local |
| Yes | Yes | **Three-way merge** |

### Three-Way Merge Process

When both sides have changed:

1. Compute three-way merge using `node-diff3(base, local, remote)`
2. If **no overlapping changes** → merge succeeds automatically (most common case)
3. If **overlapping changes** → conflict detected:
   - Apply **local-wins** for the conflicting sections
   - The overwritten Notion version is preserved in Notion's built-in page history
   - Log the conflict in the sync log with both versions for recovery
4. Update the base version in the state store to the merged result

### Why This Is Better Than Pure Local-Wins

Most "conflicts" are actually non-overlapping changes (you edited the intro locally, someone edited the conclusion in Notion). Three-way merge handles these automatically — only truly overlapping changes trigger the local-wins fallback. Bidirectional editing "just works" most of the time.

### Configurable Conflict Strategies

```yaml
sync:
  conflict_strategy: "three-way-merge"  # default
  # Alternatives:
  # "local-wins"     — always use local version on conflict
  # "notion-wins"    — always use Notion version on conflict
  # "conflict-file"  — create a .conflict copy (Syncthing-style)
  # "ask"            — flag for human resolution via Notion status
```

---

## 8. MCP Server Tool Surface

33 tools across 7 domains, plus resources and apps.

### Project Management (6 tools)

| Tool | Description |
|---|---|
| `interkasten_list_projects` | List all discovered projects with sync status, health score, Notion URLs |
| `interkasten_get_project` | Detailed project info: tech stack, doc coverage, beads summary, last sync |
| `interkasten_register_project` | Manually register a directory as a project |
| `interkasten_unregister_project` | Stop tracking a project |
| `interkasten_get_health` | Compute project health score |
| `interkasten_dashboard` | MCP App — interactive HTML dashboard |

### Sync Operations (5 tools)

| Tool | Description |
|---|---|
| `interkasten_sync` | Trigger immediate sync for one or all projects |
| `interkasten_sync_status` | Show pending operations, last sync timestamps, errors |
| `interkasten_resolve_conflict` | View conflicting versions, apply resolution |
| `interkasten_sync_log` | Query sync log with filters |
| `interkasten_set_sync_config` | Configure poll interval, tunnel, exclusions |

### Document Operations (5 tools)

| Tool | Description |
|---|---|
| `interkasten_generate_doc` | Generate a doc type for a project (spawns subagent) |
| `interkasten_refresh_doc` | Re-evaluate and update an existing doc |
| `interkasten_list_docs` | List docs with tier, sync status, staleness |
| `interkasten_promote_doc` | Move from T2 (linked reference) to T1 (Notion-native) |
| `interkasten_demote_doc` | Move from T1 to T2 |

### Research Inbox (4 tools)

| Tool | Description |
|---|---|
| `interkasten_add_research` | Add URL or text to inbox |
| `interkasten_classify_research` | Manually trigger classification |
| `interkasten_research_status` | Inbox stats by status and project |
| `interkasten_search_research` | Full-text search across research items |

### Pagent Workflows (6 tools)

| Tool | Description |
|---|---|
| `interkasten_list_workflows` | List workflows with status and run stats |
| `interkasten_get_workflow` | Full workflow definition + execution history |
| `interkasten_run_workflow` | Manually trigger a workflow |
| `interkasten_pause_workflow` | Pause auto-triggering |
| `interkasten_resume_workflow` | Resume a paused workflow |
| `interkasten_workflow_log` | Query execution history |

### Pagent Actions (4 tools)

| Tool | Description |
|---|---|
| `interkasten_list_actions` | List available actions (built-in + custom) |
| `interkasten_run_action` | Run a single action against a page |
| `interkasten_create_action` | Register a new custom action |
| `interkasten_create_workflow` | Register a new workflow from YAML |

### Configuration (3 tools)

| Tool | Description |
|---|---|
| `interkasten_init` | First-time setup: create Notion workspace structure |
| `interkasten_config_get` | Read current configuration |
| `interkasten_config_set` | Update configuration |

### MCP Resources

| Resource URI | Description |
|---|---|
| `interkasten://projects` | JSON list of all projects |
| `interkasten://projects/{name}` | Full project detail |
| `interkasten://research/inbox` | Current research inbox |
| `interkasten://sync/status` | Real-time sync status |
| `interkasten://workflows` | All workflow definitions |

### MCP Apps

| App | Trigger | What It Renders |
|---|---|---|
| **Project Dashboard** | `interkasten_dashboard` | Grid of projects with health, sync status, activity |
| **Conflict Resolver** | `interkasten_resolve_conflict` | Side-by-side diff, pick-per-section resolution |
| **Workflow Visualizer** | `interkasten_get_workflow` | Interactive DAG with execution status per node |

### Tool Search Optimization

All tools start with `interkasten_` for prefix filtering. Descriptions use domain keywords so Tool Search surfaces the right tools. With Tool Search deferral, the 33 tool definitions don't consume context until needed.

---

## 9. Plugin Layer

### Hooks

**`SessionStart`** — Check daemon health, inject sync status:
```bash
#!/bin/bash
DAEMON_STATUS=$(interkasten status --json 2>/dev/null)
if [ $? -ne 0 ]; then
  echo '{"status":"context","message":"Interkasten daemon not running. Use /interkasten:init."}'
  exit 0
fi
PROJECTS=$(echo "$DAEMON_STATUS" | jq '.projects_tracked')
PENDING=$(echo "$DAEMON_STATUS" | jq '.pending_operations')
echo "{\"status\":\"context\",\"message\":\"Interkasten: ${PROJECTS} projects, ${PENDING} pending ops\"}"
```

**`PostToolUse(Edit|Write)`** — Fast-path file change notification:
```bash
#!/bin/bash
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty')
[ -n "$FILE_PATH" ] && interkasten notify-change "$FILE_PATH" &
echo '{"status":"approve"}'
```

**`PostToolUse(Bash)`** — Catch git operations:
```bash
#!/bin/bash
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
echo "$COMMAND" | grep -qE '^git (commit|tag|merge|rebase|pull)' && interkasten notify-git-event &
echo '{"status":"approve"}'
```

**`Stop` / `SessionEnd`** — Flush pending sync:
```bash
#!/bin/bash
interkasten sync --flush &
```

### Skills

**`interkasten-sync`** — Activates when user discusses documentation or sync:
- Check sync status, suggest refreshing stale docs, mention auto-sync on edits

**`interkasten-research`** — Activates when user shares links or discusses research:
- Offer to add to inbox, report routing results, search existing research

**`interkasten-pagent`** — Activates when user wants to create automations:
- Help define triggers, compose DAGs, validate with test runs

### Commands

| Command | Description |
|---|---|
| `/interkasten:status` | Show sync dashboard (MCP App) |
| `/interkasten:sync [project \| --all]` | Force immediate sync |
| `/interkasten:research <url>` | Add to research inbox |
| `/interkasten:init` | First-time setup wizard |
| `/interkasten:workflow [create\|list\|show\|pause\|resume]` | Manage pagent workflows |
| `/interkasten:generate <doc-type> [project]` | Generate or refresh a document |

### Subagents

| Agent | Model | Purpose |
|---|---|---|
| `prd-writer` | Opus | Generate/update PRDs from project source + docs |
| `doc-writer` | Opus | Architecture docs, vision docs, ADRs |
| `roadmap-builder` | Sonnet | Roadmap from beads + git history |
| `changelog-writer` | Sonnet | Changelog from git log |
| `research-classifier` | Haiku | Classify research against project descriptions |
| `doc-refresher` | Haiku | Evaluate staleness, light patching |
| `content-fetcher` | Haiku | URL extraction and text cleanup |

Model assignments are configurable per-agent via `/interkasten:config`.

---

## 10. Technology Stack

### Dependencies: Reuse

| Library | Purpose | Weekly Downloads |
|---|---|---|
| `@modelcontextprotocol/sdk` | MCP server framework | — |
| `@notionhq/client` | Official Notion SDK | 350K |
| `@tryfabric/martian` | Markdown → Notion blocks | 101K |
| `notion-to-md` | Notion blocks → Markdown | 131K |
| `better-sqlite3` | Sync state store | 3.2M |
| `drizzle-orm` | Type-safe SQLite queries + migrations | 4.6M |
| `chokidar` | Filesystem watcher | 97M |
| `diff` (jsdiff) | Text diffing & patching | 64M |
| `node-diff3` | Three-way merge | 5K |
| `diff-match-patch-es` | Fuzzy patch application (Obsidian's approach) | 85K |
| `p-queue` | Rate limiting (3 req/sec for Notion) | 3M |
| `yaml` | Workflow definition parsing | — |
| `zod` | Config and schema validation | — |

### Custom Code: Build (~2000-4000 lines estimated)

| Component | Est. Lines | Purpose |
|---|---|---|
| Sync state machine | ~300 | Track per-entity sync state, direction detection |
| Reconciliation engine | ~600 | When to push/pull/merge/conflict |
| Conflict detection + resolution | ~500 | Three-way merge integration, fallback strategies |
| Pipeline orchestrator | ~400 | Watch → detect → diff → resolve → apply flow |
| Frontmatter manager | ~200 | Sync metadata in YAML frontmatter |
| Notion version tracker | ~200 | Track `last_edited_time` per entity |
| Debouncing / batching | ~150 | Custom logic tied to sync state machine |
| Operation log | ~100 | SQLite append-only audit log |
| Configuration loader | ~200 | YAML config with env var resolution |

### Why These Choices

**No sync engine framework fits**: All major frameworks (Zero, ElectricSQL, PowerSync) are designed for database-to-client sync. CRDTs (Yjs, Automerge) solve real-time collaborative editing. Neither matches our use case: periodic batch sync between files and a rate-limited REST API.

**TypeScript over Go**: The MCP SDK, Notion SDK, and all conversion libraries are TypeScript. go-notion-md-sync (the only Go option) has critical flaws: no API pagination (data loss on large pages), destructive push (deletes all blocks), rich text annotations lost on roundtrip, and no library API (CLI-only with interactive prompts).

### Runtime Requirements

```
node >= 20 (LTS)
Optional: cloudflared binary (auto-downloaded if webhooks enabled)
```

---

## 11. Configuration

All configuration in `~/.interkasten/config.yaml`:

```yaml
# Project discovery
projects_dir: "/root/projects"
project_detection:
  markers: [".git", ".beads"]
  exclude: ["node_modules", ".cache", "vendor"]
  max_depth: 2

# Notion connection
notion:
  token: "${INTERKASTEN_NOTION_TOKEN}"
  workspace_id: "auto-detected-during-init"
  databases:                              # auto-created during init
    projects: null
    research_inbox: null
    pagent_workflows: null
    sync_log: null

# Sync engine
sync:
  poll_interval: 60                       # seconds
  batch_size: 10                          # max API calls per cycle
  conflict_strategy: "three-way-merge"    # three-way-merge | local-wins | notion-wins | conflict-file | ask
  tunnel:
    enabled: false
    provider: "cloudflared"

# Filesystem watcher
watcher:
  debounce_ms: 500
  ignore_patterns: ["*.swp", "*.tmp", ".git/objects/**", "node_modules/**"]

# Document generation
docs:
  default_tier: "T2"
  auto_promote_threshold: 3              # promote to T1 after N manual Notion edits
  models:
    prd_writer: "opus"
    doc_writer: "opus"
    roadmap_builder: "sonnet"
    changelog_writer: "sonnet"
    research_classifier: "haiku"
    doc_refresher: "haiku"
    content_fetcher: "haiku"

# Adaptive doc thresholds
milestones:
  skeleton_prd: "project_detected"
  full_prd: { commits: 5 }
  issues_db: "first_beads_issue"
  roadmap: { commits: 10, beads_closed: 5, either: true }
  architecture: "dependency_file_detected"
  adr_suggest: { file_churn_ratio: 0.4 }
  changelog: "git_tag_detected"
  full_suite: { commits: 50, beads_closed: 20, either: true }

# Scheduled sweeps
schedules:
  staleness_check:
    cron: "0 9 * * *"                    # daily 9am
    scope: "all_projects"
  full_refresh:
    cron: "0 9 * * 1"                    # weekly Monday
    scope: "stale_docs_only"

# Pagent engine
pagent:
  max_concurrent_workflows: 5
  max_dag_depth: 10
  default_timeout_per_node: 120          # seconds
  default_error_policy: "stop"

# Beads integration
beads:
  track_operations: true
  auto_close: true
  priority: 4                            # P4 for automated operations
```

### Secrets Management

The Notion token is the only secret. Referenced as `${INTERKASTEN_NOTION_TOKEN}` in config, resolved from environment at startup. Never stored in plaintext in the config file.

```bash
# User sets in shell profile
export INTERKASTEN_NOTION_TOKEN="ntn_..."
```

---

## 12. Deployment & Distribution

### Architecture

```
User's Machine
│
├── Claude Code
│   ├── Interkasten Plugin (hooks, skills, commands, agents)
│   └── MCP Client ──stdio──┐
│                            │
│   ┌────────────────────────┴──────────────────────┐
│   │         Interkasten Daemon (MCP Server)        │
│   │                                                │
│   │  FS Watcher ─── Sync Engine ─── Pagent Engine  │
│   │                      │                         │
│   │              SQLite State Store                 │
│   │              ~/.interkasten/state.db            │
│   └────────────────────┬──────────────────────────┘
│                        │ HTTPS
│   ┌────────────────────┴─── optional ────────────┐
│   │  Cloudflared Tunnel (webhooks only)           │
│   └──────────────────────────────────────────────┘
│
└── Filesystem: /projects/*
                    │
                    ▼
            ┌──────────────┐
            │  Notion API   │
            └──────────────┘
```

Everything runs locally. The only external dependency is the Notion API.

### Plugin Manifest

```json
{
  "name": "interkasten",
  "version": "0.1.0",
  "description": "Living bridge between your projects folder and Notion",
  "author": { "name": "...", "email": "..." },
  "license": "MIT",
  "keywords": ["notion", "sync", "documentation", "pagent", "workflows"],
  "skills": "./skills/",
  "commands": "./commands/",
  "mcpServers": {
    "interkasten": {
      "type": "stdio",
      "command": "npx",
      "args": ["interkasten-daemon"],
      "env": {
        "INTERKASTEN_NOTION_TOKEN": "${INTERKASTEN_NOTION_TOKEN}",
        "INTERKASTEN_CONFIG_PATH": "${HOME}/.interkasten/config.yaml"
      }
    }
  },
  "hooks": ".claude-plugin/hooks/hooks.json"
}
```

### Installation Flow

```
1. claude plugin install interkasten
2. export INTERKASTEN_NOTION_TOKEN="ntn_..."
3. Start Claude Code, run /interkasten:init
4. Init wizard:
   → Verifies Notion token
   → Creates workspace structure (databases)
   → Scans projects directory
   → Registers discovered projects
   → Generates skeleton PRDs
   → Installs default pagent workflows
   → Shows dashboard
5. Daemon is running. Sync is active.
```

### Repository Structure

```
interkasten/
├── src/
│   ├── daemon/                        # MCP server
│   │   ├── index.ts                   # Entry point
│   │   ├── tools/                     # 33 tool implementations
│   │   ├── resources/                 # MCP resource handlers
│   │   └── apps/                      # MCP App HTML templates
│   │
│   ├── sync/                          # Sync engine
│   │   ├── engine.ts                  # Reconciler + operation queue
│   │   ├── watcher.ts                 # Filesystem watcher
│   │   ├── notion-client.ts           # Notion API wrapper + poller
│   │   ├── entity-map.ts             # SQLite entity mapping
│   │   ├── translator.ts             # Markdown ↔ Notion blocks
│   │   ├── conflict.ts               # Three-way merge + strategies
│   │   └── tunnel.ts                 # Cloudflared tunnel manager
│   │
│   ├── pagent/                        # Pagent workflow engine
│   │   ├── engine.ts                  # DAG executor
│   │   ├── triggers.ts               # Trigger evaluation
│   │   ├── actions/                   # Built-in action implementations
│   │   ├── fan.ts                    # Fan-out / fan-in
│   │   └── cycle-detect.ts           # DAG validation
│   │
│   ├── config/                        # Configuration
│   │   ├── schema.ts                  # Zod schemas
│   │   ├── loader.ts                  # YAML + env var resolution
│   │   └── defaults.ts               # Default values
│   │
│   └── store/                         # SQLite state store
│       ├── migrations/                # Schema migrations (drizzle-kit)
│       ├── entities.ts               # Entity map CRUD
│       ├── sync-log.ts               # Sync log queries
│       └── workflow-log.ts           # Execution history
│
├── .claude-plugin/
│   ├── plugin.json
│   └── hooks/
│       ├── hooks.json
│       ├── session-start.sh
│       ├── post-edit.sh
│       ├── post-bash.sh
│       └── session-end.sh
│
├── skills/
│   ├── interkasten-sync/SKILL.md
│   ├── interkasten-research/SKILL.md
│   └── interkasten-pagent/SKILL.md
│
├── commands/
│   ├── status.md
│   ├── sync.md
│   ├── research.md
│   ├── init.md
│   ├── workflow.md
│   └── generate.md
│
├── agents/
│   ├── prd-writer.md
│   ├── doc-writer.md
│   ├── roadmap-builder.md
│   ├── changelog-writer.md
│   ├── research-classifier.md
│   ├── doc-refresher.md
│   └── content-fetcher.md
│
├── workflows/                         # Default pagent workflows (YAML)
│   ├── default-project-sync.yaml
│   ├── research-intake.yaml
│   ├── doc-staleness-check.yaml
│   └── milestone-doc-generation.yaml
│
├── tests/
│   ├── sync/
│   ├── pagent/
│   ├── tools/
│   └── integration/
│
├── package.json
├── tsconfig.json
├── CLAUDE.md
├── AGENTS.md
├── README.md
└── LICENSE (MIT)
```

---

## 13. Monetization

### Three Revenue Layers

**Layer 1: Free & Open Source (MIT)**

The full plugin — sync engine, pagent engine, all tools, hooks, skills, commands, default workflows. Users bring their own Claude API key for AI features.

**Layer 2: Pagent Workflow Marketplace (Lemon Squeezy)**

Premium workflow packs sold individually or bundled:

| Pack | Price | Contents |
|---|---|---|
| Indie Hacker Suite | $29 | Changelog publisher, launch checklist, competitor research pipeline, metrics dashboard |
| Team Engineering | $49 | Sprint retro generator, PR-to-roadmap sync, cross-project dependency tracker, standup summarizer |
| Research Lab | $39 | Academic paper classifier, citation graph builder, literature review generator, research gap identifier |
| Content Pipeline | $29 | Blog post drafter, social media extractor, newsletter curator, content calendar sync |
| Full Bundle | $99 | All packs + future packs for 1 year |

**Layer 3: Interkasten Cloud (SaaS subscription)**

Hosted service eliminating self-hosting friction:

| Tier | Price | Features |
|---|---|---|
| Free | $0 | 3 projects, 5-min polling, 50 pagent runs/month, BYOK |
| Pro | $15/mo | Unlimited projects, webhook sync, unlimited pagent runs, hosted tunnel |
| Team | $39/mo | Pro + shared workspace, team inbox, RBAC, audit log |

### Revenue Projections (Conservative)

| Month | Free Users | Workflow Sales | Cloud MRR | Total |
|---|---|---|---|---|
| 3 | 200 | $300 | $0 | $300 |
| 6 | 800 | $800 | $300 | $1,100 |
| 12 | 2,500 | $1,500 | $2,000 | $3,500 |
| 18 | 5,000 | $2,000 | $6,000 | $8,000 |
| 24 | 10,000 | $3,000 | $12,000 | $15,000 |

### Launch Channels

| Channel | Action | Timing |
|---|---|---|
| Product Hunt | Launch with demo video | Day 1 |
| Notion Marketplace | Workspace template ($19) | Day 1 |
| Claude Code marketplace | Free plugin listing | Day 1 |
| GitHub | Open-source repo | Day 1 |
| Indie Hackers | Build-in-public posts | Pre-launch |
| YouTube | Demo video | Launch week |

### Payment Platform

**Lemon Squeezy**: 5% + $0.50 per transaction, Merchant of Record, handles global tax, supports both one-time (workflow packs) and subscriptions (cloud), license key generation.

---

## 14. Competitive Position

### The Gap We Fill

No existing tool combines: **codebase-aware + bidirectional sync + adaptive docs + agentic workflows + Notion output**.

| What Exists | Who | What's Missing |
|---|---|---|
| Basic Notion CRUD from Claude Code | Official Notion Plugin | No sync, no codebase awareness, no adaptive docs |
| Bidirectional Markdown ↔ Notion sync | go-notion-md-sync | No AI, no doc generation |
| AI doc generation from code | DocuWriter, Swimm, Mintlify | Don't output to Notion |
| PRD generation → Notion | ChatPRD ($15/mo) | One-directional, no codebase awareness |
| Autonomous Notion workflows | Notion Agents 3.0 | Blind to local dev environment |

### Defensible Territory

1. **Local-first**: Notion Agents can't watch your code change. We own the filesystem.
2. **Pagent workflows**: Nobody else has autonomous page-level DAG automation for Notion.
3. **Adaptive documentation**: No tool watches code changes and auto-updates Notion docs.
4. **Bidirectional with intelligence**: go-notion-md-sync syncs but doesn't think. The Notion plugin thinks but doesn't sync.

### Primary Threat

**Notion Agents 3.0** — if Notion adds deeper GitHub integration and local dev awareness. Mitigation: move fast, establish user base, and own the local-first experience that Notion structurally can't provide from their cloud-only architecture.

---

## Appendix A: Research Documents

The following research was conducted during this design:

| Document | Topic |
|---|---|
| `docs/research/research-notion-monetization-models.md` | Monetization strategies, pricing, platforms |
| `docs/research/research-competing-notion-ai-tools.md` | Competitive landscape analysis |
| `docs/research/deep-dive-go-notion-md-sync.md` | Technical analysis of go-notion-md-sync |
| `docs/research/research-md-notion-conversion-libs.md` | Markdown ↔ Notion conversion libraries |
| `docs/research/research-sync-engine-libraries.md` | Sync engines, CRDTs, diff/merge, prior art |

## Appendix B: Key Architectural Decisions

| Decision | Choice | Alternatives Considered | Rationale |
|---|---|---|---|
| Sync direction | Bidirectional merge | Local-first, Notion-first, split authority | Users want Notion as a real collaborative surface |
| Sync trigger | Continuous daemon | Hook-triggered, on-demand, hybrid | Always-alive watching both sides is the best UX |
| Conflict resolution | Three-way merge + local-wins fallback | Last-write-wins, section merge, fork+notify | Three-way merge handles most cases automatically; local-wins is a safe fallback |
| Research triage | Generalized as pagent workflows | Hardcoded research pipeline | Pagent system is the real product; research is just the demo workflow |
| Doc generation | Adaptive with full suite ceiling | Core set only, user-configured | Grows with the project; no upfront config burden |
| Notion websockets | Not used (polling + optional webhooks) | Websocket-driven real-time | No public websocket API; internal protocol is undocumented and fragile |
| Language | TypeScript | Go, Python, Rust | Best MCP SDK support, native Notion SDK, largest ecosystem for all dependencies |
| Markdown ↔ Notion conversion | `@tryfabric/martian` + `notion-to-md` | go-notion-md-sync, custom | TS-native, 100K+ weekly downloads each, ~95% roundtrip fidelity |
| Sync state store | SQLite via `better-sqlite3` | PostgreSQL, JSON files, LevelDB | Zero-config, embedded, fast sync API, perfect for single-user daemon |
| Three-way merge | `node-diff3` + `diff-match-patch-es` | Custom merge, CRDTs, OT | Same approach as Obsidian Sync (proven with millions of users) |
| Webhook infrastructure | Optional cloudflared tunnel | ngrok, hosted relay, poll-only | Zero infrastructure by default; tunnel is an opt-in upgrade |
| Model routing | Opus for docs, Sonnet for synthesis, Haiku for high-volume | Single model for all | Cost optimization: classifier runs 50x/day (Haiku), PRDs are rare (Opus) |
