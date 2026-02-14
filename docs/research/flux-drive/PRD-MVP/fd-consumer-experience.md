# Consumer Experience Review: Interkasten PRD-MVP

> **Reviewer**: fd-consumer-experience (consumer onboarding, error handling, upgrade paths)
> **Document**: `/root/projects/Interkasten/docs/PRD-MVP.md`
> **Date**: 2026-02-14
> **Mode**: Generic (no implemented code; review is against the design document)
> **Stage 1 Context**: FD-UP-002, FD-UP-005, FD-UP-007

---

### Findings Index

| Severity | ID | Section | Title |
|----------|-----|---------|-------|
| CRITICAL | CE-01 | "Deployment & Distribution" | Installation flow has undocumented Notion workspace prerequisite requiring manual browser steps |
| CRITICAL | CE-02 | "Configuration" | First-run config file is not auto-generated; user must create ~/.interkasten/config.yaml before init works |
| CRITICAL | CE-03 | "Plugin Layer / Hooks" | SessionStart hook fails silently when daemon is not running, giving no guidance on how to start it |
| HIGH | CE-04 | "Deployment & Distribution" | `npx interkasten-daemon` cold-start downloads ~50MB of dependencies on every new session |
| HIGH | CE-05 | "Configuration" | 80-line YAML config has no `interkasten init --defaults` path; user must understand entire schema upfront |
| HIGH | CE-06 | "Sync Engine" | Conflict resolution error messages expose raw merge diff output with no user-friendly explanation |
| HIGH | CE-07 | "Deployment & Distribution" | No version pinning strategy; `npx interkasten-daemon` always fetches latest, risking breaking changes on patch bumps |
| HIGH | CE-08 | "MCP Server Tool Surface" | No progressive disclosure; 33 tools dumped into Tool Search with no tiered onboarding |
| HIGH | CE-09 | "Plugin Layer" | No `/interkasten:help` or `/interkasten:doctor` command for self-diagnosis |
| MEDIUM | CE-10 | "Sync Engine" | Notion API errors (401/403/429) are not translated into user-friendly messages with remediation steps |
| MEDIUM | CE-11 | "Configuration" | `projects_dir: "/root/projects"` hardcoded in example config; most users do not have a `/root/projects` path |
| MEDIUM | CE-12 | "Pagent System" | Workflow YAML validation errors have no line-number or field-level feedback specified |
| MEDIUM | CE-13 | "Deployment & Distribution" | No uninstall/reset procedure documented; corrupted state.db has no recovery path |
| MEDIUM | CE-14 | "Technology Stack" | `better-sqlite3` requires native compilation; no fallback or pre-built binary strategy for non-standard platforms |
| LOW | CE-15 | "Document Model" | Skeleton PRD generation creates perceived-empty Notion pages that look like broken sync |
| LOW | CE-16 | "Sync Engine" | Sync log stored in Notion database; user cannot debug sync issues when Notion API is the problem |
| LOW | CE-17 | "Monetization" | No upgrade path documented between free self-hosted and Interkasten Cloud |

**Verdict: needs-changes**

---

### Summary

Walking through the exact steps a new user would take -- from `claude plugin install interkasten` to seeing a working synced project in Notion -- reveals 17 friction points, 3 of which are installation blockers. The installation flow described in the PRD (Section 12, lines 1057-1071) omits critical prerequisites: the user must first create a Notion integration in the Notion developer portal, configure it with the correct capabilities, share specific pages/databases with the integration, and obtain a token -- a multi-step browser workflow that takes 5-10 minutes and has its own failure modes. The config file is referenced but never auto-generated. The daemon startup via `npx` introduces cold-start latency and version instability. Error messages throughout the design are described at the technical level (HTTP status codes, merge diffs, DAG validation failures) with no consumer-facing translation layer specified. There is no self-diagnosis command (`/interkasten:doctor`) to help users debug common setup issues. The Stage 1 findings about persona confusion (FD-UP-002), missing help system (FD-UP-005), and empty time-to-value (FD-UP-007) are all confirmed and deepened by this end-to-end walkthrough.

---

### Issues Found

**CE-01. CRITICAL: Installation flow has undocumented Notion workspace prerequisite requiring manual browser steps**

The PRD describes installation as a 5-step flow (Section 12, lines 1057-1071):

