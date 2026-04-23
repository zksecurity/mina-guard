# Indexer Architecture

Deep-dive on how `backend/src/indexer.ts` turns a stream of Mina archive events into the normalized tables in `prisma/schema.prisma`. For operator concerns (env vars, scripts, API shape), see `backend/README.md`.

## 1. Modes

The indexer runs in one of two modes, set by config at startup.

| Mode | Discovery | Backfill lower bound | Subscribe API |
|---|---|---|---|
| `full` | Scans every bestChain block for MinaGuard deployments | `indexedHeight - 300` (bestChain window) | disabled |
| `lite` | No scan; only tracks contracts added via `POST /api/subscribe` | `config.indexStartHeight` (default `0`) | enabled |

`full` is the batch indexer posture: look at the whole chain and keep everything. `lite` is the user-facing posture: only track what a user asked for, but pull full history for it.

## 2. Tick loop

`MinaGuardIndexer.tick()` runs every `INDEX_POLL_INTERVAL_MS`. One pass:

1. **Fetch latest height** — `fetchLatestBlockHeight`.
2. **Reorg check** — `detectAndRollbackReorg`. If a fork is detected, rewind cursor + delete all rows above fork height, then bail out of the tick. Next tick resumes from the rewound cursor.
3. **Read cursor** — `IndexerCursor.indexed_height` (default `indexStartHeight` if absent).
4. **Discover (full mode only)** — scan a `[latestHeight - window, latestHeight]` bestChain slice for new zkApp deployments. Window = `min(290, delta + margin)`.
5. **Rescan unready contracts** — any `Contract` with `ready = false` is re-synced from its `discoveredAtBlock` up to `latestHeight`. This is what makes subscribe-before-deploy self-healing.
6. **Forward sweep** — `syncKnownContracts(indexedHeight + 1, latestHeight)` across every tracked contract.
7. **Advance cursor** — persist `indexed_height = latestHeight`.

If any step throws, the cursor is **not** advanced, so the next tick retries the same window. Per-contract sync errors re-throw for the same reason.

## 3. Reorg handling

Mina has probabilistic finality (~290 blocks). The indexer treats anything within that window as potentially reorg-able.

**Detection** (`detectAndRollbackReorg`):
- Fetch the last `REORG_DETECTION_WINDOW` (290) bestChain headers.
- Compare against stored `BlockHeader` rows over the same height range.
- Walk descending: the fork point is the highest stored height whose hash still matches the chain. Everything above it is non-canonical.
- If every overlapping header mismatches, the reorg is deeper than visibility — log and skip (operator intervention).

**Rollback** (`rollbackAboveFork`) is one atomic transaction deleting all `> forkHeight` rows across `BlockHeader`, `EventRaw`, `ContractConfig`, `OwnerMembership`, `ProposalExecution`, `Approval`, `Proposal`, `Contract` (by `discoveredAtBlock`), and rewinding the cursor to `forkHeight`.

This is safe because every mutable table stores the block at which its row became valid (`validFromBlock`, `createdAtBlock`, `blockHeight`, `discoveredAtBlock`). No "current state" row needs patching — deleting the post-fork history is enough, and the forward sweep re-derives state from re-fetched events.

`BlockHeader` is upserted at event ingestion time. A height with no events gets no header, so reorg detection only has teeth on heights where MinaGuard activity landed — which is exactly where we need it.

## 4. Contract discovery and readiness

A `Contract` row exists in one of two states:

- **`ready = false`** — address is known (discovered or subscribed) but no MinaGuard event has been ingested yet. Hidden from most read routes.
- **`ready = true`** — flipped on first event ingestion in `syncSingleContract`. Any event other than `setup`/`setupOwner` proves the contract actually initialized on-chain.

`ready` exists because a `Contract` row can be inserted speculatively — a user subscribing before the deploy tx lands, or `applyProposalEvent` eagerly inserting a child on a CREATE_CHILD proposal before `executeSetupChild` actually runs. Read routes filter on `ready = true` so these speculative rows don't surface as ghost UI entries, while the unready-rescan loop keeps polling their address range until real events land and promote them.

Two ways to become tracked:

- **Full mode discovery**: `discoverCandidateAddresses` scans recent blocks, `fetchVerificationKeyHash` confirms it's a zkApp, and the hash is optionally matched against `MINAGUARD_VK_HASH`. Backfill window is `max(0, indexedHeight - 300)`.
- **Lite mode subscribe**: user calls `POST /api/subscribe { address, fromBlock? }`. `fromBlock` omitted = `latestHeight - 5` (margin to cover a block landing mid-request). `fromBlock` supplied = trusted explicit lower bound, but the address must already resolve to a deployed zkApp (guards against typos backfilling forever). VK hash is **not** checked on subscribe — the user may subscribe before the deploy tx lands.

The `rescanUnreadyContracts` loop re-scans `[discoveredAtBlock, latestHeight]` every tick until events land. First event flips `ready = true` and the contract joins the forward sweep.

