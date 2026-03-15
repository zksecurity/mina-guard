# MinaGuard Backend

Read-only Express API + polling indexer for MinaGuard contracts.

This package does two things:

1. Indexes MinaGuard on-chain events into a local SQLite database.
2. Exposes read APIs for contracts, owners, proposals, approvals, and raw events.

## What Is Included

- `Express` server (`src/server.ts`)
- `Prisma + SQLite` storage (`prisma/schema.prisma`)
- Polling indexer (`src/indexer.ts`)
- Mina/Archive GraphQL client + event decoding (`src/mina-client.ts`)
- Read-only API routes (`src/routes.ts`)

## Runtime Architecture

At startup:

1. Environment is loaded from `.env`.
2. Prisma connects to SQLite.
3. Indexer starts and runs one immediate sync tick.
4. Express starts and serves API routes.

On every index tick:

1. Fetch latest chain height.
2. Read indexed cursor (`IndexerCursor.key = indexed_height`).
3. Discover new zkApp addresses from recent chain window.
4. Verify zkApp verification key hash (optional strict match with `MINAGUARD_VK_HASH`).
5. Fetch and decode MinaGuard events for tracked contracts.
6. Upsert normalized rows (`Contract`, `Owner`, `Proposal`, `Approval`) and raw events (`EventRaw`).
7. Mark pending proposals as `expired` when current height passes `expiryBlock`.
8. Persist cursor to latest synced height.

## Requirements

- Bun or Node toolchain capable of running workspace scripts
- Access to Mina node/archive GraphQL endpoints

## Setup

1. Create env file:

```bash
cp backend/.env.example backend/.env
```

2. Install dependencies (from workspace root):

```bash
bun install
```

3. Run backend in dev mode:

```bash
bun run --filter backend dev
```

Dev/start scripts auto-run `prisma db push` before launching server.

## Scripts

From `backend/`:

- `bun run dev`: auto-sync schema, then start server with `tsx watch`
- `bun run build`: compile TypeScript to `dist/`
- `bun run start`: auto-sync schema, then run compiled server
- `bun run prisma:generate`: generate Prisma client
- `bun run prisma:migrate`: run Prisma migration workflow
- `bun run prisma:push`: push schema manually

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | Express server port |
| `DATABASE_URL` | `file:./dev.db` | Prisma SQLite URL (resolves to `backend/prisma/dev.db`) |
| `MINA_ENDPOINT` | `https://api.minascan.io/node/devnet/v1/graphql` | Primary Mina GraphQL endpoint |
| `ARCHIVE_ENDPOINT` | `https://api.minascan.io/archive/devnet/v1/graphql` | Primary archive GraphQL endpoint |
| `MINA_FALLBACK_ENDPOINT` | empty | Optional Mina fallback endpoint |
| `ARCHIVE_FALLBACK_ENDPOINT` | empty | Optional archive fallback endpoint |
| `INDEX_POLL_INTERVAL_MS` | `15000` | Poll interval for index ticks |
| `INDEX_START_HEIGHT` | `0` | Initial cursor height when no cursor row exists |
| `MINAGUARD_VK_HASH` | empty | Optional strict verification key hash filter for discovery |

## API Routes

All routes are read-only.

### `GET /health`

Returns process liveness.

Example response:

```json
{
  "ok": true,
  "now": "2026-03-04T10:30:00.000Z"
}
```

### `GET /api/indexer/status`

Returns in-memory indexer status:

- `running`
- `lastRunAt`
- `lastSuccessfulRunAt`
- `latestChainHeight`
- `indexedHeight`
- `lastError`
- `discoveredContracts`

### `GET /api/contracts`

Lists tracked contracts with aggregate counts:

- `_count.owners`
- `_count.proposals`
- `_count.events`

Ordered by `discoveredAt desc`.

### `GET /api/contracts/:address`

Returns one tracked contract with aggregate counts.  
Returns `404` if not found.

### `GET /api/contracts/:address/owners`

Lists owners for a contract.  
Query params:

- `active=true|false` (optional)

Ordering: `index asc`, then `createdAt asc`.  
Returns `404` if contract not found.

### `GET /api/contracts/:address/proposals`

Lists proposals for a contract.  
Query params:

- `status` (optional; e.g. `pending`, `executed`, `expired`)
- `limit` (default `50`, min `1`, max `200`)
- `offset` (default `0`, min `0`, max `10000`)

Ordering: `createdAtBlock desc`, then `createdAt desc`.  
Returns `404` if contract not found.

### `GET /api/contracts/:address/proposals/:proposalHash`

Returns a single proposal by `(contract, proposalHash)`.  
Returns `404` if contract or proposal not found.

### `GET /api/contracts/:address/proposals/:proposalHash/approvals`

Lists approvals for one proposal.  
Ordering: `blockHeight asc`, then `createdAt asc`.  
Returns `404` if contract or proposal not found.

### `GET /api/contracts/:address/events`

Returns raw indexed events (`EventRaw`) for a contract.  
Query params:

- `fromBlock` (optional int, inclusive)
- `toBlock` (optional int, inclusive)
- `limit` (default `100`, min `1`, max `500`)
- `offset` (default `0`, min `0`, max `50000`)

