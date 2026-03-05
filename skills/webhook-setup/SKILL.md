---
description: "Webhook Setup — Configure Notion webhook sync"
---

# interkasten:webhook-setup — Webhook Setup

Guide the user through configuring Notion webhook-driven sync for interkasten, including deployment path selection, config writing, and step-by-step external service setup.

## Trigger

Use when: user says "set up webhooks", "configure webhook sync", "interkasten webhook setup", "set up Notion webhooks", or invokes `/interkasten:webhook-setup`.

## Workflow

### Phase 1: Check Current Status

Call `interkasten_config_get` with key `sync.webhook` to see if webhooks are already configured.

- **Already configured**: Show current settings (port, path, deployment mode) and ask if the user wants to reconfigure or just see the setup guide.
- **Not configured**: Proceed to Phase 2.

### Phase 2: Choose Deployment Path

Ask the user which deployment path to use (use `AskUserQuestion`):

1. **Cloudflare Tunnel (Recommended)** — Secure tunnel from Cloudflare to your local machine. No port forwarding, free tier available. Best for most setups.
2. **Direct URL** — Server has a public IP or is behind a reverse proxy (nginx, caddy). Requires HTTPS and open port.
3. **Cloud Bridge** — Poll-based relay for NAT-restricted networks. No inbound connections needed. Best for development or restricted environments.

### Phase 3: Gather Configuration

Based on the deployment path, ask for additional details:

**All paths:**
- Port (default: 8787)
- Webhook URL path (default: `/webhooks/notion`)
- Webhook signing secret (optional — leave blank for auto-detect from Notion verification handshake)

**Cloud Bridge only (additional):**
- Cloud bridge relay URL
- Cloud bridge auth token
- Poll interval in ms (default: 5000)
- Batch size (default: 50)

Use `AskUserQuestion` to gather these. Offer sensible defaults — most users should just accept them.

### Phase 4: Write Configuration

Call `interkasten_config_set` for each value:

```
interkasten_config_set key="sync.webhook.enabled" value=true
interkasten_config_set key="sync.webhook.port" value=<port>
interkasten_config_set key="sync.webhook.path" value=<path>
interkasten_config_set key="sync.webhook.secret" value=<secret>  (if provided)
```

For cloud bridge deployments, also set:
```
interkasten_config_set key="sync.cloud_bridge.url" value=<url>
interkasten_config_set key="sync.cloud_bridge.token" value=<token>
interkasten_config_set key="sync.cloud_bridge.poll_ms" value=<poll_ms>
interkasten_config_set key="sync.cloud_bridge.batch_size" value=<batch_size>
```

### Phase 5: Display Setup Guide

Run the CLI guide command to display deployment-specific instructions:

```bash
cd <interkasten-server-dir> && node dist/cli/webhook-setup.js guide --deployment <path> --port <port> --path <webhookPath>
```

This prints markdown with:
- Notion integration creation steps (all paths)
- Deployment-specific setup (Cloudflare Tunnel / Direct URL / Cloud Bridge)
- Webhook registration with Notion
- Next steps checklist

Present the output to the user. The guide contains clickable links to Notion and Cloudflare documentation.

### Phase 6: Verify

After the user confirms they've completed the external setup steps, run a quick verification:

1. Call `interkasten_config_get` to confirm config was written
2. Check if `INTERKASTEN_NOTION_TOKEN` is set (from `interkasten_health` if available)
3. Report status summary

## Output Format

Present configuration results as a summary:

```
Webhook Configuration Complete

  Deployment:  cloudflare
  Port:        8787
  Path:        /webhooks/notion
  Secret:      auto-detect

Next: Follow the setup guide above, then start the daemon with `npm start`.
```

## Error Handling

- If `interkasten_config_set` fails, report the error and suggest checking file permissions on `~/.interkasten/config.yaml`
- If the MCP server is not available, fall back to running the CLI directly:
  ```bash
  cd server && node dist/cli/webhook-setup.js configure --deployment <path> --port <port>
  ```
- If the user doesn't know their deployment path, recommend Cloudflare Tunnel as the default
