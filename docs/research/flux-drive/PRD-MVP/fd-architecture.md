# Flux-Drive Architecture Review: PRD-MVP

**Document**: `/tmp/flux-drive-PRD-MVP-1771064907.md` (interkasten Design Document)
**Review Date**: 2026-02-14
**Reviewer**: Flux-Drive Architecture Agent
**Focus**: Architecture (three layers), Sync Engine, Pagent System, Technology Stack, Deployment

---

### Findings Index

- CRITICAL | A1 | "Architecture" | Sync Engine lacks dependency isolation boundaries
- CRITICAL | A2 | "Architecture" | Pagent recursive workflow expansion has no cycle prevention timing guarantees
- CRITICAL | A3 | "Sync Engine" | No backpressure mechanism for Notion API rate limiting failures
- CRITICAL | A4 | "Technology Stack" | Markdown conversion libraries have known fidelity gaps contradicting bidirectional claim
- HIGH | A5 | "Sync Engine" | Three-way merge base storage strategy undefined for concurrent edits
- HIGH | A6 | "Pagent System" | DAG execution fan-out has no resource limit specification
- HIGH | A7 | "Architecture" | MCP Server daemon restart/recovery strategy missing
- HIGH | A8 | "Deployment" | No migration path specified for schema evolution in production
- MEDIUM | A9 | "Pagent System" | Workflow trigger evaluation frequency undefined creates performance risk
- MEDIUM | A10 | "Architecture" | Hook execution blocking time budget missing
- MEDIUM | A11 | "Sync Engine" | Polling safety net conflicts with webhook delivery semantics
- MEDIUM | A12 | "Technology Stack" | No validation that chosen libraries support Notion API 2025-09-03
- LOW | I1 | "Architecture" | MCP Apps HTML rendering security model unstated
- LOW | I2 | "Sync Engine" | Beads-to-Notion dependency mapping direction ambiguous
- LOW | I3 | "Deployment" | Cloudflared tunnel auto-provisioning complexity understated
- LOW | I4 | "Competitive Position" | Missing analysis of official Notion API limitations

**Verdict**: needs-changes

Critical issues in sync engine backpressure and markdown conversion fidelity must be resolved. Architecture boundaries need tightening before implementation.

---

### Summary

This PRD presents an ambitious three-layer architecture (Plugin → MCP Server → Subagents) with a novel pagent workflow system. The design demonstrates sophisticated thinking about bidirectional sync and adaptive documentation. However, the architecture has four critical structural gaps: (1) the sync engine's dependency on external libraries with known fidelity limitations contradicts the "95%+ lossless" claim without a mitigation plan, (2) no backpressure or circuit-breaker mechanism exists when Notion's rate limiter pushes back, (3) the pagent recursive workflow expansion's cycle detection happens at registration but runtime validation is only a "double-check" without stated timing guarantees, and (4) the three-layer architecture lacks explicit dependency isolation boundaries that would prevent the MCP server from becoming a god-module coupling filesystem watching, sync reconciliation, pagent execution, and SQLite state management. The design is implementable but needs boundary clarification and failure-mode hardening before coding begins.

---

### Issues Found

**A1. CRITICAL: Sync Engine lacks dependency isolation boundaries**

The MCP Server layer (Section 2, Layer 1) describes four internal components (Filesystem Watcher, Sync Engine, Pagent Workflow Engine, State Store) but provides no interface contracts or isolation guarantees between them. The architecture diagram shows them all sharing direct access to the SQLite state store without mediation. This creates hidden coupling risks: the Sync Engine's reconciliation logic, the Pagent Engine's workflow execution tracking, and the Filesystem Watcher's change detection all write to overlapping state. If the Sync Engine batches operations but the Pagent Engine triggers a workflow that reads entity state mid-batch, the pagent sees partial state. The PRD states "Sync Engine batches operations to minimize Notion API calls" (Section 2) but doesn't specify transaction boundaries or read-your-writes guarantees for concurrent components.

**Evidence**: Section 2 architecture diagram shows all four components with direct arrows to the State Store. No transaction coordinator or state machine mediator is specified. Section 6 describes operation queuing but doesn't address cross-component consistency.

