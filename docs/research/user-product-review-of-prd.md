# User & Product Review: Bidirectional Sync PRD

**Bead:** Interkasten-3wh
**Date:** 2026-02-15
**Reviewer:** Flux-drive User & Product Reviewer
**Primary User:** Multi-project indie developer using Claude Code + Notion

---

## Executive Summary

This PRD proposes adding bidirectional sync to interkasten (local ↔ Notion docs and beads ↔ Notion sprint boards). The core product value is strong and well-justified. However, **critical onboarding friction** exists around webhook setup, and **conflict resolution defaults** need clearer user-facing design. The beads sync introduces **mental model complexity** that requires upfront UX design to avoid confusion.

**Recommendation:** Proceed with F2-F5 immediately. Delay F1 (webhook receiver) until **polling proves inadequate** in production use. This reduces launch scope, removes manual setup friction, and delivers 80% of value with 40% of complexity.

---

## Primary User & Job-to-be-Done

**Who:** Multi-project indie developer (3-15 active projects), works solo or 1-3 person team, already uses Notion for planning/notes, Claude Code as primary dev environment.

**Job:** Keep project documentation synchronized between local markdown files (source of truth for dev work) and Notion workspace (collaboration/planning surface) without manual copy-paste or stale docs.

**Current pain:** Edits made in Notion don't flow back to local files. Beads issues aren't visible in Notion. Notion is read-only mirror instead of living collaboration tool.

**Desired outcome:** Edit docs in either location, changes merge automatically. Sprint boards visible in Notion stay in sync with beads tracker.

---

## Product Validation

### Problem Definition: STRONG

Evidence quality: **Direct user request** with clear articulation of pain ("edits made in Notion don't flow back to local files").

Severity: **High** for users who chose Notion as collaboration layer. This is a core product limitation, not a nice-to-have.

User segment: Well-defined (indie devs, small teams, Claude Code + Notion stack). Size unknown but constrained by intersection of Claude Code users who also use Notion.

### Solution Fit: MOSTLY STRONG, ONE WEAK SPOT

**F2-F5 (Pull sync, merge, beads sync, polish):** Direct solutions to stated problem. Three-way merge is correct technical approach. Beads → Notion sprint boards addresses visibility gap.

**F1 (Webhook receiver):** WEAK FIT for stated problem. Webhooks reduce latency from ~60s to ~instant, but **adds significant onboarding friction** (manual Notion integration UI step, cloudflared tunnel config, systemd service management). The PRD acknowledges this ("requires a one-time manual step") but doesn't adequately weigh the **adoption cost** against the **marginal latency benefit**.

**Alternative:** Start with polling-only (60s is fast enough for doc sync workflows), validate demand for <10s sync before adding webhook complexity. Webhooks can be added later as an opt-in performance feature.

### Scope Creep Check: CLEAN

Non-goals section correctly excludes doc generation (interpath), staleness monitoring (interwatch), research triage (interject), pagent workflow engine (deferred). Each exclusion has clear ownership elsewhere in Interverse ecosystem.

Beads sync is in scope and appropriate — it's a new sync domain within interkasten's existing "keep local state and Notion in sync" charter.

### Opportunity Cost

PRD does not compare against **known higher-priority work**. Based on roadmap.md, the 0.3.x series focuses on "stabilization and reliability" and "triage depth." Bidirectional sync is a 0.4.0+ feature based on maturity.

**Question:** Is bidirectional sync more valuable than "stronger observability signals for drift" or "formalize error taxonomies" from roadmap? PRD should justify priority ordering.

---

## User Experience Review

### Onboarding Flow (F1 Webhook Setup)

**Critical UX problem:** Webhook setup requires:
1. User installs plugin
2. User runs setup (provisions tunnel, generates secret)
3. **User manually opens Notion integration settings UI**
4. **User copies tunnel URL from terminal output**
5. **User creates webhook subscription in Notion UI**
6. Sync becomes active

**Failure modes:**
- User forgets step 3-5 → sync works (polling) but user expects instant sync → confusion
- User makes typo in URL → events go nowhere, no error feedback
- Tunnel URL changes (rare but possible) → user must re-configure Notion
- User doesn't understand "webhook" terminology → abandons setup

