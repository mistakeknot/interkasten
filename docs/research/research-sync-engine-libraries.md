# Sync Engine Libraries & Frameworks Research

> **Date**: 2026-02-14
> **Purpose**: Evaluate existing libraries for building a bidirectional sync engine between local markdown files and Notion pages via API.
> **Verdict**: No single library solves our exact problem. We need to compose several focused libraries together.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Sync Engine Frameworks](#1-sync-engine-frameworks)
3. [CRDT Libraries](#2-crdt-libraries)
4. [Conflict Resolution & Diff/Merge Libraries](#3-conflict-resolution--diffmerge-libraries)
5. [Operational Transform Libraries](#4-operational-transform-libraries)
6. [Event Sourcing / Operation Log Libraries](#5-event-sourcing--operation-log-libraries)
7. [File Watching & Change Detection](#6-file-watching--change-detection)
8. [Notion-Specific Libraries](#7-notion-specific-libraries)
9. [SQLite-Based Sync State Stores](#8-sqlite-based-sync-state-stores)
10. [Rate Limiting / API Call Management](#9-rate-limiting--api-call-management)
11. [Prior Art in Sync Engines](#10-prior-art-in-sync-engines)
12. [Recommended Stack](#recommended-stack)
13. [Build vs. Reuse Decision Matrix](#build-vs-reuse-decision-matrix)

---

## Executive Summary

After thorough research, the landscape breaks down clearly:

**Reuse (strong existing solutions):**
- Diff/patch/merge: `diff`, `node-diff3`, `diff-match-patch-es` are production-ready
- Notion SDK: `@notionhq/client` is the official, well-maintained SDK
- Markdown-to-Notion conversion: `@tryfabric/martian` (md -> Notion blocks) + `notion-to-md` (Notion -> md)
- File watching: `chokidar` v5 or `@parcel/watcher`
- Rate limiting: `bottleneck` or `p-queue`
- SQLite state store: `better-sqlite3` + `drizzle-orm` or `kysely`

**Build (nothing suitable exists):**
- The sync state machine itself (tracking per-file sync state, direction detection, conflict detection)
- The operation log / sync journal (event sourcing libs are too heavyweight/opinionated)
- The Notion `last_edited_time` version tracking system
- The reconciliation algorithm (when to push, pull, or flag conflict)
- The bidirectional pipeline orchestration (watch -> detect -> diff -> resolve -> apply)

**Overkill / Wrong fit:**
- Full CRDT libraries (Yjs, Automerge, Loro) -- designed for real-time collaborative editing, not periodic API sync
- Full sync engines (Zero, ElectricSQL, PowerSync) -- designed for database sync, not file-to-API sync
- ShareDB / OT libraries -- require real-time websocket connections, not batch API sync

---

## 1. Sync Engine Frameworks

### Zero (Rocicorp)
- **npm**: `@rocicorp/zero`
- **GitHub**: https://github.com/rocicorp/mono (open source as of 2025)
- **Stars**: ~5k+
- **License**: Apache-2.0
- **What it does**: General-purpose sync engine for web apps. Uses server reconciliation (pioneered by video games). Reads/writes go to local storage, sync engine runs continuously. Successor to Replicache.
- **Key features**: Partial sync, Postgres backend, real-time reactive queries, read-only offline support.
- **Suitability for us**: **Not suitable**. Designed for database-to-client sync with Postgres backend. We need file-to-API sync. Wrong abstraction level entirely.

### ElectricSQL
- **npm**: `@electric-sql/client` (v1.5.4)
- **GitHub**: https://github.com/electric-sql/electric
- **Stars**: ~7k+
- **License**: Apache-2.0
- **What it does**: Read-path sync engine for Postgres. Syncs subsets of Postgres data into local apps via HTTP.
- **Suitability for us**: **Not suitable**. Postgres-specific sync, not file/API sync.

### PowerSync
- **npm**: `@powersync/web` and related packages
- **GitHub**: https://github.com/powersync-ja/powersync-js
- **Stars**: ~1k+
- **License**: Apache-2.0
- **What it does**: Sync engine between SQLite on client and Postgres/MongoDB/MySQL on server. First-class offline support.
- **Suitability for us**: **Not suitable**. Database-to-database sync, not file-to-API sync.

### Replicache (Maintenance Mode)
- **npm**: `replicache`
- **GitHub**: Open-sourced, no longer charged
- **What it does**: Client-side sync framework for local-first web apps. Now in maintenance mode; superseded by Zero.
- **Suitability for us**: **Not suitable**. In maintenance mode, and same wrong abstraction as Zero.

### Logux
- **npm**: `@logux/core`, `@logux/client`, `@logux/server`
- **GitHub**: https://github.com/logux/logux
- **License**: MIT
- **What it does**: Client-server communication tool for collaborative web apps. Optimistic UI, offline-first, live updates. Uses operation log approach.
- **Suitability for us**: **Partially interesting** -- the operation log concept aligns with our needs, but the framework is designed for websocket-based real-time sync, not batch API sync. The log concept could inform our design.

### Summary: Sync Engine Frameworks

None of the existing sync engine frameworks are suitable for our use case. They are all designed for one of:
- Database-to-database sync (Electric, PowerSync)
- Database-to-client reactive sync (Zero, Replicache)
- Real-time websocket collaboration (Logux, ShareDB)

Our use case -- bidirectional sync between local markdown files and a REST API (Notion) with rate limits -- is fundamentally different. **We need to build the sync engine ourselves.**

---

## 2. CRDT Libraries

### Yjs
- **npm**: `yjs` (v13+)
- **Downloads**: ~1.8M/week
- **GitHub**: https://github.com/yjs/yjs
- **Stars**: ~20,700
- **License**: MIT
- **What it does**: High-performance CRDT for collaborative applications. Network-agnostic. Supports rich text editors, offline editing, version snapshots, undo/redo, shared cursors.
- **Key features**: Modular architecture, many editor bindings (ProseMirror, CodeMirror, TipTap, Quill, Monaco), multiple sync providers (WebSocket, WebRTC, y-indexeddb).
- **Suitability for us**: **Not suitable**. Designed for real-time collaborative editing with persistent connections. Overkill for periodic API sync of markdown files. The merge semantics are for character-level operations, not file-level sync.

### Automerge
- **npm**: `@automerge/automerge` (v2/v3)
- **Downloads**: ~7-8k/week
- **GitHub**: https://github.com/automerge/automerge
- **Stars**: ~5,900
- **License**: MIT
- **What it does**: JSON-like CRDT data structure. Built in Rust with JS bindings via WASM. Supports concurrent modifications that merge automatically.
- **Key features**: JSON document model, multi-language support (Rust, JS, Swift), `automerge-repo` for sync orchestration. Automerge 3 achieved ~10x memory reduction.
- **Suitability for us**: **Not suitable**. Same issues as Yjs -- designed for real-time collaborative editing of structured data, not periodic file sync. Also, WASM dependency adds complexity for a daemon.

### Loro
- **npm**: `loro-crdt` (v1.8.4)
- **Downloads**: Not widely reported (relatively new)
- **GitHub**: https://github.com/loro-dev/loro
- **Stars**: ~4k+
- **License**: MIT
- **What it does**: CRDTs based on Replayable Event Graph. Supports rich text, list, map, movable tree. Implemented in Rust with JS bindings via WASM.
- **Key features**: Version control built-in, collaborative editing, event graph approach.
- **Suitability for us**: **Not suitable**. Still experimental (API not stable), and same mismatch -- designed for real-time collaborative editing, not file-level sync.

### SyncForge
- **npm**: `syncforge`
- **GitHub**: https://github.com/ArthurzKV/syncforge
- **What it does**: Next-gen CRDT library claiming faster benchmarks than Yjs.
- **Suitability for us**: **Not suitable**. Same category as above.

### Summary: CRDT Libraries

CRDTs are the wrong tool for our problem. They solve **real-time collaborative editing** where multiple users modify the same document simultaneously through persistent connections. Our problem is **periodic batch synchronization** between two different representations of the same content (markdown files and Notion blocks) through a rate-limited REST API. The granularity, connection model, and data representation are all wrong.

**However**, the conceptual ideas from CRDTs (version vectors, causal ordering, merge semantics) could inform our conflict resolution design.

---

## 3. Conflict Resolution & Diff/Merge Libraries

### diff (jsdiff)
- **npm**: `diff` (v8.0.3)
- **Downloads**: ~64M/week
- **GitHub**: https://github.com/kpdecker/jsdiff
- **Stars**: ~9,000
- **License**: BSD-3-Clause
- **What it does**: JavaScript text diff implementation. Provides multiple diff algorithms: character-level, word-level, line-level, sentence-level, CSS, JSON.
- **Key features**: `Diff.createPatch()`, `Diff.applyPatch()`, `Diff.structuredPatch()`, `Diff.diffLines()`, `Diff.diffWords()`.
- **Suitability for us**: **Excellent**. We need line-level and word-level diffs to detect what changed in markdown files. Core utility for our sync engine. The patch generation and application functions are directly useful.

### node-diff3
- **npm**: `node-diff3` (v3.2.0)
- **Downloads**: ~5k/week
- **GitHub**: https://github.com/bhousel/node-diff3
- **Stars**: ~100+
- **License**: MIT
- **What it does**: Three-way merge for text. Compares original text with two independently modified versions and produces a merged result. Detects conflicts.
- **Key features**: `diff3Merge()`, `merge()`, `diffPatch()`, conflict detection and marking.
- **Suitability for us**: **Excellent and critical**. Three-way merge is exactly what we need for conflict resolution. When both local and Notion have changed, we need the "base" version (from our sync state) plus both sides. This library does exactly that. Small, focused, well-tested.

### diff-match-patch (Google)
- **npm**: `diff-match-patch` (original), `diff-match-patch-es` (v1.0.1, by antfu), `@sanity/diff-match-patch` (Sanity's TypeScript fork)
- **Downloads**: `diff-match-patch` ~1.5M/week; `diff-match-patch-es` ~85k/week
- **GitHub**: https://github.com/google/diff-match-patch (original), https://github.com/antfu/diff-match-patch-es (ESM rewrite)
- **Stars**: ~7k (original)
- **License**: Apache-2.0
- **What it does**: High-performance diff, match, and patch for plain text. Used by Obsidian Sync for three-way merging of markdown files.
- **Key features**: Myers diff algorithm with speedups, fuzzy matching, patch application that works even when underlying text has changed.
- **Notable**: Obsidian's official sync service uses this library for its merge algorithm.
- **Suitability for us**: **Strong candidate**. The fuzzy patch application is particularly useful -- it can apply patches even when the target text has drifted. The `diff-match-patch-es` or `@sanity/diff-match-patch` forks are better for modern TypeScript (ESM, tree-shakable, better Unicode handling).

### three-way-merge
- **npm**: `three-way-merge`
- **GitHub**: https://github.com/movableink/three-way-merge
- **License**: MIT
- **What it does**: Three-way diffs and merges on text, using Paul Heckel's two-way diff algorithm.
- **Suitability for us**: **Alternative to node-diff3**. Less established but functional. node-diff3 is more widely used.

### Summary: Diff/Merge Libraries

This is where we get strong reuse. Recommended combination:
- **`diff`** for generating line-level diffs and patches (detecting what changed)
- **`node-diff3`** for three-way merge when both sides changed (conflict resolution)
- **`diff-match-patch-es`** or **`@sanity/diff-match-patch`** for fuzzy patch application (handling drift)

---

## 4. Operational Transform Libraries

### ShareDB
- **npm**: `sharedb`
- **Downloads**: ~20k/week
- **GitHub**: https://github.com/share/sharedb
- **Stars**: ~6k+
- **License**: MIT
- **What it does**: Full-stack library for realtime JSON document collaboration based on OT. Provides Node.js server for coordinating edits from multiple clients.
- **Key features**: Multiple database adapters (MongoDB, Postgres, Memory), presence data, real-time collaboration via WebSocket.
- **Suitability for us**: **Not suitable**. Requires real-time WebSocket connections and a database backend. Designed for multi-user collaborative editing, not file-to-API sync.

### ot.js
- **npm**: `ot` (and `@otjs/*` packages)
- **GitHub**: https://github.com/Operational-Transformation/ot.js
- **What it does**: OT algorithm implementations for text editing.
- **Suitability for us**: **Not suitable**. Same issues -- real-time collaboration focused, requires persistent connections.

### JOT (JSON Operational Transformation)
- **npm**: `jot`
- **GitHub**: https://github.com/JoshData/jot
- **What it does**: OT on JSON data model. Can compose, rebase, and invert operations on JSON structures.
- **Suitability for us**: **Potentially interesting** for tracking structural changes to frontmatter/metadata, but overkill. Simple JSON diffing is sufficient for our metadata changes.

### Summary: OT Libraries

OT libraries are designed for real-time collaborative editing with a central server mediating concurrent operations. Our use case is fundamentally different -- we're doing periodic batch sync. **Not suitable**.

---

## 5. Event Sourcing / Operation Log Libraries

### sourced
- **npm**: `sourced`
- **GitHub**: https://github.com/cloudnativeentrepreneur/sourced
- **License**: MIT
- **What it does**: Tiny framework for building models with event sourcing pattern. Stores events and snapshots. Current state derived by replaying events.
- **Key features**: Entity modeling, event enqueuing/emitting, snapshot support, no assumptions about storage backend.
- **Suitability for us**: **Potentially useful but probably overkill**. We need a simple append-only operation log, not a full event sourcing framework with entities and snapshots. A custom SQLite-backed log would be simpler and more tailored to our needs.

### @rouby/event-sourcing
- **npm**: `@rouby/event-sourcing`
- **What it does**: Simple event sourcing library for storing and replaying events.
- **Suitability for us**: **Same assessment as sourced**. Too opinionated for our simple operation log needs.

### EventSourcing.NodeJS (by Oskar Dudycz)
- **GitHub**: https://github.com/oskardudycz/EventSourcing.NodeJS
- **What it does**: Examples and tutorials, not a reusable library. But demonstrates patterns well.
- **Suitability for us**: **Good for pattern reference**, not for direct reuse.

### Summary: Event Sourcing Libraries

Existing event sourcing libraries are designed for domain-driven design with aggregates, commands, and complex event replay. Our operation log is much simpler:
- Append sync operations (push, pull, conflict, skip)
- Track what happened and when
- Enable undo/replay for debugging

**Recommendation: Build a simple SQLite-backed operation log table. It's ~50 lines of code with better-sqlite3.**

---

## 6. File Watching & Change Detection

### chokidar
- **npm**: `chokidar` (v5.x, ESM-only)
- **Downloads**: ~97M/week
- **GitHub**: https://github.com/paulmillr/chokidar
- **Stars**: ~11k+
- **License**: MIT
- **What it does**: Minimal, efficient cross-platform file watching. Built on native fs.watch APIs.
- **Key features**: Debouncing, ignore patterns, directory watching, atomic write detection, symlink support.
- **v5 changes (Nov 2025)**: ESM-only, requires Node.js v20+, reduced dependency count to 1.
- **Suitability for us**: **Excellent**. The de facto standard for file watching in Node.js. Well-tested, handles edge cases (atomic writes, rapid changes). We need to add our own debouncing/batching logic on top.

### @parcel/watcher
- **npm**: `@parcel/watcher` (v2.5.x)
- **Downloads**: ~14M/week
- **GitHub**: https://github.com/parcel-bundler/watcher
- **Stars**: ~500+
- **License**: MIT
- **What it does**: Native file watcher using C++ backends (inotify, FSEvents, ReadDirectoryChanges). Significantly faster than chokidar for large directories.
- **Key features**: Native performance, watchman backend support, subscription-based API.
- **Used by**: Tailwind, Nx, Nuxt, VSCode.
- **Suitability for us**: **Strong alternative to chokidar**. Better performance for large vaults, but slightly less mature API. Native addon requires compilation.

### watcher
- **npm**: `watcher`
- **GitHub**: https://github.com/nicolo-ribaudo/watcher
- **What it does**: Chokidar-compatible API with rename/renameDir event support.
- **Suitability for us**: **Viable alternative**. Less widely used.

### @bscotch/debounce-watch
- **npm**: `@bscotch/debounce-watch`
- **What it does**: Wraps chokidar with debouncing that collects all changes and calls a function once activity settles.
- **Suitability for us**: **Interesting** but we likely want custom debouncing logic tied to our sync state machine.

### Summary: File Watching

**Recommendation: Use `chokidar` v5**. It's the standard, extremely well-tested, and our vault size won't be large enough to need @parcel/watcher's performance advantages. We'll add our own debouncing/hashing/batching layer.

If we discover performance issues with large vaults (1000+ files), switch to `@parcel/watcher`.

---

## 7. Notion-Specific Libraries

### @notionhq/client (Official SDK)
- **npm**: `@notionhq/client` (v5.9.0)
- **Downloads**: ~1.4M/month, ~14M/year
- **GitHub**: https://github.com/makenotion/notion-sdk-js
- **Stars**: ~5k+
- **License**: MIT
- **What it does**: Official Notion JavaScript/TypeScript client. Typed interface to all Notion API endpoints.
- **Key features**: Full TypeScript types, built-in error handling, pagination helpers, retry logic.
- **API version**: Supports 2025-09-03 API version.
- **Suitability for us**: **Must use**. This is the official SDK. Non-negotiable foundation for all Notion API interactions.

### notion-to-md
- **npm**: `notion-to-md` (v3.1.9)
- **Downloads**: ~2k/week (96 dependents)
- **GitHub**: https://github.com/souvikinator/notion-to-md
- **Stars**: ~1,600
- **License**: MIT
- **What it does**: Converts Notion pages/blocks to Markdown, MDX, JSX, HTML, LaTeX, and more.
- **Key features**: Configurable block handling, child page support, custom transformers, v3 with plugin architecture.
- **Suitability for us**: **Essential for pull direction** (Notion -> Markdown). This handles the complex mapping from Notion's block structure to markdown syntax. We'd need to extend/customize for our specific frontmatter needs.

### @tryfabric/martian
- **npm**: `@tryfabric/martian`
- **Downloads**: ~2.2k/week
- **GitHub**: https://github.com/tryfabric/martian
- **Stars**: ~500
- **License**: MIT
- **What it does**: Converts Markdown (including GFM) to Notion API Block objects and RichText objects.
- **Key features**: `markdownToBlocks()`, `markdownToRichText()`, preserves formatting in callouts, handles inline images, validates image URLs, auto-truncation to stay within Notion limits.
- **Suitability for us**: **Essential for push direction** (Markdown -> Notion). Handles the complex block structure generation that Notion's API requires.

### notion-sync (startnext)
- **npm**: Not published to npm
- **GitHub**: https://github.com/startnext/notion-sync
- **What it does**: Syncs markdown files from a local directory to Notion. One-way (md -> Notion).
- **Suitability for us**: **Reference only**. One-directional, no state tracking, no conflict resolution. But useful to study their markdown conversion approach.

### md-notion-sync
- **GitHub**: https://github.com/juliojimenez/md-notion-sync
- **What it does**: Sync markdown files to Notion pages. Supports rich formatting, batch processing.
- **Suitability for us**: **Reference only**. One-directional.

### go-notion-md-sync
- **GitHub**: https://github.com/byvfx/go-notion-md-sync
- **Language**: Go (not JS/TS)
- **What it does**: Bidirectional sync between local markdown files and Notion. Has TUI, file watching, git-like staging, frontmatter support, conflict resolution ("newer", "notion_wins", "markdown_wins").
- **Suitability for us**: **Best prior art reference**. This is the closest existing project to what we're building, but it's in Go. Study its architecture, conflict resolution modes, and frontmatter handling for design inspiration. Key features to study:
  - 30 concurrent workers with Notion API
  - Conflict resolution modes
  - Frontmatter-based metadata tracking
  - File watching with auto-sync

### Mk Notes
- **npm**: Not published to npm (CLI tool)
- **GitHub**: https://github.com/Myastr0/mk-notes
- **Website**: https://mk-notes.io
- **What it does**: Sync markdown files to Notion with a single command. Preserves formatting including code blocks, tables, images, LaTeX.
- **Suitability for us**: **Reference only**. One-directional (md -> Notion).

### Summary: Notion Libraries

**Must use:**
- `@notionhq/client` -- official SDK, foundation for all API calls
- `notion-to-md` -- Notion blocks to markdown (pull direction)
- `@tryfabric/martian` -- markdown to Notion blocks (push direction)

**Study for design:**
- `go-notion-md-sync` -- closest prior art for bidirectional sync architecture

**Build ourselves:**
- Sync state tracking with `last_edited_time` -- no library exists for this
- Bidirectional pipeline orchestration
- Frontmatter management for sync metadata

---

## 8. SQLite-Based Sync State Stores

### better-sqlite3
- **npm**: `better-sqlite3`
- **Downloads**: ~3.2M/week
- **GitHub**: https://github.com/WiseLibs/better-sqlite3
- **Stars**: ~6,900
- **License**: MIT
- **What it does**: The fastest and simplest SQLite3 library for Node.js. Synchronous API (no callbacks/promises needed for queries).
- **Key features**: Full-featured SQLite3 access, user-defined functions, 64-bit integers, WAL mode, transactions, prepared statements.
- **Suitability for us**: **Excellent**. Synchronous API is actually ideal for a sync daemon that needs to quickly check/update state. No async overhead for simple queries. Perfect for our sync state store.

### drizzle-orm (with SQLite)
- **npm**: `drizzle-orm` (v0.38+)
- **Downloads**: ~4.6M/week
- **GitHub**: https://github.com/drizzle-team/drizzle-orm
- **Stars**: ~32,700
- **License**: Apache-2.0
- **What it does**: Lightweight, type-safe TypeScript ORM. Native SQLite support via better-sqlite3 driver.
- **Key features**: Schema-as-code, type inference, migrations via drizzle-kit, zero runtime overhead for types, supports CJS and ESM.
- **Suitability for us**: **Good choice for type safety**. If we want type-safe queries and schema management with migrations, drizzle-orm adds minimal overhead on top of better-sqlite3. Good DX.

### Kysely
- **npm**: `kysely` (v0.28+)
- **Downloads**: ~2.5M/week
- **GitHub**: https://github.com/kysely-org/kysely
- **Stars**: ~13,400
- **License**: MIT
- **What it does**: Type-safe SQL query builder for TypeScript. Zero dependencies. Works with SQLite via better-sqlite3.
- **Key features**: Full SQL query building with type inference, no code generation needed, autocompletion for tables/columns, works anywhere JS runs.
- **Used by**: Deno, Maersk, Cal.com.
- **Suitability for us**: **Strong alternative to drizzle-orm**. More query-builder than ORM -- gives more control over SQL. Zero dependencies is nice for a daemon. Slightly lower-level than drizzle but more flexible.

### Summary: SQLite State Stores

**Recommendation: `better-sqlite3` + `drizzle-orm`**

Rationale:
- `better-sqlite3` is the fastest SQLite driver, and its synchronous API is ideal for a daemon
- `drizzle-orm` provides type-safe schema definition and queries with minimal overhead
- `drizzle-kit` handles schema migrations as the sync state schema evolves
- Alternative: `better-sqlite3` + `kysely` if we prefer a query builder over an ORM

For a minimal daemon, even raw `better-sqlite3` with hand-written SQL is fine -- our schema is small (sync_state, operation_log, maybe file_hashes tables).

---

## 9. Rate Limiting / API Call Management

### Bottleneck
- **npm**: `bottleneck` (v2.19.5)
- **Downloads**: ~5-8M/week
- **GitHub**: https://github.com/SGrondin/bottleneck
- **Stars**: ~1,970
- **License**: MIT
- **What it does**: Job scheduler and rate limiter. Builds a queue of jobs and executes them at a controlled rate.
- **Key features**: Concurrency control, priority queues, scheduling, clustering support (Redis), reservoir (token bucket), retry support.
- **Caveat**: Last published 7 years ago (2019). Maintained but not actively developed. Issue #207 discusses maintenance status.
- **Suitability for us**: **Good fit despite age**. Battle-hardened, production-ready, and the API hasn't needed changes. Perfect for wrapping Notion API calls at 3 req/sec. Configuration: `maxConcurrent: 1, minTime: 334` (3 req/sec).

### p-queue
- **npm**: `p-queue`
- **GitHub**: https://github.com/sindresorhus/p-queue
- **Stars**: ~3k+
- **License**: MIT
- **What it does**: Promise queue with concurrency control. Priority support, pause/resume, interval-based rate limiting.
- **Key features**: `intervalCap` + `interval` for rate limiting (e.g., `intervalCap: 3, interval: 1000` for 3 req/sec), priority levels, events, timeout support.
- **Suitability for us**: **Strong alternative to bottleneck**. More actively maintained (sindresorhus ecosystem). The `intervalCap` feature is exactly what we need for Notion's rate limit. ESM-only.

### p-ratelimit
- **npm**: `p-ratelimit`
- **GitHub**: https://github.com/natesilva/p-ratelimit
- **License**: MIT
- **What it does**: Promise-based rate limiter. Minimal code changes needed -- wrap existing async functions.
- **Suitability for us**: **Simpler alternative**. Good if we want minimal API changes. Less feature-rich than bottleneck or p-queue.

### throttled-queue
- **npm**: `throttled-queue`
- **What it does**: Simple throttle queue. Wraps API calls to stay within rate limits.
- **Suitability for us**: **Too simple**. No concurrency control or priority support.

### rate-limiter-flexible
- **npm**: `rate-limiter-flexible`
- **GitHub**: https://github.com/animir/node-rate-limiter-flexible
- **Stars**: ~3k+
- **License**: ISC
- **What it does**: Flexible rate limiting with multiple backends (Memory, Redis, Mongo, etc.).
- **Suitability for us**: **Overkill**. Designed for server-side rate limiting of incoming requests. We need client-side rate limiting of outgoing requests.

### Summary: Rate Limiting

**Recommendation: `p-queue`**

Rationale:
- Actively maintained (sindresorhus ecosystem)
- `intervalCap: 3, interval: 1000` directly maps to Notion's 3 req/sec limit
- Priority support lets us prioritize user-initiated syncs over background syncs
- Pause/resume support for handling 429 responses with Retry-After headers
- Event emitters for monitoring queue state

Alternative: `bottleneck` if we need Redis clustering later (we won't for a single-user daemon).

---

## 10. Prior Art in Sync Engines

### How Obsidian Sync Works
- **Architecture**: End-to-end encrypted cloud sync service.
- **Conflict resolution for markdown**: Uses Google's `diff-match-patch` algorithm for three-way merge. When both devices changed the same file, it performs a three-way merge using the last-synced version as the base.
- **Non-markdown files**: Binary files use last-write-wins (larger file wins in some cases).
- **Selective sync**: Can choose which folders, file types (images, audio, video, PDFs), and settings to sync.
- **Metadata sync**: Syncs editor settings, themes, plugins, hotkeys per-vault.
- **Key takeaway for us**: The `diff-match-patch` three-way merge approach is proven and effective for markdown. We should use the same strategy.

### How Obsidian Remotely Save Works (community plugin)
- **Architecture**: Open-source plugin syncing to S3/Dropbox/WebDAV/OneDrive/Google Drive.
- **Conflict resolution**: Simple "last modified time wins". No content-level merging.
- **Sync detection**: Compares local and remote `lastModified` timestamps.
- **Key takeaway**: Simplest possible approach. Works for single-user but loses data when both sides change. We should do better.

### How Syncthing Works
- **Architecture**: Decentralized, peer-to-peer continuous file synchronization.
- **Conflict resolution**: When a file is modified on two devices simultaneously:
  - Renames one copy to `<filename>.sync-conflict-<date>-<time>-<modifiedBy>.<ext>`
  - The file with the **older** modification time becomes the conflict file
  - If modification times are equal, the device with the larger device ID "wins"
  - Conflict files are synced to all devices as normal files
- **No automatic merging**: Text files are not auto-merged; conflict files are created instead.
- **Community extensions**: Some users have scripts using `git merge-file` for automatic three-way merge of text conflict files.
- **Key takeaway**: The "create conflict file" approach is a safe fallback. We should support this as an option alongside automatic three-way merge.

### How Dropbox Works
- **Architecture**: Client-server with rsync-based chunked sync.
- **Conflict resolution**: Creates "conflicted copy" files rather than attempting merge. The file with the newer modification time is kept as the primary; the other becomes a "conflicted copy".
- **Technical details**: Files are chunked, hashes are compared, only changed chunks are transferred. Uses a lightweight database for hash persistence.
- **Datastore API** (deprecated): Used field-level collision detection for structured data.
- **Key takeaway**: Another "conflicted copy" approach. Safe but creates file clutter. Industry standard for non-text files.

### How Logseq Sync Works
- **Architecture**: Uses rsapi (open source, written in Rust) for sync. S3 for blob storage. SQLite for persistence.
- **Conflict resolution**: Does NOT compare pages -- syncs entire pages. Most recent changes win.
- **Limitations**: Does NOT support collaboration (multiple users, same graph). Single-user only.
- **Community self-hosted**: Open-source implementations exist using SQLite + S3 storage.
- **Key takeaway**: Page-level (not line-level) sync is simpler but loses granularity. For single-user sync, "most recent wins" is often sufficient.

### Summary: Prior Art Lessons

| System | Conflict Strategy | Merge Algorithm | Suitable for Multi-user? |
|--------|------------------|-----------------|--------------------------|
| Obsidian Sync | Three-way merge | diff-match-patch | No (single vault) |
| Remotely Save | Last-modified wins | None | No |
| Syncthing | Conflict files | None (community scripts) | Yes (but manual) |
| Dropbox | Conflicted copies | None | Yes (but manual) |
| Logseq Sync | Last-modified wins (page-level) | None | No |

**Our design should combine:**
1. **Three-way merge** (like Obsidian Sync) as the primary strategy for markdown
2. **Conflict files** (like Syncthing) as a fallback when merge fails
3. **Last-modified-wins modes** (configurable, like go-notion-md-sync) for users who prefer simplicity

---

## Recommended Stack

Based on this research, here is the recommended library stack for the Interkasten sync engine:

### Core Libraries (Must Use)

| Library | Purpose | npm Package | Weekly Downloads |
|---------|---------|-------------|-----------------|
| @notionhq/client | Notion API access | `@notionhq/client` | ~350k/week |
| notion-to-md | Notion -> Markdown | `notion-to-md` | ~2k/week |
| @tryfabric/martian | Markdown -> Notion blocks | `@tryfabric/martian` | ~2.2k/week |
| better-sqlite3 | Sync state database | `better-sqlite3` | ~3.2M/week |
| chokidar | File watching | `chokidar` | ~97M/week |

### Diff/Merge Libraries (Must Use)

| Library | Purpose | npm Package | Weekly Downloads |
|---------|---------|-------------|-----------------|
| diff | Text diffing & patching | `diff` | ~64M/week |
| node-diff3 | Three-way merge | `node-diff3` | ~5k/week |
| diff-match-patch-es | Fuzzy patch application | `diff-match-patch-es` | ~85k/week |

### Infrastructure Libraries (Recommended)

| Library | Purpose | npm Package | Weekly Downloads |
|---------|---------|-------------|-----------------|
| p-queue | Rate limiting (3 req/sec) | `p-queue` | ~3M/week |
| drizzle-orm | Type-safe SQLite queries | `drizzle-orm` | ~4.6M/week |

### Total: 10 libraries. Everything else, we build.

---

## Build vs. Reuse Decision Matrix

| Component | Decision | Rationale |
|-----------|----------|-----------|
| **Notion API client** | REUSE (`@notionhq/client`) | Official SDK, well-typed, maintained by Notion |
| **Notion -> Markdown** | REUSE (`notion-to-md`) | Handles complex block mapping, extensible |
| **Markdown -> Notion blocks** | REUSE (`@tryfabric/martian`) | Handles block structure generation, validation |
| **Text diffing** | REUSE (`diff`) | Mature, ~64M/week downloads, comprehensive algorithms |
| **Three-way merge** | REUSE (`node-diff3`) | Focused, correct, exactly our use case |
| **Fuzzy patching** | REUSE (`diff-match-patch-es`) | Proven (used by Obsidian Sync), handles drift |
| **File watching** | REUSE (`chokidar` v5) | Industry standard, handles edge cases |
| **SQLite driver** | REUSE (`better-sqlite3`) | Fastest, synchronous API ideal for daemon |
| **Query layer** | REUSE (`drizzle-orm`) | Type safety, migrations, minimal overhead |
| **Rate limiting** | REUSE (`p-queue`) | Actively maintained, perfect API for Notion limits |
| **Sync state machine** | BUILD | No library handles file-to-API sync state |
| **Operation log** | BUILD | Event sourcing libs are overkill; ~50 lines of SQL |
| **Conflict detection** | BUILD | Need custom logic for Notion's `last_edited_time` |
| **Reconciliation engine** | BUILD | Core algorithm: when to push/pull/merge/conflict |
| **Sync pipeline orchestrator** | BUILD | Watch -> detect -> diff -> resolve -> apply flow |
| **Frontmatter manager** | BUILD | Sync metadata in YAML frontmatter |
| **Notion version tracker** | BUILD | Track `last_edited_time` per page/block |
| **Debouncing/batching** | BUILD | Custom logic tied to sync state machine |
| **Configuration system** | BUILD | Sync rules, ignore patterns, conflict modes |
| **CLI/daemon interface** | BUILD | User interaction, status, manual sync triggers |

### Estimated Build Effort

**What we reuse**: ~10 libraries handling low-level concerns (diffing, file watching, API access, database, rate limiting)

**What we build**: The core sync engine logic (~2000-4000 lines of TypeScript estimated):
- Sync state machine: ~300 lines
- Operation log: ~100 lines
- Conflict detection + resolution: ~500 lines
- Reconciliation engine: ~600 lines
- Pipeline orchestrator: ~400 lines
- Frontmatter manager: ~200 lines
- Notion version tracker: ~200 lines
- Debouncing/batching: ~150 lines
- Configuration: ~200 lines
- CLI/daemon: ~300 lines

This is a good ratio -- the libraries handle the well-solved problems (text diffing, API access, file watching) while we build the novel part (the bidirectional sync logic between markdown files and a REST API).