**Impact**: Without isolation boundaries, the sync engine and pagent engine will interfere with each other's state assumptions, leading to race conditions where a pagent workflow operates on stale entity mappings or where sync reconciliation overwrites pagent execution metadata.

**Recommendation**: Introduce a State Coordinator layer that mediates all reads/writes to the SQLite store. Define transaction boundaries: sync operations are one transaction scope, pagent workflow executions are another. Specify read-your-writes guarantees or introduce eventual consistency with version vectors if components must read during active sync cycles.

---

**A2. CRITICAL: Pagent recursive workflow expansion has no cycle prevention timing guarantees**

Section 3 states "Validates — Checks for cycles (at registration time and double-checked at runtime)" but provides no timing budget or algorithm complexity bounds for runtime cycle detection. The pagent system allows workflows to be nested arbitrarily deep (Section 3: "Fully recursive: a workflow can contain other workflows as nodes"). If a workflow is modified after registration (via Notion edits or custom action registration), runtime cycle detection could execute during DAG expansion while holding locks or blocking the sync engine. The PRD specifies "max_dag_depth: 10" in the configuration (Section 11) but doesn't state what happens when expansion exceeds this—does it fail fast, truncate, or retry?

**Evidence**: Section 3 describes recursive expansion ("Expands — Recursively flattens nested workflows into a single DAG") but Section 11's `max_dag_depth: 10` appears in the pagent config without enforcement semantics. No mention of how workflow updates bypass registration-time validation.

**Impact**: A malicious or buggy workflow definition (either user-created or introduced via a Notion edit that syncs back) could cause the pagent engine to hang during expansion, blocking all other pagent triggers and potentially the sync engine if they share execution threads.

**Recommendation**: State the cycle detection algorithm (DFS with visited set, bounded by max_dag_depth). Specify that runtime cycle detection is O(N*D) where N is node count and D is max depth, with a hard timeout (e.g., 5 seconds). If expansion exceeds the depth limit or timeout, mark the workflow as failed and record an error in the workflow execution log—do not retry or block other workflows.

---

**A3. CRITICAL: No backpressure mechanism for Notion API rate limiting failures**

Section 6 specifies rate limiting to 3 req/sec via `p-queue` but provides no strategy for handling 429 responses beyond the library's default behavior. The PRD states "Rate-limited to 3 req/sec via p-queue" (Section 2) and "intervalCap: 3, interval: 1000" (Section 10 recommended stack), but Notion's actual rate limit is more complex: 3 requests per second *averaged*, with burst allowances and per-endpoint sub-limits. When Notion returns a 429 with a Retry-After header, the PRD does not specify whether the sync engine pauses the entire operation queue, drops operations, or buffers them. The absence of a circuit breaker means repeated 429s could cause the operation queue to grow unbounded while the daemon waits for rate limit windows to reset.

**Evidence**: Section 10 recommends `p-queue` with "Pause/resume support for handling 429 responses with Retry-After headers" but does not specify integration. Section 6 describes batching but not backoff. The operation log model (Section 6) appends operations but has no pruning or overflow strategy.

**Impact**: Under sustained high sync load (e.g., a user modifying 50 files locally while 50 Notion pages are edited remotely), the operation queue grows without bound, the daemon's memory usage spikes, and sync latency degrades to minutes or hours. Users experience the "sync is stuck" failure mode with no visibility into why.

**Recommendation**: Implement exponential backoff with jitter for 429 responses. Introduce a circuit breaker pattern: after N consecutive 429s (e.g., 5), pause the sync engine for the Retry-After duration, emit a user-visible status message, and flush pending operations to the log without executing them. Add a max operation queue size (e.g., 1000) beyond which new operations are dropped with a warning logged to the Sync Log database.

---

**A4. CRITICAL: Markdown conversion libraries have known fidelity gaps contradicting bidirectional claim**

