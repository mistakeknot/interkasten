#!/usr/bin/env bash
set -euo pipefail

# Apply Caddy routes via the admin API.
#
# IDEMPOTENT BY CONVERGENCE, NOT BY SKIPPING.
#
# This script used to decide with `echo "$existing" | grep -q "$host"` over the
# whole live route JSON. That produced three defects, all proven on zklw on
# 2026-08-03 rather than argued:
#
#   1. a route edited live was never corrected -- the host was present, so it
#      skipped
#   2. a host removed from this file kept serving forever -- nothing deleted it,
#      and after a restart nothing would recreate it either
#   3. a host that is a SUBSTRING of a live host was never created AT ALL: the
#      grep matched `alpha.scratch.invalid` when asked for `scratch.invalid`,
#      skipped, and exited 0
#
# Defect 3 is why the fix is not a better existence test. A unit that exits 0
# having applied nothing is invisible to every check on this estate that reads
# exit codes, and the message it printed ("already exists") actively misleads.
#
# The declarations below are now the whole truth about what this owner serves.
# caddy-converge.py makes the live table match them and then READS IT BACK, so a
# zero exit means these routes are serving -- not merely that a request returned
# 200. Deleting a block here removes that route from the server on the next run.
#
# The `interkasten-` @id prefix is the ownership bound: convergence may create,
# correct and delete routes under it, and touches nothing else -- not the
# Caddyfile's routes, not the other generator's, not one added by hand.
#
# Called by caddy-routes.service on boot.

CADDY_ADMIN="${RIG_CADDY_ADMIN:-http://localhost:2019}"
CONVERGE="${CADDY_CONVERGE:-$HOME/.local/bin/caddy-converge.py}"
MAX_RETRIES=30
RETRY_DELAY=2

# A missing converger is a hard failure, not a skipped step. The entire point of
# this rewrite is that the unit must never exit 0 having applied nothing.
if [[ ! -x "$CONVERGE" ]]; then
  echo "caddy-converge.py not executable at $CONVERGE; routes NOT applied" >&2
  exit 1
fi

# Wait for the Caddy admin API to come up. If it never does, convergence exits 3
# (NO VERDICT) rather than claiming success against a server it never reached.
for i in $(seq 1 $MAX_RETRIES); do
  if curl -sf "$CADDY_ADMIN/config/" > /dev/null 2>&1; then
    break
  fi
  echo "Waiting for Caddy admin API... ($i/$MAX_RETRIES)"
  sleep $RETRY_DELAY
done

# --- webhook.meadowsyn.com → localhost:8787 ---
ROUTE_WEBHOOK='{
  "@id": "interkasten-webhook-meadowsyn-com",
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
ROUTE_STREAM='{
  "@id": "interkasten-stream-meadowsyn-com",
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

printf '[%s,%s]' "$ROUTE_WEBHOOK" "$ROUTE_STREAM" | "$CONVERGE" --owner interkasten
