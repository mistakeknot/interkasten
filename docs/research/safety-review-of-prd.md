# Safety Review: Bidirectional Notion Sync PRD

**Reviewer:** Flux-drive Safety Review Agent
**Date:** 2025-02-15
**PRD:** `docs/prds/2026-02-15-bidirectional-sync.md`
**Bead:** Interkasten-3wh

---

## Executive Summary

**Risk Classification:** High

**Primary Concerns:**
1. **F1 Webhook Receiver** introduces internet-facing attack surface with weak secret validation
2. **F2/F3 Pull Sync** treats Notion content as trusted for local file writes (privilege escalation risk)
3. **F4 Beads Sync** directly reads SQLite without schema stability guarantees (data corruption risk)
4. **Deployment:** No rollback strategy for SQLite schema migrations; webhook tunnel failure degrades silently

**Go/No-Go:** Conditional Go — requires security and deployment hardening before F1 production deployment.

---

## Threat Model

### System Boundaries

- **Local Environment:** Single-user developer workstation, root access, local-only SQLite
- **Network Exposure:** F1 webhook receiver exposed via cloudflared tunnel to internet
- **Trust Boundaries:**
  - **Internet → Webhook Receiver** (untrusted HTTP requests)
  - **Notion API → MCP Server** (Notion content is user-editable, potentially externally shared)
  - **Local Files → Notion** (trusted: user-controlled filesystem)
  - **Beads SQLite → MCP Server** (trusted: same-user filesystem)

### Threat Actors

- **External attacker:** Exploits webhook endpoint or crafts malicious Notion content
- **Malicious collaborator:** Gains Notion page access, injects payloads into synced content
- **Compromised Notion account:** Attacker modifies Notion pages to exploit local sync

### Assets at Risk

1. **Filesystem integrity** — arbitrary file writes via path traversal in Notion content
2. **Credential exposure** — `INTERKASTEN_NOTION_TOKEN` in environment, webhook secret in `~/.interkasten/`
3. **Code execution** — malicious markdown triggers unescaped shell commands (if any tooling auto-processes synced files)
4. **Data corruption** — beads SQLite direct writes without schema versioning or locking
5. **Availability** — webhook DoS, circuit breaker exhaustion, cloudflared tunnel failure

---

## Security Findings

### CRITICAL: F1 Webhook Secret Validation Insufficient

**Risk:** External attacker bypasses webhook secret validation and injects crafted events.

**Details:**
- PRD specifies "32-byte random" secret stored in `~/.interkasten/webhook-secret`
- No specification of:
  - **Comparison method** — if not constant-time, timing attacks leak secret
  - **Secret format** — URL-safe encoding required for Notion webhook config
  - **Secret rotation** — no procedure to invalidate leaked secrets
  - **Rate limiting** — attacker can brute-force short secrets or flood with invalid requests
- Notion webhook secret is **transmitted in plaintext** in webhook subscription UI (HTTPS only, but visible to browser extensions/devtools)

**Impact:** Attacker injects fake webhook events → queue poisoning → MCP server processes attacker-controlled page IDs → pulls malicious Notion content → writes to local filesystem.

**Mitigation:**
1. **Use HMAC-SHA256 signature verification** instead of raw secret comparison:
   - Notion sends `X-Signature` header with HMAC of request body
   - Verify signature using constant-time comparison (`crypto.timingSafeEqual`)
   - Reject requests without valid signature
2. **Implement rate limiting:** Max 100 requests/minute per IP, exponential backoff after 10 failures
3. **Secret rotation support:** `interkasten_rotate_webhook_secret` tool regenerates secret, logs old value for 24h grace period
4. **Log all rejected requests** with IP, timestamp, reason (monitoring for attacks)

**Residual Risk:** Cloudflared tunnel DNS name is public → attacker can enumerate and probe. Mitigation depends on HMAC signature, not URL secrecy.

---

### CRITICAL: F2/F3 Path Traversal in Notion Content

