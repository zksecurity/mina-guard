# Online UI — Architecture & Security Notes

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
broadcast is advisory. (Mechanics in focus point 3.)

**Proposal "deletion" and the `CREATE_CHILD` edge case.** There is no on-chain delete method:
"deleting" a pending proposal means minting a zero-value proposal that reuses the target's
nonce and racing it to execution, since a nonce can only be spent once. This can't work for
`CREATE_CHILD` (pinned to `nonce == 0`), so the UI disables Delete for it
(`app/transactions/[id]/page.tsx:271-274`). Because the child is already deployed and
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
    [`offline-audit-guide.md`](./offline-audit-guide.md).


#### Suggested focus points

**1. The signer boundary (`lib/multisigClient.ts` ↔ `lib/ledgerWallet.ts` / `lib/auroWallet.ts`).**
The worker (`multisigClient.worker.ts`) constructs every transaction and every
field/commitment and hands them across a Comlink boundary to be signed; since
zkApp approvals are blind (a single `Field`), whatever decides what reaches
the signer decides what the user authorizes. The moving parts:
  - `ledgerWallet.signFields` signs only `fields[0]` (`ledgerWallet.ts:186-198`)
    while echoing the full input array back; call sites pass a single-element
    array (the proposal hash).
  - Signature reconstruction differs per wallet: Ledger `{field, scalar}`
    decimals are reassembled into an o1js `Signature` (`worker.ts:240-243`,
    `602-605`); Auro returns base58.
  - `ledgerNetworkId` is process-global mutable state (`ledgerWallet.ts:10-16`)
    that has to match the network the tx is built for.
  - `broadcastWithLedgerSig` reuses the one fee-payer signature for any
    fee-payer-owned account update with `useFullCommitment`
    (`worker.ts:592-632`; reuse loop `612-620`).

**2. Atomicity of deploy + setup, and of CREATE_CHILD.**
A guard that is deployed but not yet configured could be controlled by whoever
calls `setup()` first.
  - Top-level vaults use the atomic `deployAndSetupContract` — one tx doing
    `fundNewAccount` + `deploy` + `setup` (`worker.ts:730-781`, tx at
    `764-772`; called from `accounts/new/page.tsx:160`). Separate
    `deployContract` / `setupContract` methods exist with no UI caller
    (`worker.ts:693-728`, `783-841`).
  - CREATE_CHILD spans two transactions by design: the propose tx does
    `deploy(child)` + `reserveForParent(child)` + `propose(parent)` atomically
    (`worker.ts:954-978`); the later `executeSetupChild` is bound on-chain to
    the config `reserveForParent()` committed (`MinaGuard.ts:736-760`,
    write-once guards `743-744`, commit `759-760`; binding checks `818`,
    `823-825`). The worker pre-flights the announced config against
    `proposal.data` (`worker.ts:1221-1227`).
  - Account-creation fees on execute are counted from the hash-bound
    `proposalStruct.receivers`, never the raw backend array
    (`worker.ts:1110-1132`), so indexer rows beyond `MAX_RECEIVERS` can't
    inflate the executor-signed fee.

**3. Indexer-supplied data feeding into signed transactions.**
The backend is untrusted (see threat model), yet its data rebuilds the Merkle
stores and proposal structs that get hashed and signed
(`rebuildStoresFromBackend`, `worker.ts:273`; `buildProposalStruct` — memoHash
included — `worker.ts:565`; owner ordering reconstructed by sorting event
payloads, `279-292`). On action paths the recomputed `proposalHash` must key
into a proposal that exists on-chain and the owner's signature covers it
(`MinaGuard.ts:1011`, `1014`, `1032`), so the contract re-checks what the
indexer supplied. The reconstruction paths that feed this — store roots, owner
ordering, `childExecutionRoot`, the `executeSetupChild` pre-flights
(`worker.ts:1221-1227`, `1245-1251`, on-chain anchors `MinaGuard.ts:818`,
`823-825`) — all run from indexer data.

