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

### Target User

**Primary persona: The multi-project indie developer** — someone who maintains 3-15 active projects, uses Claude Code as their primary development tool, and wants a single dashboard for documentation, research, and project health. They are comfortable with CLI tools and environment variables, but expect an automated experience once configured.

**Key characteristics:**
- Develops alone or in a small team (1-3 people)
- Already uses Notion for notes, docs, or project management
- Frustrated by docs going stale and context being scattered across repos
- Wants AI-assisted documentation that stays current without manual effort

**Explicit non-targets (v1):**
- Enterprise teams with complex RBAC/compliance requirements
- Users who don't use Notion (this is a Notion-specific integration)
- Users who want real-time collaborative editing (this is periodic batch sync)

### Core Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Truth flow | Bidirectional merge | Both sides can make changes; three-way merge resolves most conflicts automatically, local-wins as fallback |
| Sync trigger | Continuous daemon | MCP server process watches both sides; filesystem watcher + Notion polling/webhooks |
| Research triage | Generalized as pagent actions | Not hardcoded — research classification is one instance of the pagent workflow system |
| Doc generation | Adaptive with full suite ceiling | Starts minimal, grows as project matures; thresholds configurable per-project |
| User scope | Open source / general | Designed for indie developers and small teams; not hardcoded to any specific environment |

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
- Rate-limited to 3 req/sec via `p-queue` with exponential backoff on 429s and circuit-breaker for sustained failures (see [Sync Engine § Backpressure](#backpressure--rate-limiting))

**Pagent Workflow Engine** — Executes autonomous page-level agent workflows:
- Evaluates triggers (condition, page-type, pipeline, schedule, event)
- Executes DAGs of pagent actions with fan-out/fan-in
- Tracks execution via beads issues
- All Notion writes go through the shared Notion API client (see below), not a separate connection

**Notion API client (shared):** Both the sync engine and pagent engine write to Notion through a single `NotionClient` wrapper. This wrapper owns the rate limiter (`p-queue`), circuit breaker, and a per-page write lock (advisory mutex keyed on `notion_id`). This prevents the pagent engine from modifying a page mid-sync and vice versa. The write lock is held for the duration of a single sync operation or pagent action, not across entire workflows.

**State Store (SQLite)** — Persists all sync and workflow metadata:
- Entity map (local path ↔ Notion page ID)
- Base versions for three-way merge
- Sync operation log
- Workflow execution history
- Project registry

### Daemon Lifecycle & Crash Recovery

The MCP server process (daemon) is started by Claude Code via stdio and must survive crashes gracefully.

**Startup sequence:**
1. Open SQLite state store (create if absent)
2. Check WAL for incomplete operations → replay or rollback (see [Sync Engine § Crash Recovery](#crash-recovery))
3. Validate Notion token (single API call)
4. Start filesystem watcher
5. Resume any in-progress pagent workflows from execution log
6. Report ready status to Claude Code

**Crash recovery:**
- On restart after crash, the daemon detects incomplete sync operations via the WAL table and either replays (if Notion write succeeded but entity_map wasn't updated) or rolls back (if Notion write failed)
- In-progress pagent workflows are re-evaluated: completed nodes are skipped, pending nodes are re-queued
- The filesystem watcher catches up via a full diff against `last_local_hash` values in the entity map (not by replaying missed events)

**Health monitoring:**
- `SessionStart` hook checks daemon liveness via `interkasten status --json`
- If daemon is unresponsive, the hook reports the failure and suggests `/interkasten:init` to restart
- The daemon writes a heartbeat timestamp to `~/.interkasten/daemon.pid` every 30 seconds
- Stale PID file (>60s old) indicates a crashed daemon; the next startup cleans it up
- The MCP tool `interkasten_health` provides a structured liveness probe returning: daemon uptime, SQLite connection status, Notion API reachability (last successful call timestamp), circuit breaker state, pending WAL entries, and memory usage. This tool is lightweight (no Notion API calls — uses cached state) and safe to call frequently.

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
| `prompt` | AI agent executes a natural language prompt (page content is sanitized before injection — see below) | Classify research, generate PRD |
| `script` | Shell command receives page data as JSON on stdin (see Script Action Security) | Run linter, call external API |
| `transform` | Built-in data transformation | Fetch URL, set status, copy page, add relation |
| `workflow` | A nested PagentWorkflow (recursive) | `doc-refresh` workflow containing evaluate + update |

**Prompt action input sanitization:** Notion page content flows into AI prompts as context. Since page content is user-editable (and could be externally shared), it is treated as untrusted input:
- Page content is injected into prompts inside clearly delimited `<user_content>` tags, never concatenated directly into the system prompt
- The system prompt for each prompt action explicitly instructs the model to treat content within `<user_content>` as data to analyze, not as instructions to follow
- Content exceeding 50,000 characters is truncated with a notice to prevent context window abuse
- This does not eliminate prompt injection risk entirely (no current technique does), but it follows established best practices for reducing attack surface

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

**Fan-out cardinality limit:** Fan-out is capped at `max_fan_out` (default: 20, configurable in `pagent` config). If a node produces more outputs than the limit, the workflow halts with an error rather than spawning an unbounded number of downstream instances. This prevents a classify action from accidentally matching all N projects and spawning N parallel workflows.

```yaml
nodes:
  - name: classify
    action: classify-research
    fan_out: matched_projects
    max_fan_out: 10                # override default cap for this node

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
- **Script-based** — shell command with JSON stdin/stdout (see security constraints below)
- **Composite** — a named DAG of existing actions (i.e., a workflow)

**Script action security:**
- Script actions receive page data as JSON on stdin. This data originates from Notion page content, which is user-editable and therefore untrusted.
- Scripts run with the daemon's user permissions but in a restricted environment: `PATH` is limited to system binaries + `node_modules/.bin`, `HOME`/`USER` are set, and no other environment variables from the daemon process are inherited (preventing token leakage to scripts).
- Script execution has a per-node timeout (default: 120s, configurable via `pagent.default_timeout_per_node`).
- Scripts are defined by the plugin/workflow author (not by Notion page content), so the command itself is trusted — but its stdin input is not. Script authors must validate/sanitize JSON input before using it in shell commands, SQL queries, or file paths.
- A future sandboxing enhancement (v1.x) could use `bwrap` or container isolation for script actions.

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
│  Deduplication: coalesce by (side, entity_key).         │
│  Only the latest operation per entity is kept.          │
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
  last_notion_hash TEXT,          -- SHA-256 of Notion page content (normalized markdown)
  last_notion_ver TEXT,           -- Notion last_edited_time (fast-path check only)
  base_content_id INTEGER REFERENCES base_content(id),
  last_sync_ts    TEXT NOT NULL,
  UNIQUE(local_path),
  UNIQUE(notion_id)
);

-- Base content stored separately to prevent entity_map bloat.
-- Content-addressed: identical content across entities is stored once.
CREATE TABLE base_content (
  id              INTEGER PRIMARY KEY,
  content_hash    TEXT NOT NULL UNIQUE,  -- SHA-256 of content
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sync log stored locally (not in Notion) so that logging works
-- even when the Notion API is unavailable.
CREATE TABLE sync_log (
  id              INTEGER PRIMARY KEY,
  entity_map_id   INTEGER REFERENCES entity_map(id),
  operation       TEXT NOT NULL,  -- 'push' | 'pull' | 'merge' | 'conflict' | 'error'
  direction       TEXT,           -- 'local_to_notion' | 'notion_to_local'
  detail          TEXT,           -- JSON: error messages, conflict info, merge stats
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Write-ahead log for crash recovery. Every sync operation is logged
-- here BEFORE execution and removed AFTER both sides are consistent.
CREATE TABLE sync_wal (
  id              INTEGER PRIMARY KEY,
  entity_map_id   INTEGER NOT NULL REFERENCES entity_map(id),
  operation       TEXT NOT NULL,  -- 'push' | 'pull' | 'merge'
  state           TEXT NOT NULL,  -- 'pending' | 'target_written' | 'committed' | 'rolled_back'
  old_base_id     INTEGER REFERENCES base_content(id),
  new_content     TEXT,           -- the content being written
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT
);
```

**Schema invariants:**
- `UNIQUE(local_path)` and `UNIQUE(notion_id)` use `ON CONFLICT` behavior: inserts that violate uniqueness raise an error (callers must use upsert or check-then-insert). This prevents silent data loss from duplicate registrations.
- `base_content` is separated from `entity_map` to prevent unbounded table growth. The entity_map table stays small (one row per synced entity with fixed-size columns), while base_content holds the variable-size document text. Content-addressing deduplicates identical versions.
- Orphaned `base_content` rows (no referencing `entity_map.base_content_id`) are garbage-collected during scheduled sweeps.

**Cascade and orphan handling:**
- **Project unregistration** (`interkasten_unregister_project`): Deletes all `entity_map` rows for the project. Does NOT delete Notion pages (they remain as disconnected snapshots). Logs which Notion pages were orphaned so the user can manually clean up if desired.
- **Local file deletion**: Detected by FS watcher as a `file_removed` event. The entity_map row is marked `deleted` (soft delete) but not removed. The corresponding Notion page is NOT deleted — it gets a `⚠️ Source Deleted` status property. On the next scheduled sweep, soft-deleted entity_map rows older than 7 days are hard-deleted.
- **Notion page deletion**: Detected during polling (page returns 404 or `archived: true`). The entity_map row is soft-deleted. The local file is NOT deleted — a warning is logged. The user must explicitly delete the local file if desired.
- **Rationale**: Deletions are never propagated automatically across the bridge. This prevents accidental data loss from either side. The soft-delete window gives users time to recover from mistakes.

### Change Detection

| Source | Method |
|---|---|
| Local files | SHA-256 content hash compared to `last_local_hash` in entity map |
| Notion pages | Two-phase: `last_edited_time` as fast-path filter, then content hash verification |

**Why two-phase Notion change detection:** Notion's `last_edited_time` has second granularity, is non-monotonic under concurrent API writes, and coalesces during rapid edits. Using it as the sole change signal produces false positives (phantom changes) and false negatives (missed real changes). The two-phase approach:

1. **Fast path (cheap):** If `last_edited_time` hasn't changed since last sync, skip this entity. This avoids fetching page content for unchanged pages.
2. **Verification (accurate):** If `last_edited_time` has changed, fetch the page content, compute SHA-256 of normalized markdown, and compare to `last_notion_hash`. Only proceed with sync if the content hash differs. This eliminates phantom changes from metadata-only edits (e.g., property changes, comments) and timestamp jitter.

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

**Roundtrip normalization (preventing phantom conflicts):** Both sides use different representations (markdown vs Notion blocks), so roundtrip conversion is not perfectly lossless. Without normalization, pushing a local file to Notion and pulling it back produces a slightly different markdown, which looks like a "change" on the next sync cycle. To prevent this:
- The `base_content` stored after a push is the **pulled-back version** (local → Notion → markdown), not the original local file. This means the base matches what a future pull would produce.
- Change detection compares `last_local_hash` against the **current** local file hash, not against a roundtripped version. If only Notion-side formatting normalization changed, the local hash is unchanged → no phantom conflict.
- Content hashes on both sides use a **normalized markdown** form: trailing whitespace stripped, line endings unified to `\n`, consecutive blank lines collapsed to one.

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

**Error translation:** Notion API errors are translated to user-friendly messages before being surfaced in sync status or logs:

| Notion Error | User-Facing Message | Remediation |
|---|---|---|
| 401 Unauthorized | "Notion token is invalid or expired" | "Regenerate at notion.so/my-integrations and update INTERKASTEN_NOTION_TOKEN" |
| 403 Forbidden | "Integration lacks access to this page" | "Share the page with your Interkasten integration in Notion" |
| 404 Not Found | "Notion page was deleted or archived" | "Page will be soft-deleted from sync; check Notion trash to restore" |
| 409 Conflict | "Page was modified during sync" | "Will retry on next sync cycle" |
| 429 Rate Limited | "Notion API rate limit reached" | "Backing off automatically; operations will resume shortly" |
| 502/503/504 | "Notion API is temporarily unavailable" | "Circuit breaker will retry automatically" |

Raw HTTP status codes and Notion error codes are logged to `sync_log` for debugging but never shown to the user in status output.

**Webhooks (optional, requires tunnel):**
- Auto-provision a cloudflared tunnel exposing a local webhook receiver
- The cloudflared binary is downloaded from Cloudflare's official GitHub releases. On download, verify the SHA-256 checksum against the published checksums file (`cloudflared-<version>-checksums.txt` from the release). If verification fails, abort with an error and fall back to polling mode.
- Subscribe to Notion webhook events (23 event types available)
- Most events delivered within ~1 minute
- Delivery is at-most-once — polling safety net catches missed events
- **Webhook receiver authentication:** The local webhook endpoint generates a random 32-byte secret at tunnel creation, stored in `~/.interkasten/webhook-secret`. Incoming webhook requests must include this secret in the `X-Interkasten-Webhook-Secret` header. Requests without a valid secret are rejected with 401. The secret is registered with Notion's webhook subscription so Notion includes it in outgoing requests.

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

### Crash Recovery

Every sync operation follows a write-ahead protocol using the `sync_wal` table:

```
1. INSERT into sync_wal (state = 'pending')
2. Write to target (Notion API or local file)
3. UPDATE sync_wal (state = 'target_written')
4. Update entity_map (hash, base_content, timestamp)
5. UPDATE sync_wal (state = 'committed')
6. DELETE from sync_wal (cleanup)
```

**On crash recovery (daemon restart):**
- Query `sync_wal` for rows with state != 'committed'
- `pending` → target write never happened → safe to discard and re-queue
- `target_written` → target was written but entity_map is stale → verify target content, update entity_map, mark committed
- This ensures the entity_map and target are never permanently diverged

**Atomicity guarantee:** Steps 3-5 (entity_map update + WAL state change) execute within a single SQLite transaction. SQLite's own WAL mode ensures these are atomic even if the process crashes mid-transaction.

### Backpressure & Rate Limiting

The operation queue uses `p-queue` for concurrency control, extended with backpressure and circuit-breaking:

**Rate limiting:**
- Concurrency: 3 concurrent Notion API requests (Notion's rate limit is 3 req/sec)
- Queue size limit: 1000 pending operations (configurable via `sync.max_queue_size`)
- When queue is full, new operations are dropped with a warning logged; the next poll cycle will re-detect them

**Notion 429 handling (exponential backoff):**
- On HTTP 429, read `Retry-After` header (or default to 1 second)
- Apply exponential backoff: 1s → 2s → 4s → 8s → 16s → 32s (capped at 32s)
- After 5 consecutive 429s, pause all API calls for 60 seconds
- Reset backoff counter on any successful API call

**Circuit breaker (sustained failures):**
- Track consecutive API failures (any 4xx/5xx, not just 429)
- After 10 consecutive failures: **open** the circuit — stop all Notion API calls
- While open: check health every 60 seconds with a single lightweight API call (`notion.users.me()`)
- On successful health check: **half-open** — allow one real operation through
- On success: **close** the circuit — resume normal operation
- On failure: **re-open** — back to health checks only
- Circuit state is logged and visible via `interkasten_sync_status`

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

35 tools across 7 domains, plus resources and apps.

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
| `interkasten_sync_log` | Query sync log with filters (stored locally in SQLite, not Notion) |
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

### Pagent Workflows (7 tools)

| Tool | Description |
|---|---|
| `interkasten_list_workflows` | List workflows with status and run stats |
| `interkasten_get_workflow` | Full workflow definition + execution history |
| `interkasten_create_workflow` | Register a new workflow from YAML definition |
| `interkasten_run_workflow` | Manually trigger a workflow |
| `interkasten_pause_workflow` | Pause auto-triggering |
| `interkasten_resume_workflow` | Resume a paused workflow |
| `interkasten_workflow_log` | Query execution history |

### Pagent Actions (3 tools)

| Tool | Description |
|---|---|
| `interkasten_list_actions` | List available actions (built-in + custom) |
| `interkasten_run_action` | Run a single action against a page |
| `interkasten_create_action` | Register a new custom action |

### Configuration & Introspection (5 tools)

| Tool | Description |
|---|---|
| `interkasten_init` | First-time setup: create Notion workspace structure |
| `interkasten_config_get` | Read current configuration |
| `interkasten_config_set` | Update configuration |
| `interkasten_version` | Return daemon version, schema version, and plugin compatibility range |
| `interkasten_health` | Liveness probe: uptime, SQLite status, Notion reachability, circuit breaker state, WAL entries |

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

All tools start with `interkasten_` for prefix filtering. Descriptions use domain keywords so Tool Search surfaces the right tools. With Tool Search deferral, the 35 tool definitions don't consume context until needed.

### API Versioning

MCP tool schemas are the API contract between Claude Code and the daemon. Changes to tool input/output schemas can break existing conversations and cached tool definitions.

**Strategy:** Additive-only changes for v1.x. Breaking changes require a major version bump.

- **v1.x (additive):** New optional parameters, new tools, new output fields. Existing tool signatures never change. This covers the entire MVP and first year of development.
- **v2.0 (breaking):** If tool consolidation (e.g., merging CRUD variants) or parameter renaming is needed, it ships as a new major version. The plugin manifest version tracks this.
- **Deprecation:** Tools marked for removal get a `deprecated: true` field in their schema description for at least one minor version before removal.
- **Schema validation:** All tool inputs are validated with Zod schemas. Unknown fields are silently ignored (forward-compatible). Missing required fields return structured error messages.
- **Future consolidation (v2.0 candidate):** The current 35-tool surface prioritizes discoverability (one tool per operation). In v2.0, CRUD variants may be merged into parameterized tools (e.g., `interkasten_workflow({ action: "create" | "list" | "get" | "pause" | "resume" })`) to reduce tool count. Similarly, `pause_workflow`/`resume_workflow` could merge into `interkasten_set_workflow_state`. This is deferred to v2.0 to avoid breaking existing tool references.

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
# Shell-escape the file path to prevent injection from crafted filenames
if [ -n "$FILE_PATH" ]; then
  SAFE_PATH=$(printf '%q' "$FILE_PATH")
  eval interkasten notify-change "$SAFE_PATH" &
fi
echo '{"status":"approve"}'
```

**`PostToolUse(Bash)`** — Catch git operations:
```bash
#!/bin/bash
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
# Only match known git subcommands; do not pass COMMAND to shell execution
echo "$COMMAND" | grep -qE '^git (commit|tag|merge|rebase|pull)' && interkasten notify-git-event &
echo '{"status":"approve"}'
```

**Hook security invariant:** All values extracted from `jq` (which parses untrusted tool output JSON) MUST be shell-escaped with `printf '%q'` before interpolation into any command. The `$COMMAND` variable in the Bash hook is only used as input to `grep`, never passed to `eval` or command execution. The `interkasten notify-*` commands accept arguments positionally and validate them internally (path must exist on disk, no shell metacharacters in git event names).

**`Stop`** — Flush pending sync on session end:
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
| `/interkasten:doctor` | Self-diagnosis: check token validity, daemon health, database access, stale entities, WAL state |

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
| Notion change detector | ~250 | Two-phase detection: `last_edited_time` fast-path + content hash verification |
| Sync WAL + crash recovery | ~200 | Write-ahead log for atomic sync operations |
| Circuit breaker | ~150 | Backpressure, exponential backoff, circuit-breaker state machine |
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

**Native compilation note:** `better-sqlite3` requires a native addon compiled during `npm install`. Pre-built binaries are available for common platforms (macOS arm64/x64, Linux x64, Windows x64). On non-standard platforms (Linux arm64, musl/Alpine, NixOS), compilation requires `python3`, `make`, and a C++ compiler (`gcc` or `clang`). The install script detects missing build tools and provides platform-specific installation instructions. If native compilation fails, the error message includes: "Install build tools: apt install python3 make g++ (Debian/Ubuntu) or xcode-select --install (macOS)".

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

# Notion connection (token read from $INTERKASTEN_NOTION_TOKEN env var, not stored here)
notion:
  workspace_id: "auto-detected-during-init"
  databases:                              # auto-created during init
    projects: null
    research_inbox: null
    pagent_workflows: null
    # sync_log is stored locally in SQLite (not Notion) to ensure
    # logging works even when Notion API is unavailable

# Sync engine
sync:
  poll_interval: 60                       # seconds
  batch_size: 10                          # max API calls per cycle
  max_queue_size: 1000                    # max pending operations before dropping
  conflict_strategy: "three-way-merge"    # three-way-merge | local-wins | notion-wins | conflict-file | ask
  backoff:
    initial_delay_ms: 1000               # first retry delay on 429
    max_delay_ms: 32000                  # maximum backoff cap
    circuit_breaker_threshold: 10        # consecutive failures to open circuit
    circuit_breaker_check_interval: 60   # seconds between health checks when open
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
# Each milestone uses a uniform structure: { trigger: "<event_name>" }
# for event-based triggers, or { threshold: { <metric>: <value>, ... } }
# for metric-based triggers. Optional "mode" field: "all" (default) or "any".
milestones:
  skeleton_prd:
    trigger: "project_detected"
  full_prd:
    threshold: { commits: 5 }
  issues_db:
    trigger: "first_beads_issue"
  roadmap:
    threshold: { commits: 10, beads_closed: 5 }
    mode: "any"                            # fire when ANY threshold is met
  architecture:
    trigger: "dependency_file_detected"
  adr_suggest:
    threshold: { file_churn_ratio: 0.4 }
  changelog:
    trigger: "git_tag_detected"
  full_suite:
    threshold: { commits: 50, beads_closed: 20 }
    mode: "any"

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
  max_fan_out: 20                        # max downstream instances per fan-out node
  default_timeout_per_node: 120          # seconds
  default_timeout_per_workflow: 600      # seconds (whole workflow, not just per-node)
  default_error_policy: "stop"

# Beads integration
beads:
  track_operations: true
  auto_close: true
  priority: 4                            # P4 for automated operations
```

### Secrets Management

The Notion token is the only secret. It is resolved from the environment at daemon startup and never stored in plaintext.

**Token isolation:**
- The token is read by the daemon process directly from `$INTERKASTEN_NOTION_TOKEN` at startup
- The plugin manifest does NOT include the token in its `env` block — this prevents the token from being visible to all hooks and other plugins via Claude Code's environment propagation
- The daemon inherits the token from the user's shell environment (set in `.bashrc`/`.zshrc`)
- Config file references `${INTERKASTEN_NOTION_TOKEN}` as a documentation placeholder only; the actual resolution happens via `process.env`, not config parsing

**Token validation:**
- On startup, the daemon makes a single `notion.users.me()` call to verify the token
- If invalid: daemon logs an actionable error ("INTERKASTEN_NOTION_TOKEN is invalid or expired — generate a new integration token at https://www.notion.so/my-integrations") and exits with code 1
- If missing: daemon logs "INTERKASTEN_NOTION_TOKEN not set — run: export INTERKASTEN_NOTION_TOKEN='ntn_...'" and exits with code 1

```bash
# User sets in shell profile (NOT in plugin manifest or config file)
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
      "args": ["interkasten-daemon@0.1.0"],
      "env": {
        "INTERKASTEN_CONFIG_PATH": "${HOME}/.interkasten/config.yaml"
      }
    }
  },
  "hooks": "hooks/hooks.json"
}
```

### Installation Flow

**Prerequisites (documented in README and `/interkasten:init` output):**
- A Notion account (free tier is sufficient)
- A Notion integration token — created at https://www.notion.so/my-integrations:
  1. Click "New integration"
  2. Name it "Interkasten" (or any name)
  3. Select the workspace to sync with
  4. Required capabilities: Read content, Update content, Insert content, Read user information
  5. Copy the "Internal Integration Secret" (starts with `ntn_`)
- A Notion page or workspace that the integration has been invited to (Share → Invite → select integration)

```
1. claude plugin install interkasten
2. export INTERKASTEN_NOTION_TOKEN="ntn_..."  # add to .bashrc/.zshrc for persistence
3. Start Claude Code, run /interkasten:init
4. Init wizard:
   → Validates token (calls notion.users.me(); exits with actionable error if invalid)
   → Verifies workspace access (lists accessible pages; prompts user if none found)
   → Auto-generates ~/.interkasten/config.yaml with defaults
   → Creates workspace structure (databases) — tracked in init manifest (see below)
   → Scans projects directory
   → Registers discovered projects
   → Generates skeleton PRDs
   → Installs default pagent workflows
   → Shows dashboard
5. Daemon is running. Sync is active.
```

**Init rollback and recovery:**

The init wizard creates several Notion databases and pages. If init fails partway through (network error, token revoked mid-setup), the user is left with a partially-created workspace.

To handle this, init writes an **init manifest** to `~/.interkasten/init-manifest.json` that records every Notion resource created during setup:

```json
{
  "created_at": "2026-02-14T10:30:00Z",
  "workspace_id": "...",
  "resources": [
    { "type": "database", "id": "...", "name": "Projects", "step": 1 },
    { "type": "database", "id": "...", "name": "Research Inbox", "step": 2 },
    { "type": "database", "id": "...", "name": "Pagent Workflows", "step": 3 }
  ],
  "completed": true
}
```

- If `completed: false`, the next `/interkasten:init` run detects the incomplete state and offers: "Previous init was incomplete. Resume from step N, or reset and start over?"
- **Reset** archives all resources listed in the manifest (Notion archive, not permanent delete) and starts fresh
- **Resume** skips already-created resources and continues from the failed step
- `interkasten reset --confirm` provides a manual reset path that archives all tracked resources and deletes the local state store

**Uninstall and corrupted state recovery:**

```
# Full uninstall (removes local state, preserves Notion pages)
interkasten uninstall --confirm
  → Stops daemon process
  → Deletes ~/.interkasten/ (config, state.db, WAL, PID file, webhook secret)
  → Does NOT delete Notion databases/pages (they remain as standalone content)
  → Prints reminder to run: claude plugin uninstall interkasten

# Reset only (keeps plugin installed, rebuilds state)
interkasten reset --confirm
  → Archives Notion databases listed in init manifest
  → Deletes ~/.interkasten/state.db (entity_map, sync_log, WAL)
  → Preserves ~/.interkasten/config.yaml
  → Next /interkasten:init rebuilds workspace from scratch

# Nuclear option for corrupted SQLite
rm ~/.interkasten/state.db
  → Daemon detects missing DB on next startup, creates fresh
  → All sync history is lost; next sync does a full re-scan and push
  → Entity mappings are rebuilt by matching local_path ↔ Notion page titles
```

**Zero-config path:** `interkasten init --defaults` skips interactive prompts, uses `~/projects` as projects_dir, creates config with all defaults, and begins syncing immediately. Useful for CI/automation or users who prefer to configure later.

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
│   └── plugin.json
│
├── hooks/
│   ├── hooks.json
│   ├── session-start.sh
│   ├── post-edit.sh
│   ├── post-bash.sh
│   └── stop.sh
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

### Revenue Model Assumptions (Unvalidated)

> **Note:** The projections below are aspirational targets, not forecasts. They are included to illustrate the business model structure, not to predict outcomes. Before pursuing monetization, the following evidence gates must be cleared:

**Evidence gates (must validate before Layer 2/3 investment):**
1. **User acquisition:** Measure organic installs from Claude Code marketplace listing over 90 days. Target: 100+ free installs to validate demand.
2. **Retention:** Track weekly active users (daemon heartbeat) over 60 days. Target: 30%+ WAU/MAU ratio.
3. **Willingness to pay:** Survey free users about workflow marketplace interest. Target: 10%+ expressing interest.
4. **Conversion funnel:** Measure marketplace → trial → purchase flow. No benchmark exists for Claude Code plugin commerce.

**Aspirational targets (contingent on evidence gates):**

| Month | Free Users | Workflow Sales | Cloud MRR | Total |
|---|---|---|---|---|
| 3 | 200 | $300 | $0 | $300 |
| 6 | 800 | $800 | $300 | $1,100 |
| 12 | 2,500 | $1,500 | $2,000 | $3,500 |
| 18 | 5,000 | $2,000 | $6,000 | $8,000 |
| 24 | 10,000 | $3,000 | $12,000 | $15,000 |

These numbers assume conversion rates (free→paid) that have not been benchmarked against comparable Claude Code plugins (none exist yet with paid tiers). The projections will be revised after the first evidence gate (90-day install measurement).

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
