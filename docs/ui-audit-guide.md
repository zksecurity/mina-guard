# Online UI — Architecture & Security Notes

Online creation checks whether the exact proposal already exists before requesting a signature, and again when assessing a stale transaction. The recovery panel offers **View proposal** so another owner can approve the existing proposal. Propose and approve recheck their indexed witnesses against fresh vault state after the proposal signature, before building the transaction.

Initial verified-store mismatches show “Vault data isn’t up to date” with **Retry / Cancel**. Retry restarts online preparation or offline request export from current state and indexed stores; it never bypasses root validation or retries automatically. Network and unrelated errors are not classified as store mismatches.


**Pre-broadcast state checks:** the actual transaction app-state preconditions are compared with fresh node state before sending (before Auro wallet handoff). Stale transactions require explicit, eligibility-checked recovery. A deploy target that exists without zkApp state (the node answers `zkappState: null` for an account a payment created) is read as all zeros, as the chain reads it, so a deployment into it is checked like any other; an answer that omits the field blocks the broadcast. Node failures block broadcast; a successful check does not guarantee inclusion. See [design and boundaries](transaction-coordination-design.md). Permission-loading notices on vault and proposal pages are delayed and neutral; action gates remain fail-closed.

Online progress follows the submission boundary: Auro shows “Checking latest vault state…” after proving, then “Waiting for wallet confirmation…” only after the check passes. Ledger requests wallet confirmation first, checks the signed transaction, then shows “Broadcasting transaction…”. Early store/root mismatches offer explicit Retry / Cancel; the post-proof check uses the recovery panel.

This document describes the **online web UI** (`ui/`) — the Next.js app that
MinaGuard owners use to connect a wallet, deploy vaults, and run the propose →
approve → execute lifecycle against a live Mina network.

The air-gapped path is documented in [`offline-audit-guide.md`](./offline-audit-guide.md), and
the self-contained desktop build of this same UI in
[`desktop-audit-guide.md`](./desktop-audit-guide.md).

---

## General overview

The online UI is the main interface for users to interact with the MinaGuard contract
and manage their vaults. While it depends on a backend to retrieve information,
it is important to note that **the trust anchor is the contract**. All critical operations,
such as proposal creation, approval, and execution are submitted and validated on-chain.

Users have the option of connecting with Auro wallet or Ledger wallet. In the online UI first
page, they should be able to see all their deployed vaults.

**Vault display assumption.** The backend indexer tracks *every* vault it knows about with
no owner filter; the "which vaults are mine" decision is made entirely client-side by
intersecting the connected address against each vault's active owner set. Vaults are shown
as a **forest of trees** (a root vault with its children nested underneath). The controlling
rule is: **a whole tree is visible if the connected wallet owns *any* node in it** — the root
or any child. Concretely, the UI walks up from each vault the wallet owns to its root, then
renders that root's *entire* subtree, including sibling children the wallet does **not** own
(`buildOwnedForest`, `app/page.tsx:37-83`).
Those non-owned nodes are still displayed, marked **"View-only"**. So owning a single child
surfaces its parent and all siblings; conversely, if the wallet owns nothing in a tree, the
whole tree is hidden. Tree depth is capped at 2 (children cannot themselves have children),
and the header vault *count* is stricter than tree visibility — it counts only directly-owned
vaults, so a tree surfaced solely via an owned child is visible but not counted.

**Propose → approve → execute is a direct on-chain flow.** These three steps are the vault
lifecycle, and each one is an independent transaction that the browser/worker **builds,
proves, and submits directly to the Mina node** — never through the backend. The backend is a
read-only indexer: it is queried to reconstruct proposal data and Merkle witnesses, but it
never relays a transaction, and any data it tampers with is caught on-chain (a bad
reconstruction is refused before proving: the worker checks the rebuilt stores against the
vault's on-chain state). *Propose* creates the proposal and
auto-records the proposer's own approval in the same transaction (propose == create + first
approval). *Approve* has each additional owner rebuild the proposal struct from indexer data,
re-hash it, and sign that hash — the contract re-hashes on-chain and rejects any mismatch, so
a lying indexer cannot get an owner to approve something other than what was proposed. Once
approvals reach the threshold, *execute* is permissionless: anyone can submit it, the contract
re-checks threshold and moves funds / applies the governance change. In all three, what an
owner actually **signs is an application-tagged, action-specific digest of the proposal hash — a single `Field`** (blind signing; see the
threat model), not the human-readable transaction.

