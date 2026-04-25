#!/bin/bash
# MinaGuard PR Preview Environment Manager
#
# Usage:
#   ./preview.sh up   <pr-number>   — deploy preview for PR
#   ./preview.sh down <pr-number>   — teardown preview for PR
#   ./preview.sh list               — list active previews
#
# Expects to be run from the repo root directory.
# Uses the Caddy admin API (localhost:2019) — no sudo required.

set -euo pipefail

COMMAND="${1:-}"
PR_NUMBER="${2:-}"
BASE_PORT=10000
# Caddy exposes a REST API on localhost:2019 for dynamic config changes.
# We use it to add/remove preview reverse-proxy routes without editing the Caddyfile.
CADDY_API="http://localhost:2019"

# Path to the routes array inside Caddy's JSON config. Caddy converts the Caddyfile
# into a JSON structure in memory. For a Caddyfile like:
#
#   mina-nodes.duckdns.org {        <- apps/http/servers/srv0/routes/0
#     handle /lightnet/graphql {}   <- .../handle/0/routes/0
#     handle /lightnet/archive {}   <- .../handle/0/routes/1
#     ...
#   }
#
# All handle blocks become entries in this routes array. We POST new preview
# routes here and DELETE them by @id when tearing down.
ROUTES_PATH="apps/http/servers/srv0/routes/0/handle/0/routes"

# Validate PR number
if [ -n "$PR_NUMBER" ] && ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
    echo "ERROR: PR number must be a positive integer, got: $PR_NUMBER"
    exit 1
fi

add_caddy_route() {
    local pr=$1
    local port=$2

    # Remove existing route first (idempotent)
    remove_caddy_route "$pr" 2>/dev/null || true

    # Read the group name from the first existing route. Caddy assigns all handle
    # blocks the same group so they're mutually exclusive (only one matches per
    # request, like an if/else chain). We need our preview route in the same group.
    local group
    group=$(curl -s "${CADDY_API}/config/${ROUTES_PATH}/0" | python3 -c "import sys,json; print(json.load(sys.stdin).get('group','group0'))" 2>/dev/null || echo "group0")

    # Build the route JSON:
    #   @id        — label for deletion by ID later (DELETE /id/preview-N)
    #   group      — matches existing routes so only one handle block runs
    #   match      — path with and without trailing slash/subpath
    #   handle     — subroute (equivalent to handle {} in Caddyfile) that:
    #     1. Sets COOP/COEP headers (needed for SharedArrayBuffer / o1js WASM)
    #     2. Strips upstream COOP/COEP from Next.js to prevent duplicates
    #     3. Reverse proxies to the preview's Caddy container port
    local route_json
    route_json=$(cat <<EOJSON
{
  "@id": "preview-${pr}",
  "group": "${group}",
  "match": [{"path": ["/preview/${pr}", "/preview/${pr}/*"]}],
  "handle": [{
    "handler": "subroute",
    "routes": [{
      "handle": [
        {
          "handler": "headers",
          "response": {
            "set": {
              "Cross-Origin-Opener-Policy": ["same-origin"],
              "Cross-Origin-Embedder-Policy": ["credentialless"]
            }
          }
        },
        {
          "handler": "reverse_proxy",
          "headers": {
            "response": {
              "delete": ["Cross-Origin-Opener-Policy", "Cross-Origin-Embedder-Policy"]
            }
          },
          "upstreams": [{"dial": "localhost:${port}"}]
        }
      ]
    }]
  }]
}
EOJSON
)

    # POST appends the route to the end of the routes array. Caddy applies it
    # immediately — no reload needed.
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
        -H "Content-Type: application/json" \
        -d "$route_json" \
        "${CADDY_API}/config/${ROUTES_PATH}")

    if [ "$status" = "200" ]; then
        echo "Caddy route added: /preview/${pr}/ → localhost:${port}"
    else
        echo "ERROR: Failed to add Caddy route (HTTP ${status})"
        exit 1
    fi
}

remove_caddy_route() {
    local pr=$1

    # Delete by the @id we assigned when creating the route
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
        "${CADDY_API}/id/preview-${pr}")

    if [ "$status" = "200" ]; then
        echo "Caddy route removed for PR #${pr}"
    elif [ "$status" = "404" ]; then
        echo "No Caddy route found for PR #${pr}"
    else
        echo "ERROR: Failed to remove Caddy route (HTTP ${status})"
        exit 1
    fi
}

build_services_sequentially() {
    local -a compose_args=("$@")

    for service in backend frontend explorer; do
        echo "Building ${service}..."
        docker compose "${compose_args[@]}" build "$service"
    done
}

case "$COMMAND" in
    up)
        if [ -z "$PR_NUMBER" ]; then
            echo "Usage: $0 up <pr-number>"
            exit 1
        fi

        PREVIEW_PORT=$((BASE_PORT + PR_NUMBER))

        # Check available memory (lightnet needs ~3GB per instance)
        ACTIVE=$(docker compose ls --filter "name=pr-" --format json 2>/dev/null | grep -c "running" || true)
        ACTIVE=${ACTIVE:-0}
        if [ "$ACTIVE" -ge 3 ]; then
            echo "WARNING: $ACTIVE preview environments already running. Server may not have enough memory (30GB total)."
            echo "Consider tearing down unused previews: $0 list"
        fi

        echo "Deploying PR #${PR_NUMBER} preview on port ${PREVIEW_PORT}..."

        export PR_NUMBER PREVIEW_PORT
        build_services_sequentially \
            -f preview-env/docker-compose.preview.yml \
            -p "pr-${PR_NUMBER}"

        docker compose -f preview-env/docker-compose.preview.yml \
            -p "pr-${PR_NUMBER}" \
            up -d --no-build

        # Add route to main Caddy for HTTPS
        add_caddy_route "$PR_NUMBER" "$PREVIEW_PORT"

        echo ""
        echo "Waiting for lightnet to sync (this takes ~90s)..."
        echo "Check status: docker compose -p pr-${PR_NUMBER} logs -f lightnet"
        echo ""
        echo "Preview URL: https://mina-nodes.duckdns.org/preview/${PR_NUMBER}/"
        echo ""
        echo "  Frontend:  https://mina-nodes.duckdns.org/preview/${PR_NUMBER}/"
        echo "  API:       https://mina-nodes.duckdns.org/preview/${PR_NUMBER}/health"
        echo "  GraphQL:   https://mina-nodes.duckdns.org/preview/${PR_NUMBER}/graphql"
        echo "  Accounts:  https://mina-nodes.duckdns.org/preview/${PR_NUMBER}/accounts/acquire-account"
        echo "  Explorer:  https://mina-nodes.duckdns.org/preview/${PR_NUMBER}/explorer"
        ;;

    down)
        if [ -z "$PR_NUMBER" ]; then
            echo "Usage: $0 down <pr-number>"
            exit 1
        fi

        echo "Tearing down PR #${PR_NUMBER} preview..."
        docker compose -p "pr-${PR_NUMBER}" down -v --remove-orphans --rmi local 2>&1 || true

        # Remove route from main Caddy
        remove_caddy_route "$PR_NUMBER"

        echo "Done."
        ;;

    list)
        echo "Active preview environments:"
        docker compose ls --filter "name=pr-" 2>/dev/null || \
            docker ps --filter "label=com.docker.compose.project" --format '{{.Labels}}' | \
            grep -o 'com.docker.compose.project=pr-[0-9]*' | sort -u | \
            sed 's/com.docker.compose.project=/  /'
        ;;

    *)
        echo "Usage: $0 {up|down|list} [pr-number]"
        exit 1
        ;;
esac
