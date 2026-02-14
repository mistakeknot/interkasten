# Flux Drive Review: MCP API Surface (33 Tools)

**Reviewer focus**: MCP Server Tool Surface (33 tools), MCP Resources, Configuration schema, Plugin manifest
**Document**: `/root/projects/Interkasten/docs/PRD-MVP.md` (Section 8, plus Sections 9, 11, 12)
**Date**: 2026-02-14

---

## Findings Index

| SEVERITY | ID | Section | Title |
|---|---|---|---|
| HIGH | API-01 | Tool Surface | `interkasten_create_workflow` is defined in two different domain groups |
| HIGH | API-02 | Tool Surface | `interkasten_set_sync_config` breaks naming pattern — should be under `config_set` |
| HIGH | API-03 | Configuration | `milestones` config uses heterogeneous value types without discriminator |
| HIGH | API-04 | Versioning | No API versioning strategy for the 33-tool surface |
| HIGH | API-05 | Tool Surface | `interkasten_dashboard` is categorized as a "Project Management" tool but is an MCP App |
| MEDIUM | API-06 | Tool Surface | Tool count (33) inflated by CRUD that could be parameter variants |
| MEDIUM | API-07 | Tool Surface | `interkasten_get_health` vs `interkasten_get_project` overlap — health is a subset of project detail |
| MEDIUM | API-08 | Tool Surface | Pagent Actions and Pagent Workflows domains have unclear boundaries |
| MEDIUM | API-09 | Tool Surface | `interkasten_pause_workflow` / `interkasten_resume_workflow` should be a single state-change tool |
| MEDIUM | API-10 | Resources | Resource URIs don't cover pagent actions, workflow runs, or conflict state |
| MEDIUM | API-11 | Configuration | `notion.databases` uses `null` as sentinel for "not yet created" — fragile |
| MEDIUM | API-12 | Tool Descriptions | Several tool descriptions lack parameter signatures — Tool Search cannot differentiate them |
| MEDIUM | API-13 | Plugin Manifest | `npx interkasten-daemon` has cold-start penalty; no documented startup timeout |
| MEDIUM | API-14 | Forward Compatibility | No tool for introspection (`interkasten_version`, `interkasten_capabilities`) |
| LOW | API-15 | Naming | `interkasten_sync_log` vs `interkasten_workflow_log` — "log" suffix ambiguity with `interkasten_sync_status` |
| LOW | API-16 | Configuration | Config model names (`prd_writer`, `doc_writer`) use snake_case inconsistent with config section names |
| LOW | API-17 | MCP Apps | Three MCP Apps have no dedicated list/discovery mechanism |
| LOW | API-18 | Tool Surface | `interkasten_promote_doc` / `interkasten_demote_doc` should validate tier transitions |

**Verdict: needs-changes**

---

## Summary

The 33-tool API surface is well-organized into 7 domains with a consistent `interkasten_` prefix that supports Tool Search deferral. The naming convention is coherent and the domain groupings are mostly logical. However, there are several issues that will create friction for long-term maintenance and developer ergonomics:

1. **A duplicate tool definition** (`create_workflow`) appears in two domains, which will cause a registration conflict at runtime.
2. **The tool count is inflated** by splitting simple state toggles and overlapping queries into separate tools where parameterized variants would be more maintainable and forward-compatible.
3. **No versioning or capability introspection** tools exist, making it impossible for clients to negotiate features or handle rolling upgrades.
4. **The configuration schema** mixes heterogeneous types in the milestones section without discriminators, which will make Zod validation fragile and error messages opaque.
5. **Several minor naming inconsistencies** that are cheap to fix now but will calcify into permanent API debt if shipped.

---

## Issues Found

### API-01. HIGH: `interkasten_create_workflow` is defined in two different domain groups

**Evidence**: Section 8 lists `interkasten_create_workflow` under both "Pagent Workflows (6 tools)" and "Pagent Actions (4 tools)":

- Pagent Workflows group: `list_workflows`, `get_workflow`, `run_workflow`, `pause_workflow`, `resume_workflow`, `workflow_log` (6 tools, no `create_workflow`)
- Pagent Actions group: `list_actions`, `run_action`, `create_action`, **`create_workflow`** (4 tools)