For an ordinary transfer to new recipient accounts, the executor pays their
account-creation costs from their own wallet, in addition to the transaction
fee; the vault does not reimburse them. The transfer form and proposal detail
warn owners before approval. Before online execution the UI checks recipient
accounts again and asks the executor to confirm the estimated extra cost.
Account existence can change before inclusion, and an unexecuted next-nonce
proposal can delay later proposals. See the accepted risk in
[`security-audit-guide.md`](./security-audit-guide.md#accepted-risks-and-known-limitations).

**Proposal deadlines apply to all three stages.** The shared contract rejects
expiry values outside `0..4294967295`. Zero means no expiry; a non-zero deadline
requires proposing, approving, and executing transactions to be included at or
before that slot. The ledger checks the slot at inclusion, so an approval built
before expiry can still be rejected when submitted later. Online workers and
the offline CLI use the same contract methods; see
[`offline-audit-guide.md`](./offline-audit-guide.md). Proposal hashes, events,
and bundle formats are unchanged. This circuit change requires regenerated
per-network verification-key hashes and matching UI, offline CLI, and desktop
builds before release; existing deployed vaults retain their old behavior.

**Execution preflight warnings apply only to pending proposals.** The detail page
checks Add Owner targets and commitments against the current owner list, Create
SubVault configuration against its signed data, and transfer/allocate/reclaim
amounts against the source's current balance. An executed Add Owner already added
its owner, and an executed payment may have spent its balance; those current-state
checks cannot establish whether a historical proposal was executable. Leaving
pending skips these page checks, ignores in-flight results, and immediately hides
their existing warnings. Pending-proposal validation and independent worker/CLI
checks before signing remain unchanged. Memo integrity and live Vault permission
warnings are separate checks and remain visible on historical proposals.

Add Owner and Create SubVault safety checks remain valid across polling refreshes
unless the proposal or relevant Vault state changes. Unchanged refreshes retain
known failures and their approval/export blocks. Unavailable checks retry after
ten seconds without clearing their warning or overlapping requests. Changing
the proposal, its status, the network, Vault address, or owner configuration
discards late results and cancels scheduled retries;
the signing worker/CLI still performs its own validation.

**The memo has three roles, and only one is enforced on-chain.** The short note a user attaches
to a proposal shows up as (1) a **hashed** `memoHash` bound into the proposal (the only value
owners' signatures cover), (2) an unconstrained **broadcast** fee-payer memo on the outer
transaction, and (3) the **displayed** plaintext the indexer decodes from that transaction.
Nothing in the circuit ties (2)/(3) to (1), so they can diverge. The browser hashes the displayed
text itself and compares it with (1); the indexer compares the broadcast memo of the execution;
`MemoWarningTooltip` shows the result. Takeaway: **only a memo whose displayed
value matches the on-chain hash was actually approved by the multisig** — the plaintext shown or
broadcast is advisory. (Mechanics in focus point 3.)

**Proposal "deletion" and the `CREATE_CHILD` edge case.** There is no on-chain delete method:
"deleting" a pending proposal means minting a zero-value proposal that reuses the target's
nonce and racing it to execution, since a nonce can only be spent once. This can't work for
`CREATE_CHILD` (pinned to `nonce == 0`), so the UI disables Delete for it
(`app/transactions/[id]/page.tsx:307-310`). Because the child is already deployed and
`reserveForParent()`'d (write-once) in the same propose tx, abandoning such a proposal leaves
an **orphaned child account** — the creation fee is spent, and the account is not reusable or
reclaimable.

## Architecture

```
  ┌──────────────┐   read-only JSON    ┌──────────────┐
  │  Browser UI  │◀───────────────────▶│   Backend    │  (indexer / read API)
  │  (Next.js)   │      HTTP           │  Express     │
  └──────┬───────┘                     └──────────────┘
         │ Comlink (postMessage)
  ┌──────▼───────┐
  │  Web Worker  │  o1js compile + prove
  └──────┬───────┘
         │ proxied callbacks
  ┌──────▼───────┐   sign fields /     ┌──────────────┐
  │  Signer      │   fee payer / tx    │  Mina daemon │
  │  Auro/Ledger │────────────────────▶│  GraphQL     │  (broadcast)
  └──────────────┘                     └──────────────┘
```

- **The UI does not persist signing keys.** Owner keys live in Auro or on the
  Ledger. The UI generates a zkApp deploy key in-browser and offers a creation-time
  local download before creation. The creator may retain that key for recovery;
  it remains a latent verification-key authority after a transaction-version upgrade.
- **Heavy crypto runs in a Web Worker.** The worker compiles the contract and
  generates proofs. It calls *back* to the main thread for anything requiring a
  signer or network egress, via Comlink-proxied callbacks.
- **The compile cache is untrusted; the compile *output* is what's checked.**
  `idb-compile-cache.ts` matches a blob's `uniqueId` against `__manifest__`, which sits in the same
  IndexedDB — so it can't prove a blob belongs to the id it's served under, and anything able to write
  same-origin IndexedDB can swap the keys o1js compiles from. Rather than authenticate each entry, the
  worker checks the resulting verification key against `NEXT_PUBLIC_MINAGUARD_VK_HASH`, failing the
  compile and clearing the cache on mismatch. Pre-deploy is the window that matters: `zkApp.deploy()`
  installs whatever key compile produced, while afterwards a swap only yields proofs that fail on-chain.
  Unset ⇒ skipped, like the backend's `minaguardVkHash`.
- **The backend is not trusted for integrity.** Data from the backend is used to construct
  transactions and display information. Before exposing vault actions, the browser queries the configured
  Mina node directly and compares the account's verification key and every stored permission against its
  built-in MinaGuard policy. Missing fields, RPC failures, or any mismatch fail closed. This check also runs
  against a proposed child before CREATE_CHILD approval or execution. Security-critical operations, such as
  proposal creation, approval, and execution, are performed on-chain. Transactions are also submitted
  directly to the node.
  The values an owner reads next to Approve are derived in the browser from the receivers the
  proposal hash commits to (`toProposal` in `api.ts`): the recipient count, the total, the
  amount used for the Vault balance check, and the governance target (`receivers[0]`). Rows
  beyond the nine receiver slots are dropped there, since the worker signs only those. The
  indexer's precomputed copies of those values are ignored. The worker refuses a proposal whose
  transaction type it does not recognize (`requireTxType`) instead of building it as a transfer.
  The chainless UI regression checks the child-specific permission alert and verifies that both online
  approval and offline bundle creation/broadcast remain unavailable for an unsafe CREATE_CHILD target,
  and that a CREATE_CHILD approval shows the SubVault owners and threshold and keeps Approve disabled
  until they are verified.
- **Interactions with the chain.** Interactions with the chain, like transactions submitted, reach the node
  directly. Note, however, that:
  - Transactions submitted through Auro wallet reach the node endpoint defined by Auro.
  - Transactions submitted through the Ledger/offline-CLI flow reach the endpoints defined in the frontend
    code (`lib/endpoints.ts`: `NEXT_PUBLIC_MINA_ENDPOINT`/`NEXT_PUBLIC_ARCHIVE_ENDPOINT` baked in at build
    time; the desktop shell overrides them at runtime via an injected `window.__minaGuardConfig`).
- **The circuit's network domain is a build-time constant — the most security-relevant UI build var.**
  `NEXT_PUBLIC_MINA_NETWORK` selects the compile-time `NETWORK_DOMAIN` baked into every
  proposal hash *and* into the per-network verification key (`contracts/src/constants.ts`, which reads
  `NEXT_PUBLIC_MINA_NETWORK ?? MINA_NETWORK_DOMAIN`; only the `NEXT_PUBLIC_` form is inlined into
  browser code — a bare `MINA_NETWORK_DOMAIN` is not available there).
  The network must be explicitly set to `mainnet`, `testnet`, or `devnet`; missing, invalid, or
  conflicting values abort compilation. `next build` rejects a missing or invalid
  value, or a mismatch with `MINA_NETWORK_DOMAIN` when it is also set.
  The chosen domain must match the build's node network
  and expected VK hash. The worker rejects a desktop runtime networkId outside
  its baked-in proof domain. Mainnet uses `Field(1)`; testnet and devnet retain
  the existing `Field(2)` domain and VK. Auro's existing live wallet check
  compares mainnet versus non-mainnet after extracting the short network name;
  it does not validate the wallet's chain namespace. Build-time domain validation
  does not change that wallet check or establish the wallet's actual chain identity.
  V1 offline exporters explicitly map devnet to the shared `testnet` bundle domain
  without changing the snapshot endpoint, and reject unknown runtime networks.
  `bun run --filter ui test` covers this behavior for propose, approve, and execute;
  the CI test job runs that script.
  The other build-time `NEXT_PUBLIC_*` Next inlines into the bundle: `NEXT_PUBLIC_MINA_NETWORK` (o1js
  network id / fee-payer signature domain), `NEXT_PUBLIC_MINA_ENDPOINT` / `NEXT_PUBLIC_ARCHIVE_ENDPOINT`
  (node / archive), `NEXT_PUBLIC_API_BASE_URL` (backend read API), `NEXT_PUBLIC_BLOCK_EXPLORER_URL`,
  `NEXT_PUBLIC_POLL_INTERVAL_MS`, `NEXT_PUBLIC_INDEXER_MODE` (`full` vs `lite`),
  `NEXT_PUBLIC_OFFLINE_CLI_RELEASE_URL`, `NEXT_PUBLIC_MINAGUARD_VK_HASH` (expected compile output — see
  above; stale ⇒ every compile fails), and the test-only `NEXT_PUBLIC_E2E_TEST`. Only the Mina/archive
  endpoints and networkId can be supplied at runtime by the desktop shell
  (`window.__minaGuardConfig`), but the worker rejects a networkId different
  from its compiled domain. The circuit domain itself is fixed at build time.

---

## Threat model & assumptions

Assuming that the frontend (UI) is not compromised, the interactions are the following:

- **Main Thread <-> Web Worker.** Same origin, Comlink over `postMessage`.
- **Backend (indexer).** Read-only, *untrusted*. The indexer is used to retrieve on-chain
  data and events. The indexer cannot affect critical operations. For example, consider
  a propose-approve-execute flow:
  - The UI does not rely on the indexer's `permissionsVerified` flag as its trust anchor. It independently
    reads the account's verification key and complete permission vector from Mina before enabling actions.
  - Proposal is created in the UI and submitted directly to the node. The contract acts
    as the trust anchor here.
  - Owners see the proposal data (controlled by the indexer) and may choose to approve. A
    potential mismatch between what the indexer returned and what the original proposal contained
    will be caught by the contract, and will be invalid.
  - Similarly for execution.
- **Signer**. For zkAppCommand signatures, blind signing is required. That is, the user only sees a
  Field element before signing. Hence, an uncompromised frontend is of critical importance.
  For this reason, there is also the option of running a self-contained version
  of the app — the desktop build, documented in [`desktop-audit-guide.md`](./desktop-audit-guide.md).
 There are three ways to sign:
  - **Auro wallet.** Used for signing and submitting transactions, as a browser extension. For submitting
    the transaction (fees etc.), the user can see the data and confirm. For zkAppCommand signature, the signature
    is blind. That is, the user only sees a Field element before signing.
  - **Ledger wallet.** Used for signing, through WebHID. Transactions are submitted through the node endpoints
    defined in the frontend code. Due to interface restrictions, signatures are again blind.
  - **Offline-CLI.** Used for signing with a key on a different device (e.g. air-gapped). A bundle is exported
    and is assumed to be transported through an *untrusted* medium. Documented in
    [`offline-audit-guide.md`](./offline-audit-guide.md).


#### Suggested focus points

**1. The signer boundary (`lib/multisigClient.ts` ↔ `lib/ledgerWallet.ts` / `lib/auroWallet.ts`).**
The worker (`multisigClient.worker.ts`) constructs every transaction and every
field/commitment and hands them across a Comlink boundary to be signed; since
zkApp approvals are blind (a single `Field`), whatever decides what reaches
the signer decides what the user authorizes. The moving parts:
  - `ledgerWallet.signFields` signs only `fields[0]` (`ledgerWallet.ts:186-198`)
    while echoing the full input array back; call sites pass a single-element
    array (the action-specific proposal signing message).
  - Signature reconstruction differs per wallet: Ledger `{field, scalar}`
    decimals are reassembled into an o1js `Signature` (`worker.ts:240-243`,
    `627-630`); Auro returns base58.
  - `ledgerNetworkId` is process-global mutable state (`ledgerWallet.ts:10-16`)
    that has to match the network the tx is built for (that network is now
    fixed by the deployment build, not user-selectable — see #119 below).
  - `broadcastWithLedgerSig` reuses the one fee-payer signature for any
    fee-payer-owned account update with `useFullCommitment`
    (`worker.ts:617-657`; reuse loop `637-645`).

**2. Atomicity of deploy + setup, and of CREATE_CHILD.**

Child reservation enforces the same governance bounds as initialization and rejects
self-parenting or a parent without initialized root state. The parent's owners
commitment and empty parent field are ledger preconditions, not only client
checks. Successful child setup clears the consumed `reservedConfigHash`; consumers
must use initialized state and events for the active configuration. Method arguments,
proposal hashes, events, and offline bundle formats are unchanged. The circuit and
verification keys change, so UI, offline CLI, and desktop builds must use the matching
per-network CI-generated `contracts/.vk-hash`; older deployed verification keys are not upgraded
by this source change.

A guard that is deployed but not yet configured could be controlled by whoever
calls `setup()` first.
  - Top-level vaults use the atomic `deployAndSetupContract` — one tx doing
    `fundNewAccount` + `deploy` + `setup`; the worker exposes no separate
    deploy-only or setup-only API. The creation fee is paid only when the node
    has no account at the address (`classifyDeployTarget`, `lib/deploy-target.ts`):
    anyone can create the bare account first by paying into it, which fails a
    deployment that declares a new account, so a bare account is deployed into
    as it is, and an address that already carries a verification key or app
    state is refused. The same rule applies to the child in CREATE_CHILD.
  - CREATE_CHILD spans two transactions by design: the propose tx does
    `deploy(child)` + `reserveForParent(child)` + `propose(parent)` atomically
    (`worker.ts:979-1003`); the later `executeSetupChild` is bound on-chain to
    the config `reserveForParent()` committed (`MinaGuard.ts:736-760`,
    write-once guards `743-744`, commit `759-760`; binding checks `818`,
    `823-825`). The worker pre-flights the announced config against
    `proposal.data` (`worker.ts:1248-1254`).
  - Account-creation fees on execute are counted from the hash-bound
    `proposalStruct.receivers`, never the raw backend array
    (`worker.ts:1142-1153`), so indexer rows beyond `MAX_RECEIVERS` can't
    inflate the executor-signed fee. A receiver counts as new only when the
    node answers "no such account" (`receiverExists`); any other node error
    stops the build, since a wrong guess fails the transaction after proving.

**3. Indexer-supplied data feeding into signed transactions.**
The backend is untrusted (see threat model), yet its data rebuilds the Merkle
stores and proposal structs that get hashed and signed
(`rebuildStoresFromBackend` uses `IncrementalStoreCache` and the shared
`rebuildStores`; `buildProposalStruct` includes memoHash). The worker persists
public store checkpoints in IndexedDB, scoped to node/archive endpoints, network,
expected VK and vault address, and fetches only blocks after the last saved event
block. The existing offset API supplies bounded pages; failed reads and ranges
exceeding its 50,000-offset cap are rejected. Stable cursor pagination is tracked
separately in [#143](https://github.com/zksecurity/mina-guard/issues/143). Corrupt caches,
reorgs or mismatched roots trigger one full replay; another mismatch refuses the
operation. Storage failures fall back to verified in-memory operation. Unknown
legacy event heights disable incremental reuse. A bounded four-vault memory cache
avoids rehashing old leaves during warm operations; cold restore still rebuilds
trees from saved leaves. Offline export uses this same worker path to produce
version 2 request snapshots. Export rejects unknown runtime networks before worker
access or account reads; devnet uses the shared testnet proof domain. The offline
CLI independently reconstructs and checks
them against bundled account snapshots (see the offline audit guide). Child
execution maps and child reservation configuration still replay child events.
Reservation `proposalHash` values are caller-supplied labels. The UI fetches a
reservation by child address, checks its recomputed configuration hash against
the parent-approved `CREATE_CHILD` proposal data, and shows the reserved owners
and threshold on the proposal page. Approval, execution and offline export wait
until that check passes (an unindexed reservation blocks, it does not pass), and
the approve bundle carries the checked configuration for the CLI. For the other
REMOTE proposals the backend reports whether it has indexed the target SubVault
(`childTargetIndexed`); an unindexed target blocks approval, execution and
offline export on the detail page until the backend catches up, since the
proposal's freshness cannot be judged without the SubVault's state. The rebuild does not depend on delivery order: approval
leaves keep the largest value seen, owners come from the emitted setup slot index,
and owner changes replay in `configNonce` order with each insert placed where the
emitted post-change commitment says. Before any proof the worker compares the
rebuilt owner commitment, approval root and nullifier root with the vault state it
reads from the Mina node, and on SubVault paths the parent's approval root and the
child's execution root (`assertStoresMatchChain`,
`assertChildExecutionMapMatchesChain`); a mismatch refuses with a retry message,
naming the first block whose emitted roots disagree. On action paths the recomputed `proposalHash` must key
into a proposal that exists on-chain and the owner's signature covers it
(`MinaGuard.ts:1011`, `1014`, `1032`), so the contract re-checks what the
indexer supplied. The client also guards this seam locally: on
approve/execute/child paths the worker asserts that the struct it rebuilt from
indexer data hashes to the indexer-claimed `proposalHash`, hard-failing before
it signs anything (`assertRecomputedProposalHash`, `worker.ts:585`, called at
`1056`/`1127`/`1262`/`1347`), so a swapped-in different proposal is caught in the
browser rather than only on-chain (#111). The reconstruction paths that feed
this — store roots, owner ordering, `childExecutionRoot`, the
`executeSetupChild` pre-flights (`worker.ts:1248-1254`, `1273-1279`, on-chain
anchors `MinaGuard.ts:818`, `823-825`) — all run from indexer data.

The owner-chain links, vote-nullifier keys, and SubVault configuration hashes use
separate tags. The worker and offline CLI use the contract's shared hash helpers.

The memo is the worked example (three roles, one enforced — see the overview).
The **hashed** `memoHash` is the only representation owners' signatures cover
(`worker.ts:900`; part of `TransactionProposal.hash()`, `MinaGuard.ts:85`).
The **broadcast** plaintext rides the outer tx as protocol metadata
(`txSender`, `worker.ts:123-127`) — the proposer's own `input.memo` at propose
(`978-979`), the indexer-supplied `proposal.memo` at execute (`1156-1157`);
nothing in the circuit ties it to `memoHash`. The **displayed** plaintext is
decoded from the broadcast tx by the indexer (`indexer.ts:716`), which also
computes both match flags (`proposal-record.ts`; execute-side hash in
`indexer.ts`). The proposal page does not use the indexer's proposal-memo
flag: it hashes the displayed text with `memoToField` in the worker
(`computeMemoHash`) and compares that with `memoHash`, and `lib/memo-check.ts`
shows no badge until that check finishes. The execution-memo flag still comes
from the indexer, because the browser does not have the executed transaction's
memo. Net: action paths are contract-anchored; the displayed memo text is
advisory, and its match against the signed `memoHash` is checked locally.

**4. Concurrency / signer-lock correctness (`hooks/useContractTxLock.ts`,
`useTransactions.ts`, `lib/storage.ts`).**
Each submission rebuilds witnesses from current chain+indexer state, so two
in-flight txs against one contract collide; the lock serializes them, and
PR #67 hardened it against dropped transactions wedging a signer. The release
plumbing is split: the backend indexer polls the daemon mempool and marks
vanished approve/execute txs dropped (`backend/src/indexer.ts:1133-1213`); the
client reconciles its localStorage pending-tx list off those flags and off
proposal-state changes (`useTransactions.ts` `reconcilePendingTxs`), checks
deploy txs via `/api/tx-status`, and clearing a pending tx fires
`PENDING_TXS_CHANGED` (`lib/storage.ts`), which the lock listens for. It
deliberately ignores `kind='deploy'` (`useContractTxLock.ts:60-79`).
The other owners' signals come from the `lastApproveTxHash` and
`lastExecuteTxHash` the backend serves. The backend records a reported hash
only after its Mina node shows that the transaction approves or executes that
proposal, so a forged report cannot lock the vault (see
[`backend-audit-guide.md`](./backend-audit-guide.md) focus point 5). The UI
sends these reports without waiting for the answer (`reportSubmission` in
`lib/api.ts`): the check can take several seconds, and the reporting tab
already locks from its own pending record. If the backend refuses the report
(its node has not seen the tx yet, the node is down, or too many checks are
running), the backend never reports that tx's failure. The tab therefore
marks its pending record `untracked`, and that record expires 20 minutes
after broadcast instead of 24 hours (`lib/storage.ts`). Each poll deletes
expired records (`prunePendingTxs`), which lifts the lock without a reload. A
tx still waiting after 20 minutes would unlock early; a second submission
then collides and fails on-chain, which costs a retry, not funds. The same
happens when the backend stops tracking a report it accepted: another owner's
report replaced this one, whether that transaction is still live, already
failed, or was applied and cleared before this tab polled, and the backend
never reports the earlier tx's failure. An accepted report marks its record
`recorded`; reconciliation then marks it `untracked` as soon as the backend's
hash for that action is not this record's (`backendNoLongerTracks`). A report
the backend never answered within two minutes, say after a reload mid-report,
is marked the same way (`reportUnanswered`). SubVault creation records (`kind: 'create'` with a `createChild` summary) use
the same 20-minute window: a failed creation emits no proposal, and the
best-chain probe covers only recent blocks, so nothing else would ever clear
them.

**5. zkApp deploy key lifecycle & local storage.**
The only private key the UI holds is the in-browser zkApp deploy key
(`generateKeypair`). It is not persisted by the app. Before root creation or
CREATE_CHILD submission, the creator can optionally download it locally and must
acknowledge the trust risk. Regenerating the key resets the acknowledgement.
The file contains plaintext secret material, so a creator who downloads it must
move it to secure offline storage and remove unprotected Downloads copies.
Proof-authorized `setup()` (root) or `reserveForParent()` (child) overwrites
the signed deployment update with the canonical permission vector and seals
`setPermissions` in the same transaction. The UI must never broadcast
`deploy()` alone. During the stored transaction version the deploy key cannot
replace the verification key; a later version upgrade can make that permission
signature-authorized. Every vault detail page warns owners about this boundary
and that a fork which breaks old proofs can leave funds inaccessible if the
deploy key was not backed up. It also explains the option to evacuate before
a version upgrade. `lib/storage.ts` holds
non-secret prefs + pending-tx metadata.

When the node reports an older `setVerificationKey.txnVersion` and the installed
VK still matches this reviewed release, the Vault detail page shows a
transaction-version update panel. An ordinary owner-authorized proved action
can refresh the stored version if Mina accepts its proof. The UI and backend
allow this narrow case when every permission kind is canonical and the only
permission mismatch is the older version. They continue to report that mismatch
because the deploy-key signature fallback remains active until an account
update succeeds. The panel links to proposal creation and can recheck the
on-chain version; it does not submit a no-op. Because vault `access` is `none`,
any fee payer can submit an authorization-free no-op update. The first applied
vault update refreshes the version and ends the deploy-key fallback even if the
VK is unchanged; the proved action is advised because it confirms the installed
circuit still works after the fork.

If the installed VK differs from the release-pinned replacement VK, the detail
page instead offers deploy-key migration. It displays both hashes, exports a
version 2 request, and imports the MinaGuard offline CLI's signed response.
The panel warns that a maintainer must publish a fork-compatible CLI release
first. The browser does not check release availability or authenticate the
offline binary; users must independently verify the release, checksums, and
per-network VK hash before entering the saved deploy key.
If old proofs fail, the signed VK migration must land before any other vault
account update. A third party can pay for a no-op update that refreshes the
stored version first, leaving the broken VK installed and ending this saved-key
migration path.
The import checks the response binding and command shape, then rechecks the
installed VK, version, and permissions against the Mina node before broadcast.
After inclusion, the user can check the on-chain VK hash, stored version, and
complete permission vector. The saved deploy key is used only in the offline
CLI; a separate offline fee payer key is needed unless the deploy key also
funds the fee. The migration request shares version 2 with owner requests but
has a distinct action and schema; its signed response is version 2, while
owner signed responses remain version 1. The UI does not infer proof compatibility from the version
number. A release for a future fork must first review the replacement circuit,
its VK hash, and that fork's signing rules. Other non-canonical permissions or
a mismatching VK still block normal owner actions.

**6. Test-only escape hatches.**
`setTestKey` / `setSkipProofs` enable direct signing and dummy proofs, gated
on `NEXT_PUBLIC_E2E_TEST` (`worker.ts:701-716`, `multisigClient.ts:119-138`;
`skipProofs`/`DummyProof` feed `maybeProve`, `worker.ts:91-120`), which Next
inlines at build time so the branch is dead code in production. Direct test
submission returns a bare transaction hash, just like Auro and Ledger; the
caller adds the success-message prefix. Proposal status polling stores and
queries the bare hash.

---

## File tree

```
ui/
├── app/                         # Next.js App Router — pages & layout
│   ├── layout.tsx               # Root provider: wires wallet + indexer state, global
│   │                            #   operation banner, Ledger signing modal (the
│   │                            #   AppContext every page trusts — except the
│   │                            #   standalone /guide route, rendered outside it)
│   ├── page.tsx                 # Landing / connect
│   ├── globals.css
│   ├── accounts/
│   │   ├── new/page.tsx         # Vault + sub-vault creation wizard. Generates the
│   │   │                        #   ephemeral zkApp key; builds deploy/CREATE_CHILD txs
│   │   │                        #   (key lifecycle, client-side validation)
│   │   └── [address]/page.tsx   # Vault detail: owners, children, balance
│   ├── transactions/
│   │   ├── page.tsx             # Proposal list
│   │   ├── new/page.tsx         # Proposal creation form
│   │   └── [id]/page.tsx        # Proposal detail: approve / execute actions
│   ├── settings/page.tsx        # Compile-cache toggle & prefs
│   └── guide/page.tsx           # Standalone user guide (docs only; rendered
│                                #   outside the app shell — no security surface)
│
├── components/                  # Presentational + interactive components
│   ├── Header.tsx               # Wallet connect controls + node-endpoints chip;
│   │                            #   network is display-only (fixed by the deployment,
│   │                            #   no switcher — the Ledger network dropdown was removed, #119)
│   ├── WalletConnect.tsx        # Auro/Ledger connect entry point
│   ├── LedgerConnectModal.tsx   # Ledger address retrieval UX
│   ├── LedgerSigningModal.tsx   # "Confirm on device" blocking modal
│   ├── OfflineSigningFlow.tsx   # Export bundle / import signed response (bridge to
│   │                            #   the air-gapped path — see offline-audit-guide.md).
│   │                            #   CLI download links point at a GitHub release
│   │                            #   (NEXT_PUBLIC_OFFLINE_CLI_RELEASE_URL) + SHA256SUMS
│   ├── ProposalForm.tsx         # Builds NewProposalInput (what the user intends to
│   │                            #   propose)
│   ├── MemoWarningTooltip.tsx   # Surfaces memo match/mismatch (lib/memo-check.ts
│   │                            #   picks the badge from a locally recomputed hash)
│   ├── TransactionCard.tsx      # Renders proposal data from the indexer (totals
│   │                            #   derived from the signed receivers)
│   ├── TransactionList.tsx
│   ├── ApprovalProgress.tsx     # Threshold progress from indexed approvals
│   ├── OwnerList.tsx            # Owner set (rendered from backend data)
│   ├── VaultCard.tsx
│   ├── Sidebar.tsx              # Nav
│   ├── AddExistingAccountModal.tsx  # Subscribe an already-deployed vault to the indexer
│   ├── NodeEndpointsChip.tsx  NodeEndpointsModal.tsx  # Show/edit node endpoints
│   │                            #   (runtime-editable only in the desktop shell)
│   ├── ThresholdBadge.tsx  TxTypeIcon.tsx  ConnectNotice.tsx
│   ├── SearchInput.tsx  LoadMore.tsx  TestnetFundButton.tsx
│   ├── CubeLogo.tsx  AppFooter.tsx  # Brand mark + global footer (presentational)
│
├── hooks/                       # Client state & polling
│   ├── useWallet.ts             # Auro/Ledger connect, account/network change subs
│   ├── useMultisig.ts           # Selected contract + owner/indexer state
│   ├── useTransactions.ts       # Proposal polling + pending-tx reconciliation
│   ├── useContractTxLock.ts     # Prevents concurrent conflicting txs per contract
│   ├── useAdaptivePolling.ts    # Poll cadence (idle vs. in-flight)
│   ├── useLoadMore.ts  useUrlState.ts  useDebouncedValue.ts
│
├── lib/                         # Core logic — the most security-relevant layer
│   ├── multisigClient.ts        # Main-thread wrapper. Builds the proxied
│   │                            #   signFields / signFeePayer / sendTx callbacks that
│   │                            #   route worker requests to Auro/Ledger (the signing
│   │                            #   boundary)
│   ├── multisigClient.worker.ts # o1js compile + proof gen; constructs every
│   │                            #   transaction and the fields/commitments sent to the
│   │                            #   signer (what actually gets signed)
│   ├── auroWallet.ts            # Auro provider calls: sendTransaction, signFields,
│   │                            #   signMessage (see the fee/memo → commitment note
│   │                            #   at line ~77)
│   ├── ledgerWallet.ts          # Ledger WebHID: signFields, signFeePayer, address,
│   │                            #   network id (on-device signing)
│   ├── offline-signing.ts       # Offline bundle builders + signed-response validation
│   │                            #   (cross-reference offline-audit-guide.md)
│   ├── api.ts                   # Backend read client + response normalization
│   │                            #   (trust boundary — all inputs untrusted)
│   ├── endpoints.ts             # Resolves backend / Mina / archive endpoints:
│   │                            #   desktop-injected window.__minaGuardConfig wins,
│   │                            #   else NEXT_PUBLIC_* build-time vars
│   ├── indexer-mode.ts          # 'full' vs 'lite' indexer mode resolution
│   ├── types.ts  memo.ts        # Shared types; MEMO_MAX_BYTES input guard
│   ├── constants.ts             # MAX_OWNERS / MAX_RECEIVERS (UI copy; the worker
│   │                            #   imports the contracts' definitions)
│   ├── storage.ts               # localStorage: prefs + pending-tx tracking
│   ├── app-context.ts           # React context shape
│   ├── idb-compile-cache.ts     # IndexedDB cache of compiled artifacts
│   └── disable-wasm-finalizers.ts  # o1js WASM workaround (see KNOWN_ISSUES.md)
│
├── package.json                 # Pinned o1js and mina-signer dependencies
├── next.config.mjs              # COOP/COEP headers
│                                #   (COEP: credentialless) for SharedArrayBuffer;
│                                #   minification DISABLED — minifiers mangle o1js
│                                #   BigInt ops and silently produce wrong tx
│                                #   commitments
└── .env.local.example / tsconfig / tailwind …
```

---

## Dependencies

The UI is a workspace package (`ui`) in the `mina-guard` monorepo. Only the
security-relevant dependencies are called out here; framework/build tooling
(`next`, `react`, `tailwind`, `typescript`, `autoprefixer`, `postcss`) is
standard and not discussed.

### Cryptography / chain

- **`contracts` (`workspace:*`)** — the on-chain circuit *and* the shared helpers
  the UI reuses so its client-side reconstruction matches the contract exactly:
  the `TransactionProposal` struct, `memoToField` (`memo.ts`), the `Destination`
  enum, `MAX_OWNERS`/`MAX_RECEIVERS`, and the Merkle stores
  (`OwnerStore`/`ApprovalStore`/`VoteNullifierStore`). (`decodeTxMemo` also lives
  in `contracts` but is consumed by the backend indexer, not the UI; the UI's
  `TxType` union is its own in `lib/types.ts`.) This is the most security-critical
  dependency — the UI and the contract must agree on hashing and struct layout,
  and they do so by importing the *same* source.
- **`o1js` (`3.0.0`, pinned directly in the UI and contracts)** — the proving system and
  zkApp runtime. The Web Worker uses it to compile `MinaGuard`, generate proofs, and
  build `Mina.transaction`s. Heavy; runs only in the worker.
- **`mina-signer` (`4.1.0`)** — a *separate, lighter* signer used on the main thread and in the
  worker for keypair generation and for computing transaction/fee-payer commitments
  **without** paying the full o1js cost (`multisigClient.ts`, `multisigClient.worker.ts`).
  It comes from the exact npm pin in `ui/package.json`, including its published browser bundle
  and TypeScript declarations. Cross-network field/fee-payer signatures and the Ledger
  `getZkappCommandCommitmentsFromJSON` API are tested against the pinned o1js proving path.

### Signing hardware

- **`@ledgerhq/hw-transport-webhid`, `@ledgerhq/hw-transport`** — WebHID transport to a
  Ledger device (`ledgerWallet.ts`). Browser-only; requires a user gesture + HID
  permission.
- **`@zondax/ledger-mina-js`** — the Mina Ledger app client (`MinaApp`) used for
  `getAddress` / `signFields` / `signTransaction` on-device.

### Hashing primitives

- **`@noble/hashes`, `blakejs`, `js-sha256`** — low-level hash functions used by the
  published `mina-signer` browser bundle and the UI.

### Worker boundary

- **`comlink`** — the `postMessage` RPC layer between the main thread and the Web Worker.
  This is the trust seam described in the threat model (main thread ⇄ worker): the worker
  proxies signer/network callbacks back across it. It is same-origin only, but it is the
  channel across which the *fields to be signed* travel, so it is in scope for the signer-
  boundary review (focus point 1).

> The Auro wallet is **not** an npm dependency — it is a browser extension reached via the
> injected `window.mina` provider (`auroWallet.ts`), so it does not appear in
> `package.json` and its version/behavior is outside this package's lockfile.

## Safe child funding

Allocation execution fetches every non-empty recipient account. The contract
requires nonzero `ownersCommitment` and `parent == sending vault` through
ledger-enforced preconditions. Missing, uninitialized, and unrelated recipients
cannot receive an allocation; account-creation fees apply only to ordinary
transfers. Empty padding is exempt, but non-empty zero-value recipients are checked.

Offline allocation export includes each recipient's full snapshot in `accounts`,
so the air-gapped CLI can prove the same checks. Owner requests use version 2;
old allocation bundles lacking snapshots must be exported again. Desktop uses
these same worker/exporter paths. Rebuild UI, offline CLI, and desktop together
with the changed circuit and CI-generated verification-key hashes.

Complete child setup before funding by any route. Ordinary transfers and external
deposits remain possible before initialization, with no parent reclaim/destroy
until setup succeeds. See [safe child funding](./contracts-audit-guide.md#safe-child-funding)
for the remediation boundary and retained deposit risk.
