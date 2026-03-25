#!/usr/bin/env bash
set -euo pipefail

# Apply Caddy routes via admin API.
# Idempotent — safe to run multiple times.
# Called by caddy-routes.service on boot.

CADDY_ADMIN="http://localhost:2019"
MAX_RETRIES=30
RETRY_DELAY=2

# Wait for Caddy admin API to be available
for i in $(seq 1 $MAX_RETRIES); do
  if curl -sf "$CADDY_ADMIN/config/" > /dev/null 2>&1; then
    break
  fi
  echo "Waiting for Caddy admin API... ($i/$MAX_RETRIES)"
  sleep $RETRY_DELAY
done

existing=$(curl -s "$CADDY_ADMIN/config/apps/http/servers/srv0/routes" 2>/dev/null || echo "[]")

add_route_if_missing() {
  local host="$1"
  local json="$2"
  if echo "$existing" | grep -q "$host"; then
    echo "Route $host already exists"
  else
    curl -sf -X POST "$CADDY_ADMIN/config/apps/http/servers/srv0/routes" \
      -H "Content-Type: application/json" \
      -d "$json"
    echo "Route $host added"
  fi
}

# --- webhook.meadowsyn.com → localhost:8787 ---
add_route_if_missing "webhook.meadowsyn.com" '{
  "handle": [{
    "handler": "subroute",
    "routes": [{
      "handle": [{
        "handler": "reverse_proxy",
        "upstreams": [{"dial": "localhost:8787"}]
      }]
    }]
  }],
  "match": [{"host": ["webhook.meadowsyn.com"]}],
  "terminal": true
}'

# --- stream.meadowsyn.com → localhost:8401 (SSE factory-stream) ---
add_route_if_missing "stream.meadowsyn.com" '{
  "match": [{"host": ["stream.meadowsyn.com"]}],
  "handle": [
    {
      "handler": "headers",
      "response": {
        "set": {
          "X-Accel-Buffering": ["no"]
        }
      }
    },
    {
      "handler": "reverse_proxy",
      "upstreams": [{"dial": "localhost:8401"}],
      "flush_interval": -1
    }
  ],
  "terminal": true
}'