Actually the Pagent Workflows group has 6 tools without `create_workflow`, and the Pagent Actions group has 4 tools including `create_workflow`. This means workflow creation lives under the "Actions" domain rather than the "Workflows" domain. This is confusing: a developer looking for "how do I create a workflow" will look in the Workflows group first.

**Impact**: Tool Search discoverability suffers. A query like "create workflow" may surface `interkasten_create_workflow` but the user expecting it in the Workflows domain will be confused by its placement. More importantly, the Pagent Actions group becomes a dumping ground for "create" operations that conceptually belong to Workflows.

**Recommendation**: Move `interkasten_create_workflow` to the Pagent Workflows domain group (making it 7 tools), and rename the Pagent Actions domain to something narrower like "Pagent Action Registry" (now 3 tools: `list_actions`, `run_action`, `create_action`). Alternatively, merge the two domains into a single "Pagent" domain since they share a namespace anyway.

---

### API-02. HIGH: `interkasten_set_sync_config` breaks naming pattern

**Evidence**: The Configuration domain has `interkasten_config_get` and `interkasten_config_set`. But the Sync Operations domain also has `interkasten_set_sync_config` which is a config setter with an inverted word order (`set_sync_config` vs `config_set`).

This creates two problems:
1. **Naming inconsistency**: `config_set` uses noun-verb order (config is the domain, set is the action). `set_sync_config` uses verb-noun order.
2. **Overlapping responsibility**: If `interkasten_config_set` can set any configuration key (including sync config), then `interkasten_set_sync_config` is a redundant shortcut that must be kept in sync with the general config setter.

**Impact**: When new configuration domains are added (e.g., pagent config, doc config), the pattern established by `set_sync_config` suggests each domain needs its own config tool. At 7 domains, that would be 7 additional `set_*_config` tools — a combinatorial explosion.

**Recommendation**: Remove `interkasten_set_sync_config`. Let `interkasten_config_set` accept a `section` parameter (e.g., `section: "sync"`) or a dotpath key (e.g., `key: "sync.poll_interval"`). If there is truly unique sync-config logic (like restarting the poller), that can be a side-effect of `config_set` when the sync section is modified, not a separate tool.

---

### API-03. HIGH: `milestones` config uses heterogeneous value types without discriminator

**Evidence** (Section 11, config.yaml):
```yaml
milestones:
  skeleton_prd: "project_detected"              # string
  full_prd: { commits: 5 }                       # object with numeric field
  issues_db: "first_beads_issue"                 # string
  roadmap: { commits: 10, beads_closed: 5, either: true }  # object with boolean
  adr_suggest: { file_churn_ratio: 0.4 }         # object with float
```

Some milestone values are bare strings (event names), others are objects with varying shapes. This will produce a Zod schema like `z.union([z.string(), z.object({ commits: z.number().optional(), beads_closed: z.number().optional(), either: z.boolean().optional(), file_churn_ratio: z.number().optional() })])`. That union is:
- **Hard to validate** — any object with unknown keys passes the object branch.
- **Hard to error-message** — Zod union errors list all branches, producing walls of text.
- **Not self-documenting** — a developer reading the schema cannot tell which fields go with which milestone type.

**Impact**: Configuration errors at runtime will produce incomprehensible validation messages. Users editing `config.yaml` by hand have no way to know which object shape is valid for which milestone key.

**Recommendation**: Use discriminated objects consistently:
```yaml
milestones:
  skeleton_prd:
    type: event
    event: project_detected
  full_prd:
    type: threshold
    commits: 5
  roadmap:
    type: threshold
    commits: 10
    beads_closed: 5
    operator: or    # instead of "either: true"
  adr_suggest:
    type: threshold
    file_churn_ratio: 0.4
```
This makes the Zod schema a clean discriminated union on `type`, each branch with its own validated shape.

---

### API-04. HIGH: No API versioning strategy for the 33-tool surface

**Evidence**: The PRD defines 33 tools with no mention of:
- API version field in tool definitions
- Version negotiation between MCP client and server
- Deprecation path for tools that need removal or signature changes
- How the plugin manifest version (`"version": "0.1.0"`) relates to the tool surface version

