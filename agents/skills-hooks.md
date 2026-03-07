# Skills & Hooks

## Skills

| Skill | Command | Description |
|-------|---------|-------------|
| `layout` | `/interkasten:layout` | Interactive project discovery, hierarchy, and registration |
| `onboard` | `/interkasten:onboard` | Classification, doc generation, drift baselines, sync |
| `doctor` | `/interkasten:interkasten-doctor` | Self-diagnosis: config, token, MCP, database, sync health |

## Hooks

| Event | Script | Description |
|-------|--------|-------------|
| `Setup` | `setup.sh` | Auto-build MCP server (`npm install && npm run build`) on plugin install |
| `SessionStart` | `session-status.sh` | Print project count, pending WAL entries, unresolved conflicts |
| `Stop` | `session-end-warn.sh` | Warn if pending sync operations exist |