Section 6 claims "Standard content (text, headers, lists, code, links, images): ~95%+ lossless" but the research document `deep-dive-go-notion-md-sync.md` analyzed during this project explicitly documents that `notion-to-md` and similar libraries lose rich text annotations (bold, italic, links in text, colors) on round-trip. The PRD recommends `@tryfabric/martian` (md → Notion) and `notion-to-md` (Notion → md) but provides no evidence that these libraries handle inline formatting. The research doc states: "Rich text annotations lost on round-trip: The converter extracts PlainText from rich text blocks. Bold, italic, strikethrough, underline, code spans, and colors in Notion are lost when pulling." This directly contradicts the 95% claim.

**Evidence**: Section 6 states "~95%+ lossless" and "~70-80%, improvable with custom transformers and metadata comments" for rich Notion content, but Section 10 lists `notion-to-md` (131K downloads/week) without noting its known limitations. The research doc `/root/projects/interkasten/docs/research/deep-dive-go-notion-md-sync.md` Section 6.3 "Critical Limitations" item 3 documents annotation loss as a structural issue in markdown converters.

**Impact**: Users will experience data loss on their first sync cycle. A Notion page with bold headings and inline code formatting will pull to markdown as plain text, then push back to Notion with all formatting stripped. This destroys user trust in bidirectional sync and makes the tool unsuitable for collaborative editing.

**Recommendation**: Either (a) lower the fidelity claim to "~60-70% for rich content, full fidelity for structural elements only" and document this as a known limitation, or (b) specify a custom transformer layer that preserves annotations as markdown extensions (e.g., `**bold**` for bold, `` `code` `` for inline code) and validate round-trip fidelity with integration tests before claiming 95%. The PRD should explicitly state which Notion rich text features are lossy and provide a compatibility matrix.

---

**A5. HIGH: Three-way merge base storage strategy undefined for concurrent edits**

Section 7 describes three-way merge using a "base" version stored in `entity_map.base_content`, but does not specify when the base is updated or how concurrent edits are handled. The reconciler logic (Section 7 table) states "Update the base version in the state store to the merged result" after a successful merge. If a user edits the local file while a remote edit is being pulled and merged, the base could be updated mid-edit, causing the next sync cycle to use the wrong base for the three-way merge. The PRD does not specify file locking, optimistic concurrency control, or versioning for the base.

**Evidence**: Section 7 describes the base as "Last-synced content (for three-way merge)" in the schema, and the merge process updates it "after a successful merge," but Section 6 "Sync Cadence" shows multiple overlapping triggers (FS watcher, PostToolUse hook, poll cycle, webhook) with no serialization guarantee.

**Impact**: A race condition where two sync operations run concurrently (e.g., a local file edit triggers the FS watcher while a poll cycle detects a Notion change) could cause both operations to read the same base, merge independently, and then both write back, with the second write clobbering the first merge. This leads to lost edits and merge conflicts that were incorrectly resolved.

**Recommendation**: Introduce per-entity locking: before starting a sync operation on an entity, acquire a lock (SQLite row-level lock via BEGIN IMMEDIATE or a semaphore in the daemon). If a lock cannot be acquired, queue the operation for retry. Alternatively, use optimistic concurrency control: store a version counter with the base, and fail the merge if the version has changed between read and write. Document this strategy in the PRD.

---

**A6. HIGH: DAG execution fan-out has no resource limit specification**

Section 3 describes fan-out ("Actions that produce multiple outputs... trigger fan-out: the downstream action is instantiated once per output item, running in parallel") but provides no limit on the degree of fan-out. If a `classify` action matches 100 projects, the `route` action spawns 100 parallel instances. The PRD specifies `max_concurrent_workflows: 5` (Section 11) but does not specify whether this limit applies to fan-out branches within a single workflow or only to top-level workflow instances.

**Evidence**: Section 3 example shows `classify` with `fan_out: matched_projects` and `route` with `each: matched_projects` but no cardinality limit. Section 11 config shows `max_concurrent_workflows: 5` but no `max_concurrent_actions` or `max_fan_out_degree`.

**Impact**: A research item that matches 500 projects (e.g., a generic "JavaScript best practices" link) would spawn 500 parallel route actions, overwhelming the Notion API rate limiter, exhausting memory with 500 concurrent HTTP clients, and causing the daemon to crash or hang.