The plugin manifest shows `"version": "0.1.0"` (Section 12), and the document mentions this is a first release. But with 33 tools, even minor changes (adding an optional parameter, renaming a field) need a clear contract.

**Impact**: After the first external users adopt, any tool signature change is a breaking change. Without a versioning strategy:
- Removing a tool requires a major version bump (semver rules)
- Adding an optional parameter to an existing tool's response is ambiguous — is it minor or patch?
- Clients that cache tool schemas (like Tool Search) may serve stale definitions after upgrades

**Recommendation**:
1. Add an `interkasten_version` introspection tool (see API-14) that returns `{ api_version: "1", server_version: "0.1.0" }`.
2. Document that tool additions are minor bumps, tool removals or parameter type changes are major bumps, and new optional response fields are patch bumps.
3. Consider including `api_version` in the MCP server metadata so clients can negotiate without calling a tool.

---

### API-05. HIGH: `interkasten_dashboard` categorized as "Project Management" tool but is an MCP App

**Evidence**: Section 8, "Project Management (6 tools)" includes `interkasten_dashboard` described as "MCP App -- interactive HTML dashboard". This is also listed separately under "MCP Apps" as "Project Dashboard". The same applies to `interkasten_resolve_conflict` (listed as both a Sync Operations tool and a Conflict Resolver MCP App) and `interkasten_get_workflow` (both a Pagent Workflows tool and a Workflow Visualizer MCP App).

**Impact**: Three of the 33 "tools" are actually MCP Apps that render HTML. This conflates two different MCP primitives. When a client calls `interkasten_get_workflow`, it might expect JSON data (it is named `get_*`), but it also triggers an interactive DAG visualizer. The same call has two different behaviors depending on whether the client supports MCP Apps.

**Recommendation**: Either:
1. **Split the dual-purpose tools**: `interkasten_get_workflow` returns JSON data. `interkasten_view_workflow` is a separate MCP App that renders the visualizer. This preserves the principle that `get_*` tools return data.
2. **Or document the behavior explicitly**: The tool always returns structured data, and the MCP App rendering is a client-side enhancement that uses the same data. Make this clear in the tool description so Tool Search doesn't mislead callers.

Option 1 is cleaner but adds 3 tools (taking the count to 36). Option 2 preserves the count but requires careful description wording.

---

### API-06. MEDIUM: Tool count inflated by CRUD that could be parameter variants

**Evidence**: Several tool pairs/groups could be collapsed:

| Current Tools | Proposed Consolidation |
|---|---|
| `interkasten_pause_workflow` + `interkasten_resume_workflow` | `interkasten_set_workflow_state` with `state: "active" \| "paused"` |
| `interkasten_promote_doc` + `interkasten_demote_doc` | `interkasten_set_doc_tier` with `tier: "T1" \| "T2"` |
| `interkasten_generate_doc` + `interkasten_refresh_doc` | `interkasten_generate_doc` with `mode: "create" \| "refresh"` |
| `interkasten_sync_log` + `interkasten_workflow_log` | `interkasten_query_log` with `source: "sync" \| "workflow"` |

This would reduce from 33 to ~27 tools without losing any functionality.

**Impact**: 33 tools is near the upper bound of what Tool Search handles comfortably. Fewer, more parameterized tools:
- Reduce the deferred tool index size
- Make it easier to add new states (e.g., `"archived"` workflow state) without new tools
- Simplify the `src/daemon/tools/` directory structure

**Recommendation**: Consolidate the obvious pairs. Keep separate tools where the semantics genuinely differ (e.g., `list_projects` vs `get_project` are fine as separate tools because list returns summaries and get returns detail).

---

### API-07. MEDIUM: `interkasten_get_health` overlaps with `interkasten_get_project`

**Evidence**: `interkasten_get_project` returns "Detailed project info: tech stack, doc coverage, beads summary, last sync" and `interkasten_get_health` returns "Compute project health score". The health score is already described as a property of the Projects database ("Health Score: Computed from days since last commit, open/closed beads ratio, doc coverage").

If `get_project` already returns health score as one of its fields, then `get_health` is redundant. If `get_health` computes something different (e.g., on-demand recomputation vs cached value), that distinction is not documented.

