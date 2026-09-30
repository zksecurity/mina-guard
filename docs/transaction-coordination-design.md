# Check transaction state before broadcast

PR #144 now checks prepared transactions against the Mina node. It replaces the
activity-reporting design: no activity service, login signature, session, migration,
or sharing setting is added. The existing pending-submission UI behavior from main
is retained. This detects already-stale transactions; it does not serialize owners,
automatically retry, guarantee acceptance, or resolve deliberate starvation.

## Sending

`transaction-preflight.ts` reads each account update's explicit app-state
preconditions from the actual transaction JSON, then queries the configured Mina
node directly with no cache and a bounded timeout. This covers the roots and other
state fields actually constrained by the transaction, including parent/child
accounts and token IDs. Null preconditions are ignored. Repeated account updates
are processed in order, applying their known state writes before checking later
updates. An unconstrained deployment update can initialize a missing account before
setup in the same transaction.

- Current: continue sending, without an extra confirmation.
- Stale: do not send. Refresh eligibility and offer an explicit recovery action.
- Unavailable/malformed: do not send. Offer Retry check or Cancel. A connection
  retry retains the prepared transaction and checks it again without re-proving.

For Ledger and offline uploads the check is after signing and immediately before
the application broadcasts. Auro's existing API signs and sends in one call; the
check is immediately before handing the proven transaction to Auro, **before its
fee-payer signing prompt**. We cannot check inside that wallet-controlled interval.
Test-only direct submissions go through the same gate. No signatures or proofs are
modified by the check.

This is not full transaction simulation. Fees, balances, fee-payer nonces, expiry,
permissions and other ledger conditions can still cause rejection, as can a state
change between checking and inclusion. A matching check is never described as a
guarantee of acceptance. Node responses remain a trust/availability dependency.

## Recovery UI

A persistent inline panel appears on the transaction page. It uses the existing
palette and buttons and replaces the normal operation toast while a check is open.

- **The vault changed:** Rebuild transaction / Cancel. Rebuild keeps the original
  action and input, refreshes verified witnesses and produces another proof. It
  can request wallet signatures again. There is no automatic retry or fee increase.
- **Proposal already executed:** no rebuild. View execution links to the indexed
  execution hash, never `lastExecuteTxHash` from a submission report. If the hash
  is missing, show “Executed · transaction details syncing”.
- **This action is no longer available:** explain the observed invalidation,
  duplicate approval, missing ownership, disabled multisig, insufficient approvals,
  nonce ordering, or expiry. No substitute proposal is created.
- **Couldn’t check the vault:** Retry check / Cancel. Includes unavailable or
  incomplete indexed state needed for safe recovery.

Retry eligibility uses the worker's reconstructed Merkle stores verified against
current on-chain roots. Remote execution also checks the child's execution map.
Live permission checks remain in place. Eligibility is checked again after the
user chooses recovery; the normal transaction builder still enforces all contract
assertions. Eligibility can change again during preparation, so rebuilding is not a
promise that the next attempt will succeed. Cancelling or leaving the page while
waiting prevents that attempt from broadcasting.

## Offline flow

Exports do not make a network reservation. Upload validation still checks response
version, action, expected vault and proposal. Live broadcast policy runs before
**each** preflight attempt, including a connection retry.

For a stale approval/execution, **Export fresh request** rechecks eligibility and
uses the original signed action and fee-payer address with the proposal on the
page. It downloads a fresh request and displays:

> Fresh request downloaded. Sign it on your offline device, then upload the new signed file.

It does not sign or broadcast anything. Obsolete actions are not exported. An
imported *propose* response does not carry the original proposal form input, so the
UI asks the user to review the original form and export a fresh request rather than
inventing a replacement. Exported requests remain main's version 2; signed responses
remain version 1. The CLI and signing protocol are unchanged.

## Compatibility and validation

The UI is shared by web and desktop, and node queries use the desktop runtime
endpoint when present. The backend adds one read-only API response field,
`executionTxHash`, derived from indexed execution records. No database schema,
contract circuit, verification-key hash or o1js pointer changes are required.

Focused checks:

```sh
bun run --filter contracts build
bun run --filter backend build
cd ui && bun run test && bunx --no-install tsc --noEmit
# From the repo root:
bun e2e/preflight/browser.ts
# From backend, with MINA_NETWORK_DOMAIN=testnet:
bun test src/tests/proposal-record.test.ts
```

The browser checks use real UI/components and online wrappers with fixture
wallet/prover/node responses. They verify no broadcast on stale state, explicit
rebuild, terminal execution handling, connection retry without another proof,
offline regeneration and page-leave cancellation. Unit tests also use actual o1js
account-update serialization. These are not physical-wallet or live-chain evidence.


Validation on 2026-09-30: contracts/backend/production UI/desktop builds passed;
UI unit, offline CLI unit, proposal serialization and Chromium recovery checks
passed. The Linux directory package starts with native SQLite and reaches its
runtime node through the packaged CSP. Physical Auro/Ledger, live-chain inclusion,
macOS/Windows packaging, and the database-resetting full UI/E2E stack were not
rerun locally. No circuit changed and no new real proof was generated.
