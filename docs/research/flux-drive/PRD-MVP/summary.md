## Flux Drive Enhancement Summary

Reviewed by 8 agents on 2026-02-14.

### Key Findings

1. **No crash-recovery protocol for multi-step sync operations** — a crash between writing to Notion and updating entity_map leaves permanently diverged state with no journaling or WAL to recover (4/8 agents: fd-data-integrity, fd-pipeline-operations, fd-architecture, fd-safety)
2. **Notion API backpressure is absent** — p-queue caps concurrency but doesn't handle 429 responses, queue overflow during outages, or exponential backoff; the operation queue grows without bound (4/8 agents: fd-architecture, fd-pipeline-operations, fd-data-integrity, fd-safety)
3. **Hook shell injection vulnerability** — PostToolUse hooks parse untrusted tool output JSON and pass values to shell commands without sanitization; `file_path` from tool arguments flows directly into `interkasten notify-change "$FILE_PATH"` (2/8 agents: fd-safety, fd-plugin-structure)
4. **Notion `last_edited_time` is unreliable for change detection** — second-granularity, non-monotonic under concurrent API writes, and coalesced during rapid edits; used as the sole Notion-side change signal (2/8 agents: fd-data-integrity, fd-architecture)
5. **Revenue projections have zero user acquisition evidence** — no conversion funnel, no benchmarks, no churn modeling; "conservative" projections are unvalidated assumptions (1/8 agents: fd-user-product, but uncontested)

### Issues to Address

#### P0 / Critical (Must fix before implementation)
- [ ] Add WAL/journaling for sync operations — entity_map update must be atomic with target write (fd-data-integrity DI-02, fd-pipeline-operations PO-01, fd-architecture A1) **(4/8 agents)**
- [ ] Implement backpressure with exponential backoff for Notion 429s and circuit-breaker for sustained failures (fd-architecture A3, fd-pipeline-operations PO-02/PO-04, fd-safety OPS-2) **(4/8 agents)**
- [ ] Move `base_content` to a separate table or content-addressed store to prevent entity_map bloat (fd-data-integrity DI-01, fd-pipeline-operations PO-06) **(2/8 agents)**
- [ ] Add content-hash verification for Notion change detection alongside `last_edited_time` (fd-data-integrity DI-03, fd-architecture A4) **(2/8 agents)**
- [ ] Define daemon crash-recovery and restart protocol (fd-architecture A7, fd-pipeline-operations PO-03, fd-safety DEP-3) **(3/8 agents)**
- [ ] Sanitize hook script inputs — `$FILE_PATH` and `$COMMAND` must be shell-escaped (fd-safety SEC-2)
- [ ] Fix Notion token exposure — token is in plugin manifest env vars visible to all hooks; restrict scope (fd-safety SEC-1)
- [ ] Define user persona — "anyone" vs power-user vs indie-hacker conflicts throughout the doc (fd-user-product FD-UP-002, fd-consumer-experience CE-01/CE-05)
- [ ] Validate revenue projections with evidence or remove them (fd-user-product FD-UP-001)
- [ ] Undocumented Notion integration setup prerequisite — user must create integration in browser before install flow works (fd-consumer-experience CE-01)

#### P1 / High (Address in v1)
- [ ] Fix hooks directory placement — move from `.claude-plugin/hooks/` to root `hooks/` (fd-plugin-structure PS-01)
- [ ] Remove duplicate `hooks` field in plugin.json to avoid auto-discovery conflict (fd-plugin-structure PS-02)
- [ ] Fix `SessionEnd` hook event — doesn't exist; use `Stop` instead (fd-plugin-structure PS-03)
- [ ] Specify ON CONFLICT behavior for entity_map UNIQUE constraints (fd-data-integrity DI-04)
- [ ] Address asymmetric change detection — content hash (local) vs timestamp (Notion) creates phantom conflicts on roundtrip conversion loss (fd-data-integrity DI-05)
- [ ] Make `base_content` update atomic with sync write (fd-data-integrity DI-06)
- [ ] Define cascade/orphan handling for project unregistration and file deletion (fd-data-integrity DI-07)
- [ ] Add foreign-key enforcement for pagent DAG `depends_on` references (fd-data-integrity DI-08)
- [ ] Deduplicate operation queue entries for same entity (fd-data-integrity DI-09, fd-pipeline-operations PO-08)
- [ ] Cap fan-out cardinality with `max_fan_out` config (fd-data-integrity DI-14, fd-pipeline-operations PO-07)
- [ ] Add workflow-level timeout (not just per-node) (fd-pipeline-operations PO-13)
- [ ] Coordinate pagent engine and sync engine Notion writes to prevent conflicts (fd-pipeline-operations PO-09)
- [ ] Remove duplicate `interkasten_create_workflow` tool definition (fd-api-surface API-01)
- [ ] Add API versioning strategy for the 33-tool surface (fd-api-surface API-04)
- [ ] Auto-generate config.yaml with defaults during init (fd-consumer-experience CE-02, CE-05)
- [ ] Add `/interkasten:doctor` command for self-diagnosis (fd-consumer-experience CE-09, fd-user-product FD-UP-005)
- [ ] Translate Notion API errors to user-friendly messages with remediation steps (fd-consumer-experience CE-10)
- [ ] Add pagent script action sandboxing — arbitrary shell execution with page data is unsafe (fd-safety SEC-3)
- [ ] Sanitize Notion page content before flowing into AI prompts (fd-safety SEC-7)
- [ ] Document Notion workspace init rollback procedure (fd-safety DEP-1)