**Recommendation**: Add a `max_fan_out_degree` configuration parameter (e.g., 10) and enforce it during DAG expansion. If a fan-out would exceed the limit, either fail the workflow with an error or batch the fan-out into chunks (e.g., 10 parallel instances at a time, with sequential batches). Document this limit in Section 3 and Section 11.

---

**A7. HIGH: MCP Server daemon restart/recovery strategy missing**

The PRD describes the MCP Server as "a long-running process started by Claude Code via stdio" (Section 2) but provides no restart strategy when the daemon crashes or when Claude Code itself restarts. The plugin manifest (Section 12) specifies `npx interkasten-daemon` as the command, implying a fresh process on each Claude Code session. If the daemon crashes mid-sync, the PRD does not specify how the operation queue is recovered, whether in-progress operations are rolled back, or how the entity map's base versions are validated for consistency.

**Evidence**: Section 12 shows the daemon is started via the MCP server configuration but there is no mention of state recovery, crash detection, or operation replay. Section 6 describes an operation log but not a recovery procedure.

**Impact**: A daemon crash during a sync operation leaves the entity map in an inconsistent state (e.g., base version updated but Notion blocks not written). On restart, the sync engine has no way to detect this partial state and may incorrectly assume the sync completed, leading to lost edits or stuck sync status.

**Recommendation**: Implement write-ahead logging: before executing a sync operation, write an "operation started" entry to the operation log with a unique transaction ID. After completion, write "operation completed" with the same ID. On daemon startup, scan for incomplete operations and either retry them (if idempotent) or mark them as failed. Alternatively, use SQLite transactions to ensure the base version update and the operation log entry are atomic.

---

**A8. HIGH: No migration path specified for schema evolution in production**

Section 10 recommends `drizzle-orm` with `drizzle-kit` for "schema migrations as the sync state schema evolves," but Section 12 provides no migration strategy for users with existing state databases when a plugin update changes the schema. If version 0.2.0 adds a new column to `entity_map` or changes the structure of the sync log, the PRD does not specify whether the daemon auto-migrates on startup, whether users must manually run a migration command, or whether incompatible schemas cause the daemon to fail with an error.

**Evidence**: Section 10 mentions `drizzle-kit` handles migrations but Section 12 "Installation Flow" shows only initial setup via `/interkasten:init`. No update flow is documented. The plugin manifest (Section 12) has no hooks for post-update initialization.

**Impact**: A plugin update that changes the SQLite schema will break existing installations. Users who update the plugin will find their daemon failing to start with cryptic SQLite errors, losing access to their sync state and operation history.

**Recommendation**: Add a schema version number to the state database (stored in a `_meta` table). On daemon startup, check the schema version against the code's expected version. If they differ, run migrations automatically using `drizzle-kit` and log the migration to the operation log. If a migration fails, refuse to start and instruct the user to back up `~/.interkasten/state.db` and run a manual migration command.

---

**A9. MEDIUM: Workflow trigger evaluation frequency undefined creates performance risk**

Section 3 describes five trigger types (condition, page-type, pipeline, scheduled, event) but does not specify how often condition triggers are evaluated. The example shows a condition trigger matching `database: "Research Inbox", property: "Status", equals: "New"` (Section 3). If this is evaluated on every sync cycle (default 60 seconds per Section 11), the daemon queries the Research Inbox database every minute. With 10 condition-based workflows, that's 10 database queries every minute, consuming rate limit budget that could be used for sync operations.

**Evidence**: Section 3 defines triggers but Section 11 only specifies scheduled trigger frequency (`cron`). No trigger evaluation loop frequency is specified for condition or page-type triggers.

**Impact**: Aggressive trigger evaluation consumes API quota and slows sync operations. If a user has 20 workflows with condition triggers, the daemon spends most of its API budget polling trigger conditions rather than syncing content.

**Recommendation**: Specify that condition triggers are evaluated only when an entity in the relevant database is modified (event-driven), not on a polling loop. Alternatively, batch trigger evaluations: check all condition triggers once per sync cycle (e.g., once per minute) and cache the results. Document this in Section 3 and add a `trigger_evaluation_interval` config parameter in Section 11.

---

**A10. MEDIUM: Hook execution blocking time budget missing**