**Recommendation:**
- **Ship polling-only for v1.** 60-second sync interval is acceptable for doc editing workflows (not real-time collab).
- Add webhook support in **v2 as opt-in feature** with in-app setup wizard that:
  - Opens Notion integration settings automatically (if Notion API supports it)
  - Shows copy-pasteable URL + secret in terminal with clear instructions
  - Validates webhook is working before completing setup
  - Provides troubleshooting link if events don't arrive within 5 minutes

**Evidence gap:** No user research validates that <10s sync latency is required. Assumption-based, not data-backed.

### Conflict Resolution Strategy (F3)

**Good:** Conflict strategies are configurable (`three-way-merge`, `local-wins`, `notion-wins`, `conflict-file`, `ask`).

**Missing:** **No UI/UX design for how user discovers, understands, and changes these settings.**

**Questions:**
- Where does user see current conflict strategy? (MCP tool output? Config file?)
- How does user know a conflict occurred? (Sync log only? Notion status property? Local notification?)
- When `ask` strategy is used, what does "⚠️ Conflict status property in Notion" look like? Is it actionable?
- What happens to `conflict-file` artifacts? Do they auto-delete after resolution? Do they clutter the workspace?

**Recommendations:**
- Default to `local-wins` (simpler mental model: "local is truth, Notion is mirror with edit-back capability").
- Show conflict count in `/interkasten:doctor` output and session start hook.
- Add MCP tool `interkasten_list_conflicts` → returns files with unresolved conflicts + strategy used.
- `ask` strategy should create a **Notion comment** on the conflicted page with both versions + link to local file, not just a status flag.

### Beads ↔ Notion Sync (F4)

**Mental model risk:** Users now have **two sync domains with different behavior:**

| Domain | Direction | Conflict Strategy | Primary Truth |
|--------|-----------|-------------------|---------------|
| Docs | Bidirectional | Three-way merge | Depends on edit location |
| Issues | Bidirectional | Property = last-write-wins, notes = three-way merge | Beads tracker (assumed) |

**Confusion scenarios:**
- User edits issue notes in Notion, expects three-way merge → sees local-wins behavior → edits lost
- User closes issue in beads, expects Notion status to update instantly → sees 60s delay (polling) → re-closes in Notion → duplicate closure operations
- User creates issue directly in Notion Issues DB → does it sync back to beads? PRD unclear.

**Missing from PRD:**
- Can user create issues in Notion and have them appear in beads tracker?
- If yes, how are beads issue IDs assigned? (Beads controls ID sequence.)
- If no, is the Notion Issues DB read-only from Notion side? (Confusing — looks like editable DB.)
- What happens if user deletes issue in Notion? Soft-delete in beads? Hard-delete?

