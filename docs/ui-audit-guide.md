# Online UI — Architecture & Security Notes

This document describes the **online web UI** (`ui/`) — the Next.js app that
MinaGuard owners use to connect a wallet, deploy vaults, and run the propose →
approve → execute lifecycle against a live Mina network.

The air-gapped path is documented in [`offline-signing.md`](./offline-signing.md), and
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
reconstruction at worst makes the proof fail). *Propose* creates the proposal and
auto-records the proposer's own approval in the same transaction (propose == create + first
approval). *Approve* has each additional owner rebuild the proposal struct from indexer data,
re-hash it, and sign that hash — the contract re-hashes on-chain and rejects any mismatch, so
a lying indexer cannot get an owner to approve something other than what was proposed. Once
approvals reach the threshold, *execute* is permissionless: anyone can submit it, the contract
re-checks threshold and moves funds / applies the governance change. In all three, what an
owner actually **signs is the proposal hash — a single `Field`** (blind signing; see the
threat model), not the human-readable transaction.

**The memo has three roles, and only one is enforced on-chain.** The short note a user attaches
to a proposal shows up as (1) a **hashed** `memoHash` bound into the proposal (the only value
owners' signatures cover), (2) an unconstrained **broadcast** fee-payer memo on the outer
transaction, and (3) the **displayed** plaintext the indexer decodes from that transaction.
Nothing in the circuit ties (2)/(3) to (1), so they can diverge; the indexer compares them and
the UI flags match/mismatch via `MemoWarningTooltip`. Takeaway: **only a memo whose displayed
value matches the on-chain hash was actually approved by the multisig** — the plaintext shown or
broadcast is advisory. (Mechanics and audit checks in focus point 3.)

**Proposal "deletion" and the `CREATE_CHILD` edge case.** There is no on-chain delete method:
"deleting" a pending proposal means minting a zero-value proposal that reuses the target's
nonce and racing it to execution, since a nonce can only be spent once. This can't work for
`CREATE_CHILD` (pinned to `nonce == 0`), so the UI disables Delete for it
(`app/transactions/[id]/page.tsx:271-274`). Because the child is already deployed and
`reserveForParent()`'d (write-once) in the same propose tx, abandoning such a proposal strands
an **orphaned child account** — creation fee spent, not re-usable and not reclaimable. A
stranded-funds footgun, not a loss-of-control issue.

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

- **The UI never holds long-lived signing keys.** Owner keys live in Auro or on the
  Ledger. The only private key the UI ever handles is the *ephemeral zkApp deploy
  key*, which is generated in-browser and used for a single transaction.
- **Heavy crypto runs in a Web Worker.** The worker compiles the contract and
  generates proofs. It calls *back* to the main thread for anything requiring a
  signer or network egress, via Comlink-proxied callbacks.
- **The backend is not trusted for integrity.** Data from the backend is used to construct
  transactions and display information. Security-critical operations, such as proposal creation, approval,
  and execution, are performed on-chain. Transactions are also submitted directly to the node.
- **Interactions with the chain.** Interactions with the chain, like transactions submitted, reach the node
  directly. Note, however, that:
  - Transactions submitted through Auro wallet reach the node endpoint defined by Auro.
  - Transactions submitted through the Ledger/offline-CLI flow reach the endpoints defined in the frontend
    code (`lib/endpoints.ts`: `NEXT_PUBLIC_MINA_ENDPOINT`/`NEXT_PUBLIC_ARCHIVE_ENDPOINT` baked in at build
    time; the desktop shell overrides them at runtime via an injected `window.__minaGuardConfig`).

---

## Threat model & assumptions

Assuming that the frontend (UI) is not compromised, the interactions are the following:

- **Main Thread <-> Web Worker.** Same origin, Comlink over `postMessage`.
- **Backend (indexer).** Read-only, *untrusted*. The indexer is used to retrieve on-chain
  data and events. The indexer cannot affect critical operations. For example, consider
  a propose-approve-execute flow:
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
    [`offline-signing.md`](./offline-signing.md).


#### Suggested focus points

**1. The signer boundary (`lib/multisigClient.ts` ↔ `lib/ledgerWallet.ts` / `lib/auroWallet.ts`).**
This is the single most security-critical seam: it decides *what bytes the user
authorizes*. The worker (`multisigClient.worker.ts`) constructs every
transaction and every field/commitment and hands them across a Comlink boundary
to be signed — the signer sees only the result, never the intent.
  - **Blind signing is the core risk.** For zkAppCommand field signatures the
    user sees only a `Field` element (Ledger by interface restriction, Auro by
    design — see threat model above). The question is whether any path lets the
    fields/commitment presented to the signer diverge from what the UI displayed.
    The compromised-frontend case is out of scope by assumption, but a *bug*
    that mis-derives the commitment is in scope and has the same effect.
  - **Ledger `signFields` only signs `fields[0]`.** `ledgerWallet.signFields`
    converts *only the first* field element to bytes and signs it
    (`ledgerWallet.ts:186-198`); the returned `data` echoes the full input array
    but the signature covers one field. This is sound only while every call
    site passes a single-element array (the proposal hash).
  - **Signature reconstruction across wallets.** Ledger returns `{field, scalar}`
    decimal strings that are reassembled into an o1js `Signature`
    (`worker.ts:240-243` in `signProposalHash`, and `worker.ts:602-605` in
    `broadcastWithLedgerSig`); Auro returns base58. The two paths must produce
    equivalent, correctly-encoded signatures and fail closed on malformed input
    (the first site returns `null` via try/catch; the second throws).
  - **Network-id binding on Ledger.** `ledgerNetworkId` is process-global mutable
    state set via `setLedgerNetworkId` (`ledgerWallet.ts:10-16`). It has to match
    the network the transaction is built for — a stale/mismatched id yields a
    signature valid on the wrong network, or a confusing failure.
  - **Fee-payer commitment path (Ledger direct broadcast).**
    `broadcastWithLedgerSig` derives `fullCommitment` from the tx JSON via
    `mina-signer`, then reuses that one signature for the fee payer *and* for any
    fee-payer-owned account update with `useFullCommitment` (`worker.ts:592-632`;
    the reuse loop is `612-620`) — the seam being that this must never attach the
    fee-payer signature to an update the user didn't intend to authorize.

**2. Atomicity of deploy + setup, and of CREATE_CHILD.**
A guard that is deployed but *not yet configured* (no owners/threshold) is a
hijack window: whoever calls `setup()` first controls it. The UI must never
leave that gap.
  - **Top-level vault.** The wizard uses the atomic `deployAndSetupContract`,
    which bundles `deploy()` + `setup()` in one transaction
    (`worker.ts:730-781`; the single tx does `fundNewAccount` + `deploy` +
    `setup` at `764-772`; called from `accounts/new/page.tsx:160`). This is the
    only creation path the UI exercises today, but the worker also exports
    **separate** `deployContract` and `setupContract` methods (`worker.ts:693-728`
    and `783-841`) with **no UI caller** — reachable-but-unused split entry
    points that could reopen the gap.
  - **Sub-vault (CREATE_CHILD).** Child creation splits across two transactions
    by design: the propose tx does `deploy(child)` + `reserveForParent(child)` +
    `propose(parent)` atomically (`worker.ts:954-978`), and a later execute tx
    runs `executeSetupChild`. The safety of the gap between them rests on
    `reserveForParent()` committing to the config hash and blocking a hostile
    `setup()` on the child (contract-side — `MinaGuard.ts:736-760`: write-once
    guards at `743-744`, config-hash commit at `759-760`; PR #89). The points of
    interest: the UI must not be inducible to deploy a child *without* the atomic
    `reserveForParent`, and the announced owners/threshold must be re-checked
    against the committed hash before initialization — the worker pre-flights
    this (`worker.ts:1221-1227`), and the binding check is the contract's
    (`MinaGuard.ts:818`, `823-825`).
  - **Account-creation fee counting.** Executes that move funds add
    `AccountUpdate.fundNewAccount(executor, N)` where `N` is counted **from the
    hash-bound `proposalStruct.receivers`, never the raw backend array**
    (`worker.ts:1110-1132`, and the comment there) — so untrusted indexer rows
    beyond `MAX_RECEIVERS` cannot inflate the executor-signed account-creation
    fee. The same discipline should hold everywhere a count or amount is derived.

**3. Indexer-supplied data feeding into signed transactions.**
The backend is untrusted (see threat model), yet its data is used to *rebuild
Merkle stores and reconstruct proposal structs* that get hashed and signed
(`rebuildStoresFromBackend`, `buildProposalStruct`). The claimed protection is
that the contract catches any mismatch. The pressure points:
  - Whether a malicious indexer can steer witness/store reconstruction
    (owner set ordering, nullifier/approval roots, `childExecutionRoot`) into a
    tx that either fails confusingly, or worse, succeeds against attacker-chosen
    state. Owner ordering in particular is reconstructed by sorting event
    payloads (`worker.ts:279-292`).
  - The `executeSetupChild` config-mismatch guard (`worker.ts:1221-1227`) and the
    `already-initialized` guard (`worker.ts:1245-1251`) — client-side pre-flights;
    the on-chain anchors are `MinaGuard.ts:818` and `823-825`.
  - Memo independence (three roles, one enforced). The plaintext memo takes three
    independent paths and only the first is constrained on-chain:
    - **Hashed** — the worker computes `memoHash = memoToField(input.memo ?? '')`
      (`worker.ts:875`; `contracts/memo.ts`: Poseidon over the UTF-8 bytes, empty
      string → `Field(0)`) and puts it in the proposal struct. It is part of
      `TransactionProposal.hash()` (`MinaGuard.ts:85`), so it's the only representation
      owners' signatures cover, and it's re-emitted in `ProposalEvent`.
    - **Broadcast** — a plaintext string is passed as the transaction's memo via
      `txSender(pub, memo)` (`worker.ts:123-127`). At **propose** time that is the
      proposer's own `input.memo` (`worker.ts:953-954`) — the same value that was hashed.
      At **execute** time it is the **indexer-supplied** `proposal.memo`
      (`worker.ts:1129-1130`), so the executor's broadcast memo is only as honest as the
      indexer (that is what `memoExecutionMatch` below is meant to catch). Approve
      transactions attach no memo. o1js bakes the memo into the serialized zkApp-command
      JSON (`memo`, base58check-encoded) for **both** wallet paths — so the Ledger path
      (`broadcastWithLedgerSig`) already carries it and does not take a separate memo
      argument, while the Auro path *additionally* forwards it as `feePayer.memo`
      (`submitTx` → `auroWallet.sendTransaction`). It is unconstrained protocol metadata;
      nothing in the circuit ties it to `memoHash`, and it is covered only by the
      fee-payer signature/commitment, not by the proposal hash.
    - **Displayed** — the indexer decodes the memo *from the broadcast tx* with
      `decodeTxMemo(chainEvent.txMemo)` (`indexer.ts:715`; falls back to storing the raw
      base58 string if decoding throws) and stores it as `proposal.memo`; the detail page
      renders it and consumes the backend flags below. `MemoWarningTooltip` shows the match
      vs. mismatch states.

    The `contracts` package owns both `memoToField` (hash) and `decodeTxMemo` (parse Mina's
    base58check memo layout); length-checking (`MEMO_MAX_BYTES = 32`, the protocol's max
    memo *content* bytes) is a *separate*, input-only guard in `ui/lib/memo.ts` that never
    touches the hash. The two match flags are computed **by the untrusted indexer**, not the
    contract (`backend/src/proposal-record.ts`):
    - `proposalMemoMatch = memoToField(decodedProposeMemo) === event.memoHash`
      (`proposal-record.ts:123-130`; `null` when either is absent or `memoHash === '0'`) —
      meant to catch a proposer whose broadcast plaintext differs from what they hashed into
      the proposal.
    - `memoExecutionMatch = event.memoHash === executionMemoHash`
      (`proposal-record.ts:132-139`; the execute-side hash is computed at
      `indexer.ts:924-929` and persisted on the proposal row) — meant to catch an executor
      attaching a memo other than the approved one.

    **Two separate trust surfaces — keep them distinct:**

    - **Action path (approve / execute): contract-protected.** When an owner *acts*, the worker
      rebuilds the proposal struct — taking `memoHash` from the indexer too
      (`buildProposalStruct`, `worker.ts:565`) — and computes `proposalHash = proposal.hash()`.
      The contract then requires that hash to key into a proposal that actually exists on-chain
      (`assertProposalExists` / `assertApprovalWitnessValue`, `MinaGuard.ts:1014,1032`) and that
      the approver's signature covers it (`signature.verify(approver, [proposalHash])`,
      `MinaGuard.ts:1011`). A wrong `memoHash` yields a wrong `proposalHash` → the tx fails. So a
      lying indexer **cannot induce an approval or execution against a memo other than the real
      on-chain one.** This is the "contract is the trust anchor" guarantee, and for the memo it
      holds.

    - **Display path (the badge / the memo you read): NOT verified — the indexer can lie
      consistently.** Displaying is not a transaction, so nothing on-chain is checked. On this
      path **both `memo` and `memoHash` come straight from the indexer JSON** (`api.ts:245-246`;
      the detail row renders `proposal.memo ?? proposal.memoHash`, `page.tsx:628`), and the two
      match flags are computed by that same indexer. Because `memoHash` itself is
      indexer-supplied here — the UI never re-derives it from a trusted source — a malicious
      indexer can serve a **self-consistent** triple (fabricated `memo`, matching fabricated
      `memoHash`, `proposalMemoMatch: true`) and the UI will show a green ✓ `match`. **There is
      no client-side workaround as currently built.** The `null`→red fail-safe in the tooltip
      (`page.tsx:458-469`) applies only on the *executed* branch (`462-465`: anything not
      strictly `true` renders red); for a still-pending proposal a `null` flag renders **no
      icon at all** (`467-468`). Either way it only defends against an *honest* indexer that
      *dropped* the memo; it does not defend against one that *lies*. The damage is bounded to
      what's **displayed** —
      per the action-path guarantee above, a display lie can't cross into signing/executing the
      wrong thing — but the memo a user reads on-screen is strictly advisory.

    **The gap is closable in principle, but leaving it open is a deliberate design choice.**
    `memoHash` is emitted in the on-chain `ProposalEvent` and is part of the proposal hash, so
    it *is* independently recoverable from the Mina node — a client that fetched the event
    itself could re-derive `memoHash` and verify the indexer's `memo` and flags, closing the
    display surface. This is intentionally **not** done: in this architecture, reading and
    decoding chain events is the *indexer's* role, and the UI does not query the node for
    events — duplicating that read path in the browser would complicate the role separation
    between UI and indexer. The UI's only events source is therefore the indexer's own
    `fetchAllEvents` (`api.ts:345`), used for store reconstruction, not display verification,
    and the display-path limitation above is accepted as display-bounded (the action-path
    guarantee is what actually protects funds). Two supporting facts: at propose time the
    hashed and broadcast memos derive from the **same** `input.memo` (`worker.ts:875`,
    `953-954`), and both wallet transports carry that same baked-in memo (Ledger via the tx
    JSON, Auro via `feePayer.memo`).

**4. Concurrency / signer-lock correctness (`hooks/useContractTxLock.ts`,
`useTransactions.ts`, `lib/storage.ts`).**
Because each submission rebuilds witnesses from current chain+indexer state, two
in-flight txs against the same contract collide. The lock prevents that, and
recent work hardened it against *dropped* transactions permanently wedging a
signer (PR #67). The release plumbing is split across backend and client: the
**backend indexer** polls the daemon mempool and, past a grace window, marks a
vanished approve/execute tx as dropped (`backend/src/indexer.ts:1132-1213`);
the client reconciles its localStorage pending-tx list off those flags and off
proposal-state changes (`useTransactions.ts` `reconcilePendingTxs`), and checks
deploy txs itself via the backend's `/api/tx-status` bestChain lookup. Clearing
a pending tx fires `PENDING_TXS_CHANGED` (`lib/storage.ts`), which the lock
listens for. Audit for:
  - Can the lock be defeated (concurrent tabs, cleared localStorage, cross-signer
    races) such that a second tx builds against stale state? Note it deliberately
    ignores `kind='deploy'` (`useContractTxLock.ts:60-79`; the comment explains why).
  - Can the lock get *stuck on* after a genuinely dropped/failed tx, locking an
    owner out? The interplay to look at is the backend mempool-poll release vs.
    the localStorage/`PENDING_TXS_CHANGED` reconciliation.

**5. Ephemeral zkApp key lifecycle & local storage.**
The only private key the UI holds is the in-browser zkApp deploy key
(`generateKeypair`), used for a single tx. It should never land in
`localStorage`, logs, or error messages, nor be retained past the deploy call.
It should also be **powerless after the deploy tx**: `deploy()` sets the
account permissions in the same transaction (`MinaGuard.ts:282-295`) —
`editState`/`send`/`setDelegate` require **proofs**, `setPermissions` and the
other signature-flavored knobs are `impossible`, `setVerificationKey` is
`impossibleDuringCurrentVersion` — so a leaked key has no post-deploy
authority. The same applies to the child key in the CREATE_CHILD propose tx.
Separately, `lib/storage.ts` should hold only non-secret prefs + pending-tx
metadata (as the file-tree note claims).

**6. Test-only escape hatches.**
`setTestKey` / `setSkipProofs` enable direct signing and dummy proofs and are
gated on `NEXT_PUBLIC_E2E_TEST` (`worker.ts:676-691`, `multisigClient.ts:119-138`).
The gate should be compile-time dead-code-eliminated in production builds, with
`skipProofs`/`DummyProof` (used in `maybeProve`, `worker.ts:91-120`) unreachable
without it.

---

## File tree

```
ui/
├── app/                         # Next.js App Router — pages & layout
│   ├── layout.tsx               # Root provider: wires wallet + indexer state, global
│   │                            #   operation banner, Ledger signing modal (the
│   │                            #   AppContext every page trusts)
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
│   └── settings/page.tsx        # Compile-cache toggle & prefs
│
├── components/                  # Presentational + interactive components
│   ├── Header.tsx               # Wallet connect controls, network switch
│   ├── WalletConnect.tsx        # Auro/Ledger connect entry point
│   ├── LedgerConnectModal.tsx   # Ledger address retrieval UX
│   ├── LedgerSigningModal.tsx   # "Confirm on device" blocking modal
│   ├── OfflineSigningFlow.tsx   # Export bundle / import signed response (bridge to
│   │                            #   the air-gapped path — see offline-signing.md).
│   │                            #   CLI download links point at a GitHub release
│   │                            #   (NEXT_PUBLIC_OFFLINE_CLI_RELEASE_URL) + SHA256SUMS
│   ├── ProposalForm.tsx         # Builds NewProposalInput (what the user intends to
│   │                            #   propose)
│   ├── MemoWarningTooltip.tsx   # Surfaces memo match/mismatch (backend-provided memo
│   │                            #   flags — worth checking independence)
│   ├── TransactionCard.tsx      # Renders proposal data from the indexer
│   ├── TransactionList.tsx
│   ├── ApprovalProgress.tsx     # Threshold progress from indexed approvals
│   ├── OwnerList.tsx            # Owner set (rendered from backend data)
│   ├── VaultCard.tsx
│   ├── Sidebar.tsx              # Nav + indexer status
│   ├── AddExistingAccountModal.tsx  # Subscribe an already-deployed vault to the indexer
│   ├── NodeEndpointsChip.tsx  NodeEndpointsModal.tsx  # Show/edit node endpoints
│   │                            #   (runtime-editable only in the desktop shell)
│   ├── ThresholdBadge.tsx  TxTypeIcon.tsx  ConnectNotice.tsx
│   ├── SearchInput.tsx  LoadMore.tsx  TestnetFundButton.tsx
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
│   │                            #   at line ~75)
│   ├── ledgerWallet.ts          # Ledger WebHID: signFields, signFeePayer, address,
│   │                            #   network id (on-device signing)
│   ├── offline-signing.ts       # Offline bundle builders + signed-response validation
│   │                            #   (cross-reference offline-signing.md)
│   ├── api.ts                   # Backend read client + response normalization
│   │                            #   (trust boundary — all inputs untrusted)
│   ├── endpoints.ts             # Resolves backend / Mina / archive endpoints:
│   │                            #   desktop-injected window.__minaGuardConfig wins,
│   │                            #   else NEXT_PUBLIC_* build-time vars
│   ├── indexer-mode.ts          # 'full' vs 'lite' indexer mode resolution
│   ├── types.ts  memo.ts        # Shared types; MEMO_MAX_BYTES input guard
│   ├── constants.ts             # MAX_OWNERS / MAX_RECEIVERS (UI copy — the worker
│   │                            #   imports the contracts' definitions; check drift)
│   ├── storage.ts               # localStorage: prefs + pending-tx tracking (confirm
│   │                            #   no secrets stored here)
│   ├── app-context.ts           # React context shape
│   ├── idb-compile-cache.ts     # IndexedDB cache of compiled artifacts
│   └── disable-wasm-finalizers.ts  # o1js WASM workaround (see KNOWN_ISSUES.md)
│
├── types/
│   └── mina-signer.d.ts         # Ambient types for the submodule signer
│
├── deps/o1js/  (git submodule)  # Source for mina-signer browser build
├── package.json                 # Deps + postinstall esbuild of mina-signer
├── next.config.mjs              # mina-signer webpack alias; COOP/COEP headers
│                                #   (COEP: credentialless) for SharedArrayBuffer;
│                                #   minification DISABLED — minifiers mangle o1js
│                                #   BigInt ops and silently produce wrong tx
│                                #   commitments (security-relevant, keep it off)
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
  and they do so by importing the *same* source. Audit changes here as contract
  changes, not UI changes.
- **`o1js` (`3.0.0-mesa.final`, hoisted at the repo root)** — the proving system and
  zkApp runtime. The Web Worker uses it to compile `MinaGuard`, generate proofs, and
  build `Mina.transaction`s. Heavy; runs only in the worker.
- **`mina-signer`** — a *separate, lighter* signer used on the main thread and in the
  worker for keypair generation and for computing transaction/fee-payer commitments
  **without** paying the full o1js cost (`multisigClient.ts`, `multisigClient.worker.ts`).
  It is **not** consumed from npm: it resolves (via `file:` + a webpack alias, with an
  ambient type stub at `types/mina-signer.d.ts`) to the **`deps/o1js` git submodule**
  (`graikos/o1js#develop-3.0`), whose `src/mina-signer/` is built for the browser by the
  `postinstall` esbuild step (`package.json`). **Why the submodule:** mina-signer is
  developed as a subpackage inside the o1js repo, and the mesa release did not ship a
  matching standalone `mina-signer` artifact — so the UI builds its own browser bundle
  from source. The submodule's mina-signer source is **byte-identical** to the
  mina-signer sources shipped *inside* `o1js@3.0.0-mesa.final`
  (`node_modules/o1js/src/mina-signer/`), so there is no protocol divergence between the
  signing and proving paths today. **Auditor note:** that guarantee is *identity, not
  versioning* — re-verify it whenever the submodule or the o1js pin moves (e.g.
  `diff -r ui/deps/o1js/src/mina-signer node_modules/o1js/src/mina-signer`), since the
  commitment/signature encoding must match what the proving path and the contract expect.
  (A follow-up could drop the submodule for the standalone `mina-signer` npm package.)

### Signing hardware

- **`@ledgerhq/hw-transport-webhid`, `@ledgerhq/hw-transport`** — WebHID transport to a
  Ledger device (`ledgerWallet.ts`). Browser-only; requires a user gesture + HID
  permission.
- **`@zondax/ledger-mina-js`** — the Mina Ledger app client (`MinaApp`) used for
  `getAddress` / `signFields` / `signTransaction` on-device.

### Hashing primitives

- **`@noble/hashes`, `blakejs`, `js-sha256`** — low-level hash functions. Note the
  `postinstall` esbuild marks these (and `crypto`) `--external`, so the browser
  `mina-signer` bundle resolves them from `node_modules` rather than re-bundling copies —
  worth confirming a single, current version of each is what actually ships.

### Worker boundary

- **`comlink`** — the `postMessage` RPC layer between the main thread and the Web Worker.
  This is the trust seam described in the threat model (main thread ⇄ worker): the worker
  proxies signer/network callbacks back across it. It is same-origin only, but it is the
  channel across which the *fields to be signed* travel, so it is in scope for the signer-
  boundary review (focus point 1).

> The Auro wallet is **not** an npm dependency — it is a browser extension reached via the
> injected `window.mina` provider (`auroWallet.ts`), so it does not appear in
> `package.json` and its version/behavior is outside this package's lockfile.
