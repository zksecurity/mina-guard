#!/usr/bin/env bash
# Free host ports needed by standalone zk lightnet and start it.
# - Stops zkao-postgres-dev (host port 5432)
# - Stops local-lightnet-1 (preview-env compose lightnet) so the standalone
#   container can claim the zk-lightnet name and publish ports to the host.
# Run lightnet-down.sh when finished to restore stopped containers.

set -euo pipefail

STATE_FILE="${TMPDIR:-/tmp}/lightnet-up.stopped"
: > "${STATE_FILE}"

stop_if_running() {
  local name="$1"
  if docker ps --format '{{.Names}}' | grep -qx "${name}"; then
    echo "Stopping ${name}..."
    docker stop "${name}" >/dev/null
    echo "${name}" >> "${STATE_FILE}"
  else
    echo "${name} is not running — skipping."
  fi
}

stop_if_running "zkao-postgres-dev"
stop_if_running "local-lightnet-1"

echo "Starting zk lightnet (mesa)..."
zk lightnet start --mina-branch=mesa --pull=false --slot-time 3000
