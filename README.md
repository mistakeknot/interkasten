# interkasten

Bidirectional Notion sync for Claude Code.

## What this does

interkasten is the living bridge between your project filesystem and Notion. Changes flow both directions: edit a page in Notion and it syncs to your project; update a markdown file locally and it pushes to Notion. The MCP server provides 23 tools covering project CRUD, bidirectional sync, database tracking, file scanning, conflict resolution, and signal gathering. Multi-workspace support lets you sync databases from different Notion workspaces using named token aliases.

Conflict resolution uses three-way merge with `node-diff3`. When both sides change the same document, it attempts automatic resolution; when that fails, you get a structured conflict with the local version, remote version, and common ancestor so you can make an informed decision rather than guessing which version is newer.

The sync also integrates with Beads issue tracking: beads state flows into Notion for visibility, and Notion updates flow back to keep everything consistent.

## Installation

First, add the [interagency marketplace](https://github.com/mistakeknot/interagency-marketplace) (one-time setup):

```bash
/plugin marketplace add mistakeknot/interagency-marketplace
```

Then install the plugin:

```bash
/plugin install interkasten
```

Requires Node.js for the MCP server.

## Usage

Onboard a project:

```
/interkasten:onboard
```

Check sync health:

```
/interkasten:doctor
```

The MCP server starts automatically and provides 23 tools for programmatic Notion interaction. A SessionStart hook shows brief sync status; a Stop hook warns about pending sync operations.

### Multi-workspace sync

To track databases from a different Notion workspace, save a named token:

```
interkasten_config_save(alias: "work", value: "${NOTION_TOKEN_WORK}")
interkasten_track_database(database_id: "abc123", token: "work")
```

The token alias is stored with the tracked database, so refresh operations use it automatically.

## Architecture

```
server/              Node.js/TypeScript MCP server (Drizzle ORM + SQLite)
skills/              onboard, layout, doctor
commands/            onboard, doctor
hooks/               SessionStart (status), Stop (pending sync warning)
```

## Design decisions

- Agent-native: tools expose raw signals, intelligence lives in skills
- No hardcoded classification or auto-file-selection: the AI decides
- WAL protocol for crash recovery (pending → target_written → committed → delete)
- Circuit breaker pattern prevents cascading Notion API failures
- 30-day soft-delete retention aligned with Notion trash policy
- Multi-workspace: token resolution chain with per-database/project overrides