```
1. claude plugin install interkasten
2. export INTERKASTEN_NOTION_TOKEN="ntn_..."
3. Start Claude Code, run /interkasten:init
4. Init wizard (verifies token, creates databases, scans projects...)
5. Daemon is running. Sync is active.
```

Step 2 says "export INTERKASTEN_NOTION_TOKEN" but does not explain where this token comes from. Obtaining a Notion integration token requires:

1. Navigate to https://www.notion.so/my-integrations
2. Click "New integration"
3. Name the integration, select a workspace
4. Configure capabilities (Read content, Update content, Insert content, Read comments)
5. Copy the "Internal Integration Secret" (starts with `ntn_`)
6. Navigate to the Notion workspace
7. Share the parent page (or each database) with the integration via the "..." menu > "Connections"

This is a 7-step browser workflow with multiple failure modes:
- User creates a "public" integration instead of "internal" (wrong token format)
- User forgets to share the workspace page with the integration (init wizard gets 403)
- User selects wrong capabilities (e.g., read-only, causing write failures later)
- User's Notion plan doesn't support integrations (free personal plans have limitations)

None of this is mentioned in the PRD. The init wizard "verifies Notion token" (line 1063) but the PRD doesn't specify what error message the user sees when verification fails, or how to diagnose which of the above 4 failure modes occurred.