**Risk:** Malicious Notion page title/property triggers arbitrary file write via path traversal.

**Details:**
- PRD does not specify input validation for Notion page titles/properties used to derive local file paths
- Current `entity_map` stores `local_path` as string — if derived from user-controlled Notion title:
  - `../../.ssh/authorized_keys` → write outside project directory
  - Symlink following → overwrite arbitrary files
- F3 three-way merge writes `.conflict` files without path sanitization
- No specification of **allowed file extensions** or **directory allowlist**

**Attack Scenario:**
1. Attacker gains edit access to shared Notion workspace
2. Renames page to `../../../etc/cron.daily/evil.sh`
3. Webhook triggers pull sync
4. MCP server writes attacker-controlled markdown to `/etc/cron.daily/evil.sh`
5. Next cron run executes payload as root

**Impact:** Arbitrary file write → privilege escalation, credential theft, persistence.

**Mitigation:**
1. **Strict path validation:**
   - Resolve `local_path` with `path.resolve(projectRoot, relativePath)`
   - Reject if resolved path is outside `projectRoot` (prefix check AFTER resolution)
   - Reject if path contains `..`, `.git/`, `.ssh/`, `/etc/`, or other sensitive patterns
2. **File extension allowlist:** Only `.md`, `.txt`, `.json`, `.yaml` (configurable)
3. **Symlink protection:** Use `fs.lstat` (not `fs.stat`) to detect symlinks, reject writes to symlinks
4. **Dry-run validation:** New tool `interkasten_validate_pull` previews pull operations without writing
5. **Audit logging:** Log all file writes with Notion page ID, user, timestamp

**Deployment Note:** Existing `entity_map` entries created before mitigation may contain unsafe paths. Run one-time validation script on upgrade.

---

### HIGH: F4 Beads SQLite Direct Read Without Schema Versioning

**Risk:** Beads CLI changes SQLite schema → MCP server reads/writes corrupt data → issue tracker data loss.

**Details:**
- PRD F4 specifies direct reads of `.beads/issues.db` without schema version checks
- Beads is under active development (not 1.0) — schema may change
- No locking coordination between MCP server and `bd` CLI → concurrent write conflicts
- SQLite `PRAGMA user_version` not checked → schema mismatch undetected until crash

**Impact:** Silent data corruption, lost issue updates, sync desynchronization.

**Mitigation:**
1. **Schema version guard:**
   - Read `PRAGMA user_version` from `.beads/issues.db`
   - Maintain compatibility table: `{beads_version: supported_schema_versions}`
   - Reject sync if schema version unsupported, log clear error with upgrade instructions
2. **Use `bd` CLI for all writes:** Never directly `UPDATE issues.db`, use `bd update --status=...`
3. **Read-only mode for direct SQL:** Only `SELECT` queries, never `INSERT/UPDATE/DELETE`
4. **File locking:** Acquire shared lock (`PRAGMA locking_mode=EXCLUSIVE` for reads) to detect concurrent `bd` writes
5. **Diff-based change detection:** Snapshot issue state at sync start, re-read before commit, abort if changed (optimistic concurrency)

**Open Question Resolution:** Answer to PRD Q1 is **"Use bd CLI for writes, direct SQL for reads with version guard."**

---

### HIGH: F3 Merge Conflict File Write Without Sanitization

**Risk:** `.conflict` file creation inherits path traversal vulnerability.

**Details:**
- F3 `conflict-file` strategy creates `<original>.conflict` with both versions
- If `<original>` path is attacker-controlled (see path traversal finding), conflict file is also unsafe
- Example: Notion page renamed to `../../../../tmp/evil` → conflict file writes to `/tmp/evil.conflict`

**Impact:** Arbitrary file write, potential overwrite of lock files, temp files used by other processes.

**Mitigation:**
- **Same path validation as F2:** Validate conflict file path with same rules
- **Atomic write:** Use temp file + rename to prevent partial writes
- **Permissions:** Create conflict files with `0600` (owner-read-write only)

