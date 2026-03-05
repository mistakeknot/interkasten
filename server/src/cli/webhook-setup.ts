#!/usr/bin/env node
/**
 * Non-interactive webhook setup CLI for interkasten.
 *
 * Subcommands:
 *   configure   Write webhook config values
 *   guide       Print setup instructions for a deployment path
 *   status      Show current webhook configuration
 *
 * Usage:
 *   node dist/cli/webhook-setup.js configure --deployment cloudflare --port 8787
 *   node dist/cli/webhook-setup.js guide --deployment cloudflare --port 8787
 *   node dist/cli/webhook-setup.js status
 *
 * Designed for both standalone CLI use and invocation from Claude Code skills.
 */

import { loadConfig, setConfigValue } from "../config/loader.js";

// ---------- Arg parsing ----------

interface ConfigureArgs {
  deployment: "cloudflare" | "direct" | "bridge";
  port: number;
  path: string;
  secret: string;
  cloudBridgeUrl: string;
  cloudBridgeToken: string;
  cloudBridgePollMs: number;
  cloudBridgeBatchSize: number;
}

function parseArgs(argv: string[]): {
  command: string;
  args: ConfigureArgs;
} {
  const command = argv[2] || "status";
  const args: ConfigureArgs = {
    deployment: "cloudflare",
    port: 8787,
    path: "/webhooks/notion",
    secret: "",
    cloudBridgeUrl: "",
    cloudBridgeToken: "",
    cloudBridgePollMs: 5000,
    cloudBridgeBatchSize: 50,
  };

  for (let i = 3; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case "--deployment":
        args.deployment = next as ConfigureArgs["deployment"];
        i++;
        break;
      case "--port":
        args.port = parseInt(next, 10);
        i++;
        break;
      case "--path":
        args.path = next;
        i++;
        break;
      case "--secret":
        args.secret = next;
        i++;
        break;
      case "--cloud-bridge-url":
        args.cloudBridgeUrl = next;
        i++;
        break;
      case "--cloud-bridge-token":
        args.cloudBridgeToken = next;
        i++;
        break;
      case "--cloud-bridge-poll-ms":
        args.cloudBridgePollMs = parseInt(next, 10);
        i++;
        break;
      case "--cloud-bridge-batch-size":
        args.cloudBridgeBatchSize = parseInt(next, 10);
        i++;
        break;
    }
  }

  return { command, args };
}

// ---------- Commands ----------

function runConfigure(args: ConfigureArgs): void {
  // Write core webhook config
  setConfigValue("sync.webhook.enabled", true);
  setConfigValue("sync.webhook.port", args.port);
  setConfigValue("sync.webhook.path", args.path);
  if (args.secret) {
    setConfigValue("sync.webhook.secret", args.secret);
  }

  // Write cloud bridge config if applicable
  if (args.deployment === "bridge") {
    if (!args.cloudBridgeUrl || !args.cloudBridgeToken) {
      console.error(
        "Error: --cloud-bridge-url and --cloud-bridge-token required for bridge deployment",
      );
      process.exit(1);
    }
    setConfigValue("sync.cloud_bridge.url", args.cloudBridgeUrl);
    setConfigValue("sync.cloud_bridge.token", args.cloudBridgeToken);
    setConfigValue("sync.cloud_bridge.poll_ms", args.cloudBridgePollMs);
    setConfigValue("sync.cloud_bridge.batch_size", args.cloudBridgeBatchSize);
  }

  // Output summary as structured text
  console.log("webhook_configured=true");
  console.log(`deployment=${args.deployment}`);
  console.log(`port=${args.port}`);
  console.log(`path=${args.path}`);
  console.log(`secret=${args.secret ? "set" : "auto-detect"}`);
  if (args.deployment === "bridge") {
    console.log(`cloud_bridge_url=${args.cloudBridgeUrl}`);
    console.log(`cloud_bridge_poll_ms=${args.cloudBridgePollMs}`);
  }
}

