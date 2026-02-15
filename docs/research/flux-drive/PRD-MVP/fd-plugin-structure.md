# fd-plugin-structure: Plugin Structure Review of PRD-MVP

**Reviewer**: fd-plugin-structure (Claude Code Plugin Domain)
**Document**: `/root/projects/interkasten/docs/PRD-MVP.md`
**Date**: 2026-02-14
**Mode**: Generic (no CLAUDE.md or AGENTS.md in project root; no implemented plugin code exists yet)

---

### Findings Index

| Severity | ID | Section | Title |
|---|---|---|---|
| P1 | PS-01 | Deployment & Distribution | Hooks placed inside `.claude-plugin/` instead of plugin root |
| P1 | PS-02 | Deployment & Distribution | `hooks` field in plugin.json will cause duplicate hooks error |
| P1 | PS-03 | Plugin Layer / Hooks | `SessionEnd` hook event does not exist in Claude Code |
| P2 | PS-04 | Deployment & Distribution | MCP server uses `npx` without `${CLAUDE_PLUGIN_ROOT}` |
| P2 | PS-05 | Deployment & Distribution | `skills` and `commands` use directory string instead of array format |
| P2 | PS-06 | Deployment & Distribution | `agents/` directory not referenced in plugin.json |
| P2 | PS-07 | Plugin Layer / Hooks | PostToolUse hook script names don't match proposed filenames |
| P2 | PS-08 | Plugin Layer / Subagents | Agent markdown files missing required frontmatter specification |
| P2 | PS-09 | Plugin Layer / Skills | Skill SKILL.md files missing required frontmatter specification |
| P2 | PS-10 | Deployment & Distribution | `marketplace.json` not mentioned; version sync requirement undocumented |
| P3 | PS-11 | Plugin Layer / Hooks | `type` field missing from MCP server config in manifest |
| P3 | PS-12 | Repository Structure | `workflows/` directory has no plugin discovery mechanism |
| P3 | PS-13 | Configuration | `interkasten` CLI referenced in hooks but installation not specified |

**Verdict**: needs-changes

---

### Summary

The PRD describes a well-thought-out Claude Code plugin architecture, but the proposed `plugin.json` manifest and directory layout contain several structural errors that would prevent the plugin from loading correctly. The most critical issues are: (1) hooks files are placed inside `.claude-plugin/` instead of at the plugin root, which violates the standard layout and prevents auto-discovery; (2) the `hooks` field in `plugin.json` references a hooks.json path, which combined with auto-discovery from `hooks/hooks.json` will produce a "Duplicate hooks file detected" error; and (3) the design references `SessionEnd` as a hook event, but the actual supported events are `SessionStart` and `SessionEnd` -- however the PRD also references `Stop` separately, and the hook script description says "Stop / SessionEnd" as if they are the same thing, when they are distinct events with different semantics. Several P2 issues around frontmatter requirements and path conventions would cause components to fail silently during registration.

---

### Issues Found

**PS-01. P1: Hooks directory placed inside `.claude-plugin/` instead of plugin root**

The repository structure (Section 12, lines 1111-1118) places hooks at `.claude-plugin/hooks/hooks.json` with individual scripts inside `.claude-plugin/hooks/`. Per the Claude Code plugin structure reference, the `.claude-plugin/` directory must contain ONLY manifests (`plugin.json`, `marketplace.json`). Hooks must be at the plugin root: `hooks/hooks.json`. The official reference explicitly warns: "All other directories (commands/, agents/, skills/, hooks/) must be at the plugin root, not inside `.claude-plugin/`." With hooks inside `.claude-plugin/`, Claude Code will not auto-discover them, and the plugin's lifecycle hooks (SessionStart, PostToolUse, Stop) will never fire.

Evidence: PRD Section 12, repository structure shows:
```
.claude-plugin/
    hooks/
        hooks.json
        session-start.sh
        post-edit.sh
        post-bash.sh
        session-end.sh
```
Should be:
```
hooks/
    hooks.json
    session-start.sh
    post-edit.sh
    post-bash.sh
    session-end.sh
```

**PS-02. P1: `hooks` field in plugin.json will cause duplicate hooks error**

The proposed plugin.json (Section 12, line 1052) includes `"hooks": ".claude-plugin/hooks/hooks.json"`. The Claude Code plugin reference explicitly warns: "The `hooks/hooks.json` file is automatically loaded by Claude Code. Do NOT reference it in `plugin.json`'s `manifest.hooks` field or you'll get 'Duplicate hooks file detected' errors." Even after fixing the path from `.claude-plugin/hooks/` to `hooks/`, the `hooks` field must be removed from plugin.json entirely if using the standard `hooks/hooks.json` location. Including both results in a loading error that prevents all hooks from registering.