**Recommendations:**
- **Clarify directionality:** Is beads → Notion one-way (Notion is read-only view), or truly bidirectional?
- If bidirectional: Add `interkasten_create_issue_from_notion` tool that creates beads issue via `bd create` and maps it.
- If one-way: Mark Notion Issues DB as **read-only in Notion** (can't edit properties) to prevent user confusion. Use Notion's database permissions if possible.
- Document issue lifecycle explicitly: creation (where?), updates (which fields?), closure (which side?), deletion (soft vs hard?).

### Soft-Delete Safety (F5)

**Good:** Preserves user work on both sides (local file untouched when Notion deleted, Notion page marked when local deleted).

**Missing:**
- What triggers hard-delete after 7 days? (Automatic background job? Manual cleanup command?)
- Does user get notified before hard-delete? (Email? Notion comment? Sync log entry?)
- Can user undo soft-delete? (Restore from `.deleted` marker? Unarchive Notion page?)

**Recommendation:**
- Add MCP tool `interkasten_list_deleted` → shows soft-deleted entities on both sides.
- Add skill `/interkasten:cleanup` → shows pending hard-deletes, lets user review before confirming.
- Never auto-hard-delete without user confirmation. 7-day window is good, but should require explicit action.

### Linked References (T2 Summary Cards, F5)

**Concept:** Files matched by `scan_files` but not synced as full pages → summary card in Notion with title, path, AI-generated summary, last modified, line count.

**UX concern:** **Unclear when user would use this.** What files belong in T2 vs T1?

**From PRD.md research:**
- T1 = bidirectional sync (PRD, roadmap, architecture, ADRs, changelog)
- T2 = linked references (code files, research notes, meeting logs)

**Problem:** AI-generated summaries for code files are **low value** compared to actual code navigation tools (LSP, grep, IDE). Summary cards add **visual clutter** to Notion workspace without clear job-to-be-done.

**Alternative:** Instead of auto-generating summary cards for all T2 files, let user **explicitly promote files to T2** via MCP tool `interkasten_create_summary_card`. Default is: if not in T1 sync list, it's invisible to Notion.

**Recommendation:**
- Remove auto-summary-card behavior from F5 MVP.
- Add it as **opt-in feature** in follow-up iteration if user requests it.
- Test hypothesis: "Users want read-only code summaries in Notion" before building it.

---

## Flow Analysis

### Happy Path: User Edits Doc in Notion

1. User opens Notion, edits project PRD
2. Webhook fires (if F1 enabled) OR poller detects change (60s)
3. MCP server pulls Notion content → converts to markdown → detects local file unchanged since last sync
4. Writes to local file, updates base content hash
5. User sees updated file in editor (if auto-refresh enabled) or on next file open

**Missing states:**
- What if user has **uncommitted local edits** to same file? Git workspace is dirty, not yet pushed.
- Does sync overwrite working copy? (Bad: loses work.) Does it skip sync? (Bad: divergence grows.)
- **Recommendation:** Check git status before overwriting. If file is modified in git workspace, use `conflict-file` strategy even if config says `notion-wins`.

### Error Path: Three-Way Merge Fails

1. Both sides edit same paragraph
2. Merge library produces conflict markers `<<<<<<< HEAD`
3. Configured fallback strategy applies (default: local-wins)
4. Notion version preserved in page history, local version wins
5. Sync log records conflict

**Missing:**
- **No notification to user that conflict occurred.** Silent merge is dangerous.
- **Recommendation:** Add session start hook message if conflicts exist: "⚠️ 3 sync conflicts detected. Run /interkasten:conflicts to review."

### Edge Case: Beads Issue Deleted in Notion

1. User archives issue page in Notion
2. Webhook/poller detects deletion
3. Sync engine marks entity as deleted in entity_map
4. Local beads issue **untouched** (per soft-delete spec)
5. **User opens `bd ready`** → sees issue that's "deleted" in Notion → confusion

**Recommendation:**
- Beads doesn't have native "archived" state, only open/closed.
- Option A: Map Notion archive → `bd close <id>` (safe, reversible).
- Option B: Add `.interkasten-deleted` flag file in `.beads/` for soft-deleted issues, filter from `bd ready` output.
- **PRD must specify** which option.

### Recovery Path: User Wants to Undo Notion Edit

1. User edits doc in Notion, realizes mistake
2. Sync already pulled change to local file
3. User wants to revert to previous version

**Available paths:**
- Git history (if committed before sync)
- Notion page history (always available)
- **Not available:** Undo button in interkasten

**Recommendation:**
- Document this in user guide: "Interkasten sync is not a version control system. Use git for local history, Notion page history for remote."
- Consider adding `interkasten_rollback` tool in future iteration (restores from sync_log + base_content).

---

## User Impact Assessment

### Value Proposition Clarity

**Current:** "Complete interkasten's bidirectional sync: pull Notion changes to local files, merge when both sides change, sync beads issues to Notion sprint boards."

**Clearer:** "Edit project docs in Notion or locally — changes merge automatically. See beads sprint boards in Notion without leaving your workspace."

**For user-facing docs:** Lead with **outcome** (edit anywhere, stay in sync), not **mechanism** (pull, merge, sync).

### Time-to-Value

**Fast path (doc sync only, polling):**
1. Install plugin (~2 min)
2. Run `/interkasten:layout` to register projects (~5 min)
3. Edit doc in Notion → wait 60s → see change locally

**Total:** <10 minutes to first "aha" moment. **Good.**

**Slow path (webhook + beads sync):**
1. Install plugin
2. Run setup wizard (tunnel provisioning, ~3 min)
3. **Open Notion integration settings** (context switch, ~2 min)
4. **Copy-paste URL + create webhook subscription** (~2 min, error-prone)
5. Run `/interkasten:layout` (~5 min)
6. **Verify beads → Notion mapping** (unknown time, PRD doesn't specify UX)
7. Edit doc/issue → see sync

**Total:** 15-20 minutes, with **manual steps** that can fail. **Risky for adoption.**

**Recommendation:** Ship polling-only for v1, add webhooks as opt-in power-user feature in v2.

### User Segmentation

| Segment | Value | Adoption Barrier |
|---------|-------|------------------|
| Solo dev, Notion-first planning | **High** — enables Notion as collaboration surface | Webhook setup friction (if F1) |
| Solo dev, local-first docs | **Low** — doesn't use Notion for editing | N/A (won't adopt) |
| Team (2-3 people), shared Notion | **Very High** — collaborative doc editing | Webhook setup + conflict resolution education |
| Team (5+ people), enterprise Notion | **Blocked** — PRD excludes enterprise RBAC | N/A (out of scope) |

**Conversion assumption:** PRD assumes "multi-project indie developer" is primary user, but **collaborative editing** is highest value for **teams**. These are different segments with different needs.

**Evidence gap:** Which segment is larger? Which generates more revenue/retention? PRD doesn't address.

### Discoverability

**How user learns about bidirectional sync:**
- Plugin README (assumes user reads before installing)
- Session start hook message (if already configured)
- `/interkasten:doctor` output (reactive, not proactive)

**Missing:**
- Onboarding wizard that explains sync model
- In-app tutorial or demo video
- Clear visual indicator in Notion that page is synced (badge? icon? property?)

**Recommendation:**
- Add session start hook (first run only): "Interkasten now supports bidirectional sync. Edit docs in Notion or locally — changes merge automatically. Run /interkasten:onboard to set up."
- Add Notion page property "🔄 Synced" (yes/no) so user knows which pages are two-way.

---

## Design & Terminology Concerns

### "Three-Way Merge" is Developer Jargon

**User-facing language should be:**
- "Combines changes from both sides automatically"
- "Merges your Notion edits with local changes"

**Not:**
- "Three-way merge with diff3 algorithm"
- "Base version comparison"

**PRD uses correct technical terms internally (good for implementation).** Must translate for user docs.

### "Conflict Strategy" is Configuration, Not User Choice

Users don't want to **choose a strategy upfront**. They want **good defaults** that work 95% of the time, with escape hatch for the other 5%.

**Better UX:**
- Default to `three-way-merge` with `local-wins` fallback (no config required).
- When conflict detected, show **notification** with options: "Keep local version," "Use Notion version," "Edit manually."
- Let user set **per-file** or **per-project** strategy, not global config.

**Current PRD:** Global `sync.conflict_strategy` in config file. **Inflexible.**

### "Beads" is Unfamiliar Outside Interverse Ecosystem

Notion users won't know what "beads tracker" means. User-facing language should say:
- "Local issue tracker" or "project issues"
- "Sprint board sync"

**Not:**
- "Beads ↔ Notion sync"

---

## Missing Success Metrics

PRD does not define **how to measure success** post-launch. Proposed metrics:

| Metric | Target | Signal |
|--------|--------|--------|
| Adoption rate | >30% of interkasten users enable bidirectional sync | Feature usage logs |
| Conflict rate | <5% of syncs result in conflicts | Sync log analysis |
| User-initiated rollbacks | <2% of syncs are manually reverted | MCP tool usage (if rollback tool exists) |
| Webhook setup completion | >80% of users who start setup finish it | Setup funnel analytics |
| Beads sync usage | >50% of users with beads tracker enable Notion issues | Feature flag logs |

**Without metrics, can't validate assumptions or iterate based on data.**

---

## Open Questions Requiring User Research

1. **Sync latency requirement:** Is 60s polling acceptable, or do users need <10s webhook sync?
2. **Conflict frequency:** In practice, how often do users edit same doc in both places within sync window?
3. **Beads directionality:** Do users want to create issues in Notion, or just view beads issues there?
4. **T2 summary cards:** Do users want auto-generated code summaries in Notion, or is this noise?
5. **Webhook setup friction:** What % of users abandon setup at manual Notion integration step?

**Recommendation:** Ship polling-only MVP, instrument it, answer questions 1-4 with real usage data before building F1.

---

## Priority Recommendations

### SHIP IMMEDIATELY (High Value, Low Risk)

**F2: Polling + Pull Sync**
- 60s polling is good enough for doc workflows
- No manual setup steps
- Delivers 80% of user value

**F3: Three-Way Merge**
- Core conflict resolution capability
- Default to `local-wins` (simpler)
- Add user notification on conflict

**F5 (Partial): Soft-Delete Safety**
- Prevents accidental data loss
- Remove auto-hard-delete (manual cleanup only)

### DEFER TO V2 (High Complexity, Unvalidated Value)

**F1: Webhook Receiver**
- Adds systemd service, cloudflared tunnel, manual Notion UI step
- Benefit: 60s → <10s latency (marginal for doc editing)
- **Wait until polling proves inadequate** based on user feedback

**F4: Beads ↔ Notion Sync**
- Introduces second sync domain with different mental model
- Requires UX design for directionality, lifecycle, conflict handling
- **Clarify requirements** before implementation (one-way vs bidirectional?)

**F5 (Partial): T2 Summary Cards**
- Low-value feature (AI summaries of code files)
- **Test hypothesis with user research** before building

### FOUNDATIONAL WORK (Required for Any Bidirectional Sync)

1. **Conflict notification UX** — session hook message, MCP tool to list conflicts
2. **Git workspace awareness** — check dirty files before overwriting
3. **Documentation** — sync model explanation, conflict resolution guide, terminology glossary
4. **Success metrics** — instrument sync operations for post-launch analysis

---

## Risk Assessment

### Adoption Risks

**High Risk:**
- Webhook setup abandonment (F1) → users expect instant sync, get 60s polling, perceive as broken
- Conflict resolution confusion → users lose edits, blame tool

**Medium Risk:**
- Beads sync mental model mismatch → users expect Notion Issues DB to be editable, it's not (or vice versa)
- T2 summary cards clutter Notion workspace → users disable feature

**Low Risk:**
- Polling performance (60s is acceptable for stated use case)

### Data Loss Risks

**Mitigated:**
- Three-way merge preserves both versions (Notion page history + local git)
- Soft-delete prevents accidental permanent deletion

**Unmitigated:**
- Silent conflict resolution (if user isn't notified)
- Overwriting uncommitted local changes (if git workspace check missing)

**Recommendation:** Add explicit safety checks before any destructive operation.

---

## Final Recommendations

### For Product Team

1. **Remove F1 (webhooks) from v1 scope.** Ship polling-only, add webhooks in v2 if users request lower latency.
2. **Clarify F4 (beads sync) directionality.** Is Notion Issues DB read-only view or bidirectional? Document lifecycle explicitly.
3. **Remove F5 T2 summary cards from MVP.** Add as opt-in feature after validating user demand.
4. **Define success metrics** for post-launch evaluation.

### For UX Team (Missing from PRD)

1. Design conflict notification flow (where user sees conflicts, how they resolve).
2. Design first-run onboarding for bidirectional sync (explains model, sets expectations).
3. Design Notion → beads issue creation flow (if bidirectional).
4. Design soft-delete cleanup UI (review before hard-delete).

### For Documentation Team

1. Write user guide: "How Bidirectional Sync Works" (avoid jargon, show examples).
2. Write troubleshooting guide: "My Changes Didn't Sync" (common failure modes).
3. Write video tutorial: "Edit Docs in Notion and Locally" (3-5 min demo).

### For Implementation Team

1. Add git workspace dirty check before overwriting files.
2. Add conflict detection → session hook notification.
3. Add MCP tools: `list_conflicts`, `list_deleted`, cleanup command.
4. Instrument sync operations for metrics (log conflicts, errors, latencies).

---

## Conclusion

**Core product direction: STRONG.** Bidirectional sync solves real user pain for Notion + Claude Code users.

**Execution risk: MEDIUM.** Webhook setup friction (F1) and beads sync complexity (F4) create adoption/confusion risks.

**Recommended path:** Ship F2-F3 + partial F5 (no webhooks, no beads, no T2 cards) as **v1 MVP**. Validate with real usage data. Add deferred features in v2 based on user feedback, not assumptions.

**Key missing work:** Conflict notification UX, git workspace safety checks, success metrics, user documentation.

**Estimated time-to-value (simplified v1):** <10 minutes from install to first successful bidirectional sync. **Good enough to ship.**