function runGuide(args: ConfigureArgs): void {
  const port = args.port;
  const webhookPath = args.path;

  // Always print Notion integration setup
  console.log(`# Notion Integration Setup

## Step 1: Create a Notion Integration

Open the Notion integrations page in your browser:

    https://www.notion.so/my-integrations

You should see a "My integrations" dashboard. If this is your first integration,
the page will be mostly empty.

1. Click the "+ New integration" button (top-left area)
2. Fill in the form:
   - **Name**: Enter "interkasten" (or any name you'll recognize)
   - **Logo**: Optional — skip this
   - **Associated workspace**: Select the workspace you want to sync from the dropdown
3. Click "Submit" to create the integration

You'll land on the integration's settings page with several tabs:
"Secrets", "Capabilities", "Distribution", etc.

## Step 2: Configure Capabilities

Click the **"Capabilities"** tab (if not already selected).

Under **Content Capabilities**, enable:
  [x] Read content
  [x] Update content
  [x] Insert content

Under **User Capabilities**, optionally enable:
  [x] Read user information including email addresses
  (Enables author attribution in synced documents)

Click **"Save changes"** at the bottom.

## Step 3: Copy the Internal Integration Secret

Click the **"Secrets"** tab at the top of the integration page.

You'll see "Internal Integration Secret" with a partially hidden token.
Click **"Show"** (or the **"•••"** menu) to reveal the full token — it starts with \`ntn_\`.

Copy it and set it in your environment:

    export INTERKASTEN_NOTION_TOKEN="ntn_..."

TIP: Add this to your shell profile (~/.zshrc, ~/.bashrc) so it persists across sessions.

## Step 4: Share Pages/Databases with Your Integration

Your integration can only access pages explicitly shared with it.

For each Notion page or database you want to sync:
1. Open the page in Notion
2. Click the **"•••"** menu (top-right corner of the page)
3. Scroll down to **"Connections"** (near the bottom of the menu)
4. Click **"Connect to"** and search for your integration name ("interkasten")
5. Click your integration to grant access
6. In the confirmation dialog, click **"Confirm"**

You should see a small icon for your integration appear in the page header,
confirming it's connected.

→ Full guide: https://www.notion.so/help/add-and-manage-connections-with-the-api
`);

  // Deployment-specific guide
  switch (args.deployment) {
    case "cloudflare":
      console.log(`# Cloudflare Tunnel Setup (Recommended)

Cloudflare Tunnel (cloudflared) creates an encrypted tunnel from Cloudflare's edge
network to your local machine. No port forwarding or firewall changes needed.

## Step 1: Install cloudflared

→ https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

macOS:
    brew install cloudflared

Linux (Debian/Ubuntu):
    curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
    sudo dpkg -i cloudflared.deb

Verify installation:
    cloudflared --version

## Step 2: Authenticate with Cloudflare

    cloudflared tunnel login

This opens your default browser to the Cloudflare dashboard.
Select the domain you want to use and click **"Authorize"**.

On success, you'll see: "You have successfully logged in" in the terminal.
A certificate is saved to ~/.cloudflared/cert.pem.

## Step 3: Create a tunnel

    cloudflared tunnel create interkasten

Output looks like:
    Created tunnel interkasten with id abcd1234-5678-...

Save the tunnel ID — you'll need it in the next steps.

## Step 4: Route DNS to your tunnel

    cloudflared tunnel route dns <TUNNEL_ID> interkasten-webhook.yourdomain.com

Replace <TUNNEL_ID> with the ID from step 3.
Replace yourdomain.com with your actual Cloudflare-managed domain.

This creates a CNAME record in your Cloudflare DNS automatically.
You can verify it in the Cloudflare dashboard under DNS → Records.

## Step 5: Create tunnel config file

Create the file ~/.cloudflared/config.yml with this content:

    tunnel: <TUNNEL_ID>
    credentials-file: ~/.cloudflared/<TUNNEL_ID>.json
    ingress:
      - hostname: interkasten-webhook.yourdomain.com
        service: http://localhost:${port}
      - service: http_status:404

The credentials file was created automatically in step 3.
The catch-all "http_status:404" at the end is required by cloudflared.

→ Config reference: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/#4-create-a-configuration-file

## Step 6: Test the tunnel

    cloudflared tunnel run interkasten

You should see output like:
    INF Starting tunnel  tunnelID=abcd1234-5678-...
    INF Connection registered  connIndex=0 ...

Your webhook URL will be:
    https://interkasten-webhook.yourdomain.com${webhookPath}

Leave cloudflared running — it must stay active to receive webhooks.
For production, consider running it as a system service:

→ https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/as-a-service/
`);
      break;

    case "direct":
      console.log(`# Direct URL Setup

Your server needs a publicly reachable HTTPS URL for Notion to send webhooks to.
This works if your server has:
  - A public IP address, OR
  - A reverse proxy (nginx, caddy, etc.) with a valid TLS certificate

IMPORTANT: Notion requires HTTPS — plain HTTP will be rejected.

If using a reverse proxy, configure it to forward requests to localhost:${port}.

Example nginx config:
    server {
        listen 443 ssl;
        server_name webhooks.yourserver.com;
        ssl_certificate     /path/to/cert.pem;
        ssl_certificate_key /path/to/key.pem;

        location ${webhookPath} {
            proxy_pass http://127.0.0.1:${port};
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        }
    }

Your webhook URL will be:
    https://yourserver.com${webhookPath}
`);
      break;

    case "bridge":
      console.log(`# Cloud Bridge Setup

Cloud Bridge mode polls a cloud relay (e.g., a Cloudflare Worker) for webhook events
instead of receiving them directly. This avoids exposing any local port — ideal for
development machines, NAT-restricted networks, or environments where inbound
connections are blocked.

How it works:
1. Notion sends webhooks to the cloud relay (a Cloudflare Worker you deploy)
2. The relay stores events in a durable queue
3. Your local interkasten daemon polls the relay for new events
4. Events are acknowledged after processing (lease-based, at-least-once delivery)

→ Deployment guide: https://github.com/mistakeknot/interkasten/blob/main/docs/cloud-bridge.md

After deploying the relay, configure interkasten with:

    node dist/cli/webhook-setup.js configure --deployment bridge \\
      --cloud-bridge-url https://bridge.yourdomain.com \\
      --cloud-bridge-token <your-token>

Or via the skill:
    interkasten_config_set key="sync.cloud_bridge.url" value="https://bridge.yourdomain.com"
    interkasten_config_set key="sync.cloud_bridge.token" value="<your-token>"
`);
      break;
  }

  // Webhook registration guide (not needed for bridge — relay handles this)
  if (args.deployment !== "bridge") {
    console.log(`# Register Webhook with Notion

This is where you tell Notion to send events to your server.

## Step 1: Start interkasten FIRST

    npm start

The daemon MUST be running before you register the webhook.
Notion sends a verification request immediately, and the server must respond.

## Step 2: Open your integration settings

    https://www.notion.so/my-integrations

Click on your integration name ("interkasten") to open its settings.

## Step 3: Create a webhook subscription

Click the **"Webhooks"** tab at the top of the integration page.

Click the **"+ Create a subscription"** button.

In the form that appears:
  - **URL**: Enter your public webhook URL:
    https://<your-domain>${webhookPath}
  - **Events**: Select the events to subscribe to. Recommended:
      [x] page.content_updated
      [x] page.properties_updated
      [x] page.created
      [x] page.moved
      [ ] page.deleted  (optional — enable for soft-delete tracking)
      [ ] page.locked   (optional)

Click **"Create subscription"**.

## Step 4: Verify the webhook (two-phase handshake)

After creating the subscription, Notion sends a POST request to your URL
containing a "verification_token" field. Your interkasten server handles this
automatically — check the server logs for:

    Received webhook verification token

Back in the Notion integration UI, you should see a **warning icon (⚠️)** next
to your subscription. Click **"Verify"**, paste the verification token if prompted,
and click **"Verify subscription"**.

Once verified, the status changes to **"Active"** and events start flowing.

NOTE: The verification_token also serves as the HMAC signing key for the
X-Notion-Signature header on subsequent webhook deliveries. interkasten
stores this automatically during verification.

→ Webhook API reference: https://developers.notion.com/reference/webhooks
`);
  }

  // Next steps
  if (args.deployment === "cloudflare") {
    console.log(`# Startup Checklist

Run these in order:

1. Set your Notion token (if not already in your shell profile):
       export INTERKASTEN_NOTION_TOKEN="ntn_..."

2. Start the Cloudflare tunnel (in a separate terminal or as a service):
       cloudflared tunnel run interkasten

3. Start the interkasten daemon:
       npm start

4. Register the webhook in Notion (see above) — only needed once.

After initial setup, you only need steps 1-3 on restart.`);
  } else if (args.deployment === "direct") {
    console.log(`# Startup Checklist

Run these in order:

1. Set your Notion token (if not already in your shell profile):
       export INTERKASTEN_NOTION_TOKEN="ntn_..."

2. Ensure your reverse proxy / TLS is running and forwarding to port ${port}

3. Start the interkasten daemon:
       npm start

4. Register the webhook in Notion (see above) — only needed once.

After initial setup, you only need steps 1-3 on restart.`);
  } else {
    console.log(`# Startup Checklist

1. Set your Notion token (if not already in your shell profile):
       export INTERKASTEN_NOTION_TOKEN="ntn_..."

2. Start the interkasten daemon:
       npm start

   Cloud bridge polling starts automatically based on your config.
   The relay handles webhook reception — no local port exposure needed.`);
  }

  console.log(`
To enable shadow mode (dry-run, no writes to Notion or local files):
    Set sync.shadow_mode: true in ~/.interkasten/config.yaml
    Or: interkasten_config_set key="sync.shadow_mode" value=true`);
}