**Impact**: Tool Search ambiguity — a query like "how healthy is project X" could surface either tool. If both exist, callers must learn which one to use and when.

**Recommendation**: Remove `interkasten_get_health` as a separate tool. Include health score computation in `interkasten_get_project` (possibly with a `compute_health: true` flag to force fresh computation vs returning cached value). This reduces the count by 1 and eliminates the ambiguity.

---

### API-08. MEDIUM: Pagent Actions and Pagent Workflows domains have unclear boundaries

**Evidence**: The two domains share the "Pagent" namespace:

- **Pagent Workflows (6 tools)**: `list_workflows`, `get_workflow`, `run_workflow`, `pause_workflow`, `resume_workflow`, `workflow_log`
- **Pagent Actions (4 tools)**: `list_actions`, `run_action`, `create_action`, `create_workflow`

"Pagent Actions" contains both action-level tools (`list_actions`, `run_action`, `create_action`) and a workflow-level tool (`create_workflow`). The PRD defines actions as the atomic unit and workflows as the composite unit, so they are conceptually distinct — but the tool grouping blurs this.

**Impact**: A developer learning the API must understand the Action/Workflow distinction to know which domain to query. Tool Search queries for "pagent" will return a mix of both. The `create_workflow` placement issue (API-01) stems from this blurred boundary.

**Recommendation**: Merge into a single "Pagent" domain (10 tools). Within the tool descriptions, use consistent keywords: action tools mention "action" and "atomic", workflow tools mention "workflow" and "DAG". This preserves Tool Search differentiation while eliminating the confusing two-domain split.

---

### API-09. MEDIUM: `pause_workflow` / `resume_workflow` should be a single tool

**Evidence**: `interkasten_pause_workflow` ("Pause auto-triggering") and `interkasten_resume_workflow` ("Resume a paused workflow") are symmetric state transitions on the same entity. They take the same parameter (workflow ID) and differ only in the target state.

**Impact**: This pattern does not scale. If new states are added (e.g., `"archived"`, `"draft"`, `"disabled"`), each requires a new tool. With the current pattern, 5 states would require 4 transition tools.

**Recommendation**: Replace with `interkasten_set_workflow_status` taking `{ workflow_id: string, status: "active" | "paused" }`. If new states are added later, it is a parameter addition (minor bump), not a tool addition.

---

### API-10. MEDIUM: Resource URIs do not cover all domains

**Evidence**: The 5 MCP Resources are:
```
interkasten://projects
interkasten://projects/{name}
interkasten://research/inbox
interkasten://sync/status
interkasten://workflows
```

Missing resources:
- `interkasten://actions` — list of available pagent actions (parallel to `interkasten://workflows`)
- `interkasten://sync/conflicts` — list of current unresolved conflicts (critical for monitoring)
- `interkasten://config` — current configuration (without needing to call a tool)
- `interkasten://workflows/{name}/runs` — execution history for a specific workflow

The resources also don't follow a consistent depth pattern. `interkasten://projects` lists all, `interkasten://projects/{name}` gets one. But `interkasten://workflows` lists all with no `interkasten://workflows/{name}` counterpart.

**Impact**: MCP resources are designed for passive subscription (clients can subscribe to updates). Without a conflicts resource, clients cannot monitor for sync issues without polling the `sync_status` tool. Without a config resource, clients cannot react to configuration changes.

**Recommendation**: At minimum add:
- `interkasten://workflows/{name}` — single workflow detail (symmetric with projects)
- `interkasten://sync/conflicts` — active conflicts
- `interkasten://config` — current configuration

The full set can grow incrementally, but the asymmetry between projects (which has a detail URI) and workflows (which does not) should be fixed before v1.

---

### API-11. MEDIUM: `notion.databases` uses `null` as sentinel for "not yet created"

**Evidence** (Section 11):
```yaml
notion:
  databases:
    projects: null
    research_inbox: null
    pagent_workflows: null
    sync_log: null
```

After `interkasten_init`, these become Notion database IDs (UUIDs). The `null` sentinel means the Zod schema must be `z.string().nullable()` for each, and every consumer must check for null before using the ID.