Evidence: PRD Section 12 plugin manifest:
```json
"hooks": ".claude-plugin/hooks/hooks.json"
```
Fix: Remove the `hooks` field from plugin.json and rely on auto-discovery from `hooks/hooks.json`.

**PS-03. P1: Hook design conflates `Stop` and `SessionEnd` events**

Section 9 (line 808-812) describes the hook as "**`Stop` / `SessionEnd`** -- Flush pending sync" with a single script. However, `Stop` and `SessionEnd` are distinct hook events in Claude Code. `Stop` fires when Claude attempts to stop (and can be intercepted), while `SessionEnd` fires when the session actually ends. A sync flush on `Stop` might fire prematurely during multi-turn conversations when Claude pauses. The PRD should specify whether the flush should run on `Stop`, `SessionEnd`, or both, and design separate hooks if the behavior should differ. Additionally, the repository structure lists `session-end.sh` but no `stop.sh`, which means the hooks.json will need to reference the same script for two events -- a workable but confusing setup that should be made explicit.

Evidence: PRD Section 9, lines 808-812:
```
**`Stop` / `SessionEnd`** — Flush pending sync:
#!/bin/bash
interkasten sync --flush &
```
Repository structure (line 1118) only lists `session-end.sh`.

**PS-04. P2: MCP server uses `npx` without `${CLAUDE_PLUGIN_ROOT}` path variable**

The plugin manifest (Section 12, lines 1042-1045) specifies the MCP server as:
```json
"command": "npx",
"args": ["interkasten-daemon"]
```
This assumes `interkasten-daemon` is globally installed via npm or resolvable via `npx`. The Claude Code plugin reference says to use `${CLAUDE_PLUGIN_ROOT}` for all plugin paths. If the daemon is bundled with the plugin (as the repository structure suggests with `src/daemon/index.ts`), the args should reference the built output: `["${CLAUDE_PLUGIN_ROOT}/dist/daemon/index.js"]` or similar. Using `npx` introduces a network dependency (npx may download the package on first run) and version ambiguity (user might get a different version than the plugin expects).

**PS-05. P2: `skills` and `commands` use string format pointing to directories**

The plugin.json (Section 12, lines 1039-1040) uses:
```json
"skills": "./skills/",
"commands": "./commands/"
```
Per the Claude Code schema, `skills/` and `commands/` at the plugin root are auto-discovered without any declaration in plugin.json. Declaring them is redundant. More importantly, if these fields are specified, they are intended as *supplementary* paths to custom locations, and `commands` should be an array of file paths (e.g., `["./custom/cmd.md"]`), not a directory string. The `skills` field is not even documented in the official schema -- skills are always auto-discovered from `skills/` subdirectories containing `SKILL.md`. Including these fields is harmless but misleading; future developers may incorrectly assume skills won't load without the declaration.

**PS-06. P2: `agents/` directory not referenced in plugin.json but present in repo structure**

The repository structure (Section 12, lines 1133-1140) includes an `agents/` directory with 7 agent markdown files, but the plugin.json manifest does not include an `agents` field. This is actually correct for auto-discovery (agents at `agents/` are auto-discovered). However, the inconsistency with declaring `skills` and `commands` explicitly while omitting `agents` suggests the PRD author may not realize that all three follow the same auto-discovery convention. Recommendation: either declare none of them (preferred) or document the auto-discovery behavior explicitly.

**PS-07. P2: PostToolUse hook script names don't match repository structure filenames**

Section 9 describes two PostToolUse hooks:
- PostToolUse(Edit|Write) -- for file change notification
- PostToolUse(Bash) -- for git operation detection

The repository structure (lines 1116-1117) lists:
- `post-edit.sh`
- `post-bash.sh`

But there is no `post-write.sh`. The PostToolUse(Edit|Write) hook catches both Edit and Write tool uses but the script is named `post-edit.sh`, which is misleading. The hooks.json will need a `matcher: "Edit|Write"` entry pointing to `post-edit.sh` -- the naming discrepancy will cause confusion during implementation. Should be named `post-file-change.sh` or similar, or split into `post-edit.sh` and `post-write.sh`.

**PS-08. P2: Agent markdown files missing required frontmatter specification**

The PRD lists 7 agents (Section 9, lines 838-847) with model assignments and purposes, but does not specify what frontmatter fields each agent's markdown file will contain. Per the Claude Code agent reference, agents require at minimum:
```yaml
---
description: What this agent specializes in
capabilities: ["task1", "task2"]
---
```
The PRD should specify whether agents will include `description`, `capabilities`, and any custom fields like `model` or `allowed_tools`. Without proper frontmatter, Claude Code cannot route tasks to the appropriate agent. The `subagent_type` and tool restrictions mentioned in the review criteria are not explicitly defined for any agent.