function runStatus(): void {
  try {
    const config = loadConfig();
    const webhook = config.sync?.webhook;
    const bridge = config.sync?.cloud_bridge;

    console.log("# Webhook Configuration Status\n");

    console.log(`enabled:     ${webhook?.enabled ?? false}`);
    console.log(`port:        ${webhook?.port ?? 8787}`);
    console.log(`path:        ${webhook?.path ?? "/webhooks/notion"}`);
    console.log(
      `secret:      ${webhook?.secret ? "configured" : "not set (auto-detect)"}`,
    );
    console.log(`batch_ms:    ${webhook?.batch_window_ms ?? 60000}`);
    console.log();

    const hasBridge = !!(bridge?.url && bridge?.token);
    console.log(
      `cloud_bridge:  ${hasBridge ? "configured" : "not configured"}`,
    );
    if (hasBridge) {
      console.log(`  url:         ${bridge!.url}`);
      console.log(`  poll_ms:     ${bridge!.poll_ms}`);
      console.log(`  batch_size:  ${bridge!.batch_size}`);
    }
    console.log();

    const hasToken = !!process.env.INTERKASTEN_NOTION_TOKEN;
    console.log(
      `notion_token:  ${hasToken ? "set in environment" : "NOT SET — export INTERKASTEN_NOTION_TOKEN"}`,
    );
  } catch {
    console.log("No config found at ~/.interkasten/config.yaml");
    console.log('Run "webhook-setup configure" to create one.');
  }
}