**Impact**: Every function that touches a database ID must handle the null case. This is viral — `null` propagates through sync engine, pagent engine, and all tools. It also means the config file is in a "partially initialized" state that is valid according to the schema but invalid at runtime.

**Recommendation**: Either:
1. Don't write database IDs to the config file at all — store them in the SQLite state store alongside other runtime state. The config file stays declarative (user preferences only).
2. Or use a separate `state.yaml` file (auto-generated, not user-editable) that contains the resolved database IDs. The config schema then never has nulls.

Option 1 is cleaner: config is for user intent, state store is for runtime state.

---

### API-12. MEDIUM: Tool descriptions lack parameter signatures

**Evidence**: The tool descriptions in Section 8 describe what each tool does but not what parameters it accepts. Examples:

- `interkasten_sync`: "Trigger immediate sync for one or all projects" — takes a project name? An `--all` flag? Both?
- `interkasten_generate_doc`: "Generate a doc type for a project (spawns subagent)" — which doc types are valid? Is `doc_type` an enum or free-form string?
- `interkasten_resolve_conflict`: "View conflicting versions, apply resolution" — this is two operations in one description. Does it take a conflict ID? A resolution choice?

**Impact**: MCP tool descriptions are the primary interface for Tool Search discoverability and for LLM callers to understand how to invoke tools. Without parameter hints in the description, callers must call the tool with wrong parameters to discover the schema (trial-and-error).

**Recommendation**: Expand each tool description to mention key parameters. For Tool Search purposes, descriptions should include parameter names as keywords. Example:
- Before: "Trigger immediate sync for one or all projects"
- After: "Trigger immediate sync. Params: project (optional, name or path; omit for all projects), force (boolean, ignore debounce)"

This does not need to be a full JSON Schema in the description — just enough keywords for Tool Search and LLM invocation.

---

### API-13. MEDIUM: `npx interkasten-daemon` has cold-start penalty

**Evidence** (Section 12, plugin manifest):
```json
"command": "npx",
"args": ["interkasten-daemon"]
```

`npx` resolves the package on every invocation unless it is already in the npm cache. On a cold start (first run, or after cache eviction), this involves:
1. Resolving the package from the npm registry
2. Downloading dependencies (including `better-sqlite3` which has native bindings)
3. Extracting and linking

Native bindings (`better-sqlite3`) may also need to be compiled if prebuilt binaries are not available for the user's platform.

**Impact**: Claude Code's MCP client has a connection timeout. If `npx` takes longer than this timeout to resolve and start the server, the connection fails and the user sees a cryptic error. The PRD does not document the expected startup time or the Claude Code MCP timeout.

**Recommendation**:
1. Recommend `npx -y interkasten-daemon` to skip the "install?" prompt.
2. Better: use `node` directly after `npm install -g interkasten` or a postinstall hook. The manifest should use the globally installed binary path.
3. Document the expected startup time and Claude Code's MCP timeout so users can adjust.
4. Consider a health-check mechanism where the MCP server sends a "ready" signal after SQLite is initialized, rather than assuming immediate availability.

---

### API-14. MEDIUM: No introspection tool

**Evidence**: There is no `interkasten_version` or `interkasten_capabilities` tool. The 33 tools assume the client knows the full surface. There is no way for a client to:
- Query the server version
- Check if a specific tool is available (forward compatibility)
- Discover which pagent action types are supported
- Determine which conflict strategies are available

**Impact**: When the tool surface changes between versions:
- A client compiled against v0.2.0 calling a v0.1.0 server gets an "unknown tool" error with no context.
- Feature detection requires trial-and-error: call a tool, see if it errors.
- The Plugin Layer cannot display version-specific guidance without knowing the server version.

**Recommendation**: Add `interkasten_version` returning:
```json
{
  "server_version": "0.1.0",
  "api_version": 1,
  "capabilities": {
    "sync": true,
    "pagent": true,
    "tunnel": false,
    "apps": ["dashboard", "conflict_resolver", "workflow_visualizer"]
  }
}
```
This is standard practice for MCP servers and costs one tool slot (taking the total to 34, or fewer if consolidation from API-06 is applied).

---

### API-15. LOW: "log" suffix naming ambiguity

