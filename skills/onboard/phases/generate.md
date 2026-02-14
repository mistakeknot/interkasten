# Generation Phase — Doc Creation Order

## Product Projects

Generate docs in dependency order — each doc builds on the prior ones:

1. **Vision** — foundational; sets purpose, audience, north star
   - Invoke: `interpath:vision`
   - Input: project README, beads state, existing code
   - Skip if: Vision doc already exists

2. **PRD** — references Vision for scope and priorities
   - Invoke: `interpath:prd`
   - Input: Vision doc, beads state, project code
   - Skip if: PRD doc already exists

3. **Roadmap** — sequences PRD features into phases
   - Invoke: `interpath:roadmap`
   - Input: PRD, beads state, Vision
   - Skip if: Roadmap doc already exists

4. **AGENTS.md** — comprehensive dev guide for AI agents
   - Invoke: `interdoc:interdoc`
   - Input: full project codebase analysis
   - Skip if: AGENTS.md already exists

5. **CLAUDE.md** — minimal quick reference for Claude Code
   - Invoke: `interdoc:interdoc` with CLAUDE.md mode, or generate stub
   - Input: AGENTS.md content for condensation
   - Skip if: CLAUDE.md already exists

## Tool Projects

Only AGENTS.md and CLAUDE.md are required:

1. **AGENTS.md** — invoke `interdoc:interdoc`
2. **CLAUDE.md** — invoke `interdoc:interdoc` or create stub

## Stub Template (CLAUDE.md fallback)

If interdoc is unavailable, create a minimal CLAUDE.md:

```markdown
# {Project Name}

{One-line description from README or package.json}

## Quick Start

\`\`\`bash
# Build and run instructions from manifest
\`\`\`

## Architecture

{Brief description from directory structure}
```

## Rules

- Never overwrite existing docs — only fill gaps
- Always check `findKeyDocs()` output before generating
- If generation fails, log the error and continue to the next doc/project
- Rate-limit Notion API calls (the sync engine handles this, but be aware)
