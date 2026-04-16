#!/bin/bash

set -euo pipefail

OWNER_ADDRESS="${1:-}"

if [ -z "$OWNER_ADDRESS" ]; then
    echo "Usage: $0 <owner-wallet-address>"
    echo "Example: $0 B62q..."
    exit 1
fi

if ! bun -e "import { PublicKey } from 'o1js'; PublicKey.fromBase58(process.argv[1]);" "$OWNER_ADDRESS" >/dev/null 2>&1; then
    echo "ERROR: invalid Mina public key: $OWNER_ADDRESS"
    exit 1
fi

COMPOSE_ARGS=(
    -f preview-env/docker-compose.preview.yml
    -f preview-env/docker-compose.local.yml
    -p local
)

if ! docker compose "${COMPOSE_ARGS[@]}" ps db >/dev/null 2>&1; then
    echo "ERROR: local preview stack is not running."
    echo "Start it first with: ./preview-env/local-preview.sh up 1"
    exit 1
fi

export OWNER_ADDRESS

docker compose "${COMPOSE_ARGS[@]}" exec -T db \
    psql -v ON_ERROR_STOP=1 -v owner_address="$OWNER_ADDRESS" -U minaguard -d minaguard <<'SQL'
BEGIN;

SELECT set_config('app.owner_address', :'owner_address', false);

TRUNCATE TABLE
  "Approval",
  "ProposalReceiver",
  "Proposal",
  "Owner",
  "EventRaw",
  "Contract",
  "IndexerCursor"
RESTART IDENTITY CASCADE;

INSERT INTO "Contract" (
  address,
  "networkId",
  "ownersCommitment",
  threshold,
  "numOwners",
  nonce,
  "configNonce",
  "childMultiSigEnabled",
  delegate,
  "discoveredAt",
  "lastSyncedAt",
  "createdAt",
  "updatedAt"
)
VALUES (
  'B62qqsTq7n2tffm3s3z1Vu79qQMPtNPJHAB78hT5q8sHqb4uSHfMgnV',
  'testnet',
  'mock-owners-commitment',
  2,
  3,
  4,
  7,
  true,
  NULL,
  NOW() - INTERVAL '2 hours',
  NOW(),
  NOW() - INTERVAL '2 hours',
  NOW()
);

INSERT INTO "Owner" ("contractId", address, "ownerHash", "index", active, "createdAt", "updatedAt")
SELECT c.id, v.address, v.owner_hash, v.idx, v.active, NOW() - INTERVAL '2 hours', NOW()
FROM "Contract" c
CROSS JOIN (
  VALUES
    (current_setting('app.owner_address', true), 'mock-owner-0', 0, true),
    ('B62qmBjLwqKzqxStMfVTPCjxipVXwwjUvFpfhD7SBdPazQBAJeiNEvj', 'mock-owner-1', 1, true),
    ('B62qprSQdtqRwcpCtPEi3yWWCNziEgw5TsUvoce62E1MmJeXnD1CYbx', 'mock-owner-2', 2, true)
) AS v(address, owner_hash, idx, active)
WHERE c.address = 'B62qqsTq7n2tffm3s3z1Vu79qQMPtNPJHAB78hT5q8sHqb4uSHfMgnV';

INSERT INTO "Proposal" (
  "contractId",
  "proposalHash",
  proposer,
  "toAddress",
  "txType",
  data,
  nonce,
  "configNonce",
  "expiryBlock",
  "networkId",
  "guardAddress",
  status,
  "invalidReason",
  "approvalCount",
  "createdAtBlock",
  "executedAtBlock",
  "createdAt",
  "updatedAt"
)
SELECT
  c.id,
  v.proposal_hash,
  v.proposer,
  v.to_address,
  v.tx_type,
  v.data,
  v.nonce,
  v.config_nonce,
  v.expiry_block,
  'testnet',
  c.address,
  v.status,
  v.invalid_reason,
  v.approval_count,
  v.created_at_block,
  v.executed_at_block,
  NOW() - v.created_age,
  NOW() - v.updated_age
