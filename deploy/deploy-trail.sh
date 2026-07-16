#!/bin/bash
# MinaGuard Mesa Trail Deployment
#
# Usage:
#   ./deploy-trail.sh up      — deploy the trail (Mesa Trail / mesa-mut) compose project
#   ./deploy-trail.sh down    — teardown (wipes the app DB volume — see comment on `down -v` below)
#
# Runs on the prod-facing box alongside /app/* (localnet, `deploy.sh`) and
# the PR previews (`preview-env/preview.sh`). All three patterns use the
# same host Caddy admin API on localhost:2019 to dynamically add/remove
# reverse-proxy routes, and each deploys to a separate per-project host
# port (main=10000, previews=1000N, trail=10001).
#
# Cross-host dependency: the application stack here reaches the Mina node
# stack on $MESA_NODE_HOST (daemon GraphQL :3085, archive-node-api :8282,
# read-only archive postgres :5433). Before bringing this up, confirm the
# node-stack box's Hetzner Cloud Firewall allows inbound 3085/8282/5433
# from this server's public IP only. Do NOT rely on host ufw for this:
# Docker publishes ports through its own iptables chains, which bypass ufw
# entirely — a ufw rule looks right but enforces nothing. Setup details
# in the ops repo: mina-guard-ops/architecture.md §3.
#
# MESA_NODE_HOST is required — fill in deploy/.env (see deploy/.env.example)
# or `export MESA_NODE_HOST=...` in the deploying shell before invoking this
# script. There is no default — `docker compose up` fails fast if unset.
#
# Expects to be run from the repo root directory.

set -euo pipefail

# Pull deploy-time config from deploy/.env if present (gitignored). Then
# enforce MESA_NODE_HOST is set so the failure is loud here, not buried
# in docker compose's parser later.
if [ -f deploy/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . deploy/.env
  set +a
fi
: "${MESA_NODE_HOST:?MESA_NODE_HOST must be set in deploy/.env (see deploy/.env.example) or exported in the shell}"
: "${ARCHIVE_DB_PASSWORD:?ARCHIVE_DB_PASSWORD must be set in deploy/.env (see deploy/.env.example) or exported in the shell — read-only role on the node-stack archive postgres}"

# The MinaGuard VK hash is a property of the contract source, not deploy-time
# config — it's committed at contracts/.vk-hash. Read it from there (stripping
# the comment header) unless explicitly overridden in the environment. The
# backend image takes it as a build arg; the indexer filters events by it.
if [ -z "${MINAGUARD_VK_HASH:-}" ] && [ -f contracts/.vk-hash ]; then
  # trail is a testnet deploy; read-vk-hash.sh is the single validated parser
  # for the keyed .vk-hash (testnet=… / mainnet=…).
  MINAGUARD_VK_HASH=$(contracts/scripts/read-vk-hash.sh testnet) || exit 1
  export MINAGUARD_VK_HASH
fi
# A pre-set MINAGUARD_VK_HASH bypasses the helper's validation; still reject
# empty/garbage and allow the explicit "skip" opt-out (indexer accepts all).
case "${MINAGUARD_VK_HASH:-}" in
  skip) ;;
  ''|*[!0-9]*) echo "MINAGUARD_VK_HASH must be a decimal hash or 'skip' (got '${MINAGUARD_VK_HASH:-}')" >&2; exit 1 ;;
esac

COMMAND="${1:-}"
PORT=10001
CADDY_API="http://localhost:2019"
ROUTES_PATH="apps/http/servers/srv0/routes/0/handle/0/routes"

add_caddy_route() {
    remove_caddy_route 2>/dev/null || true

    local group
    group=$(curl -s "${CADDY_API}/config/${ROUTES_PATH}/0" | python3 -c "import sys,json; print(json.load(sys.stdin).get('group','group0'))" 2>/dev/null || echo "group0")

    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
        -H "Content-Type: application/json" \
        -d "{
          \"@id\": \"trail-main\",
          \"group\": \"${group}\",
          \"match\": [{\"path\": [\"/trail\", \"/trail/*\"]}],
          \"handle\": [{
            \"handler\": \"subroute\",
            \"routes\": [{
              \"handle\": [
                {
                  \"handler\": \"headers\",
                  \"response\": {
                    \"set\": {
                      \"Cross-Origin-Opener-Policy\": [\"same-origin\"],
                      \"Cross-Origin-Embedder-Policy\": [\"credentialless\"]
                    }
                  }
                },
                {
                  \"handler\": \"reverse_proxy\",
                  \"headers\": {
                    \"response\": {
                      \"delete\": [\"Cross-Origin-Opener-Policy\", \"Cross-Origin-Embedder-Policy\"]
                    }
                  },
                  \"upstreams\": [{\"dial\": \"localhost:${PORT}\"}]
                }
              ]
            }]
          }]
        }" \
        "${CADDY_API}/config/${ROUTES_PATH}")

    if [ "$status" = "200" ]; then
        echo "Caddy route added: /trail/ → localhost:${PORT}"
    else
        echo "ERROR: Failed to add Caddy route (HTTP ${status})"
        exit 1
    fi
}

remove_caddy_route() {
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
        "${CADDY_API}/id/trail-main")

    if [ "$status" = "200" ]; then
        echo "Caddy route removed for /trail"
    elif [ "$status" = "404" ]; then
        echo "No Caddy route found for /trail"
    else
        echo "ERROR: Failed to remove Caddy route (HTTP ${status})"
        exit 1
    fi
}

case "$COMMAND" in
    up)
        echo "Deploying trail (Mesa Trail) on port ${PORT}..."
        docker compose -f deploy/docker-compose.trail.yml -p minaguard-trail up -d --build --remove-orphans
        add_caddy_route

        echo ""
        echo "  App:       https://mina-nodes.duckdns.org/trail/"
        echo "  Health:    https://mina-nodes.duckdns.org/trail/health"
        echo "  GraphQL:   https://mina-nodes.duckdns.org/trail/graphql"
        echo "  Archive:   https://mina-nodes.duckdns.org/trail/archive"
        ;;

    down)
        echo "Tearing down trail deployment..."
        # `-v` wipes the minaguard-trail-db volume. Rationale: during active
        # contract development the VK hash changes per PR merge, and the
        # indexer filters discovery by VK hash — so on every deploy the
        # previously-indexed Contract rows point at vk-hash-mismatched
        # addresses that the new indexer would skip anyway. Preserving them
        # would just leave dead rows in the DB and waste tick cycles on
        # rescanUnreadyContracts for contracts nobody can interact with.
        # Same applies to the new archive_discovered_height cursor — stale
        # high-water mark, no longer matches the current VK's deploy heights.
        # When the contract stabilizes, drop the `-v` to get persistence.
        docker compose -f deploy/docker-compose.trail.yml -p minaguard-trail down -v --remove-orphans --rmi local
        remove_caddy_route
        echo "Done."
        ;;

    *)
        echo "Usage: $0 {up|down}"
        exit 1
        ;;
esac