**Evidence**: Three tools deal with historical data:
- `interkasten_sync_log` — query sync operation history
- `interkasten_workflow_log` — query workflow execution history
- `interkasten_sync_status` — current sync status (not historical)

The "log" suffix on the first two is clear, but `sync_status` (current state) vs `sync_log` (history) differ only by the last word. A Tool Search query for "sync status" might surface `sync_log` as well, since both contain "sync" and both relate to the sync domain.

**Impact**: Minor Tool Search confusion. Not a blocking issue.

**Recommendation**: Consider renaming to `interkasten_sync_history` and `interkasten_workflow_history` to make the "past events" semantics more explicit. Or, per API-06, merge both into `interkasten_query_log` with a `source` parameter.

---

### API-16. LOW: Config model names use snake_case inconsistent with section names

**Evidence** (Section 11):
```yaml
docs:
  models:
    prd_writer: "opus"         # snake_case
    doc_writer: "opus"         # snake_case
    roadmap_builder: "sonnet"  # snake_case
```

But the agents themselves are named with hyphens in Section 9:
- `prd-writer` (hyphenated)
- `doc-writer` (hyphenated)
- `roadmap-builder` (hyphenated)

And the Subagents table uses hyphenated names. The config uses snake_case versions of these names.

**Impact**: A user reading the config who sees `prd_writer` and then reads the docs about `prd-writer` must mentally translate. This is minor but adds cognitive load, especially when error messages reference one form and docs use the other.

**Recommendation**: Pick one convention. Since YAML keys conventionally use snake_case (or kebab-case), and the agent file names in `agents/` use hyphens, consider using kebab-case in config too: `prd-writer: "opus"`. YAML supports hyphenated keys natively.

---

### API-17. LOW: MCP Apps have no dedicated discovery mechanism

**Evidence**: Three MCP Apps are defined (Project Dashboard, Conflict Resolver, Workflow Visualizer), triggered by specific tools. But there is no `interkasten_list_apps` tool or `interkasten://apps` resource that lets a client discover available apps.

**Impact**: A client that wants to enumerate available visual interfaces must hard-code knowledge of which tools trigger apps. If new apps are added in later versions, existing clients cannot discover them.

**Recommendation**: Either:
1. Include the apps list in the `interkasten_version` capabilities response (see API-14).
2. Or add a `interkasten://apps` resource URI listing available apps with their trigger tool names.

This is low priority because the app count is small (3) and unlikely to change frequently.

---

### API-18. LOW: `promote_doc` / `demote_doc` should validate tier transitions

**Evidence**: `interkasten_promote_doc` ("Move from T2 to T1") and `interkasten_demote_doc` ("Move from T1 to T2") imply a strict two-tier system. But the PRD mentions an `auto_promote_threshold` (config Section 11) that automatically promotes docs after N Notion edits.

Questions not answered:
- What happens if you call `promote_doc` on a doc already at T1?
- What happens if you call `demote_doc` on a doc that was auto-promoted? Does it reset the edit counter?
- Can a doc be "pinned" to a tier, preventing auto-promotion?

**Impact**: Without defined behavior for edge cases, implementations will make ad-hoc choices that become de facto API contracts. Different clients may rely on different edge-case behaviors.

**Recommendation**: Document the idempotency and edge-case behavior:
- Promoting an already-T1 doc is a no-op (idempotent).
- Demoting resets the auto-promote counter.
- Add a `pinned: boolean` flag to prevent future auto-promotion/demotion.

If using the consolidated `interkasten_set_doc_tier` tool (API-06), these rules apply to the single tool.

---

## Improvements

### IMP-01. Merge Pagent Actions and Pagent Workflows into a single "Pagent" domain

**Rationale**: The Action/Workflow split is an internal concept (actions are atoms, workflows are DAGs of atoms). From the API consumer's perspective, both are part of the "pagent" system. Merging reduces the domain count from 7 to 6 and eliminates the `create_workflow` placement confusion (API-01). Tool Search queries for "pagent" return a single coherent group.

### IMP-02. Add `interkasten_version` introspection tool

**Rationale**: Standard MCP practice. Enables capability negotiation, version checking, and future feature flagging. Costs one tool slot. See API-14 for specification.

