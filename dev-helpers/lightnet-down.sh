#!/usr/bin/env bash
# Stop zk lightnet and restart any containers that lightnet-up.sh stopped.

set -euo pipefail

STATE_FILE="${TMPDIR:-/tmp}/lightnet-up.stopped"

echo "Stopping zk lightnet..."
zk lightnet stop || echo "(no lightnet running)"

if [[ -s "${STATE_FILE}" ]]; then
  while IFS= read -r name; do
    [[ -z "${name}" ]] && continue
    echo "Restarting ${name}..."
    docker start "${name}" >/dev/null
  done < "${STATE_FILE}"
  rm -f "${STATE_FILE}"
else
  echo "No containers to restart."
  rm -f "${STATE_FILE}"
fi