Evidence: Section 12 lines 1057-1071 describe the full install flow. Section 11 line 986-991 shows secrets management but only covers the env var, not the token acquisition. The Notion API documentation (https://developers.notion.com/docs/getting-started) lists these prerequisites as mandatory.

Impact: Every single new user will hit this gap. It is the first thing they must do, and it is not documented.

Recommendation: Add a "Prerequisites" section to the install flow. The init wizard should detect missing or misconfigured tokens and provide step-by-step remediation including direct links to the Notion integration setup page. Consider adding a `/interkasten:setup-notion` command that walks through this interactively.

---

**CE-02. CRITICAL: First-run config file is not auto-generated; user must understand config schema before init**

Section 11 (lines 903-982) describes "All configuration in `~/.interkasten/config.yaml`" as a prerequisite. Section 12's installation flow (line 1057-1071) jumps from "export token" to "run /interkasten:init" without creating this file.

Two interpretations, both problematic:

**If the config file must exist before init**: The user must manually create `~/.interkasten/config.yaml` with the correct YAML structure (80 lines in the example). This requires understanding the full schema before they have used the product.

**If init creates the config file**: The PRD doesn't say this. The init wizard description (lines 1063-1069) says it "verifies Notion token, creates workspace structure, scans projects directory" but does not mention config file creation. The config references `projects_dir: "/root/projects"` (line 907) which must be set before project scanning can work.

Evidence: Section 11 presents the full config as a monolithic block. No mention of `interkasten init --defaults` or interactive config generation. The config includes environment-specific values (`projects_dir`, `watcher.ignore_patterns`, `milestones` thresholds) that cannot be defaulted without asking the user.

Impact: Without auto-generation, users must copy-paste the 80-line example, understand every field, and customize before first use. This contradicts the "designed for anyone" claim (line 48).

Recommendation: Init wizard should auto-generate config with sensible defaults, asking only 2 questions: (1) Where are your projects? (detect common paths like `~/projects`, `~/code`, `~/dev`) and (2) Notion token (if not already in env). All other config should be defaults with a "Customize later with `/interkasten:config`" message.

---

**CE-03. CRITICAL: SessionStart hook fails silently when daemon is not running, giving no guidance on startup**

Section 9 (lines 777-788) shows the SessionStart hook:

```bash
DAEMON_STATUS=$(interkasten status --json 2>/dev/null)
if [ $? -ne 0 ]; then
  echo '{"status":"context","message":"Interkasten daemon not running. Use /interkasten:init."}'
  exit 0
fi
```

This hook references an `interkasten` CLI binary (`interkasten status --json`). But the daemon is specified as an MCP server started via `npx interkasten-daemon` (Section 12, lines 1041-1049). The MCP server is started by Claude Code automatically when the plugin loads. So:

1. If the MCP server failed to start (e.g., missing Node, port conflict, corrupt state.db), the hook says "Use /interkasten:init" -- but init also requires the daemon. Circular dependency.
2. The `interkasten` CLI binary (used in hooks) is a different executable from `interkasten-daemon` (the MCP server). The PRD never specifies that the CLI binary is installed or how it communicates with the daemon.
3. If the user's first session after install has a daemon startup failure, they see "daemon not running, use init" with no information about *why* it failed or how to check logs.

Evidence: Hook script at lines 780-788 uses `interkasten status --json`. MCP server config at lines 1041-1049 specifies `npx interkasten-daemon`. These appear to be different binaries. No IPC mechanism (socket, HTTP, shared file) is specified between the CLI and daemon.

Impact: The most common first-run failure (daemon didn't start) produces a misleading error message that sends the user in a loop.

Recommendation: (1) Specify how the `interkasten` CLI communicates with the daemon (Unix socket at `~/.interkasten/daemon.sock`?). (2) The SessionStart hook should check for common failure modes: missing Node >= 20, missing config file, missing Notion token, corrupt state.db. (3) Each failure should produce a specific remediation message, not a generic "use init."

---

**CE-04. HIGH: `npx interkasten-daemon` cold-start downloads ~50MB of dependencies on every new session**

The plugin manifest (Section 12, lines 1041-1049) specifies:

```json
"command": "npx",
"args": ["interkasten-daemon"]
```

`npx` without a version pin fetches the latest version from npm on every invocation unless the package is already in the npm cache. The dependency tree includes `better-sqlite3` (native addon requiring compilation), `chokidar`, `drizzle-orm`, `@notionhq/client`, and 8+ other packages (Section 10). Total install size is likely 40-80MB.

For a new user on a fresh machine:
- First session: 30-120 second delay while `npx` downloads and compiles `better-sqlite3`
- Subsequent sessions: faster if cached, but npm cache can be cleared by OS or user
- If `better-sqlite3` native compilation fails (missing build tools), the entire daemon fails to start with a cryptic node-gyp error

Evidence: Section 10 lists 13 runtime dependencies. `better-sqlite3` requires `node-gyp` and a C++ compiler. Section 12 uses `npx` without `--yes` flag (user gets an interactive prompt to install the package).

Impact: The user's first Claude Code session after installing the plugin will hang for 30+ seconds with no progress indicator while npm downloads dependencies. If they lack build tools, it fails with compile errors.

Recommendation: (1) Bundle the daemon as a pre-built binary (esbuild/pkg) included in the plugin package, eliminating the npx cold-start. (2) If npx is used, pin the version (`npx interkasten-daemon@0.1.0`) and add `--yes` flag. (3) Add a post-install hook that pre-downloads dependencies. (4) For `better-sqlite3`, consider `better-sqlite3` pre-built binaries via `@aspect-build/better-sqlite3` or switch to `sql.js` (pure WASM, no native compilation).

---

**CE-05. HIGH: 80-line YAML config has no progressive disclosure; full schema exposed upfront**

Section 11 (lines 903-982) presents the configuration as a single 80-line YAML block with 8 top-level sections:

1. `projects_dir` + `project_detection` (4 fields)
2. `notion` (token, workspace_id, 4 database IDs)
3. `sync` (poll_interval, batch_size, conflict_strategy, tunnel config)
4. `watcher` (debounce_ms, ignore_patterns)
5. `docs` (default_tier, auto_promote_threshold, 7 model assignments)
6. `milestones` (8 threshold definitions with complex object syntax)
7. `schedules` (2 cron definitions)
8. `pagent` (4 engine settings)
9. `beads` (3 integration settings)

A new user who has never heard of "pagent," "beads," "T2 docs," or "three-way merge" is confronted with all of this at once. The PRD provides no guidance on which fields are required vs. optional, which have safe defaults, or which can be ignored on first run.

Evidence: Section 11 presents config without any annotations like "required" or "advanced." No tiered config approach (minimal, standard, advanced). The `milestones` section uses complex YAML syntax: `{ commits: 10, beads_closed: 5, either: true }` which is unfamiliar to most users.

Impact: Configuration complexity is the second-largest onboarding barrier (after Notion token setup). Users who open this file will feel overwhelmed and uncertain about which fields to change.

Recommendation: Define a minimal config (3 fields: `projects_dir`, `notion.token`, `notion.workspace_id`). Auto-generate everything else with defaults. Add `# Advanced - usually no need to change` comments to delineate tiers. Provide a `/interkasten:config show` command that explains current config with annotations.

---

**CE-06. HIGH: Conflict resolution error messages expose raw merge diff output with no consumer-facing translation**

Section 7 (Conflict Resolution) describes the three-way merge process but does not specify what the user sees when a conflict occurs. The `interkasten_resolve_conflict` tool (Section 8, line 698) is described as "View conflicting versions, apply resolution" and the Conflict Resolver MCP App (line 765) renders "Side-by-side diff, pick-per-section resolution."

What the PRD does not specify:
- What notification does the user receive when a conflict is detected? (Notion page status change? Claude Code message? Nothing until they check?)
- What does the conflict diff look like? (Raw unified diff? Rendered markdown diff? Merge conflict markers?)
- What happens if the user ignores conflicts? (Do they accumulate? Does sync stop for that entity?)
- What language is used to describe the conflict? ("Overlapping change detected in section 'Architecture'" vs. "merge_conflict: lines 42-67, local_hash=a3f..., remote_ver=42")

Evidence: Section 7 lines 652-657 describe the merge algorithm but not the UX. Section 8's tool descriptions are one-liners. The Pagent System error handling (Section 3, lines 250-258) describes policies ("stop," "retry," "skip," "fallback") but not error message formats.

Impact: When the first real conflict occurs, the user's experience is undefined. If raw diff output is shown, most non-developer users will not understand it. If conflicts accumulate silently, the user will discover them as data loss.

Recommendation: Define a conflict notification pipeline: (1) immediate Claude Code context message ("1 conflict detected in ProjectX/PRD.md"), (2) Notion page status change to "Conflict" with a comment showing both versions in human-readable format, (3) `/interkasten:conflicts` command listing all pending conflicts with one-line summaries, (4) resolution options: "keep local," "keep Notion," "view diff," "resolve later."

---

**CE-07. HIGH: No version pinning strategy; npx always fetches latest, risking breaking changes on patch bumps**

The plugin manifest (Section 12, line 1045) specifies `"args": ["interkasten-daemon"]` without a version pin. Combined with `npx`, this means:

- Every new Claude Code session could potentially run a different version of the daemon
- A breaking change in a minor or patch release would silently break the user's setup
- The user has no way to know what version they are running
- There is no `interkasten --version` command listed in Section 9 (Commands)

The PRD mentions `"version": "0.1.0"` in the plugin manifest (line 1033) but this is the plugin version, not the daemon version. These could diverge.

Evidence: Section 12 plugin manifest. Section 9 commands list (lines 828-834) has no version or update command. No migration guide or changelog is referenced for users upgrading between versions.

Impact: A user who installed the plugin on Monday could have a completely different daemon running on Friday, with schema changes, config format changes, or API behavior changes, with no warning.

Recommendation: (1) Pin daemon version in manifest: `["interkasten-daemon@0.1.0"]`. (2) Add `interkasten_version` tool that reports daemon version, plugin version, and config schema version. (3) Add startup check: if daemon version doesn't match plugin expected version, emit a warning. (4) Specify semver policy: patch = bugfix only, minor = backward-compatible features, major = breaking changes requiring migration.

---

**CE-08. HIGH: No progressive disclosure for 33 tools; entire surface exposed immediately**

Section 8 (lines 677-770) lists 33 tools across 7 domains. While the PRD mentions "Tool Search deferral" (line 769) to avoid consuming context, all 33 tools are registered with Tool Search simultaneously. A user asking "what can interkasten do?" will see:

- 6 project management tools
- 5 sync operations
- 5 document operations
- 4 research inbox tools
- 6 pagent workflow tools
- 4 pagent action tools
- 3 configuration tools

This directly confirms Stage 1 finding FD-UP-005 (no discoverable help system) and FD-UP-014 (33 tools exceeds cognitive load). The consumer experience impact is: the user does not know where to start, what the most common operations are, or which tools are "advanced."

Evidence: Section 8 tool listing. Section 9 only lists 6 commands (lines 828-834), suggesting 27 tools are only accessible via MCP tool calls with no command shortcuts. A user who types `/interkasten:` sees 6 options but there are actually 33 capabilities.

Impact: New users will either (a) only discover the 6 commands and miss 80% of functionality, or (b) see 33 tools in Tool Search and feel overwhelmed.

Recommendation: (1) Categorize tools into "core" (10-12) and "advanced" (remaining). Core tools are always registered. Advanced tools are registered only when the `interkasten-pagent` skill activates or user runs `/interkasten:workflow` or `/interkasten:advanced`. (2) Add a `/interkasten:help` command (as FD-UP-I04 recommends) that shows core operations with examples. (3) Add an `interkasten-onboarding` skill that activates in the first 3 sessions, proactively explaining available features.

---

**CE-09. HIGH: No `/interkasten:help` or `/interkasten:doctor` self-diagnosis command**

Section 9 (lines 828-834) lists 6 commands:

```
/interkasten:status    - Show sync dashboard
/interkasten:sync      - Force immediate sync
/interkasten:research  - Add to research inbox
/interkasten:init      - First-time setup wizard
/interkasten:workflow  - Manage pagent workflows
/interkasten:generate  - Generate or refresh a document
```

Missing from this list:
- `/interkasten:help` - What can I do? How do I get started?
- `/interkasten:doctor` - Is everything working? What's broken?
- `/interkasten:version` - What version am I running?
- `/interkasten:reset` - Start over / clean state

The `/interkasten:doctor` command is especially important because the system has many failure modes:
- Notion token expired or revoked
- Notion integration permissions changed
- State.db corrupted
- Daemon process crashed and didn't restart
- Config file has invalid YAML
- Node version too old
- `better-sqlite3` native module broken after OS update

Evidence: Section 9 command list is complete as written -- no help or diagnostic commands are planned. SessionStart hook (lines 777-788) provides a single "daemon not running" message but no diagnosis of *why*.

Impact: When something breaks (and it will -- external API dependencies always break), the user has no self-service debugging path. They must inspect logs manually, check environment variables, and understand the architecture to diagnose issues.

Recommendation: Add `/interkasten:doctor` that checks: (1) Node version >= 20, (2) `interkasten-daemon` resolves in npm, (3) `~/.interkasten/config.yaml` exists and parses, (4) Notion token is set and valid (API call), (5) Notion databases exist and are accessible, (6) `state.db` opens and has correct schema version, (7) filesystem watcher can access `projects_dir`, (8) no pending conflicts older than 24 hours. Output should be a checklist with pass/fail and remediation for each failure.

---

**CE-10. MEDIUM: Notion API errors are not translated into user-friendly messages**

The PRD references the Notion API throughout (Sections 6, 7, 8, 11, 12) but never specifies an error translation layer. Common Notion API errors:

| HTTP Code | Notion Meaning | User Sees (without translation) | User Should See |
|-----------|---------------|-------------------------------|----------------|
| 401 | Invalid token | `APIResponseError: Unauthorized` | "Your Notion token is invalid or expired. Get a new one at notion.so/my-integrations" |
| 403 | No access to page | `APIResponseError: Forbidden` | "Interkasten doesn't have access to this page. Share it with the integration in Notion." |
| 404 | Page/database deleted | `APIResponseError: Not Found` | "The Notion page for ProjectX was deleted. Run /interkasten:sync to re-create it." |
| 429 | Rate limited | `APIResponseError: Rate limited` | "Notion's API is throttling requests. Sync will retry automatically in 60 seconds." |
| 502/503 | Notion outage | `APIResponseError: Bad Gateway` | "Notion's API is temporarily down. Sync paused -- will resume when Notion recovers." |
| 409 | Conflict | `APIResponseError: Conflict` | "Another process modified this page. Sync will retry with fresh data." |

Evidence: Section 10 lists `@notionhq/client` as the Notion SDK. The SDK throws `APIResponseError` with HTTP status codes. Section 6 mentions rate limiting via `p-queue` (line 101) but does not specify what happens when rate limits are *still* exceeded (p-queue delays requests but Notion can reject them if the queue fills).

Impact: Every Notion API error will surface as a raw SDK exception unless an error translation layer is built. Users will Google cryptic error messages instead of following clear remediation steps.

Recommendation: Add an error translation module that maps Notion API error codes to user-friendly messages with remediation steps. Include this in the architecture as a required component of the sync engine.

---

**CE-11. MEDIUM: Example config uses `/root/projects` path that most users don't have**

Section 11 (line 907) shows:

```yaml
projects_dir: "/root/projects"
```

This is specific to the author's environment. On macOS (likely the majority of Claude Code users), the home directory is `/Users/<name>`. On Linux, it's `/home/<name>`. Running as root is atypical for desktop users.

Evidence: Section 11 config example. Section 12 states "Everything runs locally" (line 1027) and targets "anyone to install and configure" (line 48).

Impact: If users copy the example config without modification (common for quick-start), the filesystem watcher will watch a non-existent directory. Depending on error handling, this either fails silently (no projects discovered) or throws an error.

Recommendation: Use `${HOME}/projects` or `~/projects` in the example. Better: init wizard should auto-detect projects by scanning common locations (`~/projects`, `~/code`, `~/dev`, `~/Documents/projects`) and letting the user confirm.

---

**CE-12. MEDIUM: Workflow YAML validation errors have no line-number or field-level feedback specified**

Section 3 (lines 289-351) shows workflow YAML definitions with complex structure: nested nodes, depends_on references, config objects, fan_out/fan_in fields. When a user creates a custom workflow (via `interkasten_create_workflow` tool, line 739, or by editing YAML files), validation errors are inevitable.

The PRD does not specify:
- What validation is performed (schema validation? reference checking? cycle detection?)
- What error format is returned (line number? field path? suggestion?)
- When validation occurs (at creation time? at trigger time? both?)

Evidence: Section 3 describes DAG validation ("Validates -- Checks for cycles at registration time and double-checked at runtime," line 226) but only for cycles. No schema validation is mentioned. The `yaml` and `zod` libraries are listed in the tech stack (Section 10), suggesting schema validation is intended but not designed.

Impact: A user who typos `depends_on: classify` as `depends_on: clasify` (missing 's') will get undefined behavior. If validation catches it, the error message format is unspecified. If it doesn't catch it, the workflow runs with a broken dependency graph.

Recommendation: Specify Zod schema validation for all YAML input. Errors should include: (1) file path, (2) line number (using `yaml` library source mapping), (3) field path (e.g., `nodes[1].depends_on`), (4) expected vs. actual value, (5) suggestion if the error looks like a typo (Levenshtein distance on action/node names).

---

**CE-13. MEDIUM: No uninstall/reset procedure; corrupted state.db has no recovery path**

The PRD describes `~/.interkasten/state.db` as the central state store (Section 2, line 77) and `~/.interkasten/config.yaml` as the config file (Section 11, line 903). No uninstall, reset, or recovery procedure is documented.

Scenarios requiring reset:
- User wants to completely remove Interkasten and clean up
- State.db is corrupted (SQLite WAL file left from crash, schema mismatch after failed migration)
- User wants to re-run init after changing Notion workspaces
- Entity map has stale entries pointing to deleted Notion pages

Evidence: No `interkasten reset` or `interkasten uninstall` command in Section 9. No backup strategy for state.db. `drizzle-kit` is listed for schema migrations (Section 10) but no migration failure recovery is specified.

Impact: When state.db corruption occurs (inevitable with a long-running daemon that writes during filesystem events), the user has no documented path to recovery. They will likely delete `~/.interkasten/` entirely and re-run init, losing all sync state and forcing a full re-sync.

Recommendation: (1) Add `/interkasten:reset` command with options: `--config` (reset config to defaults), `--state` (clear state.db, re-scan), `--full` (remove everything). (2) Add automatic state.db backups before migrations. (3) Document manual recovery: "If sync breaks, run `/interkasten:doctor`. If doctor can't fix it, run `/interkasten:reset --state` to re-scan without losing config."

---

**CE-14. MEDIUM: `better-sqlite3` requires native compilation with no fallback strategy**

Section 10 lists `better-sqlite3` for the state store. This library requires:
- Node.js native addon compilation (node-gyp)
- A C++ compiler (gcc/clang/MSVC)
- Python 3 (for node-gyp)
- On macOS: Xcode Command Line Tools
- On Windows: Visual Studio Build Tools

The PRD states "Runtime Requirements: node >= 20 (LTS)" (line 896) but does not mention these build dependencies.

Evidence: Section 10 dependency table. `better-sqlite3` npm page documents these requirements. The PRD mentions no alternative or fallback.

Impact: Users on minimal environments (Docker containers, CI, Windows without Visual Studio) will fail at daemon startup with node-gyp compilation errors -- one of the most confusing error messages in the Node ecosystem.

Recommendation: (1) Use pre-built binaries (`@aspect-build/better-sqlite3` or `better-sqlite3` with `--build-from-source=false`). (2) Add `sql.js` (pure WASM) as a fallback when native compilation fails. (3) Document build prerequisites in a "System Requirements" section. (4) The `/interkasten:doctor` command should check for these before attempting daemon start.

---

**CE-15. LOW: Skeleton PRD generation creates perceived-empty Notion pages**

Section 5 (lines 467-470) describes that when a project is first detected, a "PRD (skeleton)" is generated. Section 12 line 1067 says init "Generates skeleton PRDs." FD-UP-007 (Stage 1) flagged this as "unclear time-to-value."

From the consumer perspective: after init, the user opens their Notion workspace and sees 5-20 project pages (one per discovered project), each containing a skeleton PRD. A skeleton PRD is presumably: a title, maybe section headers, maybe placeholder text like "TODO: Describe the project's purpose."

This looks like broken output. The user expected "living documentation" and got empty templates. The adaptive model (Section 5, lines 467-478) means the next improvement comes after "first 5 commits" -- which for an existing project with 500 commits means... immediately? Or does it only count commits made *after* Interkasten was installed?

Evidence: Section 5 milestone table. The distinction between "project_detected" (skeleton) and "5 commits" (full PRD) is clear for new projects but ambiguous for existing ones with extensive git history.

Impact: The first impression for users with existing projects will be disappointing. They install a tool that promises adaptive documentation and get empty pages.

Recommendation: (1) For projects with existing git history, skip skeleton and generate full PRD immediately (the data is already there). (2) For truly new projects (0-4 commits), generate a "Project Card" instead of a skeleton PRD -- showing detected tech stack, file structure summary, and last commit message. This provides immediate value even with minimal data.

---

**CE-16. LOW: Sync log stored in Notion database; cannot debug sync when Notion is the problem**

Section 4 (lines 402-408) describes a "Sync Log" Notion database recording every sync operation. Section 8 line 699 provides `interkasten_sync_log` tool to query it.

If the Notion API is down, rate-limited, or returning errors, the sync log cannot be written to (it's in Notion) and cannot be queried (the tool queries Notion). The user cannot debug why sync stopped because the debugging tool requires the thing that's broken.

Evidence: Section 4 Notion workspace structure shows Sync Log as a Notion database. DI-12 (data integrity review) also flagged this: "Sync log stored as Notion database -- Notion API rate limits throttle audit trail writes."

Impact: During Notion outages (which are the most likely time a user would want to check sync status), the primary diagnostic tool is unavailable.

Recommendation: Store sync log locally in SQLite (`state.db`) as the primary source. Mirror to Notion as a secondary/optional audit trail. The `interkasten_sync_log` tool should query the local log, not the Notion database.

---

**CE-17. LOW: No upgrade path between free self-hosted and Interkasten Cloud**

Section 13 (lines 1184-1192) describes Interkasten Cloud as a hosted alternative with tiered pricing. But no migration path is described:

- Can a self-hosted user migrate their `state.db` to the cloud version?
- Do they lose sync history?
- Are workflow definitions compatible between self-hosted and cloud?
- What about existing Notion database structures -- does cloud re-create them or import?

Evidence: Section 13 lists features per tier but no migration tooling. The cloud "Free" tier has "3 projects, 5-min polling, 50 pagent runs/month" which may be more restrictive than self-hosted defaults (unlimited projects, 60s polling).

Impact: Users who outgrow self-hosted (e.g., want webhook sync without managing cloudflared) have no clear upgrade path. Users who try cloud first and want to self-host have no export path.

Recommendation: (1) Define a `/interkasten:export` command that produces a portable state bundle. (2) Define a `/interkasten:import` command for cloud-to-self-hosted migration. (3) Ensure workflow YAML definitions are identical between self-hosted and cloud. (4) Document the upgrade path in a "Migration Guide" section.

---

### Improvements

**CE-I01. Add "Prerequisites" section with step-by-step Notion integration setup**

The install flow should start with:
1. **System**: Node >= 20, C++ compiler (for better-sqlite3)
2. **Notion**: Create integration at notion.so/my-integrations, select capabilities, copy token
3. **Notion**: Share the workspace root page (or target pages) with the integration
4. **Claude Code**: `claude plugin install interkasten`
5. **Environment**: `export INTERKASTEN_NOTION_TOKEN="ntn_..."`
6. **First run**: `/interkasten:init`

Each step should include a verification check and common error resolution.

**CE-I02. Implement `/interkasten:doctor` as the universal diagnostic command**

Checklist to verify:
- Node version >= 20
- `better-sqlite3` native module loads
- `~/.interkasten/config.yaml` exists and parses
- `INTERKASTEN_NOTION_TOKEN` is set
- Notion API responds (test query)
- Notion integration has required capabilities
- Target databases exist and are accessible
- `state.db` opens with correct schema version
- Filesystem watcher can access `projects_dir`
- No unresolved conflicts older than 24 hours
- Daemon process is running and responsive

Output: green/red checklist with fix instructions for each failure.

**CE-I03. Auto-generate minimal config during init wizard**

The init wizard should:
1. Detect `projects_dir` by scanning common locations
2. Accept Notion token from environment (already done)
3. Generate config with sensible defaults for everything else
4. Write `~/.interkasten/config.yaml` with comments explaining each section
5. Print "Config generated. Customize with `/interkasten:config`."

No user should ever need to write YAML manually to get started.

**CE-I04. Add error translation layer for all external API errors**

Create a centralized error handler that wraps every Notion API call and every filesystem operation. Transform technical errors into three-part messages: (1) what happened (plain language), (2) why it matters (impact on sync/workflows), (3) what to do (specific command or action).

**CE-I05. Bundle daemon as pre-built binary; eliminate npx cold-start**

Use `esbuild` to bundle the daemon into a single JavaScript file included in the plugin package. This eliminates:
- npx download latency
- Version drift between plugin and daemon
- Native compilation issues (if sql.js is used as fallback)
- Network dependency for daemon startup

**CE-I06. Implement progressive tool disclosure with onboarding skill**

Phase 1 (first 3 sessions): Register only core tools (list_projects, sync, sync_status, generate_doc, add_research, init, config_get, dashboard). Activate `interkasten-onboarding` skill that explains available features contextually.

Phase 2 (after user runs first sync): Add doc operations, research tools, conflict resolution.

Phase 3 (after user mentions workflows/automation): Add pagent workflow and action tools.

This matches the adaptive documentation model -- the tool surface grows with user sophistication.

**CE-I07. Define conflict notification and resolution UX end-to-end**

Specify the complete conflict lifecycle:
1. Detection: sync engine identifies overlapping changes
2. Notification: Claude Code context message + Notion page comment
3. Summary: one-line description ("You edited the 'Goals' section locally while someone edited it in Notion")
4. Options: "keep local" / "keep Notion" / "view both" / "merge manually"
5. Resolution: user picks via command or Notion status change
6. Confirmation: sync resumes, conflict cleared from pending list

**CE-I08. Distinguish existing projects from new projects in init flow**

During init, classify discovered projects:
- **Existing** (50+ commits, multiple files): Generate full PRD immediately using git history + file analysis
- **Active** (5-49 commits): Generate contextual PRD with detected tech stack, recent activity summary
- **New** (0-4 commits): Generate project card with placeholder sections

This eliminates the "empty pages" first impression for users with established codebases.

**CE-I09. Store sync log locally with optional Notion mirror**

Primary sync log in SQLite (`~/.interkasten/state.db` or separate `~/.interkasten/sync-log.db`). Notion Sync Log database becomes a read-only mirror updated during normal sync cycles. The `interkasten_sync_log` tool queries local storage first, falling back to Notion only if local data is unavailable.

**CE-I10. Add `/interkasten:reset` with graduated options**

```
/interkasten:reset --check     # dry-run: what would be reset
/interkasten:reset --config    # reset config to defaults (backs up old)
/interkasten:reset --state     # clear state.db, re-scan projects
/interkasten:reset --notion    # remove Interkasten databases from Notion
/interkasten:reset --full      # all of the above
```

Each option should confirm before acting and create a backup of the current state.

<!-- flux-drive:complete -->
