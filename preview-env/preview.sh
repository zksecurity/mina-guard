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

    # Remove existing route first (idempotent). Caddy unreachable here
    # surfaces as a non-zero return; we ignore it because the POST below
    # will fail with a clearer error if Caddy really is down.
    remove_caddy_route "$pr" >/dev/null 2>&1 || true

    # Read the group name from the first existing route. Caddy assigns all handle
    # blocks the same group so they're mutually exclusive (only one matches per
    # request, like an if/else chain). We need our preview route in the same group.
    # `|| true` on each leg so curl exit-7 (Caddy unreachable) doesn't trip
    # `set -e` via the command substitution; we always end up with "group0".
    local group raw
    raw=$(curl -s "${CADDY_API}/config/${ROUTES_PATH}/0" 2>/dev/null || true)
    group=$(printf '%s' "$raw" | python3 -c "import sys,json; print(json.load(sys.stdin).get('group','group0'))" 2>/dev/null || echo "group0")

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
    # immediately — no reload needed. curl writes "000" to stdout via
    # `-w %{http_code}` when the connection fails, and `|| true` suppresses
    # its non-zero exit from tripping set -e. Combined: $status is always a
    # string, never empty, even when Caddy is unreachable.
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
        -H "Content-Type: application/json" \
        -d "$route_json" \
        "${CADDY_API}/config/${ROUTES_PATH}" 2>/dev/null || true)

    if [ "$status" = "200" ]; then
        echo "Caddy route added: /preview/${pr}/ → localhost:${port}"
        return 0
    elif [ "$status" = "000" ]; then
        echo "ERROR: Caddy admin API unreachable at ${CADDY_API} — preview reverse-proxy route was NOT added." >&2
        echo "Check that Caddy is running on the host and exposing :2019." >&2
        return 1
    else
        echo "ERROR: Failed to add Caddy route (HTTP ${status})" >&2
        return 1
    fi
}

remove_caddy_route() {
    local pr=$1

    # Delete by the @id we assigned when creating the route. `|| true` keeps
    # us going when curl itself fails to connect (e.g. Caddy admin API
    # unreachable on the runner) — curl already writes "000" via
    # `-w %{http_code}` on connection failure, so we just need to suppress
    # the exit code from tripping set -e.
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
        "${CADDY_API}/id/preview-${pr}" 2>/dev/null || true)

    if [ "$status" = "200" ]; then
        echo "Caddy route removed for PR #${pr}"
        return 0
    elif [ "$status" = "404" ]; then
        echo "No Caddy route found for PR #${pr}"
        return 0
    elif [ "$status" = "000" ]; then
        echo "WARNING: Caddy admin API unreachable at ${CADDY_API} — leaving route untouched."
        return 1
    else
        echo "WARNING: Caddy returned HTTP ${status} when removing route preview-${pr} — leaving it untouched."
        return 1
    fi
}

build_services_sequentially() {
    local -a compose_args=("$@")

    for service in backend frontend explorer; do
        echo "Building ${service}..."
        docker compose "${compose_args[@]}" build "$service"
    done
}

# Compiles the MinaGuard zkApp circuit on the host once and exports the
# verification key hash so the backend Dockerfile can skip its in-image
# compile (which OOM-kills inside CI's Docker build). Honors a
# pre-set MINAGUARD_VK_HASH env var to avoid recompiling between runs,
# and caches by contracts/src content-hash so unchanged contracts skip
# the multi-minute (and OOM-prone) compile entirely.
ensure_vk_hash() {
    if [ -n "${MINAGUARD_VK_HASH:-}" ]; then
        echo "Using MINAGUARD_VK_HASH from environment: ${MINAGUARD_VK_HASH}"
        export MINAGUARD_VK_HASH
        return
    fi

    if ! command -v bun >/dev/null 2>&1; then
        echo "ERROR: bun is not on PATH. Either install bun on the host, or" >&2
        echo "       export MINAGUARD_VK_HASH=<hash> before running preview.sh." >&2
        exit 1
    fi

    # Cache key: hash of every file under contracts/src. Lives outside the
    # repo so it survives `git clean` / fresh checkouts on the runner.
    local cache_dir="${HOME}/.cache/minaguard-vk"
    mkdir -p "$cache_dir"
    local srchash=""
    if [ -d contracts/src ]; then
        srchash=$(find contracts/src -type f -print0 2>/dev/null \
                  | LC_ALL=C sort -z \
                  | xargs -0 sha256sum 2>/dev/null \
                  | sha256sum | awk '{print $1}')
    fi
    if [ -n "$srchash" ] && [ -s "$cache_dir/$srchash" ]; then
        MINAGUARD_VK_HASH=$(cat "$cache_dir/$srchash")
        export MINAGUARD_VK_HASH
        echo "Using cached MINAGUARD_VK_HASH for contracts/src@${srchash:0:12}: ${MINAGUARD_VK_HASH}"
        return
    fi

    # vk-hash compile imports the built contracts package; without this the
    # bun runner errors out before printing any vkHash: line.
    echo "Building contracts package..."
    bun run --filter contracts build

    echo "Computing MinaGuard verification key hash on host (this can take several minutes)..."
    local output rc hash
    set +e
    output=$(bun run dev-helpers/cli.ts vk-hash compile 2>&1)
    rc=$?
    set -e
    if [ "$rc" -ne 0 ]; then
        echo "ERROR: vk-hash compile exited with code $rc. Output:" >&2
        echo "$output" >&2
        # Bash maps SIGKILL to exit 137 — this is the OOM-killer's signature.
        if [ "$rc" -eq 137 ] || [ "$rc" -gt 128 ]; then
            local sig=$((rc - 128))
            echo "(killed by signal ${sig}; exit code 137 typically means OOM-killed)" >&2
            if command -v dmesg >/dev/null 2>&1; then
                echo "Recent kernel OOM messages (if any):" >&2
                dmesg 2>/dev/null | tail -n 20 | grep -i -E 'oom|killed' >&2 || true
            fi
            echo "Free memory at this moment:" >&2
            free -h 2>&1 | head -3 >&2 || true
            echo "Hint: tear down idle preview environments (./preview-env/preview.sh list)," >&2
            echo "      or pre-set MINAGUARD_VK_HASH from a host with more memory." >&2
        fi
        exit 1
    fi
    hash=$(echo "$output" | awk '/^vkHash:/{print $2}')
    if [ -z "$hash" ]; then
        echo "ERROR: vk-hash compile printed no 'vkHash:' line. Full output:" >&2
        echo "$output" >&2
        exit 1
    fi
    export MINAGUARD_VK_HASH="$hash"
    if [ -n "$srchash" ]; then
        echo "$hash" > "$cache_dir/$srchash"
        echo "Cached vkHash at ${cache_dir}/${srchash:0:12}…"
    fi
    echo "MINAGUARD_VK_HASH=${MINAGUARD_VK_HASH}"
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
        ensure_vk_hash
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
        # Only invoke `docker compose down` when there's actually a project to
        # tear down. Older runs got away with running it unconditionally; some
        # docker compose versions return non-zero on "no resource found" and
        # `set -e` would then abort `preview.sh up`'s clean-slate down step.
        if docker compose ls --all --format json 2>/dev/null \
                | grep -q "\"Name\":\"pr-${PR_NUMBER}\""; then
            docker compose -p "pr-${PR_NUMBER}" down -v --remove-orphans --rmi local 2>&1 || true
        else
            echo "No compose project pr-${PR_NUMBER} — skipping docker compose down."
        fi

        # Remove route from main Caddy (idempotent: 404 is fine)
        remove_caddy_route "$PR_NUMBER" || true

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
