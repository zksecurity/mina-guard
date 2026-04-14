#!/bin/bash
# MinaGuard Main Branch Deployment
#
# Usage:
#   ./deploy.sh up      — deploy main branch (force-recreates containers for fresh lightnet chain)
#   ./deploy.sh reset   — wipe volumes and redeploy (used by the 3-day bloat-cleanup cron)
#   ./deploy.sh down    — teardown deployment
#
# Expects to be run from the repo root directory.

set -euo pipefail

COMMAND="${1:-}"
PORT=10000
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
          \"@id\": \"app-main\",
          \"group\": \"${group}\",
          \"match\": [{\"path\": [\"/app\", \"/app/*\"]}],
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
        echo "Caddy route added: /app/ → localhost:${PORT}"
    else
        echo "ERROR: Failed to add Caddy route (HTTP ${status})"
        exit 1
    fi
}

remove_caddy_route() {
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
        "${CADDY_API}/id/app-main")

    if [ "$status" = "200" ]; then
        echo "Caddy route removed for /app"
    elif [ "$status" = "404" ]; then
        echo "No Caddy route found for /app"
    else
        echo "ERROR: Failed to remove Caddy route (HTTP ${status})"
        exit 1
    fi
}

case "$COMMAND" in
    reset)
        echo "Wiping volumes for bloat cleanup..."
        docker compose -f deploy/docker-compose.yml -p minaguard down -v --remove-orphans 2>/dev/null || true
        remove_caddy_route 2>/dev/null || true
        ;&
    up)
        echo "Deploying main branch on port ${PORT}..."
        docker compose -f deploy/docker-compose.yml -p minaguard up -d --build --force-recreate --remove-orphans
        add_caddy_route

        echo ""
        echo "Waiting for lightnet to sync (this takes ~90s)..."
        echo ""
        echo "  App:       https://mina-nodes.duckdns.org/app/"
        echo "  API:       https://mina-nodes.duckdns.org/app/health"
        echo "  GraphQL:   https://mina-nodes.duckdns.org/app/graphql"
        echo "  Accounts:  https://mina-nodes.duckdns.org/app/accounts/acquire-account"
        echo "  Explorer:  https://mina-nodes.duckdns.org/app/explorer"
        ;;

    down)
        echo "Tearing down main deployment..."
        docker compose -p minaguard down -v --remove-orphans --rmi local
        remove_caddy_route
        echo "Done."
        ;;

    *)
        echo "Usage: $0 {up|reset|down}"
        exit 1
        ;;
esac
