#!/bin/bash
# Local preview environment helper.
#
# Usage:
#   ./preview-env/local-preview.sh up   <pr-number> [port]
#   ./preview-env/local-preview.sh down <pr-number>

set -euo pipefail

COMMAND="${1:-}"
PR_NUMBER="${2:-}"
BASE_PORT=10000
PREVIEW_PORT="${3:-}"

if [ -n "$PR_NUMBER" ] && ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
    echo "ERROR: PR number must be a positive integer, got: $PR_NUMBER"
    exit 1
fi

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
            echo "Usage: $0 up <pr-number> [port]"
            exit 1
        fi

        if [ -z "$PREVIEW_PORT" ]; then
            PREVIEW_PORT=$((BASE_PORT + PR_NUMBER))
        fi

        echo "Starting local preview for PR #${PR_NUMBER} on port ${PREVIEW_PORT}..."
        echo "This stack is memory-heavy. Builds run sequentially to avoid RAM spikes."

        export PR_NUMBER PREVIEW_PORT
        build_services_sequentially \
            -f preview-env/docker-compose.preview.yml \
            -f preview-env/docker-compose.local.yml \
            -p local

        docker compose \
            -f preview-env/docker-compose.preview.yml \
            -f preview-env/docker-compose.local.yml \
            -p local \
            up -d --no-build

        echo ""
        echo "Access: https://localhost:${PREVIEW_PORT}/preview/${PR_NUMBER}/"
        echo "Logs:   docker compose -p local logs -f"
        ;;

    down)
        if [ -z "$PR_NUMBER" ]; then
            echo "Usage: $0 down <pr-number>"
            exit 1
        fi

        echo "Stopping local preview for PR #${PR_NUMBER}..."
        PR_NUMBER=$PR_NUMBER docker compose \
            -f preview-env/docker-compose.preview.yml \
            -f preview-env/docker-compose.local.yml \
            -p local \
            down -v --remove-orphans
        ;;

    *)
        echo "Usage: $0 {up|down} <pr-number> [port]"
        exit 1
        ;;
esac