Section 9 describes hooks that fire on lifecycle events (SessionStart, PostToolUse, Stop/SessionEnd) but does not specify a timeout or execution budget. The note at the top of the PRD states "hooks are stateless and fast (<5 seconds)" in the domain context for claude-code-plugin, but the hook examples in Section 9 run `interkasten status --json`, `interkasten notify-change`, and `interkasten sync --flush` which could take arbitrarily long if the daemon is under load or the Notion API is slow.

**Evidence**: Section 9 shows hooks calling `interkasten` CLI commands but does not specify timeouts. The PostToolUse hooks run in the background (`&`) but SessionStart blocks until `DAEMON_STATUS=$(interkasten status --json 2>/dev/null)` completes.

**Impact**: A slow SessionStart hook (e.g., if the daemon is syncing a large vault) blocks the Claude Code session from starting, creating a poor user experience where Claude appears frozen for 10+ seconds on startup.

**Recommendation**: Add explicit timeouts to all hook commands (e.g., `timeout 3s interkasten status --json`). Document the timeout budget in Section 9 and specify fallback behavior (e.g., if the status check times out, inject a "interkasten: status unknown" message instead of blocking). For SessionStart, consider making the status check asynchronous and injecting the status after the session starts.

---

**A11. MEDIUM: Polling safety net conflicts with webhook delivery semantics**

Section 6 describes two Notion change detection modes: polling (default every 60s) and optional webhooks. The polling mode includes a "safety-net full sweep on a longer interval (default: daily)" to catch missed events. However, webhook delivery is stated as "at-most-once" (Section 6), meaning events can be lost. The PRD does not specify how the polling safety net reconciles with webhook-delivered events. If a webhook delivers an event and the polling safety net also detects the same change a day later, does the sync engine de-duplicate them, or does it re-sync the same entity?

**Evidence**: Section 6 states "Delivery is at-most-once — polling safety net catches missed events" but does not specify de-duplication logic. The entity map (Section 6 schema) stores `last_notion_ver` (last_edited_time) but the operation queue (Section 6 diagram) has no de-duplication filter shown.

**Impact**: Redundant sync operations for the same entity waste API quota and cause unnecessary writes. A page edited once could trigger two syncs (webhook + polling safety net), doubling the load on the Notion API and the local filesystem.

**Recommendation**: Use the `last_edited_time` from the entity map to de-duplicate operations. Before queuing an operation, check if the entity's current `last_edited_time` matches the stored version. If it does, skip the operation (it's already synced). Document this de-duplication logic in Section 6.

---

**A12. MEDIUM: No validation that chosen libraries support Notion API 2025-09-03**

Section 10 recommends `@notionhq/client` (v5.9.0, 350K/week) but does not verify that this version supports the Notion API version 2025-09-03. The research document `deep-dive-go-notion-md-sync.md` notes that the go-notion-md-sync client uses API version 2022-06-28 (outdated). The PRD should verify that the recommended libraries support the latest API version, especially for new features like webhooks (introduced in 2023) and any pagination improvements.

**Evidence**: Section 10 lists `@notionhq/client` but does not state the API version it supports. The deep-dive research doc shows that older clients use outdated API versions. No API version is specified in the PRD.

**Impact**: If the chosen libraries use an outdated API version, the sync engine may miss new features (e.g., improved pagination, new block types, webhook events) or encounter deprecated endpoints that break in future Notion updates.

**Recommendation**: Add an "API Version Compatibility" subsection to Section 10 that specifies the target Notion API version (2025-09-03 or later) and verifies that each chosen library supports it. Check the `@notionhq/client` changelog to confirm version 5.9.0 includes 2025-09-03 support. If not, specify the minimum required version.

---

**I1. LOW: MCP Apps HTML rendering security model unstated**

Section 8 describes three MCP Apps (Project Dashboard, Conflict Resolver, Workflow Visualizer) that render HTML, but does not specify how user-generated content (e.g., project names, document titles, workflow descriptions) is sanitized before rendering. If a project is named `<script>alert('XSS')</script>`, does the dashboard HTML-escape it, or does it execute the script in Claude Code's rendering context?

