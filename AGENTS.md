# interkasten — Agent Instructions

Claude Code plugin + MCP server for bidirectional Notion sync with adaptive AI documentation.

**Version:** 0.4.20
**Repository:** `github.com/mistakeknot/interkasten`
**Monorepo location:** `plugins/interkasten/` in Interverse

## Canonical References
1. [`PHILOSOPHY.md`](../../PHILOSOPHY.md) — direction for ideation and planning decisions.
2. `CLAUDE.md` — implementation details, architecture, testing, and release workflow.

## Quick Start

```bash
cd server && npm install && npm run build
npm test          # 261 tests (unit + 9 integration)
node dist/index.js  # MCP server on stdio
```

Integration tests require `INTERKASTEN_TEST_TOKEN` env var (Notion API token for test workspace).

## Topic Guides

| Topic | File | Covers |
|-------|------|--------|
| Architecture | [agents/architecture.md](agents/architecture.md) | Source tree, dependencies, build process |
| Database | [agents/database.md](agents/database.md) | 5-table schema: entity_map, base_content, sync_log, sync_wal, beads_snapshot |
| MCP Tools | [agents/mcp-tools.md](agents/mcp-tools.md) | 21 tools: infrastructure, projects, hierarchy, sync, legacy |
| Sync Engine | [agents/sync-engine.md](agents/sync-engine.md) | Bidirectional sync, WAL protocol, circuit breaker, merge, beads sync |
| Design Patterns | [agents/design-patterns.md](agents/design-patterns.md) | Agent-native design, hierarchy, path validation, soft-delete, triage |
| Skills & Hooks | [agents/skills-hooks.md](agents/skills-hooks.md) | 3 skills (layout, onboard, doctor), 3 hooks (Setup, SessionStart, Stop) |
| Testing & Config | [agents/testing-config.md](agents/testing-config.md) | Test suites, config reference, environment, common tasks, gotchas, status |

## Session Completion

> See `/root/projects/Interverse/AGENTS.md` for session completion protocol.