Ordering: `blockHeight desc`, then `createdAt desc`.  
Returns `404` if contract not found.

## Database Schema

Defined in `prisma/schema.prisma`.

### `Contract`

Tracked MinaGuard contract metadata:

- identity: `id`, unique `address`
- setup/config: `networkId`, `ownersCommitment`, `threshold`, `numOwners`
- state: `configNonce`, `proposalCounter`, `isValid`, `invalidReason`
- sync timestamps: `discoveredAt`, `lastSyncedAt`

Relations: `owners`, `proposals`, `events`.

### `Owner`

Owner rows per contract:

- unique per contract: `@@unique([contractId, address])`
- indexed by active state: `@@index([contractId, active])`
- fields: `address`, `ownerHash`, `index`, `active`

### `Proposal`

Normalized proposal lifecycle record:

- unique per contract: `@@unique([contractId, proposalHash])`
- indexed: `@@index([contractId, status])`
- fields include `proposer`, `toAddress`, `amount`, `tokenId`, `txType`, `data`
- lifecycle: `status`, `approvalCount`, `createdAtBlock`, `executedAtBlock`
- metadata: `nonce`, `configNonce`, `expiryBlock`, `networkId`, `guardAddress`

### `Approval`

One row per `(proposal, approver)`:

- unique: `@@unique([proposalId, approver])`
- fields: `approvalRaw`, `blockHeight`

### `EventRaw`

Raw event persistence for replay/debug:

- event metadata: `blockHeight`, `txHash`, `eventType`, `payload`
- idempotency key: unique `fingerprint`
- index: `@@index([contractId, blockHeight])`

### `IndexerCursor`

Simple key-value table for index progress:

- key used by indexer: `indexed_height`

## Event-to-State Mapping

Indexer applies contract events as follows:

- `setup`: update contract setup fields
- `setupOwner`: upsert owner rows
- `proposal`: upsert proposal with `status = pending`
- `approval`: upsert approval, recompute `proposal.approvalCount`
- `execution`: mark proposal `executed`, set `executedAtBlock`
- `ownerChange`: toggle owner active state, update `numOwners` when provided
- `thresholdChange`: update contract threshold

After event ingestion, pending proposals are re-evaluated and moved to `expired` if `latestHeight > expiryBlock`.

## Logging

Route middleware logs every request with a short request id:

- inbound: `[api:<id>] -> METHOD /path {...query}`
- outbound: `[api:<id>] <- METHOD /path <status> <duration>ms`
- errors: `[api:<id>] !! METHOD /path ...stack`

This makes it easy to correlate request lifecycle and failures in local/dev logs.

## Error Handling and Troubleshooting

### Reset the database

To wipe all data and recreate tables from the schema:

```bash
bun prisma db push --force-reset
```

### `P2021` table missing

If Prisma throws `P2021` (`table does not exist`), schema was not applied to the current database.

Fix:

```bash
bun run --filter backend prisma:push
```

Or restart backend with `dev`/`start` scripts so `db:push` runs automatically.

### No contracts discovered

Check:

- endpoint connectivity (`MINA_ENDPOINT`, `ARCHIVE_ENDPOINT`)
- `MINAGUARD_VK_HASH` value (empty means no strict hash filter)
- `INDEX_START_HEIGHT` and current chain activity window

### Indexer appears stuck

Check `GET /api/indexer/status`:

- `lastError` for failure reason
- `latestChainHeight` vs `indexedHeight` for lag
- server logs for GraphQL/network errors

## Local Development with Lightnet

### Prerequisites

- [zkApp CLI](https://docs.minaprotocol.com/zkapps/how-to-write-a-zkapp) installed (`zk` command available)
- Lightnet running locally: `zk lightnet start`

### 1. Generate signer keys

From `dev-helpers/`:

```bash
bun run cli.ts key gen
```

Run this once per signer. Copy the output keys into `dev-helpers/.env` (see `.env.example` for the format).

### 2. Fund signer accounts

Once `dev-helpers/.env` has the signer public keys populated:

```bash
bun run cli.ts lightnet-fund
```

This acquires funded accounts from the lightnet account manager and transfers MINA to each public key listed in `.env`. It runs all transfers in parallel (one funder per target) and waits for confirmation.

Environment variables (optional overrides):

| Variable | Default | Description |
|---|---|---|
| `LIGHTNET_ACCOUNT_MANAGER` | `http://127.0.0.1:8181` | Lightnet account manager URL |
| `MINA_ENDPOINT` | `http://127.0.0.1:8080/graphql` | Mina GraphQL endpoint |

### 3. Deploy a contract

Open the UI at `http://localhost:3000/deploy`. A fresh keypair is auto-generated for the contract address. Fill in the signers and threshold, then submit the deploy transaction.

### 4. Start the backend

```bash
bun run --filter backend dev
```

The indexer will pick up the deployed contract and begin syncing events.

## Notes

- API is intentionally read-only; on-chain mutations are performed by the frontend wallet flow.
- `EventRaw.payload` is stored as JSON string for compatibility and simple replay/debug workflows.
