# /interkasten:doctor

Run self-diagnosis to verify interkasten is correctly installed and operating.

## Usage

```
/interkasten:doctor
```

## What It Does

Runs a cascading health checklist: config file, Notion token, MCP server, SQLite, Notion API connection, project count, WAL status, and hook configuration. Each check gates the next — if an early check fails, dependent checks are skipped with remediation instructions.

## Skill

Load and execute `skills/doctor/SKILL.md`.