// ---------- Main ----------

const { command, args } = parseArgs(process.argv);

switch (command) {
  case "configure":
    runConfigure(args);
    break;
  case "guide":
    runGuide(args);
    break;
  case "status":
    runStatus();
    break;
  case "help":
  default:
    console.log(`interkasten webhook-setup

Commands:
  configure   Write webhook config to ~/.interkasten/config.yaml
  guide       Print setup instructions for a deployment path
  status      Show current webhook configuration
  help        Show this message

Options (for configure and guide):
  --deployment <cloudflare|direct|bridge>   Deployment path (default: cloudflare)
  --port <number>                           Webhook server port (default: 8787)
  --path <string>                           Webhook URL path (default: /webhooks/notion)
  --secret <string>                         Webhook signing secret (default: auto-detect)
  --cloud-bridge-url <url>                  Cloud bridge URL (bridge mode only)
  --cloud-bridge-token <token>              Cloud bridge auth token (bridge mode only)
  --cloud-bridge-poll-ms <number>           Bridge poll interval ms (default: 5000)
  --cloud-bridge-batch-size <number>        Bridge batch size (default: 50)

Examples:
  npm run webhook-setup -- configure --deployment cloudflare --port 8787
  npm run webhook-setup -- guide --deployment cloudflare
  npm run webhook-setup -- status`);
    break;
}