#### P2 / Medium (Address in v1.x)
- [ ] Move sync log to local SQLite — Notion API failures prevent logging the failure (fd-data-integrity DI-12, fd-pipeline-operations PO-11, fd-consumer-experience CE-16) **(3/8 agents)**
- [ ] Add health-check endpoint for daemon liveness (fd-pipeline-operations PO-12)
- [ ] Reduce tool count — merge CRUD variants into parameterized tools (fd-api-surface API-06)
- [ ] Merge `pause_workflow`/`resume_workflow` into single state-change tool (fd-api-surface API-09)
- [ ] Add `interkasten_version` / `interkasten_capabilities` for introspection (fd-api-surface API-14)
- [ ] Fix `milestones` config heterogeneous value types (fd-api-surface API-03)
- [ ] Verify cloudflared binary signature on download (fd-safety SEC-5)
- [ ] Add webhook receiver authentication (fd-safety SEC-6)
- [ ] Validate Notion token before creating workspace structure (fd-safety OPS-1)
- [ ] Add uninstall/reset procedure for corrupted state (fd-consumer-experience CE-13)
- [ ] Address `better-sqlite3` native compilation on non-standard platforms (fd-consumer-experience CE-14)

### Improvements Suggested

1. **Articulate the pain point before features** — lead with "what workflow breaks without this?" not "here's what we built" (fd-user-product FD-UP-003)
2. **Progressive disclosure for 33 tools** — tier into core (5-7 tools), intermediate, and advanced; hide advanced behind `/interkasten:tools --all` (fd-api-surface API-06, fd-user-product FD-UP-014, fd-consumer-experience CE-08)
3. **Add `interkasten init --defaults`** — zero-config path that creates config.yaml, detects projects_dir, validates token, creates workspace (fd-consumer-experience CE-05)
4. **Token rotation runbook** — document how to rotate Notion API token without sync downtime (fd-safety IMP-1)
5. **Pin interkasten-daemon version in manifest** — avoid `npx` cold-start and breaking changes (fd-consumer-experience CE-04, CE-07)
6. **Validate sync idempotency in test suite** — running `/interkasten:sync` twice must produce same state (fd-pipeline-operations, fd-data-integrity)

### Individual Agent Reports

- [fd-architecture](./fd-architecture.md) — needs-changes: 4 CRITICAL (sync isolation, cycle prevention, backpressure, markdown fidelity), 4 HIGH, 4 MEDIUM, 4 LOW
- [fd-user-product](./fd-user-product.md) — risky: 3 CRITICAL (revenue evidence, persona gaps, buried value prop), 5 HIGH, 4 MEDIUM, 2 LOW
- [fd-data-integrity](./fd-data-integrity.md) — needs-changes: 3 P0 (base_content growth, crash recovery, Notion timestamps), 6 P1, 5 P2, 2 P3
- [fd-plugin-structure](./fd-plugin-structure.md) — needs-changes: 3 P1 (hooks placement, duplicate hooks field, SessionEnd event), 7 P2, 3 P3
- [fd-pipeline-operations](./fd-pipeline-operations.md) — needs-changes: 4 P0 (WAL, unbounded queue, daemon recovery, 429 handling), 6 P1, 4 P2
- [fd-consumer-experience](./fd-consumer-experience.md) — needs-changes: 3 CRITICAL (Notion setup prerequisite, config not auto-generated, silent hook failure), 6 HIGH, 5 MEDIUM, 3 LOW
- [fd-api-surface](./fd-api-surface.md) — needs-changes: 5 HIGH (duplicate tool, naming inconsistency, config types, versioning, MCP App categorization), 9 MEDIUM, 4 LOW
- [fd-safety](./fd-safety.md) — needs-changes: 2 CRITICAL (token exposure, hook injection), 3 HIGH (script execution, token leakage, schema rollback), 5 MEDIUM, 1 LOW
