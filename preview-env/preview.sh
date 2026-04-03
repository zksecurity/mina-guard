#!/bin/bash
# MinaGuard PR Preview Environment Manager
#
# Usage:
#   ./preview.sh up   <pr-number>   — deploy preview for PR
#   ./preview.sh down <pr-number>   — teardown preview for PR
#   ./preview.sh list               — list active previews
#
# Expects to be run from the repo root directory.

set -euo pipefail

COMMAND="${1:-}"
PR_NUMBER="${2:-}"
BASE_PORT=10000

# Validate PR number to prevent sed injection into Caddyfile
if [ -n "$PR_NUMBER" ] && ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
    echo "ERROR: PR number must be a positive integer, got: $PR_NUMBER"
    exit 1
fi
MAIN_CADDYFILE="/etc/caddy/Caddyfile"
HOME_CADDYFILE="$HOME/Caddyfile"

add_caddy_route() {
    local pr=$1
    local port=$2

    # Skip if already present
    if grep -q "# PREVIEW-START-${pr}" "$MAIN_CADDYFILE" 2>/dev/null; then
        echo "Caddy route for PR #${pr} already exists, updating..."
        remove_caddy_route "$pr"
    fi

    # Insert preview block before the closing } of the site block
    sudo sed -i "/^}$/i\\
\\
    # PREVIEW-START-${pr}\\
    @preview${pr} path /preview/${pr} /preview/${pr}/*\\
    handle @preview${pr} {\\
        reverse_proxy localhost:${port} {\\
            header_down -Cross-Origin-Opener-Policy\\
            header_down -Cross-Origin-Embedder-Policy\\
        }\\
        header Cross-Origin-Opener-Policy \"same-origin\"\\
        header Cross-Origin-Embedder-Policy \"credentialless\"\\
    }\\
    # PREVIEW-END-${pr}" "$MAIN_CADDYFILE"

    # Keep home copy in sync
    sudo cp "$MAIN_CADDYFILE" "$HOME_CADDYFILE"

    # Reload Caddy
    sudo systemctl reload caddy
    echo "Caddy route added: /preview/${pr}/ → localhost:${port}"
}

remove_caddy_route() {
    local pr=$1

    if grep -q "# PREVIEW-START-${pr}" "$MAIN_CADDYFILE" 2>/dev/null; then
        sudo sed -i "/# PREVIEW-START-${pr}/,/# PREVIEW-END-${pr}/d" "$MAIN_CADDYFILE"
        # Clean up any blank lines left behind
        sudo sed -i '/^$/N;/^\n$/d' "$MAIN_CADDYFILE"
        sudo cp "$MAIN_CADDYFILE" "$HOME_CADDYFILE"
        sudo systemctl reload caddy
        echo "Caddy route removed for PR #${pr}"
    fi
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

        PR_NUMBER=$PR_NUMBER PREVIEW_PORT=$PREVIEW_PORT \
        docker compose -f preview-env/docker-compose.preview.yml \
            -p "pr-${PR_NUMBER}" \
            up -d --build

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
        docker compose -p "pr-${PR_NUMBER}" down -v --remove-orphans

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