---

### MEDIUM: F1 Webhook Event Queue Poisoning

**Risk:** Attacker floods webhook endpoint → SQLite `webhook_events` table exhausts disk space → DoS.

**Details:**
- No specified size limit for `webhook_events` table
- No TTL for old events (processed or failed)
- No deduplication → same page edit triggers multiple webhook deliveries (Notion batches rapidly)

**Impact:** Disk exhaustion, MCP server crash, sync halt.

**Mitigation:**
1. **Event retention policy:** Auto-delete events older than 7 days
2. **Table size cap:** Max 10,000 events, FIFO eviction (drop oldest unprocessed)
3. **Deduplication:** Upsert on `(page_id, last_edited_time)` — only store latest version per page
4. **Circuit breaker:** If queue size > 1000, reject new webhook requests with 429 (rate limit)

---

### MEDIUM: F2 Frontmatter Injection via Notion Properties

**Risk:** Malicious Notion property values inject YAML into local file frontmatter → code execution if frontmatter is parsed by unsafe tooling.

**Details:**
- PRD F2 specifies "frontmatter preserved on pull"
- Notion properties (tags, status, custom fields) may be synced into frontmatter YAML
- YAML parsers have RCE history (e.g., `!!python/object/apply` in PyYAML)
- If interkasten uses `yaml.load()` (unsafe) instead of `yaml.safeLoad()`, attacker-controlled properties → RCE

