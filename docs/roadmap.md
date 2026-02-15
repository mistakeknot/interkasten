# Interkasten Roadmap

**Version:** 0.3.1
**Last updated:** 2026-02-15
**Vision:** [`docs/vision.md`](vision.md)
**PRD:** [`docs/PRD.md`](PRD.md)

---

## Where We Are

Interkasten currently ships as:

- 1 MCP server (`interkasten`) with project, sync, and diagnostics tools
- 2 user-invocable skills: `layout`, `onboard`
- 1 command: `onboard`
- Local SQLite state + Notion integration + triage workflows

## What's Working

- Project discovery and registration with explicit parent/tags support in registry model
- SQLite-backed mapping between local projects/files and Notion entities
- Tool-level triage signal capture via `interkasten_gather_signals`
- File scanning and sync preview before mutation actions
- Sync lifecycle tools: trigger, status, and sync log
- Health and configuration tooling for operation visibility

## What's Next (Roadmap Candidates)

### 0.3.1 stabilization and reliability

- Lock down recovery behavior for WAL/incomplete operations under process interruption
- Improve sync edge-case handling when Notion schemas diverge from expected shape
- Standardize output formats for status/log tools to reduce parsing ambiguity

### 0.3.2 + 0.3.3: Triage depth and documentation cadence

- Expand triage signals to improve confidence without adding policy in the tool layer
- Improve key-document generation prompts so doc scaffolding aligns with project maturity
- Expand examples for hierarchy resolution and cross-project parenting flows

### 0.4.0: Operational quality and team-ready workflows

- Add stronger observability signals for drift and retry quality
- Add ergonomics around project selection workflows (bulk operations + safer defaults)
- Formalize error taxonomies so agents can auto-route failures (and humans can decide quickly)

## Open Areas

- Advanced conflict resolution policies for high-churn pages
- More granular sync scopes (folder filters, policy packs per project)
- Better onboarding defaults for mixed repository types and mono-repos

## Not in Scope Right Now

- Hardcoded documentation policy generation
- Fully automatic triage or sync decisions without user review
- Rewriting Notion as source-of-truth for local execution state
