# Deep Technical Analysis: go-notion-md-sync (by byvfx)

**Date:** 2025-02-14
**Repo:** https://github.com/byvfx/go-notion-md-sync
**Latest version analyzed:** v0.16.0 (August 8, 2025)
**License:** MIT (Brandon Young, 2025)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Full Feature Set](#2-full-feature-set)
3. [Architecture](#3-architecture)
4. [API & Library Usability](#4-api--library-usability)
5. [Bidirectional Sync Details](#5-bidirectional-sync-details)
6. [Limitations & Known Issues](#6-limitations--known-issues)
7. [License & Commercial Use](#7-license--commercial-use)
8. [Development Activity](#8-development-activity)
9. [Integration Feasibility for Interkasten](#9-integration-feasibility-for-interkasten)
10. [Recommendation](#10-recommendation)

---

## 1. Executive Summary

go-notion-md-sync is a **Go CLI tool** (not a library) that provides bidirectional sync between local markdown files and Notion pages. It is a **solo-developer project** (~2 stars, 0 forks, 108 commits all by `byvfx`) created in June 2025. While it covers an impressive breadth of features on paper, the codebase reveals several significant architectural gaps that make it unsuitable as a dependency for Interkasten. It is best understood as a **functional but immature CLI tool** with limited battle-testing.

### Key Findings

- **CLI-only**: No importable Go library API. All logic is entangled with CLI commands, `fmt.Printf` side effects, and stdin prompts.
- **Conflict resolution is naive**: "Bidirectional sync" uses simple string equality comparison (`localContent != remoteContent`). The "newer" strategy actually falls through to interactive diff/user-prompt. There is no true automatic merge.
- **Change detection is hybrid but fragile**: Uses SHA-256 content hashes + file timestamps for local changes, but relies entirely on re-fetching and comparing Notion content for remote changes. No ETag, no `last_edited_time` comparison, no incremental sync.
- **No daemon mode**: The `watch` command uses fsnotify but only watches the local markdown directory for write events, pushing changes to Notion. It does NOT poll Notion for remote changes.
- **Single contributor, low adoption**: 2 stars, 0 forks, only `byvfx` contributing. Last commit August 8, 2025. Two open issues (sub-documents appending to parent, token format change).
- **MIT licensed**: Fully permissive, commercially usable.

---

## 2. Full Feature Set

### 2.1 Markdown Features Supported

| Feature | MD -> Notion | Notion -> MD | Notes |
|---------|:---:|:---:|-------|
| Headings H1-H3 | Yes | Yes | H4+ converted to H3 |
| Paragraphs | Yes | Yes | |
| Bullet lists | Yes | Yes | Nested lists supported with indentation |
| Numbered lists | Yes | Yes | All rendered as `1.` (no sequential numbering) |
| Fenced code blocks | Yes | Yes | 70+ language mappings (js->javascript, py->python, etc.) |
| Indented code blocks | Yes | Yes | No language detection |
| Tables | Yes | Yes | Full bidirectional with header row support |
| Blockquotes | Yes | Yes | Converted to Notion callouts |
| Bold/Italic/Code | Partial | Partial | Extracted as plain text during conversion (annotations NOT preserved on round-trip) |
| Images | Yes | Yes | External URLs only; `![caption](url)` format |
| Horizontal rules | Yes | Yes | `---` <-> divider block |
| LaTeX math | Yes | Yes | `$$...$$` block equations (not inline `$...$`) |
| Mermaid diagrams | Yes | Yes | Preserved as code blocks with `mermaid` language |
| HTML (details/summary) | Yes | Yes | Mapped to Notion toggle blocks |
| Links | Partial | Partial | Links in rich text NOT fully preserved; plain text extraction loses them |
| Inline HTML | No | No | Only `<details>/<summary>` handled |
| Footnotes | No | No | |
| Task lists (checkboxes) | No | No | |
| Definition lists | No | No | |
| Strikethrough | No | No | Annotations exist in types but not used in converter |

### 2.2 Notion Block Types Supported

| Block Type | Pull (Notion->MD) | Push (MD->Notion) | Notes |
|-----------|:---:|:---:|-------|
| paragraph | Yes | Yes | |
| heading_1/2/3 | Yes | Yes | |
| bulleted_list_item | Yes | Yes | |
| numbered_list_item | Yes | Yes | |
| code | Yes | Yes | With language normalization |
| quote | Yes | Yes | |
| divider | Yes | Yes | |
| table / table_row | Yes | Yes | |
| image | Yes | Yes | External only |
| callout | Yes | Yes | With emoji icon extraction |
| toggle | Yes | Yes | Via HTML details/summary |
| bookmark | Yes | Yes | |
| equation | Yes | Yes | |
| child_database | Yes (CSV export) | No | Databases exported as CSV files |
| child_page | Yes (recursive) | No | Creates nested directory structure |
| to_do | No | No | |
| embed | No | No | |
| video | No | No | |
| file/pdf | No | No | |
| synced_block | No | No | |
| column/column_list | No | No | |
| link_preview | No | No | |
| template | No | No | |
| breadcrumb | No | No | |

### 2.3 Frontmatter Handling

The tool manages YAML frontmatter with these fields:

```yaml
---
title: "Document Title"           # Used as Notion page title
notion_id: "uuid-of-notion-page"  # Auto-set on first push, used for subsequent syncs
created_at: "2025-06-10T18:39:00Z"
updated_at: "2025-06-10T15:38:10-07:00"
sync_enabled: true                # Must be true for sync to process file
tags: ["tag1", "tag2"]            # Stored but NOT synced to Notion properties
status: "published"               # Stored but NOT synced to Notion properties
---
```

**Key observations:**
- `notion_id` is the primary link between a local file and a Notion page. Without it, a new page is always created.
- `tags` and `status` are stored in frontmatter but **NOT mapped to Notion page properties**. They are metadata-only.
- `sync_enabled: false` causes the file to be skipped entirely.
- The tool overwrites frontmatter on sync operations (push writes back `notion_id`, pull regenerates all frontmatter).

### 2.4 Nested Pages

Pull operations create a directory hierarchy mirroring Notion's page structure:

```
docs/
  Parent Page/
    Parent Page.md
    Child Page/
      Child Page.md
      Grandchild/
        Grandchild.md
```

The hierarchy is built by traversing `GetAllDescendantPages()` which recursively calls `GetChildPages()` for each page. This means:
- **N+1 API calls**: One call per page to discover children, plus one to fetch blocks per page.
- **No pagination**: `GetChildPages` does not handle Notion API pagination (`has_more`/`next_cursor`).
- **Push does NOT create nested pages**: Pushing a file creates a flat page under the configured parent. There is no way to push a directory structure as nested Notion pages.

### 2.5 Database Support

- **Pull**: Child databases are detected during pull and exported as CSV files alongside the markdown.
- **Query/Create/Update**: The `Client` interface includes `GetDatabase`, `QueryDatabase`, `CreateDatabase`, `CreateDatabaseRow`, `UpdateDatabaseRow` methods.
- **DatabaseSync**: A `DatabaseSync` struct provides `SyncNotionDatabaseToCSV`, `SyncCSVToNotionDatabase`, and `CreateDatabaseFromCSV`.
- **No CLI exposure for database write operations**: The CLI only triggers database export during pull. There is no `notion-md-sync db import` command or similar.

---

## 3. Architecture

### 3.1 Package Structure

```
cmd/notion-md-sync/main.go   -- Entry point, calls cli.Execute()

pkg/
  cli/          -- Cobra commands (add, init, pull, push, reset, status, sync, tui, verify, watch)
  config/       -- Viper-based config loading (.env, config.yaml, env vars)
  cache/        -- LRU memory cache for Notion API responses
  concurrent/   -- Worker pool, batch processor, sync jobs
  markdown/     -- Frontmatter extraction, goldmark-based parser
  notion/       -- HTTP client for Notion API (raw REST, no SDK)
  staging/      -- Git-like staging area (.notion-sync/index JSON file)
  sync/         -- Core engine: converter, conflict resolver, database sync, streaming
  tui/          -- Bubble Tea TUI (file browser + sync status)
  util/         -- Logger, path security, validation
  watcher/      -- fsnotify-based file watcher with debounce
```

### 3.2 Core Flow

**Push (MD -> Notion):**
1. Parse markdown file with goldmark (AST-based)
2. Extract frontmatter (title, notion_id, sync_enabled, etc.)
3. Skip if `sync_enabled: false`
4. Convert markdown AST nodes to Notion API block JSON (`map[string]interface{}`)
5. If `notion_id` exists: clear all existing blocks on the page, then append new blocks
6. If no `notion_id`: create new page under parent, then append blocks
7. Write back frontmatter with updated `notion_id` and `updated_at`

**Pull (Notion -> MD):**
1. Fetch parent page, then recursively discover all descendant pages
2. For each page: fetch all blocks (recursively for child blocks)
3. Detect child databases, export as CSV
4. Convert Notion blocks to markdown strings
5. Generate frontmatter and write `.md` file

**Watch:**
1. Use fsnotify to watch the markdown root directory for `.md` file write events
2. Debounce writes (2-second interval)
3. On debounced write: call `SyncFileToNotion()` for that file
4. **One-directional only**: Does NOT poll Notion for changes

**Bidirectional Sync:**
1. Fetch all descendant pages from Notion
2. Walk local markdown directory
3. For each local file with `notion_id`: fetch remote blocks, convert to markdown, compare strings
4. If strings differ (`HasConflict` = `localContent != remoteContent`): invoke conflict resolver
5. Conflict resolution strategies:
   - `newer`: Falls through to `diff` (comment in code: "we don't have reliable timestamps")
   - `notion_wins`: Always use remote
   - `markdown_wins`: Always use local
   - `diff`: Show diff in terminal, prompt user for [l]ocal/[r]emote/[s]kip
6. For Notion pages without local files: pull them
7. For local files without `notion_id`: push them

### 3.3 Notion API Client

The client is a **hand-rolled HTTP client** (not using `jomei/notionapi` or any SDK):

- Direct REST calls to `https://api.notion.com/v1`
- API version: `2022-06-28` (not the latest 2025-09-03)
- Default timeout: 30 seconds (extended to 10 minutes for large syncs via context)
- **No rate limiting**: No built-in retry on 429 responses. Only `time.Sleep(50-200ms)` delays between operations.
- **No pagination**: `GetPageBlocks` and `GetChildPages` do not handle `has_more`/`next_cursor`. This will silently truncate results for pages with >100 blocks or >100 children.
- Block updates use destructive clear-and-replace: delete all existing blocks, wait 200ms, append new blocks in chunks of 100.
- `BatchClient` (multi-client) available but not default: creates multiple HTTP clients for parallel API calls.

### 3.4 Change Detection Model

| Source | Detection Method | Notes |
|--------|-----------------|-------|
| Local files | SHA-256 hash + mtime | Timestamp checked first; hash computed only if mtime changed. Stored in `.notion-sync/index` JSON. |
| Notion pages | Full content comparison | Re-fetches all blocks, converts to markdown, does string comparison. No incremental detection. |

### 3.5 Concurrency Model

- Pull operations use goroutine-based worker pools (auto-tuned: 30 workers for 15+ pages, 20 for 5-14, fewer for <5)
- Worker count capped at 50
- For very large workspaces (100+ direct children): switches to "streaming mode" which processes pages sequentially as they're discovered
- `sync.Mutex` used in staging area for concurrent file status checks
- No connection pooling beyond Go's default `http.Client` transport

### 3.6 No Daemon Mode

There is no persistent background daemon. The `watch` command runs in the foreground and only watches local file changes. To continuously sync in both directions, you would need to run `sync bidirectional` on a cron or manually.

---

## 4. API & Library Usability

### 4.1 Can It Be Used as a Go Library?

**Technically yes, practically no.** The packages are in `pkg/` and could theoretically be imported, but:

1. **Side effects everywhere**: The `sync.Engine`, `conflict.ConflictResolver`, and `notion.Client` all contain `fmt.Printf` and `fmt.Fprintf` calls scattered throughout. There is no logging interface or output abstraction.

2. **Interactive prompts**: The `diff` conflict resolver reads from `os.Stdin` with `bufio.NewReader`. This makes it unusable in non-interactive contexts without modification.

3. **No exported constructors for testing**: `NewEngine` requires a full `*config.Config`. The `NewEngineWithClient` allows injecting a mock client, which is good, but the engine still prints to stdout.

4. **Types are `map[string]interface{}`**: Notion blocks are represented as `map[string]interface{}` throughout the converter, making the API fragile and hard to use programmatically.

5. **No Go module versioning**: The module is `github.com/byvfx/go-notion-md-sync` with no tagged Go modules beyond the git tags. It would need to be imported by commit hash.

### 4.2 Key Interfaces

```go
// Sync engine - the main orchestrator
type Engine interface {
    SyncFileToNotion(ctx context.Context, filePath string) error
    SyncNotionToFile(ctx context.Context, pageID, filePath string) error
    SyncAll(ctx context.Context, direction string) error
    SyncSpecificFile(ctx context.Context, filename, direction string) error
}

// Markdown <-> Notion converter
type Converter interface {
    MarkdownToBlocks(content string) ([]map[string]interface{}, error)
    BlocksToMarkdown(blocks []notion.Block) (string, error)
}

// Notion API client
type Client interface {
    GetPage(ctx context.Context, pageID string) (*Page, error)
    GetPageBlocks(ctx context.Context, pageID string) ([]Block, error)
    CreatePage(ctx context.Context, parentID string, properties map[string]interface{}) (*Page, error)
    UpdatePageBlocks(ctx context.Context, pageID string, blocks []map[string]interface{}) error
    DeletePage(ctx context.Context, pageID string) error
    // ... + database methods, streaming methods
}
```

### 4.3 Could We Shell Out to the CLI?

Yes, but with significant caveats:

- **Installation**: Would need the Go binary compiled and available on PATH.
- **Configuration**: Requires `.env` file or environment variables for Notion credentials.
- **Output parsing**: CLI output is human-readable with emojis, not machine-parseable. No `--json` flag. No structured output format.
- **Error handling**: Exit codes are basic (0 or 1). Error messages go to stderr via `log.Printf`.
- **Interactive prompts**: The `diff` conflict resolver blocks on stdin. Would need to always set `conflict_resolution: markdown_wins` or `notion_wins` to avoid hangs.
- **File-centric**: Operations are file-path based. Converting a string of markdown to Notion blocks is not exposed as a CLI operation.

---

## 5. Bidirectional Sync Details

### 5.1 Sync Model

The sync model is **full-replacement, not incremental**:

- **Push**: Deletes ALL existing blocks on the Notion page, then appends all new blocks. This means:
  - Any Notion-side edits to individual blocks are lost on push
  - Comments on blocks are destroyed
  - Block IDs change on every push (breaking any cross-references)
  - Sub-pages (child_page blocks) may be orphaned or lost

- **Pull**: Overwrites the local file entirely with freshly converted content.

- **No merge**: There is no three-way merge. No common ancestor tracking. No operational transform.

### 5.2 Conflict Detection

```go
func HasConflict(localContent, remoteContent string) bool {
    return localContent != remoteContent
}
```

This is a **simple string inequality check** on the full markdown content. Since the converter is not perfectly round-trip stable (formatting differences, whitespace, annotation loss), this will likely report false conflicts frequently.

### 5.3 Conflict Resolution Strategies

| Strategy | Behavior | Automatic? |
|----------|----------|:---:|
| `newer` | Falls through to `diff` (timestamp comparison not implemented) | No |
| `notion_wins` | Always uses Notion version | Yes |
| `markdown_wins` | Always uses local version | Yes |
| `diff` | Shows unified diff in terminal, prompts user to choose | No (interactive) |

### 5.4 What's Missing for True Bidirectional Sync

1. **No common ancestor / base version tracking**: Cannot do three-way merge
2. **No `last_edited_time` comparison**: The Notion API provides this but it's not used for conflict detection
3. **No block-level diffing**: Changes are compared at the full-document level
4. **No sync state database**: The `.notion-sync/index` only tracks local file hashes, not Notion page states
5. **No webhook/polling for Notion changes**: Must manually trigger pull or bidirectional sync
6. **No lock mechanism**: Concurrent modifications during sync could corrupt state

---

## 6. Limitations & Known Issues

### 6.1 Critical Limitations

1. **No API pagination**: `GetChildPages` and `GetPageBlocks` do not handle Notion's pagination. Pages or blocks beyond the first response page (~100 items) are silently dropped. This is a **data loss risk** for large pages or deep hierarchies.

2. **Destructive push**: Every push operation deletes all blocks and re-creates them. This destroys:
   - Block-level comments
   - Block IDs (breaking internal links/references)
   - Any Notion-specific formatting not representable in markdown
   - Potential sub-page relationships

3. **Rich text annotations lost on round-trip**: The converter extracts `PlainText` from rich text blocks. Bold, italic, strikethrough, underline, code spans, and colors in Notion are **lost when pulling**. When pushing, the goldmark AST walker extracts text nodes but does not translate emphasis/strong nodes into Notion annotations.

4. **No inline math**: Only block-level `$$...$$` equations are supported. Inline `$x^2$` is not handled.

5. **Numbered lists always emit `1.`**: The converter outputs `1.` for all numbered list items, relying on markdown renderers to auto-number. This is technically valid markdown but loses explicit numbering.

6. **Links in text are lost**: The `extractPlainTextFromRichText` function extracts `.PlainText` only, discarding link URLs. A paragraph like "Visit [Google](https://google.com)" in Notion becomes "Visit Google" in markdown.

7. **No pagination in database queries**: `QueryDatabase` sends a single request. Databases with >100 rows will be truncated.

### 6.2 Open Issues

- **Issue #7**: "Sub Documents appended to Parent Document" -- sub-pages content gets merged into parent
- **Issue #6**: "Notion Tokens no longer start with `secret_`" -- token validation too strict (reportedly fixed in code but issue still open)

### 6.3 Performance Characteristics

- **Pull speed**: ~0.20 pages/second with 30 concurrent workers (per README benchmarks)
- **API calls per page pull**: Minimum 2 (GetPage + GetPageBlocks), potentially more for nested blocks and databases
- **Memory**: Loads all descendant pages into memory before processing. Streaming mode available for 100+ pages but loses hierarchy information.
- **Rate limiting**: No 429 handling. The only rate-limit mitigation is 50-200ms sleeps between operations.

---

## 7. License & Commercial Use

**MIT License** - Copyright (c) 2025 Brandon Young

Fully permissive. We can:
- Use commercially
- Modify
- Distribute
- Sublicense
- Use privately

The only requirement is including the MIT license notice.

---

## 8. Development Activity

### 8.1 Timeline

| Date | Event |
|------|-------|
| 2025-06-10 | Repository created |
| 2025-06-10 - 2025-07-30 | Rapid development: v0.1.0 through v0.16.0 (16 versions in ~7 weeks) |
| 2025-08-08 | Last commit (security fix for .env file permissions) |
| 2025-02-14 (today) | **~6 months since last commit** |

### 8.2 Contributors

Single contributor: `byvfx` (Brandon Young) with 108 commits.

### 8.3 Community

- **Stars**: 2
- **Forks**: 0
- **Open issues**: 2 (both unresponded since July 2025)
- **Pull requests**: 0 (never had external PRs)
- **Discussions**: No evidence of community engagement
- **npm/pip wrappers**: None exist
- **Third-party integrations**: None found

### 8.4 Assessment

This appears to be a **personal/hobby project** that saw intense development over ~7 weeks and then went dormant. The development style (16 versions in 7 weeks, all by one person, heavy use of AI-assisted development via Claude Code integration) suggests rapid prototyping rather than production-hardened development. The `.claude/` directory with custom commands (`session-start`, `session-end`, `review`, `release`, etc.) confirms heavy AI pair-programming.

---

## 9. Integration Feasibility for Interkasten

### 9.1 Option A: Shell Out to CLI

**Feasibility**: Low-Medium

| Pros | Cons |
|------|------|
| No Go dependency needed | No structured output (no `--json`) |
| Simple to invoke | Interactive conflict resolver blocks stdin |
| Handles Notion API details | File-path-centric (can't convert strings) |
| | Requires Go binary distribution |
| | No error detail beyond exit code |
| | No pagination = data loss on large pages |
| | Would need to parse human-readable output |

**Verdict**: Possible for basic push/pull but fragile and limiting. The lack of structured output and the interactive conflict resolver make it unsuitable for programmatic use from an MCP server.

### 9.2 Option B: Use as Go Library

**Feasibility**: Low

| Pros | Cons |
|------|------|
| Direct access to types and functions | stdout/stderr pollution (fmt.Printf everywhere) |
| Could inject mock clients for testing | Interactive stdin prompts in conflict resolver |
| Interfaces are reasonably clean | `map[string]interface{}` block representation |
| MIT license allows forking | No API stability guarantees |
| | Would need to fork and patch significantly |
| | Go dependency in a Node.js/TypeScript project |

**Verdict**: Would require a significant fork to remove side effects, fix pagination, and make it embeddable. At that point, we'd essentially be maintaining our own fork.

### 9.3 Option C: Port Converter Logic Only

**Feasibility**: Medium

The most useful component to port is the `Converter` which handles markdown <-> Notion block conversion. Key files:

- `pkg/sync/converter.go` (~600 lines) - Bidirectional markdown/Notion conversion
- `pkg/notion/types.go` (~350 lines) - Notion API type definitions
- `pkg/markdown/frontmatter.go` (~120 lines) - Frontmatter extraction

Porting just the converter logic to TypeScript would give us:
- Markdown -> Notion blocks conversion (using a TS markdown parser like remark/unified)
- Notion blocks -> Markdown conversion
- Frontmatter management

We would still need our own:
- Notion API client (or use `@notionhq/client` npm package)
- Sync engine with proper conflict resolution
- Change tracking system
- File watcher (if needed)

### 9.4 Option D: Build From Scratch Using Lessons Learned

**Feasibility**: High

go-notion-md-sync provides a valuable **reference implementation** showing:
1. Which Notion block types matter most for markdown sync
2. How to structure the markdown <-> blocks conversion
3. What frontmatter fields are useful
4. What language mappings are needed for code blocks
5. How nested page hierarchies should be represented on disk
6. What pitfalls to avoid (destructive push, no pagination, annotation loss)

We can use the `@notionhq/client` official SDK (JavaScript) and build a proper sync layer that avoids all the architectural issues.

---

## 10. Recommendation

**Do NOT use go-notion-md-sync as a dependency (library or CLI).** Instead, use it as a **reference implementation** for building our own sync layer.

### Reasons

1. **Pagination is broken**: This alone is disqualifying. Data loss on pages with 100+ blocks or 100+ children is unacceptable.

2. **Rich text fidelity is poor**: Annotations (bold, italic, links) are lost on round-trip. This defeats the purpose of bidirectional sync.

3. **Destructive push model**: Deleting all blocks and recreating them destroys comments, block IDs, and Notion-specific content.

4. **No true conflict resolution**: String comparison + interactive prompts is not viable for an MCP server.

5. **Single dormant maintainer**: 6 months inactive, 2 stars, no community. If we depend on this, we own it.

6. **Go in a Node/TS stack**: Adding a Go binary dependency to a TypeScript MCP server adds build/distribution complexity for minimal benefit.

### What to Build Instead

Use go-notion-md-sync's converter as a **reference** and build a TypeScript sync module that:

1. Uses `@notionhq/client` (official Notion SDK) with proper pagination
2. Preserves rich text annotations (bold, italic, links, code) bidirectionally
3. Uses `last_edited_time` for change detection (not full-content comparison)
4. Implements block-level diffing instead of full-document replacement
5. Tracks sync state in a proper database (SQLite or similar)
6. Provides a clean programmatic API (no stdout/stdin side effects)
7. Handles rate limiting with exponential backoff
8. Supports the Notion API 2025-09-03 version

### Estimated Effort

Building the core converter (markdown <-> Notion blocks) from scratch in TypeScript: **3-5 days**
Building the sync engine with proper conflict resolution: **5-8 days**
Total for a minimal viable sync layer: **~2 weeks**

This is comparable to the effort of forking, patching, and maintaining go-notion-md-sync, but produces a result that is architecturally sound and native to our stack.

---

## Appendix: Key Source Files Analyzed

| File | Lines (approx) | Purpose |
|------|------:|---------|
| `pkg/sync/engine.go` | ~500 | Core sync orchestration, push/pull/bidirectional logic |
| `pkg/sync/converter.go` | ~600 | Markdown <-> Notion block conversion (goldmark-based) |
| `pkg/sync/conflict.go` | ~150 | Conflict detection and resolution |
| `pkg/notion/client.go` | ~450 | Hand-rolled Notion REST API client |
| `pkg/notion/types.go` | ~350 | Notion API type definitions |
| `pkg/staging/staging.go` | ~350 | Git-like staging area with SHA-256 hashing |
| `pkg/watcher/watcher.go` | ~100 | fsnotify file watcher with debounce |
| `pkg/config/config.go` | ~120 | Viper-based configuration |
| `pkg/markdown/frontmatter.go` | ~120 | YAML frontmatter extraction |
| `cmd/notion-md-sync/main.go` | ~10 | Entry point |

## Appendix: Dependency Graph

Key Go dependencies:
- **goldmark** + goldmark-meta: Markdown parsing (AST-based)
- **goldmark extension.Table**: Table parsing
- **cobra**: CLI framework
- **viper**: Configuration management
- **fsnotify**: File system watching
- **charmbracelet/bubbletea + bubbles + lipgloss**: TUI framework
- **go-diff/diffmatchpatch**: Diff computation for conflict display
- **gotenv**: .env file loading
- **stretchr/testify**: Testing assertions

No Notion SDK is used -- all API calls are hand-rolled HTTP requests.