**Attack Scenario:**
1. Attacker adds Notion property with YAML payload
2. Pull sync writes frontmatter with attacker payload
3. Next time interkasten parses file (or user's static site generator), YAML parsing triggers code execution

**Impact:** Remote code execution.

**Mitigation:**
1. **Use safe YAML parser:** `yaml` package with `{ json: true }` schema (no custom tags)
2. **Escape special characters:** Sanitize Notion property values before embedding in frontmatter
3. **Frontmatter schema validation:** Use Zod schema to validate frontmatter structure, reject unexpected keys
4. **Principle of least surprise:** Do NOT auto-sync arbitrary Notion properties to frontmatter — only explicitly configured fields

**Current Code Check Required:** Verify `server/src/sync/` uses safe YAML parsing.

---

### MEDIUM: Credential Exposure in Environment and Filesystem

**Risk:** `INTERKASTEN_NOTION_TOKEN` and webhook secret leaked via process listing, logs, or filesystem access.

**Details:**
- Token stored in environment variable → visible in `/proc/<pid>/environ` (other users can read)
- Webhook secret stored in plaintext file `~/.interkasten/webhook-secret` (mode 0644 by default)
- MCP server runs as `claude-user` → same group as other agents (interlock, interfluence)
- If any agent compromised, attacker pivots via shared environment

**Impact:** Notion workspace compromise, webhook spoofing.

**Mitigation:**
1. **Webhook secret permissions:** `chmod 0600 ~/.interkasten/webhook-secret` on creation
2. **Token storage:** Move to `~/.interkasten/token.enc` with XOR obfuscation (not encryption, just plaintext hiding)
3. **Avoid logging secrets:** Redact token/secret in all logs and error messages
4. **Environment hardening:** Document that `INTERKASTEN_NOTION_TOKEN` should be session-scoped, not global shell export
5. **Secret scanning:** Add pre-commit hook to detect token patterns in git history

**Residual Risk:** Root user can still read all secrets. Acceptable for single-user dev workstation threat model.

---

### LOW: F1 Cloudflared Tunnel DNS Takeover

**Risk:** Attacker hijacks cloudflared tunnel DNS name if not properly authenticated.

**Details:**
- PRD specifies "Cloudflare-managed subdomain" via `cloudflared tunnel route dns`
- If Cloudflare account credentials leak, attacker can re-route tunnel to their own endpoint
- Mitigation is operational (Cloudflare account security), not code-level

**Impact:** Webhook events redirected to attacker → attacker learns workspace activity.

**Mitigation:**
1. **Document Cloudflare account security requirements:** 2FA, API token rotation
2. **Tunnel verification:** MCP tool `interkasten_webhook_status` includes tunnel DNS name + last verified timestamp
3. **Health check:** Periodically POST test event to own webhook, verify receipt (detect DNS hijack)

---

### LOW: F3 Diff Library Vulnerability (Supply Chain)

**Risk:** Malicious version of `node-diff3` or `diff-match-patch-es` introduced via dependency confusion or compromised npm account.

**Details:**
- F3 adds two new dependencies for merge logic
- No specified package integrity checks (lockfile, SRI)
- Dependency runs with full MCP server privileges

**Impact:** Supply chain attack → arbitrary code execution.

**Mitigation:**
1. **Package lockfile:** Commit `package-lock.json`, use `npm ci` in CI/CD
2. **Audit dependencies:** `npm audit` in CI, auto-PR for security updates
3. **Pin versions:** Lock major/minor versions in `package.json`, review changelogs before upgrades
4. **Minimal dependencies:** Evaluate if `node-diff3` can be replaced with simpler line-based diff (less attack surface)

---

## Deployment & Migration Risks

### CRITICAL: SQLite Schema Migration Without Rollback

**Risk:** New tables (`webhook_events`, beads issue state cache) added without downgrade path → rollback to old version breaks.

**Details:**
- F1 adds `webhook_events` table, F4 adds issue state tracking tables
- No specified migration tooling (Drizzle ORM supports migrations but PRD doesn't mandate usage)
- If F1 deployed → user hits bug → rolls back → old MCP server crashes on unknown table

**Impact:** Sync service unavailable, requires manual SQLite surgery to recover.

**Mitigation:**
1. **Schema versioning:** Use Drizzle migrations with `PRAGMA user_version` increments
2. **Rollback procedure documented:**
   - To roll back F1: `sqlite3 ~/.interkasten/store.db "DROP TABLE IF EXISTS webhook_events;"`
   - To roll back F4: `sqlite3 ~/.interkasten/store.db "DROP TABLE IF EXISTS beads_issue_state;"`
   - Update version: `PRAGMA user_version = <prev>;`
3. **Migration smoke tests:** Integration test that runs old version after new migration → verifies backward compat
4. **Startup version check:** MCP server refuses to start if schema version > supported version (fail fast)

**Pre-Deploy Checklist:**
- [ ] Backup `~/.interkasten/store.db` before upgrade
- [ ] Test rollback procedure on dev machine
- [ ] Document schema version <-> plugin version mapping

---

### HIGH: F1 Webhook Receiver Restart Loop

**Risk:** Systemd service crashes on startup → restart loop → systemd gives up (5 failures) → no webhook processing.

**Details:**
- PRD specifies auto-restart but not restart limits or failure logging
- Common failure modes:
  - Port 7339 already in use (previous instance hung)
  - Cloudflared binary missing or tunnel config invalid
  - SQLite database locked by another process
  - Permissions on `~/.interkasten/` directories

**Impact:** Webhook events dropped, sync lag until manual intervention.

**Mitigation:**
1. **Systemd unit hardening:**
   ```ini
   [Service]
   Restart=on-failure
   RestartSec=10s
   StartLimitBurst=5
   StartLimitIntervalSec=300
   ```
2. **Pre-flight checks in startup script:**
   - Verify port available: `netstat -tuln | grep 7339`
   - Verify cloudflared installed: `which cloudflared`
   - Verify database accessible: `sqlite3 ~/.interkasten/store.db "PRAGMA quick_check;"`
   - Fail early with clear error message
3. **Health endpoint:** HTTP `/health` returns 200 if service is functional (systemd can poll)
4. **Dead letter queue:** Failed webhook events logged to separate file for manual replay

**Monitoring:**
- Systemd journal alerts on "StartLimitHit" (restart loop detected)
- Daily cron job checks `systemctl status interkasten-webhook`, emails if failed

---

### HIGH: F2 Polling Interval DoS

**Risk:** 60-second polling with 100+ projects → rate limit Notion API → circuit breaker opens → no sync.

**Details:**
- Notion API rate limit: 3 requests/second average (documented)
- PRD polling every 60s for all projects → if 200 projects, 200 API calls in <60s → ~3.3 req/sec → at limit
- Webhook events add burst traffic
- Circuit breaker opens after N failures → polling stops

**Impact:** Sync lag, circuit breaker exhaustion, user frustration.

**Mitigation:**
1. **Adaptive polling:** Increase interval if API rate limit hit (exponential backoff: 60s → 120s → 240s)
2. **Per-project jitter:** Randomize polling offset to spread load (not all projects polled at :00 second)
3. **Webhook prioritization:** Process webhook events first, skip polling for those projects
4. **Polling budget:** Max 100 API calls per polling cycle, defer remaining projects to next cycle
5. **Circuit breaker tuning:** Require 5 consecutive failures before opening (not 1-2)

**Config:**
```yaml
sync:
  poll_interval: 60  # seconds
  max_api_calls_per_cycle: 100
  circuit_breaker:
    failure_threshold: 5
    recovery_timeout: 300
```

---

### MEDIUM: F4 Beads Sync Desynchronization

**Risk:** Concurrent updates (local via `bd`, remote via Notion) → last-write-wins → lost updates.

**Details:**
- PRD F4 specifies "last-write-wins" for property conflicts (status, priority)
- No vector clocks or causal ordering → concurrent edits detected but resolution is arbitrary
- User changes status to "in_progress" locally, collaborator closes issue in Notion → one side loses

**Impact:** User confusion, lost work, trust erosion.

**Mitigation:**
1. **Conflict notification:** Log WARN when last-write-wins applied, include both values
2. **MCP tool `interkasten_conflicts`:** List recent LWW resolutions for user review
3. **Notion timestamp columns:** Store `local_updated_at` and `notion_updated_at` in Issues DB → user can see divergence
4. **Future enhancement:** Operational transform or CRDT for property merging (defer to F5+)

**Documentation:**
- Add to interkasten README: "F4 issue sync uses last-write-wins for property conflicts. Avoid concurrent edits to the same issue."

---

### MEDIUM: F3 Merge Result Validation Gap

**Risk:** Three-way merge produces malformed markdown → breaks downstream tooling.

**Details:**
- PRD does not specify post-merge validation
- Malformed merge output examples:
  - Duplicate YAML frontmatter delimiters (`---`)
  - Broken markdown links `[text](url`
  - Unclosed code fences ` ``` `
- Downstream tools (static site generators, interdoc) fail on malformed markdown

**Impact:** Broken documentation build, sync loop (engine re-pulls malformed content).

**Mitigation:**
1. **Post-merge validation:**
   - Parse frontmatter YAML → validate structure
   - Count markdown fence pairs (` ``` `) → must be even
   - Count bracket pairs `[]()` → must balance
2. **Validation failure handling:**
   - Log error with merge details
   - Apply `conflict-file` fallback (both versions preserved)
   - Set Notion status `⚠️ Merge Failed`
3. **Integration test:** Test suite includes malformed base/local/remote → verifies validation catches

---

### LOW: F5 Soft-Delete 7-Day Window

**Risk:** User deletes sensitive file locally → 7 days until Notion page hard-deleted → exposure window.

**Details:**
- PRD F5 specifies 7-day grace period before hard-delete
- Notion page remains accessible to collaborators during grace period
- If file contained secrets, they persist in Notion

**Impact:** Information disclosure.

**Mitigation:**
1. **Configurable retention:** Allow `soft_delete_retention: 0` for immediate hard-delete (opt-in)
2. **Sensitive file patterns:** Config option `sensitive_paths: [".env", "credentials/*"]` → force immediate delete
3. **Delete confirmation:** MCP tool `interkasten_sync` with `--confirm-deletes` flag, lists files to be deleted
4. **Notion page archival:** Use Notion archive API (preserves history) instead of delete during grace period

---

## Risk Prioritization

### Must-Fix Before Production (F1 Deployment)

1. **CRITICAL:** F1 webhook HMAC signature verification (not raw secret)
2. **CRITICAL:** F2 path traversal validation (allowlist + prefix check)
3. **CRITICAL:** SQLite schema migration + rollback procedure documented
4. **HIGH:** F4 beads schema version guard (schema compatibility check)
5. **HIGH:** F1 webhook systemd unit hardening (restart limits, health checks)

### Must-Fix Before F2/F3 Production

6. **HIGH:** F3 conflict file path validation (inherit F2 path rules)
7. **MEDIUM:** F2 frontmatter injection (safe YAML parsing)
8. **MEDIUM:** F3 merge result validation (malformed markdown detection)

### Must-Fix Before F4 Production

9. **HIGH:** F4 beads concurrent write coordination (use bd CLI)
10. **MEDIUM:** F4 conflict notification (LWW logging)

### Recommended (Harden Over Time)

11. **MEDIUM:** F1 webhook event queue limits (DoS prevention)
12. **MEDIUM:** Credential storage (file permissions, obfuscation)
13. **MEDIUM:** F2 polling adaptive backoff (rate limit resilience)
14. **LOW:** F3 diff library auditing (supply chain)
15. **LOW:** F5 sensitive file immediate delete (configurable)

---

## Rollback Strategy

### Pre-Deployment Snapshot

1. **Backup SQLite:** `cp ~/.interkasten/store.db ~/.interkasten/store.db.pre-f1`
2. **Backup config:** `cp ~/.interkasten/config.yaml ~/.interkasten/config.yaml.pre-f1`
3. **Git tag:** `git tag interkasten-pre-f1 && git push --tags`

### Rollback Procedure

#### Rollback F1 (Webhook Receiver)

```bash
# Stop webhook service
systemctl stop interkasten-webhook

# Revert to previous plugin version
cd ~/.claude/plugins/cache/interkasten-*
git checkout <prev-tag>
npm install && npm run build

# Drop new tables
sqlite3 ~/.interkasten/store.db "DROP TABLE IF EXISTS webhook_events;"
sqlite3 ~/.interkasten/store.db "PRAGMA user_version = <prev>;"

# Restart MCP server (session restart)
```

**Compatibility:** Old MCP server ignores F1 config keys (graceful degradation).

#### Rollback F2/F3 (Pull Sync + Merge)

```bash
# Disable pull sync
sqlite3 ~/.interkasten/store.db "UPDATE entity_map SET sync_direction='push' WHERE sync_direction='bidirectional';"

# Revert plugin (same as F1)
```

**Data Preservation:** Local files modified by pull sync are NOT auto-reverted → manual `git checkout` required.

#### Rollback F4 (Beads Sync)

```bash
# Stop beads sync
sqlite3 ~/.interkasten/store.db "DELETE FROM entity_map WHERE entity_type='issue';"
sqlite3 ~/.interkasten/store.db "DROP TABLE IF EXISTS beads_issue_state;"

# Revert plugin
```

**Irreversibility:** Notion Issues database pages remain (soft-deleted, not hard-deleted).

---

## Post-Deploy Verification

### F1 Verification Checklist

- [ ] Systemd service running: `systemctl status interkasten-webhook`
- [ ] Tunnel URL accessible: `curl https://<tunnel>.trycloudflare.com/health`
- [ ] Webhook secret file permissions: `ls -l ~/.interkasten/webhook-secret` (should be `-rw-------`)
- [ ] Event queue empty: `sqlite3 ~/.interkasten/store.db "SELECT COUNT(*) FROM webhook_events;"`
- [ ] Circuit breaker closed: Call `interkasten_webhook_status`, verify `circuit_breaker: "closed"`

### F2/F3 Verification Checklist

- [ ] Pull sync completes without errors: `interkasten_sync direction=pull`
- [ ] No files written outside project root: `find ~ -name "*.md" -newer /tmp/deploy-start` (check paths)
- [ ] Merge conflict creates `.conflict` file: Manually edit Notion + local, verify conflict handling
- [ ] Frontmatter preserved: Verify local YAML frontmatter not overwritten by Notion content

### F4 Verification Checklist

- [ ] Notion Issues database created: Check Notion workspace for new DB
- [ ] Beads issue synced: `bd show <id>`, verify Notion page link in output
- [ ] Property mapping correct: Change status in Notion → verify `bd show` reflects change
- [ ] No SQLite lock errors: Run `bd update` and `interkasten_sync` concurrently

---

## Unknowns Requiring User Input

1. **Cloudflare account access:** Does user have Cloudflare account with API token? Tunnel provisioning requires auth.
2. **Notion workspace permissions:** Is Notion integration token scoped to all relevant pages? Shared workspace may have permission boundaries.
3. **Beads schema stability commitment:** Is beads SQLite schema considered stable, or should F4 be deferred until beads 1.0?
4. **Webhook secret rotation frequency:** How often should webhook secret rotate? (Recommendation: 90 days)
5. **Acceptable sync lag:** Is 60-second polling + webhook delay acceptable, or is <10s required? (Impacts polling strategy)

---

## Architecture Review Notes

### Strengths

- **Graceful degradation:** Webhook failure falls back to polling (good resilience)
- **Circuit breaker:** Prevents API rate limit exhaustion
- **WAL protocol:** Crash recovery prevents partial writes
- **Agent-native design:** Tools expose primitives, skills orchestrate (good separation)

### Weaknesses

- **Notion as trust boundary not recognized:** PRD treats Notion content as safe, but it's user-editable and potentially externally shared
- **No input validation specification:** Path traversal, YAML injection, SQL injection risks not addressed
- **No rollback strategy:** Schema migrations add irreversible state
- **No monitoring/alerting:** Circuit breaker opens silently, webhook failures invisible until user notices lag

### Recommended Enhancements (Future)

1. **Dry-run mode:** All sync operations support `--dry-run` flag (preview without writes)
2. **Sync audit log:** Separate SQLite table for all file writes (who, when, what, why)
3. **Permission model:** Config option to restrict sync to specific Notion users (block external collaborators)
4. **Webhook replay:** Manual tool to replay failed/dropped webhook events from dead letter queue
5. **Health dashboard:** Web UI showing sync status, circuit breaker state, recent errors (interline integration?)

---

## Conclusion

**Recommendation:** Conditional Go

**Rationale:** PRD is architecturally sound but underspecifies security boundaries and deployment safety. The webhook receiver (F1) introduces internet-facing attack surface without adequate input validation or signature verification. Pull sync (F2/F3) treats Notion content as trusted, creating path traversal and injection risks. Beads sync (F4) lacks schema stability guarantees. SQLite migrations have no documented rollback procedure.

**Required Actions:**
1. Implement HMAC signature verification for F1 webhook receiver
2. Add strict path validation for F2 pull sync (allowlist + prefix check + symlink protection)
3. Add schema version guard for F4 beads sync (reject unsupported schema versions)
4. Document SQLite migration rollback procedures
5. Add systemd unit hardening for F1 (restart limits, health checks, dead letter queue)

**Timeline Impact:** +2-3 days of hardening work before F1 production deployment. F2-F5 can proceed in parallel with lower risk (no internet exposure).

**Monitoring Requirements:**
- Systemd journal alerts on webhook service failures
- Daily cron job checks circuit breaker state
- Weekly review of sync error logs and conflict resolutions

**Sign-Off Criteria:**
- All CRITICAL and HIGH findings mitigated
- Rollback procedure tested on dev machine
- Security checklist in deployment runbook
- Post-deploy verification script passes
