#!/usr/bin/env bash
# Trail pull-based deploy — phase 2.
#
# Pulls the latest SIGNED /trail images from GHCR, verifies each with cosign
# against the release-workflow identity, and redeploys only when a digest
# actually changed. Verification reaches the PUBLIC Sigstore log
# (rekor.sigstore.dev) at verify time — an external availability dependency.
# Nothing pushes to this box; it pulls. Replaces the
# self-hosted `deploy` runner path — nothing pushes to the box.
# Meant to be run by trail-pull-deploy.timer.
#
# ┌─ DRAFT — NOT YET VALIDATED ON THE TRAIL BOX ────────────────────────────┐
# │ Before enabling: (1) cosign installed, (2) `docker login ghcr.io` with a │
# │ read:packages token so the private images pull, (3) the images actually  │
# │ built + signed by trail-release.yml, (4) MESA_NODE_HOST / ARCHIVE_DB_*   │
# │ present in the systemd unit's EnvironmentFile. See the setup runbook.     │
# └──────────────────────────────────────────────────────────────────────────┘
set -euo pipefail

PREFIX="ghcr.io/zksecurity/mina-guard/trail"
TAG="${TRAIL_TAG:-main}"
# The image was signed keyless by THIS workflow on THIS ref. Verifying the
# identity — not a shared key — is the whole point: a rogue build from another
# branch/workflow has a different identity and fails here.
IDENTITY="https://github.com/zksecurity/mina-guard/.github/workflows/trail-release.yml@refs/heads/${TAG}"
ISSUER="https://token.actions.githubusercontent.com"
REPO_DIR="${TRAIL_REPO_DIR:-$HOME/mina-guard}"
COMPOSE="${REPO_DIR}/deploy/docker-compose.trail.pull.yml"
STATE_DIR="${TRAIL_STATE_DIR:-$HOME/.trail-deploy}"
mkdir -p "$STATE_DIR"

# Runtime config the compose needs (same as the interim deploy).
: "${MESA_NODE_HOST:?set MESA_NODE_HOST}"
: "${ARCHIVE_DB_PASSWORD:?set ARCHIVE_DB_PASSWORD}"
export MESA_NODE_HOST ARCHIVE_DB_PASSWORD

log() { echo "[$(date -u +%FT%TZ)] $*"; }

changed=0
for img in backend frontend explorer; do
  ref="${PREFIX}-${img}:${TAG}"
  docker pull -q "$ref" >/dev/null
  # Resolve the concrete digest the tag currently points to.
  digest=$(docker inspect --format '{{index .RepoDigests 0}}' "$ref" | sed 's/.*@//')
  pinned="${PREFIX}-${img}@${digest}"

  # Verify the signature on THIS digest came from our release workflow.
  # Fail closed: a verify failure must never deploy.
  if ! cosign verify "$pinned" \
        --certificate-identity="$IDENTITY" \
        --certificate-oidc-issuer="$ISSUER" >/dev/null 2>&1; then
    log "FATAL: cosign verify FAILED for ${pinned} — refusing to deploy"
    exit 1
  fi

  # Pin the verified digest for compose (env-substituted below).
  var="TRAIL_$(printf '%s' "$img" | tr '[:lower:]' '[:upper:]')_IMAGE"
  export "${var}=${pinned}"

  prev="${STATE_DIR}/${img}.digest"
  if [ ! -f "$prev" ] || [ "$(cat "$prev")" != "$digest" ]; then
    changed=1
    printf '%s' "$digest" > "${prev}.pending"
    log "${img}: new verified digest ${digest}"
  fi
done

if [ "$changed" -eq 0 ]; then
  log "no image changes — nothing to deploy"
  exit 0
fi

# NOTE (DB-wipe semantics): the interim deploy used `down -v` because the VK
# hash changed per PR merge during active dev and the indexer filters discovery
# by VK. In steady production the VK is stable, so a rolling `up -d` (no wipe)
# is correct. If a release intentionally changes the VK, wipe + re-index
# deliberately (docker compose ... down -v) — do NOT wipe on every deploy.
log "deploying verified images…"
docker compose -f "$COMPOSE" -p minaguard-trail up -d

# Commit pending digests only after a successful up.
for img in backend frontend explorer; do
  [ -f "${STATE_DIR}/${img}.digest.pending" ] && \
    mv "${STATE_DIR}/${img}.digest.pending" "${STATE_DIR}/${img}.digest"
done
log "deploy complete"