FROM "Contract" c
CROSS JOIN (
  VALUES
    ('1001', current_setting('app.owner_address', true), NULL, 'transfer', NULL, '1', '7', '5000', 'pending', NULL, 1, 120, NULL, INTERVAL '90 minutes', INTERVAL '85 minutes'),
    ('1002', 'B62qmBjLwqKzqxStMfVTPCjxipVXwwjUvFpfhD7SBdPazQBAJeiNEvj', 'B62qmzbgvSmtBCPbtKJNrr86S1u96xr6caF7TQgt7xF75ueezceqrCV', 'addOwner', NULL, '2', '7', '5000', 'executed', NULL, 2, 130, 132, INTERVAL '70 minutes', INTERVAL '60 minutes'),
    ('1003', current_setting('app.owner_address', true), NULL, 'changeThreshold', '3', '3', '7', '141', 'expired', NULL, 1, 140, NULL, INTERVAL '50 minutes', INTERVAL '45 minutes'),
    ('1004', 'B62qprSQdtqRwcpCtPEi3yWWCNziEgw5TsUvoce62E1MmJeXnD1CYbx', 'B62qrUvp84KrH4aFmGMWThsQP91PiW9Pf4CXxjMQqWHMXEwsSCWJ9ry', 'setDelegate', NULL, '4', '6', '5000', 'invalidated', 'proposal_nonce_stale', 0, 110, NULL, INTERVAL '40 minutes', INTERVAL '35 minutes')
) AS v(
  proposal_hash,
  proposer,
  to_address,
  tx_type,
  data,
  nonce,
  config_nonce,
  expiry_block,
  status,
  invalid_reason,
  approval_count,
  created_at_block,
  executed_at_block,
  created_age,
  updated_age
)
WHERE c.address = 'B62qqsTq7n2tffm3s3z1Vu79qQMPtNPJHAB78hT5q8sHqb4uSHfMgnV';

INSERT INTO "ProposalReceiver" ("proposalId", idx, address, amount, "createdAt", "updatedAt")
SELECT p.id, v.idx, v.address, v.amount, NOW() - INTERVAL '85 minutes', NOW()
FROM "Proposal" p
CROSS JOIN (
  VALUES
    (0, 'B62qioDo27JxVcECXdAaFg6AWYzbKCXQ1a2BjSCvEHxZEMD3xpm7mRD', '2500000000'),
    (1, 'B62qrNkdQLkWVCSWrcFmubthYNnZYTWNMcpQnPUjXhjyPu7Ew7ihj18', '1750000000')
) AS v(idx, address, amount)
WHERE p."proposalHash" = '1001';

INSERT INTO "Approval" ("proposalId", approver, "approvalRaw", "blockHeight", "createdAt")
SELECT p.id, v.approver, v.approval_raw, v.block_height, NOW() - v.created_age
FROM "Proposal" p
CROSS JOIN (
  VALUES
    ('1001', current_setting('app.owner_address', true), 'mock-approval-1001-a', 121, INTERVAL '84 minutes'),
    ('1002', current_setting('app.owner_address', true), 'mock-approval-1002-a', 131, INTERVAL '64 minutes'),
    ('1002', 'B62qmBjLwqKzqxStMfVTPCjxipVXwwjUvFpfhD7SBdPazQBAJeiNEvj', 'mock-approval-1002-b', 132, INTERVAL '62 minutes'),
    ('1003', 'B62qmBjLwqKzqxStMfVTPCjxipVXwwjUvFpfhD7SBdPazQBAJeiNEvj', 'mock-approval-1003-a', 140, INTERVAL '49 minutes')
) AS v(proposal_hash, approver, approval_raw, block_height, created_age)
WHERE p."proposalHash" = v.proposal_hash;

INSERT INTO "EventRaw" ("contractId", "blockHeight", "txHash", "eventType", payload, fingerprint, "createdAt")
SELECT
  c.id,
  v.block_height,
  v.tx_hash,
  v.event_type,
  v.payload,
  v.fingerprint,
  NOW() - v.created_age
FROM "Contract" c
CROSS JOIN (
  VALUES
    (100, '5Jmocksetup', 'setup', '{"threshold":2,"numOwners":3}', 'mock-event-setup', INTERVAL '100 minutes'),
    (120, '5Jmockproposal1', 'proposal', '{"proposalHash":"1001","txType":"transfer"}', 'mock-event-proposal-1001', INTERVAL '90 minutes'),
    (130, '5Jmockproposal2', 'proposal', '{"proposalHash":"1002","txType":"addOwner"}', 'mock-event-proposal-1002', INTERVAL '70 minutes'),
    (132, '5Jmockexecute2', 'execution', '{"proposalHash":"1002"}', 'mock-event-execution-1002', INTERVAL '60 minutes'),
    (140, '5Jmockproposal3', 'proposal', '{"proposalHash":"1003","txType":"changeThreshold"}', 'mock-event-proposal-1003', INTERVAL '50 minutes')
) AS v(block_height, tx_hash, event_type, payload, fingerprint, created_age)
WHERE c.address = 'B62qqsTq7n2tffm3s3z1Vu79qQMPtNPJHAB78hT5q8sHqb4uSHfMgnV';

INSERT INTO "IndexerCursor" (key, value, "updatedAt")
VALUES ('indexed_height', '140', NOW());

COMMIT;
SQL

echo "Mock data seeded."
echo "Owner address wired into the contract: $OWNER_ADDRESS"
echo "Connect that wallet in the UI, then open /preview/1 or refresh the page."
echo "Note: approve/execute actions against this mock contract will still fail on-chain."
