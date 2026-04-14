#!/usr/bin/env bash
# Pin o1labs/mina-local-network:compatible-latest-lightnet to a known-good
# digest so `zk lightnet start --pull=false` stops hitting upstream breakage.
# Run once per machine.

set -euo pipefail

DIGEST="sha256:746190ff2f556f252b7f50215ae60d4a5e786c8adc16f27986e3e35ce6105949"
IMAGE="o1labs/mina-local-network"

docker pull "${IMAGE}@${DIGEST}"
docker tag  "${IMAGE}@${DIGEST}" "${IMAGE}:compatible-latest-lightnet"

echo "Pinned ${IMAGE}:compatible-latest-lightnet -> ${DIGEST}"
