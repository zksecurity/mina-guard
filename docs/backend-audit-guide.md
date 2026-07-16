# Backend Indexer & Read API — Architecture & Security Notes

This document describes the **backend** (`backend/`) — an Express read API backed by
a polling indexer that turns MinaGuard's on-chain events into normalized database
tables. It is **untrusted for integrity**: it holds no keys, and everything it serves
is a re-indexable materialized view of public chain events.

It is the read source for the online UI ([`ui-audit-guide.md`](./ui-audit-guide.md)),
runs in-process inside the desktop shell ([`desktop-audit-guide.md`](./desktop-audit-guide.md)),
and the trust argument for why an untrusted indexer is safe lives in
[`security-audit-guide.md`](./security-audit-guide.md). The events it reconstructs are
defined by the contract ([`contracts-audit-guide.md`](./contracts-audit-guide.md#events)).

---

## General overview

The backend does two things:

1. **Indexes** MinaGuard on-chain events into a SQL database (PostgreSQL in the hosted
   deployment; SQLite in the desktop shell).
2. **Exposes** read APIs for contracts, owners, proposals, approvals, and raw events —
   read-heavy, plus a few narrow write routes: tx-hash submissions, lightnet funding, and
   lite-mode subscribe.

**Its data is used but not trusted.** Clients query it to reconstruct proposal data and
Merkle witnesses, then rebuild the `TransactionProposal` struct, re-hash it, and sign that
hash locally — the contract re-hashes on-chain and rejects any mismatch. A fully compromised
backend therefore cannot forge an approval or steer an owner into signing something other than
what was proposed; its **damage ceiling is censorship and denial of service** (hiding
proposals, showing stale state, causing failed transactions). The one display-only surface
where a lying indexer's data is shown but not action-bound — the memo match badge — is analyzed
in [`ui-audit-guide.md`](./ui-audit-guide.md) focus point 3.

The API performs **no on-chain mutations**: signing and submission happen in the frontend
wallet flow (or the offline CLI). The write routes only touch backend-local state (tx-hash
submissions, lite-mode subscriptions) or lightnet test funding.

## Architecture

At startup: environment is loaded and validated by `src/config.ts` (fails fast on
missing/invalid vars) → Prisma connects to the database → the indexer starts and runs one
immediate sync tick → Express starts and serves API routes.

### Modes

The indexer runs in one of two modes, set by config at startup.

| Mode | Discovery | Backfill lower bound | Subscribe API |
|---|---|---|---|
| `full` | Scans a bounded recent bestChain window (≤290 blocks) for MinaGuard deployments | `indexedHeight - 300` (~290-block bestChain horizon + safety margin) | disabled |
| `lite` | No scan; only tracks contracts added via `POST /api/subscribe` | `config.indexStartHeight` (default `0`) | enabled |

`full` is the batch indexer posture: look at the whole chain and keep everything. `lite` is the
user-facing posture (and the desktop shell's): only track what a user asked for, but pull full
history for it.

In full mode, the source of candidate addresses is itself pluggable via `DISCOVERY_BACKEND`:

| Backend | Source | History reach | Requirements |
|---|---|---|---|
| `daemon` (default) | bestChain scan over daemon GraphQL | ~290 blocks (transition-frontier cap) | none |
| `archive` | direct SQL against the Mina archive postgres | unbounded (from genesis) | `ARCHIVE_DB_*` connection env vars + `MINAGUARD_VK_HASH` (the SQL filters on the VK hash to keep results bounded — config load fails fast without it) |

Both backends funnel their candidates through the same dedup / VK re-verification / backfill
path (`processCandidateAddresses`). The archive backend also reads the latest chain height from
postgres (`fetchLatestBlockHeightFromArchive`) instead of archive-node-api, which has been
observed to return generic errors mid-block.

### Tick loop

`MinaGuardIndexer.tick()` runs every `INDEX_POLL_INTERVAL_MS`. One pass:

1. **Fetch latest height** — `fetchLatestBlockHeight` (daemon GraphQL), or `fetchLatestBlockHeightFromArchive` (max non-orphaned `blocks.height` in postgres) when `DISCOVERY_BACKEND=archive`.
2. **Reorg check** — `detectAndRollbackReorg`. If a fork is detected, rewind cursor + delete all rows above fork height, then bail out of the tick. Next tick resumes from the rewound cursor.
3. **Read cursor** — `IndexerCursor.indexed_height` (default `indexStartHeight` if absent).
4. **Discover (full mode only)** — collect candidate addresses and run them through `processCandidateAddresses` (dedup → VK re-verify → insert → backfill, with per-candidate error isolation):
   - **daemon**: scan a `[latestHeight - window, latestHeight]` bestChain slice. Window = `min(290, delta + margin)`. `discoveredAtBlock` is approximated as the tick's chain tip (bestChain's ~290-block horizon bounds the imprecision).
   - **archive**: one VK-hash-filtered SQL query over `[from, latestHeight]`, where `from` is the `archive_discovered_height` cursor minus a small reorg margin — or, on cold start (no cursor yet), `indexStartHeight`, giving a from-genesis sweep that picks up historical deploys. `discoveredAtBlock` is the actual on-chain deploy block (`MIN(blocks.height)`). The cursor only advances when **zero** candidates failed, so transient failures (e.g. a flaky VK fetch) are retried next tick instead of being dropped past the cursor forever.
5. **Rescan unready contracts** — any `Contract` with `ready = false` is re-synced from its `discoveredAtBlock` up to `latestHeight`. This is what makes subscribe-before-deploy self-healing.
6. **Forward sweep** — `syncKnownContracts(indexedHeight + 1, latestHeight)` across every tracked contract.
7. **Advance cursor** — persist `indexed_height = latestHeight`.
8. **Poll pending submissions** — `pollPendingSubmissions` checks every in-flight approve/execute tx hash against bestChain and records structured failure reasons on the `Proposal` row. Transactions still `pending` past a 20-minute grace period are additionally checked against the daemon mempool (`pooledZkappCommands`); absent from both, they're marked dropped via `lastApproveError`/`lastExecuteError`, which releases the UI's signer lock. (Successful txs need no handling here — their Approval/Execution events clear them in the apply pipeline.)

If any step throws, the cursor is **not** advanced, so the next tick retries the same window.
Per-contract sync errors re-throw for the same reason.

### Reorg handling

Mina has probabilistic finality (~290 blocks). The indexer handles any reorg that forks at or
above the last 290 bestChain headers; reorgs that fork deeper than the detection window are
logged and left for operator intervention (see [Failure semantics](#failure-semantics)).

**Detection** (`detectAndRollbackReorg`):
- Fetch the last `REORG_DETECTION_WINDOW` (290) bestChain headers.
- Compare against stored `BlockHeader` rows over the same height range.
- Walk descending: the fork point is the highest stored height whose hash still matches the chain. Everything above it is non-canonical.
- If every overlapping header mismatches, the reorg is deeper than visibility — log and skip (operator intervention).

**Rollback** (`rollbackAboveFork`) is one atomic transaction deleting all `> forkHeight` rows
across `BlockHeader`, `EventRaw`, `ContractConfig`, `OwnerMembership`, `ProposalExecution`,
`Approval`, `Proposal`, `Contract` (by `discoveredAtBlock`), and rewinding the cursor to
`forkHeight`.

This is safe because every mutable table stores the block at which its row became valid
(`validFromBlock`, `createdAtBlock`, `blockHeight`, `discoveredAtBlock`). No "current state" row
needs patching — deleting the post-fork history is enough, and the forward sweep re-derives state
from re-fetched events. `BlockHeader` is upserted at event ingestion time, so reorg detection only
has teeth on heights where MinaGuard activity landed — which is exactly where it's needed.

### Contract discovery and readiness

A `Contract` row exists in one of two states:

- **`ready = false`** — address is known (discovered or subscribed) but no MinaGuard event has been ingested yet. Hidden from most read routes.
- **`ready = true`** — flipped on first event ingestion in `syncSingleContract`. Any event other than `setup`/`setupOwner` proves the contract actually initialized on-chain.

`ready` exists because a `Contract` row can be inserted speculatively — a user subscribing before
the deploy tx lands, or `applyProposalEvent` eagerly inserting a child on a CREATE_CHILD proposal
before `executeSetupChild` actually runs. Read routes filter on `ready = true` so these speculative
rows don't surface as ghost UI entries, while the unready-rescan loop keeps polling their address
range until real events land and promote them.

Three ways to become tracked:

- **Full mode, daemon discovery**: `discoverCandidateAddresses` scans recent bestChain blocks, `fetchVerificationKeyHash` confirms it's a zkApp, and the hash is optionally matched against `MINAGUARD_VK_HASH`. Backfill window is `max(0, indexedHeight - 300)` — a safe margin around the ~290-block bestChain horizon, which is guaranteed to cover the deploy since that horizon is the only place daemon discovery could have seen it.
- **Full mode, archive discovery**: `discoverCandidateAddressesFromArchive` queries the archive postgres for account updates that installed MinaGuard's VK (applied zkapp commands in non-orphaned blocks). Because this can surface contracts deployed at arbitrary historical heights, the backfill lower bound is `indexStartHeight` (default 0). The on-chain VK re-fetch via the daemon still runs per new candidate: it catches the edge case where the archive shows a VK install that has since been upgraded on-chain. The query includes `pending` blocks so fresh deploys are discoverable before finalization; orphaned pending deploys are cleaned up by `rollbackAboveFork`, which deletes `Contract` rows by `discoveredAtBlock` on every reorg rollback. The residual risk is the same as any reorg deeper than the ~290-block detection window: operator intervention.
- **Lite mode subscribe**: user calls `POST /api/subscribe { address, fromBlock? }`. `fromBlock` omitted = `latestHeight - 5` (margin to cover a block landing mid-request). `fromBlock` supplied = trusted explicit lower bound, but the address must already resolve to a deployed zkApp (guards against typos backfilling forever). A *mismatched* VK is rejected (HTTP 400) on both subscribe paths when `MINAGUARD_VK_HASH` is set (`routes.ts`); only a *missing* VK is tolerated, so the user may still subscribe before the deploy tx lands.

The `rescanUnreadyContracts` loop re-scans `[discoveredAtBlock, latestHeight]` every tick until
events land. First event flips `ready = true` and the contract joins the forward sweep.

### Event pipeline

`syncSingleContract(contractId, address, from, to)`:

1. **Fetch** decoded events via `fetchDecodedContractEvents` (archive GraphQL). Each event carries `txMemo` (the base58-encoded transaction memo from the archive).
2. **Reverse per-tx groups** (`reverseEventsWithinEachTx`). o1js returns events within a single tx in newest-first order; the contract emits them oldest-first. Cross-tx ordering is preserved. This matters for multi-receiver proposals — reversed `receiver` indices break the off-chain proposal-hash recomputation on approve.
3. **Stable sort by type** (`setup`/`setupOwner`/`proposal`/`approval`/`receiver`/`execution`/...). Ensures a `proposal` row exists before its `approval`/`receiver`/`execution` children are processed within the same batch.
4. **Dedupe by fingerprint** (`address::type::blockHeight::txHash::payload`). `EventRaw.fingerprint` is unique; second writer is a no-op.
5. **Upsert BlockHeader** for the event's `(height, blockHash, parentHash)`. First writer wins; mismatches across events at the same height get caught by the next tick's reorg detector.
6. **Insert EventRaw** and dispatch to the appropriate `apply*` handler.
7. **Flip `ready`** if any event was ingested.

### Data model

Two kinds of tables. Full schema in `prisma/schema.prisma` (PostgreSQL) /
`prisma/schema.sqlite.prisma` (desktop). The schema is **append-only where state mutates**:
instead of patching a "current state" row, every mutation inserts a new row stamped with the
block it became valid at. Current state is the latest row; reorg rollback is a single
`DELETE WHERE > forkHeight`.

**Append-only history.** Every mutation gets a new row stamped with `validFromBlock` +
`eventOrder`. Current state = latest row by `(validFromBlock DESC, eventOrder DESC)`.

- **`BlockHeader`** — `(height, blockHash, parentHash)`. Only populated at heights with MinaGuard activity. Raw material for reorg detection.
- **`ContractConfig`** — full snapshot of `threshold`, `numOwners`, `nonce`, `parentNonce`, `configNonce`, `delegate`, `childMultiSigEnabled`, `ownersCommitment`, `networkId`. `appendContractConfigSnapshot` copies the latest row forward and overlays changes, so every row is a complete point-in-time view. Read routes use the latest row.
- **`OwnerMembership`** — `{address, action: 'added'|'removed', index?}`. Active owners = reduce memberships per address, keep addresses whose latest action is `added`.
- **`ProposalExecution`** — unique per proposal (`@@unique([proposalId])`); upserted when an `execution` event is ingested. Its existence is what makes a proposal `executed`.
- **`Approval`** — unique per `(proposalId, approver)`; upserted so duplicate approval events from reorgs/retries don't inflate counts.
- **`EventRaw`** — raw per-event record, unique by `fingerprint`. Source of truth for replay/debug; `payload` stored as a JSON string.

**Identity / pointer.**

- **`Contract`** — `(address, parent?, ready, discoveredAtBlock, ...)`. Identity + latest-synced metadata. `parent` set from `setup.parent` (null/EMPTY for root guards).
- **`Proposal`** — `(contractId, proposalHash, ...)`, unique per `@@unique([contractId, proposalHash])`. Identity + propose-time fields (`proposer`, `toAddress`, `tokenId`, `txType`, `data`, `nonce`, `configNonce`, `expirySlot`, `networkId`, `guardAddress`, `destination`, `childAccount`, `memo`/`memoHash`/`executionMemoHash`, `createdAtBlock`), plus last-submitted approve/execute tx hashes and error fields for UI polling. `ProposalReceiver` child rows carry per-slot receivers from `receiver` events (padded empties skipped); for governance proposals slot 0 is mirrored onto `Proposal.toAddress`. **There is no stored status column** — status is derived at read time (see [Proposal status](#proposal-status)).
- **`IndexerCursor`** — key/value rows. `indexed_height` is the forward-sweep cursor. `archive_discovered_height` is the archive-discovery high-water mark, tracked separately so that switching `DISCOVERY_BACKEND` from `daemon` to `archive` triggers a from-genesis sweep instead of inheriting the (much narrower) daemon cursor position.

**Memo lifecycle.** The on-chain `TransactionProposal` struct includes a `memoHash` field
(Poseidon hash of the UTF-8 memo bytes). The plaintext memo is not stored on-chain — it travels
as the Mina transaction memo set by the wallet.

- **Proposal creation**: the proposer sets the memo as the transaction memo. The indexer decodes `txMemo` (base58 → plaintext via `decodeTxMemo`) and stores it as `Proposal.memo`; the `memoHash` from the `ProposalEvent` is stored separately. If decoding fails, the raw base58 string is stored as a fallback (display-only; the authoritative hash is always `memoHash` from the event).
- **Execution**: the executor's wallet sets the same memo. The indexer decodes `txMemo`, hashes it via `memoToField`, and stores the result as `Proposal.executionMemoHash`. At read time, `computeMemoExecutionMatch` compares `memoHash === executionMemoHash` → `true`/`false`/`null`.
- **No-memo proposals**: `memoToField('')` returns `Field(0)`, so `memoHash` is `"0"`. The UI treats `"0"` as absent and hides the memo row.

The two memo match flags are computed **by this untrusted indexer**, not the contract. They defend
against an *honest* indexer that dropped or mismatched a memo; a *lying* indexer can serve a
self-consistent triple, so the on-screen memo is strictly advisory. The action path (approve/execute)
is contract-protected regardless — see [`ui-audit-guide.md`](./ui-audit-guide.md) focus point 3 for
the full analysis.

**Cross-contract execution (REMOTE path).** Child-lifecycle methods (`executeSetupChild`,
`executeReclaimToParent`, `executeDestroy`, `executeEnableChildMultiSig`) emit `ExecutionEvent` on
the **child** guard, but the `Proposal` row lives under the **parent**. `applyExecutionEvent`:

1. Try `(contractId, proposalHash)` local lookup.
2. On miss, walk `child.parent` → parent contract → retry `(parent.id, proposalHash)`.
3. Upsert `ProposalExecution` and `executionMemoHash` against whichever matched.

In lite mode, a `proposal` event for `txType = 5` (CREATE_CHILD) eagerly inserts the child's
`Contract` row so the parent's execution event can be matched later. Without this, the child address
would never be tracked and the parent proposal would stay pending forever.

---

## Threat model & assumptions

The backend is **untrusted for integrity and trusted only for availability**. It holds no signing
keys, performs no on-chain mutations, and every byte it serves is re-derivable from public chain
events. The security argument is entirely about *bounding* what a compromised or buggy backend can
do, not preventing compromise:

- **Integrity is enforced downstream.** Clients re-hash the proposal they rebuild from indexer data and sign that hash; the contract re-hashes on-chain. Tampered fields → wrong hash → failed tx. So the backend cannot induce a wrong approval or execution.
- **The damage ceiling is censorship / DoS / display lies.** Hiding proposals, serving stale state, or lying on a display-only surface (the memo badge). None of these can move funds.
- **The read API is the only exposed surface.** The write routes are narrow: tx-hash submissions (backend-local polling state), lite-mode subscribe/unsubscribe (indexer scope), and lightnet `POST /api/fund` (test-only, gated on `LIGHTNET_ACCOUNT_MANAGER`).

### Suggested focus points

**1. Reorg safety of the append-only model.** Every mutable row is stamped with the block it
became valid at, and rollback is a single `DELETE WHERE > forkHeight` inside one transaction.
Audit whether any write path inserts a row *without* a `validFromBlock`/`discoveredAtBlock`/
`blockHeight` stamp (which rollback would then miss), and whether `Contract` rows are correctly
deleted by `discoveredAtBlock` so orphaned pending deploys don't linger.

**2. Cursor advancement gating.** The forward cursor advances only if the whole tick succeeds, and
the `archive_discovered_height` cursor advances only if **zero** candidates failed. Confirm no path
advances a cursor past unprocessed or failed work — that would silently drop events/deploys past the
cursor forever.

**3. Dropped-tx classification is fail-safe.** A submission is marked dropped only when *both*
lookups positively succeed (a genuine `pending` from `fetchZkappTxStatus` — an `unknown` is not
treated as absent — **and** a real mempool set, `null` on network failure). Verify neither lookup
failing can misclassify an included tx as dropped, since that flag releases the UI signer lock.

**4. VK-hash filtering.** Discovery filters candidates by `MINAGUARD_VK_HASH` (required for archive,
optional for daemon), and re-verifies the on-chain VK per candidate. Confirm a wrong/stale hash
degrades to "discovers nothing" rather than "tracks arbitrary zkApps", and that the network-specific
hash (`testnet=`/`mainnet=` in `contracts/.vk-hash`) matches the target chain.

### Failure semantics

- **GraphQL fetch failure during reorg check** → log, skip rollback, continue tick (the stored state may still be valid).
- **GraphQL fetch failure mid-tick** → caught at `tick()` boundary, `lastError` set, cursor not advanced. Next tick retries.
- **Per-candidate discovery failure** → caught inside `processCandidateAddresses` so one bad candidate (archive-node-api hiccup during backfill, transient daemon error during VK fetch) doesn't abort the batch. The failure count gates the `archive_discovered_height` cursor: any failure keeps it in place so the same range is re-scanned next tick (cheap — one VK-filtered SQL; already-inserted rows dedup harmlessly).
- **Per-contract sync failure** → re-thrown from `syncKnownContracts` so the cursor stays put. Every tracked contract must sync cleanly before the cursor moves.
- **Archive postgres unavailability** → the `pg.Pool` is created with 5s connection / 30s statement timeouts and TCP keepalives, so a wedged or firewalled archive DB fails the tick quickly (surfacing in `lastError`) instead of hanging it for the kernel TCP timeout. Idle-client pool errors are logged and swallowed; the pool replaces the dead client on the next checkout.
- **Dropped-tx classification is fail-safe** → a submission is only marked dropped when both lookups positively succeed (see focus point 3). Either lookup failing leaves the submission untouched for the next tick.
- **Duplicate events** → idempotent via `EventRaw.fingerprint` unique constraint.
- **Reorg deeper than 290** → not auto-handled. Logged as `reorg deeper than detection window`; requires operator intervention. This is [accepted risk #4](./security-audit-guide.md#accepted-risks-and-known-limitations) — display-layer only, matches Mina's finality horizon.

### Surfaces for tests

Exported beyond the class so tests can drive pipeline stages directly:
`detectAndRollbackReorg(config)` (drive reorg detection with fixture `BlockHeader` rows),
`rollbackAboveFork(forkHeight)` (verify cascade deletes), `deleteContract(contractId)`
(unsubscribe cascade, lite mode), and `MinaGuardIndexer#syncSingleContract` / `#backfillContract`
(public for feeding mocked `ChainEvent[]` through the apply pipeline). See
`backend/src/tests/indexer-reorg.test.ts`, `indexer-autosubscribe.test.ts`, and
`indexer-archive-discovery.test.ts`.

---

## Operations

### Setup

```bash
cp backend/.env.example backend/.env    # create env file
bun install                              # install deps (from workspace root)
bun run --filter backend dev             # run in dev mode
```

Dev/start scripts auto-run `prisma migrate deploy` before launching the server. Requirements: a Bun or
Node toolchain capable of running workspace scripts, and access to Mina node/archive GraphQL
endpoints.

### Scripts

From `backend/`:

- `bun run dev` — auto-sync schema, then start server with `tsx watch`
- `bun run build` — compile TypeScript to `dist/`
- `bun run start` — auto-sync schema, then run compiled server
- `bun run prisma:generate` — generate Prisma client
- `bun run prisma:migrate` — run Prisma migration workflow
- `bun run prisma:push` — push schema manually
- `bun run seed:fixtures` — seed bulk synthetic UI-scaling fixtures straight into Postgres (bypasses the indexer; dev-only)

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | Express server port |
| `DATABASE_URL` | *(required)* | PostgreSQL connection URL (see `.env.example`) |
| `MINA_ENDPOINT` | *(required)* | Primary Mina daemon GraphQL endpoint |
| `ARCHIVE_ENDPOINT` | *(required)* | Primary archive(-node-api) GraphQL endpoint |
| `MINA_FALLBACK_ENDPOINT` | empty | Optional Mina fallback endpoint |
| `ARCHIVE_FALLBACK_ENDPOINT` | empty | Optional archive fallback endpoint |
| `LIGHTNET_ACCOUNT_MANAGER` | empty | Lightnet account-manager URL; enables `POST /api/fund` |
| `INDEX_POLL_INTERVAL_MS` | `15000` | Poll interval for index ticks |
| `INDEX_START_HEIGHT` | `0` | Initial cursor height when no cursor row exists |
| `INDEXER_MODE` | `full` | `full` = auto-discover contracts on every tick; `lite` = track only addresses added via the subscribe API |
| `DISCOVERY_BACKEND` | `daemon` | Candidate source for full-mode discovery: `daemon` (bestChain scan, ~290-block reach) or `archive` (direct archive-postgres SQL, unbounded history) |
| `MINAGUARD_VK_HASH` | empty | Verification key hash filter for discovery. Optional for `daemon`; **required** for `archive` (the SQL filters on it). The canonical value is committed at `contracts/.vk-hash` (two labeled entries: `testnet=` and `mainnet=`; use the one matching the target network) |
| `ARCHIVE_DB_HOST` | — | Archive postgres host (required when `DISCOVERY_BACKEND=archive`) |
| `ARCHIVE_DB_PORT` | `5432` | Archive postgres port |
| `ARCHIVE_DB_USER` | — | Archive postgres user (read-only role; required for `archive`) |
| `ARCHIVE_DB_PASSWORD` | — | Archive postgres password (required for `archive`) |
| `ARCHIVE_DB_NAME` | — | Archive postgres database name (required for `archive`) |

The archive connection is passed as discrete parts (not a URL) so passwords containing reserved
URL characters don't need percent-encoding.

### API routes

Contract-scoped read routes only surface contracts with `ready = true` (at least one MinaGuard
event ingested); speculative rows — subscribed-before-deploy addresses, eagerly inserted children
— 404 until real events land.

| Route | Purpose |
|---|---|
| `GET /health` | Process liveness (`{ ok, now }`). |
| `GET /api/indexer/status` | In-memory indexer status: `running`, `lastRunAt`, `lastSuccessfulRunAt`, `latestChainHeight`, `latestSlot`, `indexedHeight`, `lastError`, `discoveredContracts`, `indexerMode`. |
| `GET /api/tx-status?hash=<txHash>` | Looks up a submitted zkApp tx hash on bestChain (used for CREATE proposals with no `Proposal` row yet). `{ status, reason? }`, status ∈ `pending`/`included`/`failed`/`unknown` — `unknown` means the lookup failed, not confirmed absent. |
| `GET /api/contracts` | Lists tracked (`ready`) contracts merged with latest `ContractConfig` snapshot + `_count.owners`/`proposals`/`events`. Ordered `discoveredAt desc`. |
| `GET /api/contracts/:address` | One tracked contract, same enriched shape. `404` if not found or not ready. |
| `GET /api/contracts/:address/children` | Ready child contracts whose `parent` points at the address. Ordered `discoveredAt asc`. |
| `GET /api/contracts/:address/owners` | Owners, collapsing `OwnerMembership` history to latest action per address (`active = latest is "added"`). Query: `active=true\|false`. Ordered `index asc, createdAt asc`. `404` if not found. |
| `GET /api/contracts/:address/proposals` | Proposals; `status` derived at read time (filters other than `executed` applied in memory). Query: `status` (`pending`/`executed`/`expired`/`invalidated`), `limit` (1–200, default 50), `offset` (0–10000). Ordered `createdAtBlock desc, createdAt desc`. `404` if not found. |
| `GET /api/contracts/:address/proposals/:proposalHash` | Single proposal. `404` if not found. |
| `POST /api/contracts/:address/proposals/:proposalHash/submissions` | Records a fresh approve/execute tx hash for polling, clearing any prior error. Body: `{ action: "approve"\|"execute", txHash }`. |
| `GET /api/contracts/:address/proposals/:proposalHash/approvals` | Approvals for one proposal. Ordered `blockHeight asc, createdAt asc`. `404` if not found. |
| `GET /api/contracts/:address/events` | Raw `EventRaw` rows. Query: `fromBlock`, `toBlock`, `limit` (1–500, default 100), `offset` (0–50000). Ordered `blockHeight desc, createdAt desc`. `404` if not found. |
| `GET /api/account/:address/balance` | MINA balance via daemon GraphQL. `{ balance: null }` when the account doesn't exist on-chain (distinct from a real `"0"`). |
| `POST /api/fund` | Lightnet only (requires `LIGHTNET_ACCOUNT_MANAGER`). Acquires a pre-funded lightnet keypair and transfers MINA. Body: `{ address }`. |
| `POST /api/subscribe` | Lite mode only (`404` otherwise). Subscribes an address; idempotent. Body: `{ address, fromBlock? }` — supplied `fromBlock` = explicit lower bound (address must resolve to a deployed zkApp); omitted = `latestHeight - 5`, no existence check (subscribe-before-deploy). |
| `DELETE /api/subscribe/:address` | Lite mode only. Unsubscribes and deletes all tracked history, cascading to children. |
| `GET /api/offline-cli/:platform` | Downloads the offline signing CLI binary (`macos-arm64\|macos-x64\|linux-x64\|linux-arm64\|windows-x64`), building it on first request. |

Route middleware logs every request with a short id (`[api:<id>] -> …` inbound, `<- … <status> <ms>`
outbound, `!! … stack` on error) to correlate lifecycle and failures in local/dev logs.

### Proposal status

Status is computed per request in `src/proposal-record.ts`, with precedence:

1. `executed` — a `ProposalExecution` row exists
2. `expired` — `expirySlot > 0` and the current `latestSlot` is past it
3. `invalidated` — the proposal's `configNonce` is stale, or its `nonce` is no longer fresh for its execution domain (contract `nonce` for LOCAL, the child's `parentNonce` for REMOTE), compared against the latest `ContractConfig` snapshot
4. `pending` — otherwise

Deriving instead of storing means a reorg rollback can't leave a stale status behind, and expiry
needs no background job.

### Local development with Lightnet

Prerequisites: the [zkApp CLI](https://docs.minaprotocol.com/zkapps/how-to-write-a-zkapp) (`zk`
command) and lightnet running locally (`zk lightnet start`).

1. **Generate signer keys** — from `dev-helpers/`, `bun run cli.ts key gen` (once per signer); copy the output into `dev-helpers/.env` (see `.env.example`).
2. **Fund signer accounts** — once `dev-helpers/.env` has the signer public keys, `bun run cli.ts lightnet-fund` acquires funded accounts from the lightnet account manager and transfers MINA to each (parallel, waits for confirmation). Optional overrides: `LIGHTNET_ACCOUNT_MANAGER` (default `http://127.0.0.1:8181`), `MINA_ENDPOINT` (default `http://127.0.0.1:8080/graphql`).
3. **Deploy a contract** — open the UI at `http://localhost:3000/accounts/new`, fill in signers + threshold, submit the deploy tx.
4. **Start the backend** — `bun run --filter backend dev`. The indexer picks up the deployed contract and begins syncing.

### Troubleshooting

- **Reset the database** — `bun prisma db push --force-reset` (wipes all data, recreates tables).
- **`P2021` table missing** — schema not applied to the current DB: `bun run --filter backend prisma:push`, or restart with `dev`/`start` so `db:push` runs automatically.
- **No contracts discovered** — check `INDEXER_MODE` (`lite` auto-discovers nothing — use `POST /api/subscribe`), endpoint connectivity (`MINA_ENDPOINT`/`ARCHIVE_ENDPOINT`; `ARCHIVE_DB_*` for archive), `MINAGUARD_VK_HASH` (must match the deployed VK for the target network — pick `testnet=`/`mainnet=` from `contracts/.vk-hash`; stale after any circuit change), discovery reach (`daemon` sees only ~290 blocks — use `DISCOVERY_BACKEND=archive` for older deploys), and `INDEX_START_HEIGHT` vs the current activity window.
- **Indexer appears stuck** — check `GET /api/indexer/status`: `lastError` for the failure reason, `latestChainHeight` vs `indexedHeight` for lag, and server logs for GraphQL/network errors.

---

## File tree

```
backend/
├── src/
│   ├── server.ts               # Express bootstrap + middleware
│   ├── routes.ts               # API route handlers (read-heavy + narrow writes)
│   ├── request-validation.ts   # Query/body validation
│   ├── route-utils.ts          # Shared response helpers
│   ├── indexer.ts              # THE indexer: tick loop, reorg detection/rollback,
│   │                           #   discovery, event apply pipeline, pending-tx polling
│   ├── mina-client.ts          # GraphQL event decoding + direct archive-postgres discovery
│   ├── proposal-record.ts      # Read-time proposal status + memo match derivation
│   ├── config.ts               # Env loading + validation (fails fast)
│   ├── db.ts                   # Prisma client wiring
│   ├── lightnet.ts             # Lightnet account-manager helpers (POST /api/fund)
│   └── embed-entry.ts          # In-process entry point for the desktop shell (SQLite, lite mode)
│
├── prisma/
│   ├── schema.prisma           # PostgreSQL schema (hosted deployment)
│   └── schema.sqlite.prisma    # SQLite schema (desktop embed)
└── .env.example                # Env template
```

---

## Dependencies

Only the security/operationally relevant dependencies are called out; framework tooling
(`express`, `tsx`, `typescript`) is standard.

- **`@prisma/client` / `prisma`** — the ORM and schema tool. The append-only data model and its
  reorg-rollback guarantee live in the schema; migrations are applied from the committed
  baseline in `backend/prisma/migrations/` via `prisma migrate deploy` (PR #95).
- **`pg`** — direct PostgreSQL driver used **only** for `DISCOVERY_BACKEND=archive` (a read-only
  role against the Mina archive DB). The pool is hardened with connection/statement timeouts so a
  wedged archive DB fails a tick fast rather than hanging it.
- **`o1js` (`3.0.0-mesa.final`)** — used read-only to fetch and decode on-chain account state
  (`fetchOnChainState`) and to compute `memoToField` when reconciling execution memos. The backend
  never proves or signs; it reuses the contract's hashing helpers so its derived `memoHash` matches
  the circuit's.

The backend imports the `contracts` package for shared decoding helpers (`decodeTxMemo`,
`memoToField`) and enum/constant definitions, so its event interpretation matches the contract's
emission exactly.
