# /interkasten:onboard

Triage all registered projects, generate missing docs based on tier requirements, establish drift baselines, and sync to Notion.

## Usage

```
/interkasten:onboard
```

## What It Does

1. **Triage** — Classifies projects as Product, Tool, or Inactive based on signals (LOC, git history, manifests)
2. **Generate** — Creates missing required docs per tier (Vision, PRD, Roadmap for Product; AGENTS.md, CLAUDE.md for Tool)
3. **Watch** — Establishes drift baselines with interwatch
4. **Sync** — Pushes everything to Notion and updates key doc columns

## Skill

Load and execute `skills/onboard/SKILL.md`.
