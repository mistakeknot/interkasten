---
module: Claude Code Plugin System
date: 2026-02-15
problem_type: integration_issue
component: tooling
symptoms:
  - "Plugin not in cache despite being listed in marketplace.json"
  - "claude plugins list does not show the plugin"
  - "Plugin skills, commands, hooks, and MCP tools unavailable"
  - "19/20 marketplace plugins installed, one silently missing"
root_cause: incomplete_setup
resolution_type: config_change
severity: high
tags: [plugin, marketplace, installed-plugins, cache, claude-code, onboarding]
---

# Troubleshooting: New Marketplace Plugin Not Auto-Installed

## Problem

interkasten was listed in the interagency-marketplace catalog and all metadata was correct, but the plugin never loaded — no skills, commands, hooks, or MCP tools available. 19 of 20 marketplace plugins were installed; interkasten was silently missing.

## Environment
- Module: Claude Code Plugin System
- Affected Component: Plugin installation pipeline
- Date: 2026-02-15

## Symptoms
- Plugin not in `~/.claude/plugins/cache/interagency-marketplace/interkasten/`
- `claude plugins list` shows no interkasten entry
- Plugin skills (`/interkasten:doctor`, `/interkasten:layout`) not available
- MCP server (`interkasten`) not started
- No error messages anywhere — silent omission

## What Didn't Work

**Attempted Solution 1:** `claude plugins install https://github.com/mistakeknot/interkasten.git`
- **Why it failed:** Running from inside Claude Code session gets "cannot launch nested session" error. Using `CLAUDECODE=` bypass produced unexpected output (seemed to read the Interverse README instead of installing).

**Attempted Solution 2:** Checking marketplace cache and config for exclusion lists
- **Why it failed:** No exclusion mechanism found. `config.json` has empty `repositories: {}`. The marketplace entry was correct and identical between source and installed copy.

## Solution

The plugin system uses **two separate registries**:

| Registry | Path | Purpose |
|---|---|---|
| `marketplace.json` | `~/.claude/plugins/marketplaces/<name>/.claude-plugin/marketplace.json` | **Catalog** — what's available for install |
| `installed_plugins.json` | `~/.claude/plugins/installed_plugins.json` | **Registry** — what actually loads at startup |

interkasten was in the catalog but not in the registry. Adding a plugin to the marketplace **does not auto-install it** on machines that already have the marketplace configured.

**Fix — two steps:**

```bash
# 1. Clone into cache at the version-named path
git clone --recurse-submodules \
  https://github.com/mistakeknot/interkasten.git \
  ~/.claude/plugins/cache/interagency-marketplace/interkasten/0.3.12

# 2. Set ACLs if running as claude-user
setfacl -R -m u:claude-user:rwX ~/.claude/plugins/cache/interagency-marketplace/interkasten
setfacl -R -m d:u:claude-user:rwX ~/.claude/plugins/cache/interagency-marketplace/interkasten

# 3. Add entry to installed_plugins.json
python3 -c "
import json, datetime
with open('$HOME/.claude/plugins/installed_plugins.json') as f:
    d = json.load(f)
now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
d['plugins']['interkasten@interagency-marketplace'] = [{
    'scope': 'user',
    'installPath': '$HOME/.claude/plugins/cache/interagency-marketplace/interkasten/0.3.12',
    'version': '0.3.12',
    'installedAt': now,
    'lastUpdated': now,
    'gitCommitSha': '$(git -C ~/.claude/plugins/cache/interagency-marketplace/interkasten/0.3.12 rev-parse HEAD)'
}]
with open('$HOME/.claude/plugins/installed_plugins.json', 'w') as f:
    json.dump(d, f, indent=2)
"

# 4. Restart Claude Code to pick up the new plugin
```

## Why This Works

Claude Code's plugin lifecycle has a clear separation:

1. **Marketplace add** (`/plugin marketplace add`) — clones the marketplace repo, discovers all plugin entries, and batch-installs them at that point in time
2. **Plugin updates** — on session start, existing entries in `installed_plugins.json` are checked for version changes and updated
3. **New plugins** — entries added to the marketplace *after* the initial `marketplace add` are discoverable in the catalog but **never auto-installed**

This is by design — auto-installing every new marketplace plugin without user consent would be a security concern. But the failure mode is silent: no warning that new plugins are available, no "1 new plugin available" message.

The fix works because we manually perform both steps that `marketplace add` does automatically for initial plugins: clone into cache + register in `installed_plugins.json`.

## Prevention

1. **After adding a new plugin to interagency-marketplace:** Explicitly install it on all consumer machines:
   ```bash
   claude plugins install <name>@interagency-marketplace
   ```
   Or if running inside Claude Code, manually clone + register as shown above.

2. **Publishing checklist addition:** When adding a new plugin to the marketplace (not just updating), add a step: "Install on local machine: `claude plugins install <name>`"

3. **Diagnostic check:** If a plugin seems missing, check `installed_plugins.json` first:
   ```bash
   python3 -c "import json; d=json.load(open('$HOME/.claude/plugins/installed_plugins.json')); print([k for k in d['plugins'] if 'interagency' in k])"
   ```

## Related Issues

- See also: [marketplace-cached-clone-stale.md](/root/projects/Interverse/plugins/interfluence/docs/solutions/marketplace-cached-clone-stale.md) — stale marketplace cache (different failure: catalog out of date vs plugin not registered)
- See also: [plugin-version-drift-breaks-loading.md](/root/projects/Interverse/plugins/tldr-swinton/docs/solutions/build-errors/plugin-version-drift-breaks-loading.md) — version mismatch between marketplace and plugin.json (different failure: registered but wrong version)
- Together these three docs cover the plugin installation failure trilogy: **not in catalog** (stale cache), **not registered** (this doc), and **registered wrong** (version drift)