## 5. Event pipeline

`syncSingleContract(contractId, address, from, to)`:

1. **Fetch** decoded events via `fetchDecodedContractEvents` (archive GraphQL).
2. **Reverse per-tx groups** (`reverseEventsWithinEachTx`). o1js returns events within a single tx in newest-first order; the contract emits them oldest-first. Cross-tx ordering is preserved. This matters for multi-receiver proposals — reversed `receiver` indices break the off-chain proposal-hash recomputation on approve.
3. **Stable sort by type** (`setup`/`setupOwner`/`proposal`/`approval`/`receiver`/`execution`/...). Ensures a `proposal` row exists before its `approval`/`receiver`/`execution` children are processed within the same batch.
4. **Dedupe by fingerprint** (`address::type::blockHeight::txHash::payload`). `EventRaw.fingerprint` is unique; second writer is a no-op.
5. **Upsert BlockHeader** for the event's `(height, blockHash, parentHash)`. First writer wins; mismatches across events at the same height get caught by the next tick's reorg detector.
6. **Insert EventRaw** and dispatch to the appropriate `apply*` handler.
7. **Flip `ready`** if any event was ingested.

## 6. Data model

Two kinds of tables:

### Append-only history

Every mutation gets a new row stamped with `validFromBlock` + `eventOrder`. Current state = latest row by `(validFromBlock DESC, eventOrder DESC)`. Rollback on reorg is a single `DELETE WHERE > forkHeight`.

- **`BlockHeader`** — `(height, blockHash, parentHash)`. Only populated at heights with MinaGuard activity.
- **`ContractConfig`** — full snapshot of `threshold`, `numOwners`, `configNonce`, `delegate`, `childMultiSigEnabled`, `ownersCommitment`, `networkId`. `appendContractConfigSnapshot` copies the latest row forward and overlays changes, so every row is a complete point-in-time view.
- **`OwnerMembership`** — `{address, action: 'added'|'removed', index?}`. Active owners = reduce memberships per address, keep addresses whose latest action is `added`.
- **`ProposalExecution`** — unique per proposal; upserted when an `execution` event is ingested.
- **`Approval`** — unique per `(proposalId, approver)`; upserted so duplicate approval events from reorgs/retries don't inflate counts.
- **`EventRaw`** — raw per-event record, unique by `fingerprint`. Source of truth for replay/debug.

### Identity / pointer

- **`Contract`** — `(address, parent?, ready, discoveredAtBlock, ...)`. Identity + latest-synced metadata. `parent` set from `setup.parent` (null/EMPTY for root guards).
- **`Proposal`** — `(contractId, proposalHash, ...)`. Identity + propose-time fields. `ProposalReceiver` child rows carry per-slot receivers from `receiver` events (padded empties skipped). For governance proposals (addOwner/removeOwner/setDelegate), slot 0 is mirrored onto `Proposal.toAddress`.
- **`IndexerCursor`** — single row `key = 'indexed_height'`.

### Cross-contract execution (REMOTE path)

Child-lifecycle methods (`executeSetupChild`, `executeReclaim`, `executeDestroy`, `executeEnableChildMultiSig`) emit `ExecutionEvent` on the **child** guard, but the `Proposal` row lives under the **parent**. `applyExecutionEvent`:

1. Try `(contractId, proposalHash)` local lookup.
2. On miss, walk `child.parent` → parent contract → retry `(parent.id, proposalHash)`.
3. Upsert `ProposalExecution` against whichever matched.

In lite mode, a `proposal` event for `txType = 5` (CREATE_CHILD) eagerly inserts the child's `Contract` row so the parent's execution event can be matched later. Without this, the child address would never be tracked and the parent proposal would stay pending forever.

## 7. Failure semantics

- **GraphQL fetch failure during reorg check** → log, skip rollback, continue tick (the stored state may still be valid).
- **GraphQL fetch failure mid-tick** → caught at `tick()` boundary, `lastError` set, cursor not advanced. Next tick retries.
- **Per-contract sync failure** → re-thrown from `syncKnownContracts` so the cursor stays put. Every tracked contract must sync cleanly before the cursor moves.
- **Duplicate events** → idempotent via `EventRaw.fingerprint` unique constraint.
- **Reorg deeper than 290** → not auto-handled. Logged as `reorg deeper than detection window`.

## 8. Surfaces for tests

Exported beyond the class so tests can drive pipeline stages directly:

- `detectAndRollbackReorg(config)` — drive reorg detection with fixture `BlockHeader` rows.
- `rollbackAboveFork(forkHeight)` — verify cascade deletes.
- `deleteContract(contractId)` — unsubscribe cascade (lite mode).
- `MinaGuardIndexer#syncSingleContract` / `#backfillContract` — public for feeding mocked `ChainEvent[]` through the apply pipeline.

See `backend/src/tests/indexer-reorg.test.ts` and `backend/src/tests/indexer-autosubscribe.test.ts` for usage.