**PS-09. P2: Skill SKILL.md files missing required frontmatter specification**

Three skills are listed (Section 9, lines 816-823) with descriptions of when they activate, but no frontmatter format is specified. Skills require:
```yaml
---
name: skill-name
description: Use when [triggering conditions] - [what it does]
---
```
The `description` field is critical for Claude's routing -- it determines when the skill auto-activates. The PRD describes activation conditions narratively ("Activates when user discusses documentation or sync") but does not translate these into the `description` frontmatter that Claude Code actually reads. Without proper descriptions, skill auto-activation will not work as intended.

**PS-10. P2: `marketplace.json` not mentioned; version sync requirement undocumented**

The PRD mentions the Claude Code marketplace as a launch channel (Section 13, line 1211) and provides a plugin.json with version "0.1.0", but never mentions `marketplace.json`. For marketplace distribution, a `.claude-plugin/marketplace.json` file is required during development, and the version in `marketplace.json` must match `plugin.json`. The PRD should specify where and how `marketplace.json` is maintained, especially given that the monetization model includes a Claude Code marketplace listing.

**PS-11. P3: MCP server config includes `type` field not shown in standard examples**

The plugin.json (Section 12, line 1042) includes `"type": "stdio"` in the mcpServers entry. While this field is valid and useful for clarity, most real-world plugin manifests omit it (stdio is the default). More notably, the full-featured example from the superpowers-dev reference does not include `type`. This is cosmetic and will not cause errors, but deviates from convention. The `type: "http"` variant (for remote MCP servers) is where explicit typing is needed.

**PS-12. P3: `workflows/` directory has no plugin discovery mechanism**

The repository structure includes a `workflows/` directory (lines 1142-1146) containing 4 default YAML workflow definitions. However, Claude Code's plugin system has no auto-discovery for a `workflows/` directory -- it only auto-discovers `skills/`, `commands/`, `agents/`, and `hooks/`. The workflow files will need to be loaded by the MCP server daemon itself (reading from disk at startup), which is a fine design, but the PRD should make this loading mechanism explicit. Currently the workflows appear alongside the auto-discovered plugin components, which could mislead implementers into expecting Claude Code to handle workflow loading.

**PS-13. P3: `interkasten` CLI command referenced in hooks but installation not specified**

The hook scripts (Section 9, lines 780-812) invoke `interkasten` as a CLI command (e.g., `interkasten status --json`, `interkasten notify-change`, `interkasten notify-git-event`, `interkasten sync --flush`). But the PRD never specifies how this CLI is installed or made available on the PATH. The MCP server is launched via `npx interkasten-daemon`, suggesting the npm package provides the daemon entry point. Does it also provide an `interkasten` CLI binary? If the CLI communicates with the running daemon (e.g., via IPC, HTTP, or SQLite), that communication channel is not specified. If the CLI is a separate concern from the MCP server, it needs its own installation step. Hooks that fail because the CLI is not found will silently fail (they background with `&`), making this a subtle runtime issue.

---

### Improvements

**IMP-01. Specify hooks.json structure in the PRD** -- The PRD provides bash script contents for each hook but does not show the actual `hooks.json` file that registers them. Including the hooks.json structure would eliminate ambiguity about matcher patterns, timeout values, and async behavior.

**IMP-02. Add `cwd` to MCP server config** -- The mcpServers entry should include `"cwd": "${CLAUDE_PLUGIN_ROOT}"` to ensure the daemon starts in the plugin directory, which is important for resolving relative paths to workflow YAML files and config.

**IMP-03. Define agent frontmatter contract** -- Create a table mapping each agent name to its `description`, `capabilities`, `model`, and `allowed_tools` frontmatter values. This is the implementable contract; narrative descriptions of agent behavior are not sufficient for Claude Code's routing system.

**IMP-04. Consolidate MCP server definition to `.mcp.json`** -- The standard location for MCP server definitions is `.mcp.json` at the plugin root, which avoids the `mcpServers` block in plugin.json. This separates concerns: plugin metadata in plugin.json, server config in .mcp.json. Both approaches work, but `.mcp.json` is the more modern convention and avoids manifest bloat.

**IMP-05. Add a `postInstall` or init script to the distribution plan** -- The installation flow (Section 12, lines 1058-1071) assumes the user will manually run `/interkasten:init` after plugin install. Consider whether a SessionStart hook could detect first-run state (no `~/.interkasten/` directory) and prompt the user automatically, rather than relying on them to know the command.

<!-- flux-drive:complete -->