**Evidence**: Section 8 lists MCP Apps with "interactive HTML" but provides no sanitization or escaping strategy. Section 12 shows `apps/` directory with "HTML templates" but no security notes.

**Impact**: Potential XSS vulnerability if Claude Code's MCP App renderer does not sandbox HTML. A malicious project name or workflow description could inject scripts that steal the Notion API token or corrupt local state.

**Recommendation**: Specify that all user-generated content in MCP Apps is HTML-escaped using a standard library (e.g., `he` for Node.js). Document this in Section 8 and add a security note in Section 12. Test with a project named `<script>alert('XSS')</script>` to verify escaping works.

---

**I2. LOW: Beads-to-Notion dependency mapping direction ambiguous**

Section 6 states "Beads `dependencies` → Notion relation property" but does not specify whether this is a one-to-many relation (one beads issue depends on multiple others) or many-to-many (issues can have mutual dependencies). Notion relation properties support both, but the sync engine needs to know which direction to map. The beads data model is not defined in the PRD.

**Evidence**: Section 6 mentions `dependencies` mapping but does not reference a beads schema. No example beads JSON or database structure is provided.

**Impact**: Ambiguity in the dependency mapping could cause sync errors or incorrect relationship representations in Notion. If beads supports DAG dependencies but the sync engine assumes a tree, circular dependencies will break the sync.

**Recommendation**: Add an appendix or reference that defines the beads data model, including the structure of the `dependencies` field. Specify how circular dependencies are handled (e.g., are they allowed in beads? If so, do they map to Notion relations or are they filtered?).

---

**I3. LOW: Cloudflared tunnel auto-provisioning complexity understated**

Section 12 states "Auto-provision a cloudflared tunnel exposing a local webhook receiver" as if this is a simple operation, but `cloudflared` tunnel setup requires Cloudflare account authentication, DNS configuration, and tunnel token management. The PRD does not specify whether the plugin handles this fully automatically (unlikely without Cloudflare API credentials) or whether the user must manually configure the tunnel and provide the token.

**Evidence**: Section 6 mentions "Auto-provision a cloudflared tunnel" but Section 11 config only shows `tunnel.enabled: false` and `tunnel.provider: "cloudflared"` with no authentication fields.

**Impact**: Users who enable webhooks expecting automatic tunnel setup will encounter errors when the daemon tries to start `cloudflared` without credentials. This creates a setup friction point that contradicts the "zero infrastructure by default" claim.

**Recommendation**: Clarify whether tunnel setup is automatic or manual. If automatic, specify that the user must provide a Cloudflare API token in the config or environment variables. If manual, provide setup instructions in Section 12 and link to Cloudflare's tunnel documentation. The current phrasing "auto-provision" should be changed to "auto-start a pre-configured tunnel" if it's the latter.

---

**I4. LOW: Missing analysis of official Notion API limitations**

Section 14 "Competitive Position" compares interkasten to other tools but does not analyze the limitations of the Notion API itself as a constraint on the design. Known Notion API limitations include: (1) no atomic transactions across multiple page updates, (2) no batch write API (must write blocks one page at a time), (3) rate limits that vary by endpoint, (4) no incremental block updates (must replace entire blocks), and (5) webhook events are at-most-once delivery. The PRD's design assumes these limitations but does not document them as risks.

**Evidence**: Section 14 analyzes competitors but not the Notion API. Section 6 mentions "at-most-once" delivery for webhooks but does not discuss other API limitations.

**Impact**: If Notion changes its API limitations (e.g., introduces batch writes or transactions), the sync engine could be redesigned to take advantage of them. Conversely, if Notion tightens rate limits or removes features, the sync engine could break. Documenting these assumptions makes the design more resilient to API changes.

**Recommendation**: Add a subsection to Section 10 or Appendix B titled "Notion API Constraints" that lists the known limitations and how the design accommodates them. This serves as both documentation and a checklist for validating assumptions when the Notion API changes.

---

### Improvements

**I5. Consider event-driven trigger evaluation instead of polling**

Section 3 describes condition triggers that match page properties, but the evaluation frequency is unspecified (see A9). Instead of polling the Research Inbox every minute to check for `Status == "New"`, the sync engine could evaluate condition triggers only when the Research Inbox database is modified (detected via the normal Notion polling or webhook). This reduces API calls and improves trigger latency.