The memo is the worked example (three roles, one enforced — see the overview).
The **hashed** `memoHash` is the only representation owners' signatures cover
(`worker.ts:875`; part of `TransactionProposal.hash()`, `MinaGuard.ts:85`).
The **broadcast** plaintext rides the outer tx as protocol metadata
(`txSender`, `worker.ts:123-127`) — the proposer's own `input.memo` at propose
(`953-954`), the indexer-supplied `proposal.memo` at execute (`1129-1130`);
nothing in the circuit ties it to `memoHash`. The **displayed** plaintext is
decoded from the broadcast tx by the indexer (`indexer.ts:716`), which also
computes both match flags (`proposal-record.ts:123-130`, `132-139`;
execute-side hash at `indexer.ts:925-930`) that `MemoWarningTooltip` renders.
On the display path, `memo`, `memoHash`, and the flags all come from the same
indexer JSON (`api.ts:245-246`; rendered at `page.tsx:628`, tooltip logic
`458-469`), and the UI deliberately does not re-derive `memoHash` from the
node — reading chain events is the indexer's role, and the UI's only events
source is `fetchAllEvents` (`api.ts:345`). Net: action paths are
contract-anchored; the displayed memo and its match badge are advisory.

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

**5. Ephemeral zkApp key lifecycle & local storage.**
The only private key the UI holds is the in-browser zkApp deploy key
(`generateKeypair`), generated for a single tx and not persisted. It is
powerless after deploy: `deploy()` sets proofs-only account permissions in the
same transaction (`MinaGuard.ts:282-295`). The same applies to the child key
inside the CREATE_CHILD propose tx. `lib/storage.ts` holds non-secret prefs +
pending-tx metadata.

**6. Test-only escape hatches.**
`setTestKey` / `setSkipProofs` enable direct signing and dummy proofs, gated
on `NEXT_PUBLIC_E2E_TEST` (`worker.ts:676-691`, `multisigClient.ts:119-138`;
`skipProofs`/`DummyProof` feed `maybeProve`, `worker.ts:91-120`), which Next
inlines at build time so the branch is dead code in production.

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
│   │                            #   the air-gapped path — see offline-audit-guide.md).
│   │                            #   CLI download links point at a GitHub release
│   │                            #   (NEXT_PUBLIC_OFFLINE_CLI_RELEASE_URL) + SHA256SUMS
│   ├── ProposalForm.tsx         # Builds NewProposalInput (what the user intends to
│   │                            #   propose)
│   ├── MemoWarningTooltip.tsx   # Surfaces memo match/mismatch (renders the
│   │                            #   backend-provided memo flags)
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
├── types/
│   └── mina-signer.d.ts         # Ambient types for the submodule signer
│
├── deps/o1js/  (git submodule)  # Source for mina-signer browser build
├── package.json                 # Deps + postinstall esbuild of mina-signer
├── next.config.mjs              # mina-signer webpack alias; COOP/COEP headers
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
  signing and proving paths today. The guarantee is *identity, not versioning*: it holds
  as long as the submodule and the o1js pin reference the same mina-signer source that the
  proving path and the contract use.

### Signing hardware

- **`@ledgerhq/hw-transport-webhid`, `@ledgerhq/hw-transport`** — WebHID transport to a
  Ledger device (`ledgerWallet.ts`). Browser-only; requires a user gesture + HID
  permission.
- **`@zondax/ledger-mina-js`** — the Mina Ledger app client (`MinaApp`) used for
  `getAddress` / `signFields` / `signTransaction` on-device.

### Hashing primitives

- **`@noble/hashes`, `blakejs`, `js-sha256`** — low-level hash functions. The
  `postinstall` esbuild marks these (and `crypto`) `--external`, so the browser
  `mina-signer` bundle resolves them from `node_modules` rather than re-bundling its own
  copies.

### Worker boundary

- **`comlink`** — the `postMessage` RPC layer between the main thread and the Web Worker.
  This is the trust seam described in the threat model (main thread ⇄ worker): the worker
  proxies signer/network callbacks back across it. It is same-origin only, but it is the
  channel across which the *fields to be signed* travel, so it is in scope for the signer-
  boundary review (focus point 1).

> The Auro wallet is **not** an npm dependency — it is a browser extension reached via the
> injected `window.mina` provider (`auroWallet.ts`), so it does not appear in
> `package.json` and its version/behavior is outside this package's lockfile.