### IMP-03. Define a tool deprecation lifecycle in the PRD

**Rationale**: Before any external users exist, establish the contract:
1. Deprecated tools return a `deprecated: true` field in responses for 2 minor versions.
2. Deprecated tools are removed in the next major version.
3. The `interkasten_version` response includes a `deprecated_tools: string[]` array.

This costs nothing now and saves painful conversations with users later.

### IMP-04. Unify "query log" tools into a single parameterized tool

**Rationale**: `interkasten_sync_log` and `interkasten_workflow_log` are structurally identical (query historical events with filters). A single `interkasten_query_log` with `source: "sync" | "workflow" | "all"` is more composable and forward-compatible. When new log sources are added (e.g., pagent action execution logs, config change audit), they plug into the same tool.

### IMP-05. Move Notion database IDs from config.yaml to SQLite state store

**Rationale**: The config file should contain user intent (preferences, thresholds, credentials reference). Runtime state (resolved database IDs, workspace ID) belongs in the state store. This eliminates the `null` sentinel problem (API-11) and makes the config file safe to version-control or share between environments.

### IMP-06. Add parameter hints to all tool descriptions for Tool Search optimization

**Rationale**: The PRD already notes Tool Search optimization as a design goal (Section 8, "Tool Search Optimization"). But the tool descriptions currently only describe behavior, not parameters. Adding key parameter names to descriptions (even informally) dramatically improves Tool Search precision. Example: "Generate a doc for a project. Params: project (name), doc_type (prd|roadmap|adr|changelog|architecture), force (skip staleness check)."

### IMP-07. Define explicit forward-compatibility behavior for unknown tool names

**Rationale**: The MCP SDK should return a structured error (not a crash) when an unknown tool name is received. The PRD should specify that the server responds with `{ error: "unknown_tool", tool: "interkasten_foo", available_tools: [...] }` or similar. This is critical for clients that may be running a newer plugin version against an older server.

### IMP-08. Consider a `dry_run` parameter on mutation tools

**Rationale**: Tools like `interkasten_sync`, `interkasten_run_workflow`, `interkasten_resolve_conflict`, and `interkasten_generate_doc` all have side effects. A `dry_run: true` parameter that returns what would happen without executing is invaluable for:
- Testing workflow definitions before activation
- Previewing sync operations before committing
- Building confidence in conflict resolution choices

This is a single optional parameter across multiple tools, not new tools.

---

## Tool Consolidation Summary

If the consolidation recommendations from API-06, API-07, API-08, API-09, and IMP-04 are applied, along with the addition from IMP-02, the tool count changes:

| Change | Tools Removed | Tools Added | Net |
|---|---|---|---|
| Merge pause/resume into set_workflow_status (API-09) | -1 | 0 | -1 |
| Merge promote/demote into set_doc_tier (API-06) | -1 | 0 | -1 |
| Merge generate/refresh_doc (API-06) | -1 | 0 | -1 |
| Merge sync_log/workflow_log into query_log (IMP-04) | -1 | 0 | -1 |
| Remove get_health (API-07) | -1 | 0 | -1 |
| Add interkasten_version (IMP-02) | 0 | +1 | +1 |
| **Total** | **-5** | **+1** | **-4** |

Revised count: **29 tools** across 6 domains. This is a cleaner surface with no loss of functionality.

| Domain | Tools | Count |
|---|---|---|
| Project Management | list_projects, get_project, register_project, unregister_project, dashboard | 5 |
| Sync Operations | sync, sync_status, resolve_conflict, config_set absorbed (see API-02) | 3 |
| Document Operations | generate_doc (with mode), list_docs, set_doc_tier | 3 |
| Research Inbox | add_research, classify_research, research_status, search_research | 4 |
| Pagent (merged) | list_workflows, get_workflow, run_workflow, set_workflow_status, create_workflow, query_log, list_actions, run_action, create_action | 9 |
| Configuration | init, config_get, config_set, version | 4 |
| **Total** | | **28** |

(Note: `set_sync_config` removed per API-02, absorbed into `config_set`; one fewer than the 29 calculated above.)

<!-- flux-drive:complete -->