**Rationale**: Event-driven triggers align with the sync engine's existing change detection model and avoid redundant API queries.

---

**I6. Add a "dry-run" mode for sync operations**

Section 8 lists tools for sync operations but does not include a dry-run mode. Users may want to preview what a sync will do (e.g., which files will be pushed, which Notion pages will be pulled, which conflicts exist) before executing it. A `interkasten_sync --dry-run` tool would return a report of pending operations without modifying any files or Notion pages.

**Rationale**: Dry-run modes are standard in sync tools (rsync, git, etc.) and reduce user anxiety about data loss. This is especially important given the PRD's admission of <100% fidelity in markdown conversion.

---

**I7. Specify observability for pagent workflow executions**

Section 3 describes the pagent workflow engine but does not specify how users monitor workflow executions. The Pagent Workflows database (Section 4) has "Last Run, Run Count, Error Count" but does not show execution logs, node-level timing, or input/output data. Users cannot debug a failed workflow without detailed execution traces.

**Rationale**: Workflow engines are notoriously hard to debug without execution traces. Adding a `interkasten_workflow_log` tool (already listed in Section 8) with detailed node-level logs would make the pagent system much more usable.

---

**I8. Clarify whether the plugin is single-workspace or multi-workspace**

Section 11 shows a single `workspace_id` in the config, implying one Notion workspace per installation. However, Section 1 describes interkasten as creating "a living bridge between a local projects folder and a Notion workspace" (singular). If a user has multiple Notion workspaces (e.g., personal and work), do they need separate plugin installations, or can the plugin sync to multiple workspaces simultaneously?

**Rationale**: Multi-workspace support is a common feature request for Notion tools. Clarifying this upfront sets user expectations and avoids scope creep during development.

---

**I9. Add a fallback for when Notion API is unreachable**

Section 2 states the daemon "watches both sides" but does not specify what happens if the Notion API is unreachable (e.g., network outage, Notion downtime). Does the daemon continue watching local changes and queue them for later sync, or does it halt all operations? The polling mode (Section 6) will fail silently if the API is down.

**Rationale**: Graceful degradation during API outages improves reliability. A simple enhancement would be to continue watching local changes, queue operations in the SQLite log, and retry when the API becomes reachable again.

---

**I10. Provide a migration tool from other Notion sync solutions**

Section 14 positions interkasten against competitors like go-notion-md-sync and the official Notion plugin, but does not provide a migration path for users of those tools. If a user has markdown files already synced via go-notion-md-sync (with frontmatter containing `notion_id`), will interkasten recognize those mappings, or will it create duplicate Notion pages?

**Rationale**: Reducing migration friction increases adoption. A simple migration tool that reads existing frontmatter and populates the interkasten entity map would make switching seamless.

---

**I11. Consider incremental block updates instead of full-replacement**

Section 6 describes content translation from markdown to Notion blocks, but the research document `deep-dive-go-notion-md-sync.md` notes that go-notion-md-sync uses a destructive "delete all blocks, append new blocks" strategy. The PRD states "Diff against existing Notion blocks to minimize API calls (patch, don't full-replace)" which is better, but does not specify the diffing algorithm. If the sync engine uses a naive line-by-line diff, it will still replace entire paragraphs when a single word changes.

**Rationale**: Block-level diffing (e.g., diff only the changed paragraph block, leave other blocks untouched) would preserve Notion block IDs, comments, and reduce API calls. This is more complex but significantly improves fidelity and user experience.

---

**I12. Add user-facing sync conflict UI in Notion itself**

Section 7 describes conflict resolution strategies (three-way merge, local-wins, notion-wins, conflict-file, ask) but the "ask" strategy is not explained. If the strategy is "ask," does the daemon pause and prompt the user via a CLI, or does it create a Notion page with a conflict marker that the user resolves in Notion? The latter would be more intuitive for Notion-centric users.

**Rationale**: Resolving conflicts in Notion (e.g., via a two-column table showing local vs. remote versions) keeps the workflow in one tool and reduces context-switching.

---

<!-- flux-drive:complete -->
