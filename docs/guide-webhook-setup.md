# Webhook Setup Guide

Event-driven sync between Notion and your local filesystem. When you edit a page in Notion, interkasten receives a webhook event and pulls the change within seconds — no polling delay.

## Overview

```
Notion ──webhook──→ [your public endpoint] ──→ interkasten daemon ──→ local files
```

Three deployment options:

| Path | Best for | Requires |
|------|----------|----------|
| **Cloudflare Tunnel** (recommended) | Most setups | Free Cloudflare account + domain |
| **Direct URL** | Servers with public IP | HTTPS + open port or reverse proxy |
| **Cloud Bridge** | Dev machines / NAT | Deploy a Cloudflare Worker relay |

All paths share the same Notion integration setup (Part 1) and differ only in how your machine becomes reachable from the internet.

---

## Part 1: Create a Notion Integration

Every deployment path starts here.

### 1.1 Open the Integrations Page

Go to **[notion.so/my-integrations](https://www.notion.so/my-integrations)** in your browser.

You'll see the "My integrations" dashboard. If this is your first integration, it will be empty.

### 1.2 Create a New Integration

1. Click the **"+ New integration"** button (top-left area of the dashboard)
2. Fill in the form:
   - **Name**: `interkasten` (or any name you'll recognize)
   - **Logo**: Optional — skip this
   - **Associated workspace**: Select the workspace you want to sync from the dropdown
3. Click **"Submit"**

You'll land on the integration's settings page. It has several tabs along the top: **Secrets**, **Capabilities**, **Distribution**, **Webhooks**, etc.

### 1.3 Configure Capabilities

Click the **"Capabilities"** tab.

Under **Content Capabilities**, enable all three:

- [x] **Read content**
- [x] **Update content**
- [x] **Insert content**

Under **User Capabilities**, optionally enable:

- [x] **Read user information including email addresses** — enables author attribution in synced documents

Click **"Save changes"** at the bottom of the page.

### 1.4 Copy the Integration Secret

Click the **"Secrets"** tab.

You'll see **"Internal Integration Secret"** with a partially hidden value. Click **"Show"** (or the **"•••"** button) to reveal the full token. It starts with `ntn_`.

Copy it and set it in your shell environment:

```bash
export INTERKASTEN_NOTION_TOKEN="ntn_..."
```

> **Tip:** Add this line to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.) so it persists across terminal sessions.

### 1.5 Share Pages with Your Integration

Notion integrations can only access pages **explicitly shared** with them.

For each page or database you want to sync:

1. Open the page in Notion
2. Click the **"•••"** menu (top-right corner)
3. Scroll down to **"Connections"**
4. Click **"Connect to"** and search for `interkasten`
5. Click your integration name to grant access
6. Click **"Confirm"** in the dialog

A small icon appears in the page header confirming the connection.

> **Tip:** Sharing a parent page automatically shares all child pages. You can share at the top-level workspace page to sync everything.

See Notion's guide: [Add and manage connections with the API](https://www.notion.so/help/add-and-manage-connections-with-the-api)

---

## Part 2: Choose a Deployment Path

### Option A: Cloudflare Tunnel (Recommended)

Cloudflare Tunnel creates an encrypted connection from Cloudflare's edge network to your local machine. No port forwarding, no firewall changes, free tier available.

#### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- A domain added to Cloudflare (you need DNS management through Cloudflare)

#### A.1 Install cloudflared

See the [official downloads page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for all platforms.

**macOS:**
```bash
brew install cloudflared
```

**Linux (Debian/Ubuntu):**
```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
```

Verify:
```bash
cloudflared --version
```

#### A.2 Authenticate

```bash
cloudflared tunnel login
```

This opens your browser to the Cloudflare dashboard. Select the domain you want to use and click **"Authorize"**.

On success you'll see in the terminal:
```
You have successfully logged in.
```

A certificate is saved to `~/.cloudflared/cert.pem`.

#### A.3 Create a Tunnel

```bash
cloudflared tunnel create interkasten
```

Output:
```
Created tunnel interkasten with id abcd1234-5678-90ef-...
```

**Save the tunnel ID** — you'll need it for the next two steps.

#### A.4 Route DNS

```bash
cloudflared tunnel route dns <TUNNEL_ID> interkasten-webhook.yourdomain.com
```

Replace `<TUNNEL_ID>` with the ID from step A.3, and `yourdomain.com` with your actual domain.

This creates a CNAME record automatically. You can verify it in the Cloudflare dashboard under **DNS → Records**.

#### A.5 Create Config File

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: ~/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: interkasten-webhook.yourdomain.com
    service: http://localhost:8787
  - service: http_status:404
```

The credentials JSON file was created automatically in step A.3. The catch-all `http_status:404` rule at the end is required by cloudflared.

See the [config file reference](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/#4-create-a-configuration-file).

#### A.6 Start the Tunnel

```bash
cloudflared tunnel run interkasten
```

Expected output:
```
INF Starting tunnel  tunnelID=abcd1234-5678-...
INF Connection registered  connIndex=0 ...
```

Your webhook URL is:
```
https://interkasten-webhook.yourdomain.com/webhooks/notion
```

Leave cloudflared running — it must stay active to receive webhooks. For production, consider [running it as a system service](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/as-a-service/).

---

### Option B: Direct URL

Use this if your server already has a public IP or is behind a reverse proxy.

#### Prerequisites

- A publicly reachable HTTPS endpoint (Notion rejects plain HTTP)
- Valid TLS certificate (Let's Encrypt, etc.)

#### B.1 Configure Your Reverse Proxy

If using **nginx**, add a location block that forwards to interkasten:

```nginx
server {
    listen 443 ssl;
    server_name webhooks.yourserver.com;
    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location /webhooks/notion {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

If using **Caddy**, it handles TLS automatically:

```
webhooks.yourserver.com {
    reverse_proxy /webhooks/notion localhost:8787
}
```

Your webhook URL is:
```
https://webhooks.yourserver.com/webhooks/notion
```

---

### Option C: Cloud Bridge

Cloud Bridge mode polls a cloud relay instead of receiving webhooks directly. Your machine never exposes a port — ideal for development, NAT-restricted networks, or firewalled environments.

#### How It Works

```
Notion ──webhook──→ Cloudflare Worker (relay) ──stores──→ Durable Object queue
                                                              ↑
interkasten daemon ──polls──→ Cloudflare Worker ──leases──→ events
                   ←──acks───┘
```

1. You deploy a Cloudflare Worker that receives Notion webhooks
2. The Worker stores events in a durable queue
3. Your local interkasten daemon polls the Worker for new events
4. Events are acknowledged after processing (lease-based, at-least-once delivery)

#### C.1 Deploy the Relay

See the [Cloud Bridge deployment guide](https://github.com/mistakeknot/interkasten/blob/main/docs/cloud-bridge.md) for the Worker template and deployment instructions.

#### C.2 Configure interkasten

```bash
node dist/cli/webhook-setup.js configure --deployment bridge \
  --cloud-bridge-url https://bridge.yourdomain.com \
  --cloud-bridge-token <your-token>
```

Or set values individually:

```bash
interkasten_config_set key="sync.cloud_bridge.url" value="https://bridge.yourdomain.com"
interkasten_config_set key="sync.cloud_bridge.token" value="<your-token>"
interkasten_config_set key="sync.cloud_bridge.poll_ms" value=5000
interkasten_config_set key="sync.cloud_bridge.batch_size" value=50
```

---

## Part 3: Register the Webhook with Notion

> **Skip this part if using Cloud Bridge** — the relay handles webhook registration.

### 3.1 Start interkasten First

```bash
npm start
```

**The daemon must be running before you register the webhook.** Notion sends a verification request immediately upon subscription creation, and your server must respond to it.

### 3.2 Open Your Integration Settings

Go to **[notion.so/my-integrations](https://www.notion.so/my-integrations)** and click on your integration name (`interkasten`).

### 3.3 Create a Webhook Subscription

1. Click the **"Webhooks"** tab at the top of the integration page
2. Click the **"+ Create a subscription"** button
3. In the form:
   - **URL**: Enter your public webhook URL (from Part 2):
     ```
     https://interkasten-webhook.yourdomain.com/webhooks/notion
     ```
   - **Events**: Select the events to receive. Recommended:
     - [x] `page.content_updated`
     - [x] `page.properties_updated`
     - [x] `page.created`
     - [x] `page.moved`
     - [ ] `page.deleted` — optional, enable for soft-delete tracking
     - [ ] `page.locked` — optional
4. Click **"Create subscription"**

### 3.4 Complete the Verification Handshake

Notion's webhook verification is a **two-phase process**:

**Phase 1 (automatic):** When you create the subscription, Notion immediately sends a POST request to your URL containing a `verification_token` field. interkasten handles this automatically. Check your server logs for:

```
Received webhook verification token
```

**Phase 2 (manual):** Back in the Notion integration UI, you'll see a **warning icon (⚠️)** next to your new subscription. Click the **"Verify"** button, enter the verification token if prompted, and click **"Verify subscription"**.

Once verified, the subscription status changes to **Active** and events start flowing.

> **Note:** The `verification_token` doubles as the HMAC signing key for the `X-Notion-Signature` header on all subsequent deliveries. interkasten stores it automatically during the verification handshake — you don't need to configure it manually.

See the [Notion Webhook API reference](https://developers.notion.com/reference/webhooks) for payload format details.

---

## Part 4: Configure interkasten

### Using the CLI

```bash
# Cloudflare Tunnel
node dist/cli/webhook-setup.js configure --deployment cloudflare --port 8787

# Direct URL
node dist/cli/webhook-setup.js configure --deployment direct --port 8787

# Cloud Bridge
node dist/cli/webhook-setup.js configure --deployment bridge \
  --cloud-bridge-url https://bridge.yourdomain.com \
  --cloud-bridge-token <token>
```

### Using the Skill (in Claude Code)

```
/interkasten:webhook-setup
```

The skill walks you through the same steps interactively.

### Using MCP Tools Directly

```
interkasten_config_set key="sync.webhook.enabled" value=true
interkasten_config_set key="sync.webhook.port" value=8787
interkasten_config_set key="sync.webhook.path" value="/webhooks/notion"
```

### Checking Status

```bash
node dist/cli/webhook-setup.js status
```

Or:
```
interkasten_config_get key="sync.webhook"
```

---

## Part 5: Startup & Verification

### Startup Checklist

**Cloudflare Tunnel:**
1. Set `INTERKASTEN_NOTION_TOKEN` in your environment
2. Start cloudflared: `cloudflared tunnel run interkasten`
3. Start the daemon: `npm start`
4. Register the webhook (one-time, see Part 3)

**Direct URL:**
1. Set `INTERKASTEN_NOTION_TOKEN` in your environment
2. Ensure your reverse proxy is running with valid TLS
3. Start the daemon: `npm start`
4. Register the webhook (one-time, see Part 3)

**Cloud Bridge:**
1. Set `INTERKASTEN_NOTION_TOKEN` in your environment
2. Start the daemon: `npm start` — bridge polling starts automatically

### Verifying It Works

1. Edit a Notion page that's shared with your integration
2. Watch the interkasten server logs — you should see:
   ```
   Webhook received: page.content_updated for <page-id>
   Queued: remote_entity_pull <page-id>
   Pull complete: <page-title>.md
   ```
3. Check the local file — it should reflect the Notion change

### Shadow Mode (Dry Run)

To test without writing any changes to Notion or local files:

```bash
interkasten_config_set key="sync.shadow_mode" value=true
```

Or in `~/.interkasten/config.yaml`:
```yaml
sync:
  shadow_mode: true
```

The daemon will log what it *would* do without actually modifying anything.

---

## Troubleshooting

### Webhook not receiving events

| Symptom | Cause | Fix |
|---------|-------|-----|
| No events at all | Webhook not verified | Complete the two-phase verification (Part 3.4) |
| Events received but pages not syncing | Pages not shared with integration | Share pages (Part 1.5) |
| `502 Bad Gateway` in Notion webhook logs | Daemon not running | Start the daemon before registering |
| `Connection refused` | Tunnel/proxy not running | Start cloudflared or check reverse proxy |
| Events delayed by 60s+ | Batch window too large | Lower `sync.webhook.batch_window_ms` |

### Cloudflare Tunnel issues

| Symptom | Fix |
|---------|-----|
| `ERR Cannot determine default origin` | Check `~/.cloudflared/config.yml` exists and has correct `ingress` |
| `ERR Register tunnel error` | Run `cloudflared tunnel login` again — certificate may have expired |
| DNS not resolving | Verify CNAME in Cloudflare dashboard → DNS → Records |

### Verification handshake fails

1. Ensure the daemon is running **before** creating the subscription
2. Check server logs for the verification token receipt
3. If the subscription shows as "Failed", delete it and create a new one
4. Ensure your endpoint is reachable from the internet (test with `curl` from an external machine)

### Token issues

```bash
# Check if token is set
echo $INTERKASTEN_NOTION_TOKEN

# Test the token works
curl -H "Authorization: Bearer $INTERKASTEN_NOTION_TOKEN" \
     -H "Notion-Version: 2022-06-28" \
     https://api.notion.com/v1/users/me
```

You should see your integration's bot user info in the response.

---

## Architecture

```
                                    ┌─────────────────────┐
                                    │   Notion Workspace   │
                                    └─────────┬───────────┘
                                              │ webhook POST
                                              ▼
                              ┌───────────────────────────────┐
                              │  Public Endpoint               │
                              │  (Cloudflare / Direct / Relay) │
                              └───────────────┬───────────────┘
                                              │
                                              ▼
                              ┌───────────────────────────────┐
                              │  Webhook Server (HTTP)         │
                              │  - Signature verification      │
                              │  - Scope evaluation            │
                              │  - Batch windowing             │
                              └───────────────┬───────────────┘
                                              │ enqueue
                                              ▼
                              ┌───────────────────────────────┐
                              │  Durable Queue (queue.db)      │
                              │  - Deduplication               │
                              │  - Retry with backoff          │
                              │  - Dead-letter after 5 fails   │
                              └───────────────┬───────────────┘
                                              │ claim + process
                                              ▼
                              ┌───────────────────────────────┐
                              │  Sync Engine                   │
                              │  - Three-way merge             │
                              │  - WAL protocol                │
                              │  - Asset localization          │
                              │  - Conflict artifacts          │
                              └───────────────┬───────────────┘
                                              │
                                              ▼
                              ┌───────────────────────────────┐
                              │  Local Filesystem (markdown)   │
                              └───────────────────────────────┘
```

Webhook events flow through a **durable queue** (SQLite-backed) that provides deduplication, retry with exponential backoff, and dead-letter handling. The sync engine processes queue items using the same three-way merge and WAL protocol as polling-based sync — webhooks just provide faster event notification.

Polling (60s interval) continues running as a safety net alongside webhooks. A full reconciliation scan runs every 6 hours by default to catch any missed events.

---

## Configuration Reference

All webhook-related config lives in `~/.interkasten/config.yaml` under the `sync` key:

```yaml
sync:
  # Webhook server
  webhook:
    enabled: true                    # Enable webhook-driven sync
    port: 8787                       # Local HTTP server port
    path: /webhooks/notion           # URL path for webhook endpoint
    secret: ""                       # Signing secret (auto-detected from verification)
    batch_window_ms: 60000           # Batch window for deduplicating rapid changes

  # Cloud bridge (alternative to direct webhooks)
  cloud_bridge:
    url: ""                          # Relay URL (e.g., https://bridge.yourdomain.com)
    token: ""                        # Auth token for the relay
    poll_ms: 5000                    # Poll interval in milliseconds
    batch_size: 50                   # Max events per poll

  # Scoped sync (optional — filter which pages to sync)
  scope_root_ids: []                 # Only sync pages under these Notion page IDs
  scope_exclude_ids: []              # Exclude these page IDs and their children

  # Safety
  shadow_mode: false                 # Dry-run mode — log operations without writing

  # Reconciliation
  reconcile_interval_s: 21600       # Full sync safety net (default: 6 hours)
```
