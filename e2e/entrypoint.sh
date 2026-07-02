#!/bin/sh
# Inline e2e runner entrypoint:
#   1. Reset the backend database against the `db` service
#   2. Start backend + frontend in the background (same container)
#   3. Wait for both to be healthy
#   4. Run the Playwright suite in CI mode (global-setup skips service mgmt)
#
# Mina/archive/account-manager URLs are overridden to docker DNS names via
# E2E_* env vars so network-config.ts points at the `lightnet` sibling service.
set -eu

log() { echo "[e2e-entrypoint $(date -u +'%H:%M:%S')] $*"; }

cleanup() {
  status=$?
  log "Shutting down background services (exit=$status)"
  # Kill any child processes still running so compose can exit cleanly.
  jobs -p | xargs -r kill 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT INT TERM

log "Resetting backend database at $DATABASE_URL"
(cd /app/backend && bunx prisma db push --force-reset --skip-generate)

if [ -z "${MINAGUARD_VK_HASH:-}" ] && [ -f /app/.vk-hash ]; then
  MINAGUARD_VK_HASH=$(cat /app/.vk-hash)
  export MINAGUARD_VK_HASH
  log "Loaded VK hash from build: $(printf '%.20s' "$MINAGUARD_VK_HASH")..."
fi

log "Starting backend on :4000"
(
  cd /app
  DATABASE_URL="$DATABASE_URL" \
  MINA_ENDPOINT="$E2E_MINA_ENDPOINT" \
  ARCHIVE_ENDPOINT="$E2E_ARCHIVE_ENDPOINT" \
  LIGHTNET_ACCOUNT_MANAGER="$E2E_ACCOUNT_MANAGER" \
  MINAGUARD_VK_HASH="${MINAGUARD_VK_HASH:-}" \
  PORT=4000 \
  INDEX_POLL_INTERVAL_MS=5000 \
  bun run --filter backend dev
) > /tmp/backend.log 2>&1 &
BACKEND_PID=$!

log "Starting frontend on :3000"
(
  # Production build: NEXT_PUBLIC_* values are already baked into the bundle
  # at docker build time. `next start` serves the pre-built static output
  # (no on-demand bundling overhead and better concurrent-request handling
  # than `next dev` for the /vk-cache/ static assets).
  cd /app
  bun run --filter ui start
) > /tmp/frontend.log 2>&1 &
FRONTEND_PID=$!

log "Waiting for backend health (pid=$BACKEND_PID)"
i=0
until curl -sf http://localhost:4000/health > /dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then
    log "Backend never became healthy. Last 120 log lines:"
    tail -120 /tmp/backend.log || true
    exit 1
  fi
  sleep 2
done
log "Backend ready"

log "Waiting for frontend (pid=$FRONTEND_PID)"
i=0
until curl -sf http://localhost:3000 > /dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 300 ]; then
    log "Frontend never became ready. Last 120 log lines:"
    tail -120 /tmp/frontend.log || true
    exit 1
  fi
  sleep 2
done
log "Frontend ready"

log "Streaming backend + frontend logs in the background"
tail -F /tmp/backend.log /tmp/frontend.log &

log "Running Playwright tests"
cd /app/e2e
CI=true node node_modules/@playwright/test/cli.js test
