# Offline Signing (Air-Gapped CLI) — Architecture & Security Notes

This document describes the **air-gapped signing path**: the bundle
export/import UI inside the web app (`ui/lib/offline-signing.ts`,
`ui/components/OfflineSigningFlow.tsx`) and the standalone CLI
(`offline-cli/`) that builds, proves, and signs MinaGuard transactions on a
machine with **no network access and no wallet software**.

It complements [`ui-audit-guide.md`](./ui-audit-guide.md) (the online UI and
its threat model) and [`desktop-audit-guide.md`](./desktop-audit-guide.md).

---

## General overview

Owners who keep a key on an air-gapped machine can participate in the full
propose → approve → execute lifecycle without that key ever touching a
networked device:

1. **Export** — on the online machine, the web UI builds a JSON **request
   bundle** containing everything needed to construct, prove, and sign the
   transaction offline: on-chain account snapshots, the contract's full event
   history (to rebuild the Merkle stores), and the action parameters.
2. **Sign** — the bundle is carried (USB stick, QR, …) to the air-gapped
   machine, where the self-contained CLI binary reads it, **shows a
   human-readable summary and asks for confirmation**, compiles the MinaGuard
   circuit, generates the zero-knowledge proof, signs the proposal hash and
   the fee payer with `MINA_PRIVATE_KEY`, and writes a **signed response**
   JSON to stdout.
3. **Broadcast** — back on the online machine, the signed response is uploaded
   in the UI, which validates it and broadcasts the pre-signed transaction
   directly to the configured Mina GraphQL endpoint (`sendZkapp`). The backend
   is never involved in broadcasting.

The transport medium in both directions is assumed **untrusted** — see the
threat model below for exactly what protects each leg.

Where it lives in the UI: proposal creation (`app/transactions/new`) has an
**Online / Offline** toggle for *propose*; the proposal detail page
(`app/transactions/[id]`) has the same toggle for *approve* and *execute*.
In offline mode the user types the **fee-payer address** (the air-gapped
owner's public key — no wallet connection is needed); the UI checks it is an
active owner (and, for approve, has not already approved) before exporting.
One asymmetry to know: **CREATE_CHILD proposals cannot currently be exported**
— sub-vault creation is wizard-only in the online flow — although the bundle
format and the CLI fully support them (relevant for hand-built bundles);
*approve* and *execute* for a CREATE_CHILD proposal export normally.

```
 online machine                    air gap                   online machine
┌─────────────────┐          ┌──────────────────┐          ┌─────────────────┐
│ web UI          │  bundle  │ mina-guard-cli   │  signed  │ web UI          │
│  export builder ├─────────▶│  summary+confirm │─────────▶│  upload+validate│
│  (accounts +    │  .json   │  compile+prove   │  .json   │  sendZkapp ─────┼──▶ Mina node
│   events from   │          │  sign (mina-     │          │  (direct to     │
│   node+indexer) │          │   signer + key)  │          │   node GraphQL) │
└─────────────────┘          └──────────────────┘          └─────────────────┘
```

---

## How each stage works

### 1. Export (`ui/lib/offline-signing.ts`, main thread — no o1js needed)

One builder per action. Every bundle carries the target network
(`minaNetwork`, resolved at call time from the runtime config, devnet mapping
to `testnet`; it selects the fee-payer signature domain and must match the
domain the CLI runs with), the contract and typed fee-payer addresses, live
**account snapshots** from the Mina node, and the contract's **full event
history** from the indexer — everything the CLI needs to stay fully offline.
Propose bundles add the form's `NewProposalInput` and a freshly re-fetched
`configNonce`; execute bundles add per-receiver existence
(`receiverAccountExists`) and, for child actions, the child's address and
event history. Field-by-field details are in the bundle format reference
below.

After building, the UI surfaces **pre-transfer warnings** from data already in
the bundle (missing fee-payer account, balance under 1 MINA, account-creation
fees) and downloads the bundle as `<action>-<id>-<timestamp>.json`.

> Endpoint note: the snapshot/broadcast endpoint and the bundle's
> `minaNetwork` resolve at call time via `getMinaGuardConfig()`, so the
> desktop shell's runtime `window.__minaGuardConfig` override applies, same
> as the worker path. Only the backend `API_BASE` is fixed at build time
> (`NEXT_PUBLIC_API_BASE_URL`).

### 2. Sign (`offline-cli/src/`)

```
MINA_PRIVATE_KEY=EKE... ./mina-guard-cli <bundle.json> [--yes] > signed.json
```

For mainnet bundles, additionally set `MINA_NETWORK_DOMAIN=mainnet` — it
selects the circuit's compile-time network domain (unset ⇒ testnet), and the
CLI rejects a bundle whose `minaNetwork` doesn't match it (step 4 below).
Progress goes to stderr; stdout stays pure JSON. The flow
(`index.ts` → `summary.ts` → `build-tx.ts`):

1. **Summary + confirmation first** — after a version gate, and *before any
   compile/prove/sign work or key use*, `renderBundleSummary` renders
   everything the proposal hash covers (action, contract, fee payer, fee,
   nonce, memo, expiry, the per-type body, a `*** MAINNET ***` banner when
   applicable) and asks for `y`; `--yes` / `MINA_GUARD_ASSUME_YES=1` — or no
   attached TTY — skips the prompt (see focus point 7).
2. **Offline chain state** — an o1js network with dummy endpoints (the CLI
   never dials out), the bundled account snapshots injected into o1js's
   account cache, and the Merkle stores rebuilt by replaying the bundled
   event history (`rebuildStores`) — the same event-sourcing the web worker
   does from indexer data, with child executions feeding a separate
   `childExecutionRoot` map.
3. **Proposal hash + in-circuit signature** — the proposal struct is built
   from `bundle.input` (propose) or rebuilt from `bundle.proposal`
   (approve/execute), mirroring the worker 1:1; the CLI recomputes
   `proposalHash = proposal.hash()` and signs it with mina-signer's
   `signFields` — deliberately with the fixed 'devnet' domain that o1js's
   in-circuit `Signature.verify` always uses. Cross-network replay is
   prevented instead by the compile-time `NETWORK_DOMAIN` baked into the
   proposal hash (`TransactionProposal.hash()`, `MinaGuard.ts:92`) and into
   the per-network VK (see focus point 3).
4. **Compile + prove** — after rejecting a bundle whose `minaNetwork`
   disagrees with the process's `MINA_NETWORK_DOMAIN` (`build-tx.ts:731-739`),
   `MinaGuard.compile` runs against the local `offline-cli/cache/`
   (gitignored, generated on first run; circuit-keyed, so per-domain; a cold
   cache regenerates in minutes).
   Proving takes minutes on typical hardware; `SKIP_PROOFS=1` swaps in dummy
   proofs (see focus point 6).
5. **Fee-payer signing + output** — the proved tx is signed with mina-signer's
   **network-aware** `signZkappCommand` (the fee payer and any fee-payer-owned
   signed account updates); for CREATE_CHILD proposes the child's deploy
   update is additionally signed with the bundled child key, without
   disturbing the fee-payer signature. The signed response goes to stdout:

```json
{
  "version": 1,
  "type": "offline-signed-tx",
  "action": "propose | approve | execute",
  "contractAddress": "B62q...",
  "proposalHash": "...",
  "transaction": { /* sendZkapp-compatible zkApp command JSON */ }
}
```

Execute handling mirrors the worker per type: account-creation funding is
counted **from the hash-bound `proposalStruct.receivers`**, never the raw
bundle array; CREATE_CHILD executes re-derive the child config hash against
`proposal.data` and refuse an already-initialized child. The broadcast memo
on executes is the bundle's advisory `proposal.memo` (see the UI guide).

### 3. Broadcast (`UploadSignedResponse`, `ui/components/OfflineSigningFlow.tsx`)

The upload path validates the file shape (`type: 'offline-signed-tx'`,
`version === 1`, an accepted `action`, a `transaction` present) and enforces
the **binding checks**: the response's `contractAddress` must equal the vault
open on the page, and on the proposal detail page `proposalHash` must equal
the proposal being viewed — a signed file for a different vault or proposal
is rejected. (The propose page can only bind by contract: its hash is new by
definition.) It then POSTs `sendZkapp` straight to the frontend-configured
Mina endpoint, maps common node rejections to actionable messages, and on
success records a pending tx so the normal pending-tx/lock reconciliation
takes over.

---

## Bundle format reference (version 1)

### Common fields (`BundleBase`)

| Field | Type | Purpose |
|-------|------|---------|
| `version` | `1` | Format version (checked by both CLI and upload path) |
| `action` | `"propose" \| "approve" \| "execute"` | Dispatch |
| `minaNetwork` | `"testnet" \| "mainnet"` | o1js network id → fee-payer signature domain; must match the CLI's `MINA_NETWORK_DOMAIN` |
| `contractAddress` | `string` | The vault being operated on |
| `feePayerAddress` | `string` | Public key of the air-gapped signer (must match `MINA_PRIVATE_KEY`) |
| `accounts` | `Record<address, FetchedAccount>` | On-chain snapshots injected via `addCachedAccount` (nonce, balance, zkApp state, verification key) |
| `events` | `Array<{eventType, payload}>` | Full contract event history for Merkle-store reconstruction |

Event types replayed: `setupOwner`, `ownerChange`, `ownerChangeBatch`,
`proposal`, `approval`, `execution`, `executionBatch`.

### `propose` extras

| Field | Type | Purpose |
|-------|------|---------|
| `configNonce` | `number` | Current governance nonce (freshly fetched; binds the proposal to the current owner/threshold config) |
| `input.txType` | `string` | `transfer`, `addOwner`, `removeOwner`, `changeThreshold`, `setDelegate`, `createChild`, `allocateChild`, `reclaimChild`, `destroyChild`, `enableChildMultiSig` |
| `input.nonce` | `number` | Proposal nonce (LOCAL vs REMOTE nonce spaces; `createChild` is pinned to 0) |
| `input.receivers` | `[{address, amount}]` | Transfer/allocate recipients |
| `input.newOwner` / `input.removeOwnerAddress` | `string` | Governance targets |
| `input.newThreshold` | `number` | changeThreshold |
| `input.delegate` / `input.undelegate` | `string` / `boolean` | setDelegate |
| `input.reclaimAmount` | `string` | reclaimChild (nanomina) |
| `input.childAccount` | `string` | Target child (child actions) |
| `input.childMultiSigEnable` | `boolean` | enableChildMultiSig |
| `input.createChildConfigHash` | `string` | createChild: Poseidon(ownersCommitment, threshold, numOwners) |
| `input.childPrivateKey` | `string` | createChild only — signs the child's deploy update (see threat model) |
| `input.childOwners` / `input.childThreshold` | `string[]` / `number` | createChild config |
| `input.expirySlot` | `number` | Optional expiry |
| `input.memo` | `string` | Plaintext memo — hashed into the proposal **and** attached as the broadcast memo |

### `approve` extras

| Field | Type | Purpose |
|-------|------|---------|
| `proposal` | object | The claimed proposal, mirroring the backend record: `proposalHash`, `proposer`, `toAddress`, `tokenId`, `txType`, `data`, `nonce`, `configNonce`, `expirySlot`, `guardAddress`, `destination`, `childAccount`, `memoHash`, `memo` (advisory plaintext), `receivers` |

The CLI does **not** trust `proposal.proposalHash` — it rebuilds the struct
from the fields and recomputes the hash it signs.

### `execute` extras

| Field | Type | Purpose |
|-------|------|---------|
| `proposal` | object | Same shape as approve |
| `receiverAccountExists` | `Record<address, boolean>` | Which receivers already exist on-chain (drives `fundNewAccount`; absent/false ⇒ treated as new) |
| `childAddress` | `string?` | Child contract (child actions) |
| `childEvents` | `Array?` | Child event history (child lifecycle actions — rebuilds `childExecutionRoot`) |
| `childOwners` / `childThreshold` | `string[]?` / `number?` | createChild execute: announced config, re-verified against `proposal.data` by the CLI **and** by the contract |

---

## Threat model

**What the air gap buys:** `MINA_PRIVATE_KEY` exists only on the offline
machine. Nothing in the bundle or the signed response contains it, and the
signed response can only effect the exact, proved transaction it carries.

**Bundle transport (online → air gap) is untrusted.** What protects each
action differs, and the distinction is the heart of this design:

- **Propose bundles *define* intent.** There is no pre-existing on-chain
  object to check against: whatever `input` says is what gets hashed, proved,
  and signed. The CLI renders everything the hash covers in the summary
  before signing, and for propose the displayed memo *is* the string that
  gets hashed.
- **Approve bundles *claim* an existing proposal.** The CLI does not trust
  the bundle's `proposalHash`; it rebuilds the struct from the hash-covered
  fields and recomputes it, and the contract requires that hash to match a
  proposal that exists on-chain (`Proposal not found` otherwise). The summary
  renders the rebuilt proposal's fields for out-of-band comparison; its Memo
  line is the bundle's advisory plaintext, not the hash-covered `memoHash`
  (see focus point 2).
- **Execute bundles.** Execution is permissionless on-chain: anyone can
  submit a fully-approved proposal. The `receiverAccountExists` map drives the
  executor-signed account-creation fee (1 MINA per new receiver slot), counted
  from the hash-bound `proposalStruct.receivers`.
- **`childPrivateKey` (createChild propose bundles).** It signs the child's
  *deploy* account update; post-deploy, all child state changes require
  proofs. The UI never exports such a bundle — the field matters only for
  hand-built ones.

**Response transport (air gap → online) is also untrusted.** The response is
a fully signed and proved transaction: any mutation breaks the fee-payer
signature (it covers the full commitment) or the proof. The UI's binding
checks (contract + proposal hash) tie the signed file to the vault/proposal
open on the page, and the node verifies the signature and proof on receipt.
Broadcasting is not privileged.

**The CLI binary is the trust root of the offline path.** It handles
`MINA_PRIVATE_KEY` and renders the summary the operator relies on. Binaries
come from a **GitHub release** of this repo pinned by
`NEXT_PUBLIC_OFFLINE_CLI_RELEASE_URL` (see Build & distribution), so
provenance rests with the release pipeline (maintainers + GitHub Actions)
rather than a backend operator, as in the earlier build-on-demand design.
`SHA256SUMS` ships in the same release as the binaries, and the release's
`minaguard-vk-hash.txt` identifies the deployment its proofs target. The key
is read from the `MINA_PRIVATE_KEY` environment variable.

#### Suggested focus points

**1. Summary faithfulness & duplicated-logic drift (`summary.ts` ↔
`build-tx.ts` ↔ `worker.ts` ↔ `contracts`).** The CLI deliberately duplicates
rather than imports UI logic (`normalizeTxType`, `uiTxTypeToField`,
`buildReceiversForProposal`, `buildProposalDataField`, a verbatim
`decodeTxMemo` copy, the `NewProposalInput` mirror, `ZKAPP_TX_FEE`). The
summary renders the fields that feed `proposal.hash()` and the outer tx (fee
included), so these copies sit on the propose path between what is signed and
what the operator sees.

**2. What the confirmation screen shows.** The summary prints the bundle's
*claimed* `p.proposalHash`; on approve/execute the hash the CLI recomputes from
the fields is **verified against that claimed hash (hard failure on mismatch)**
before any signing (`assertRecomputedProposalHash`, `build-tx.ts:381`, called at
`929`/`1023`) — propose mints a new proposal, so there is no prior hash to check.
The Memo line is the bundle's advisory plaintext, not the hash-covered
`memoHash`.

**3. Signature-domain split.** In-circuit proposal-hash signatures use
mina-signer's `signFields` with its fixed devnet domain (the code comments say
this must never be made network-aware, because o1js `Signature.verify` always
uses the devnet prefix); the fee payer is signed with the **network-aware**
`signZkappCommand`. Each half carries an invariant: cross-network replay of
proposals is blocked by the compile-time `NETWORK_DOMAIN` baked into the
proposal hash *and* the VK (plus `guardAddress`/`configNonce`/nonce) — the
`compileContract` bundle↔domain gate (`build-tx.ts:731-739`) is the UX-level
check, the per-network VK is the on-chain enforcement — and the fee-payer
domain (`minaNetwork`) has to match the chain the tx is broadcast to. Note
the two are set by *different* inputs (an env var vs. a bundle field); the
gate is what keeps them from silently diverging.

**4. Store reconstruction from bundled events (`rebuildStores`).** Same seam
as the worker's indexer-fed reconstruction (UI guide, focus point 3), but the
inputs come from the *bundle file*: the replayed events determine owner
ordering, approval counts, and nullifier roots, which become the witnesses
the contract checks on-chain.

**5. Fee counting & account snapshots.** `countNewReceiverAccounts` derives
strictly from the hash-bound `proposalStruct.receivers` (bundle rows beyond
`MAX_RECEIVERS` don't affect the count). Account snapshots (nonce/balance/VK)
come from the bundle and feed o1js's account cache; the proved tx is checked
against real chain state at broadcast.

**6. `SKIP_PROOFS=1` runtime hatch (`build-tx.ts:722`, dummy-proof path
`749-758`).** Unlike the web UI's compile-time-gated test hooks, this ships in
every binary and is enabled by an env var.

**7. Confirmation policy (`confirmOrExit`).** No attached TTY ⇒ proceed
without prompting (with a log line); `--yes`/`MINA_GUARD_ASSUME_YES` skip it;
an unreadable `/dev/tty` despite a TTY also proceeds.

**8. Upload validation (`UploadSignedResponse`).** The binding checks compare
the response's `contractAddress`/`proposalHash` against the open
vault/proposal; the propose page can bind only by contract. The UI records
`response.proposalHash` into pending-tx tracking.

---

## File tree

```
offline-cli/
├── src/
│   ├── index.ts        # Entry: args/env parsing, version gate, summary+confirm,
│   │                   #   dispatch to handlers, stdout discipline. Also the
│   │                   #   worker-mode guard: o1js spawns its WASM thread pool by
│   │                   #   re-running this very binary, so non-main threads load
│   │                   #   o1js's node-backend and exit instead of running the CLI
│   ├── build-tx.ts     # The core: bundle types, network stub, addCachedAccount
│   │                   #   injection, store reconstruction, proposal building,
│   │                   #   network-domain gate, compile/prove, mina-signer field +
│   │                   #   fee-payer signing, child deploy grafting (mirrors the
│   │                   #   web worker 1:1)
│   ├── summary.ts      # Human-readable bundle summary + y/N confirmation
│   │                   #   (the operator's tamper check — duplicated formatters)
│   ├── wasm-shim.ts    # Embeds plonk + kimchi WASM into the compiled binary
│   │                   #   (patches fs.readFileSync; redirects kimchi_wasm.cjs
│   │                   #   resolution inside Bun-compiled binaries via a temp-dir
│   │                   #   stub — see the file's comments before touching it)
│   └── tests/          # Unit + e2e tests (bundle → sign → broadcast on lightnet)
├── cache/              # o1js compile cache (prover/verifier keys, SRS) — NOT
│                       #   committed (gitignored); generated locally on first
│                       #   run, keyed to the circuit (per network domain)
└── package.json        # deps: contracts (workspace), mina-signer (ui submodule)

ui/
├── lib/offline-signing.ts        # Bundle builders + types (main thread; fetches
│                                 #   node snapshots + indexer events)
└── components/OfflineSigningFlow.tsx  # Export button + warnings + CLI download
                                  #   instructions; UploadSignedResponse validation
                                  #   + direct sendZkapp broadcast
```

---

## Build & distribution

The CLI is a self-contained Bun-compiled binary bundling o1js (with the
Kimchi/Plonk prover), the embedded prover WASM (via `wasm-shim.ts`), the
browser build of `mina-signer` (the same `ui/deps/o1js` submodule build
the UI uses — see the dependency note in the UI guide), and the `contracts`
source:

```bash
cd offline-cli
bun build --compile --target=bun-<os>-<arch> src/index.ts \
  --outfile dist/mina-guard-cli-<os>-<arch> \
  --define 'process.versions.node=""'
```

The `--define` keeps o1js off Node-specific code paths that don't exist in the
Bun runtime. Supported targets: `darwin`/`linux`/`windows` × `x64`/`arm64`
(as exposed by the download UI; Windows binaries carry `.exe`). macOS
binaries must additionally be **codesigned with JIT entitlements**
(`allow-jit` + `allow-unsigned-executable-memory`; ad-hoc identity is enough)
or the embedded WASM fails to load at runtime. One binary serves both
networks: the circuit's `NETWORK_DOMAIN` is selected per run by the
`MINA_NETWORK_DOMAIN` env var, not at binary-build time.

**Distribution — GitHub releases** (`.github/workflows/offline-cli-release.yml`):
pushing an `offline-cli-v*` tag builds all five platform binaries **natively**
on a three-leg runner matrix (each leg smoke-tests its own-arch binary,
exercising module init and the embedded WASM), signs the macOS ones, and an
aggregation job attaches one canonical `SHA256SUMS` plus
`minaguard-vk-hash.txt` (a copy of `contracts/.vk-hash`, one hash per
network), publishing everything as a **draft** release for manual review
(`workflow_dispatch` = dry run, CI artifacts only). The UI's download panel
links the binary and `SHA256SUMS` of the release pinned by
`NEXT_PUBLIC_OFFLINE_CLI_RELEASE_URL`. There is deliberately **no default
URL**: `releases/latest` resolves repo-wide (the desktop app releases through
the same repo) and can stop carrying CLI assets at any moment — and the right
release is a per-deployment choice anyway: pin the one whose VK hash matches
the deployed contracts, since the binary inlines the circuit. When the
variable is unset, the panel shows setup guidance instead of a link.

The `offline-cli/cache/` directory holds o1js's compile cache, but it is **not
committed** — it is `.gitignore`d (the repo-wide `cache/` rule). The CLI
generates it locally on first run, looking for `./cache` relative to its working
directory and regenerating (slowly) if absent, so the first run is the one that
spends the minutes to build the keys. The cache is circuit-keyed (and therefore
per-network-domain): after a contract change, stale entries are simply
recompiled.

## Dependencies

- **`contracts` (`workspace:*`)** — the circuit itself plus the shared struct/
  store/memo helpers; the CLI's reconstruction must agree with the contract
  exactly, same as the UI. Inlined into the compiled binary.
- **`mina-signer` (`file:../ui/deps/o1js/src/mina-signer`)** — proposal-hash
  field signing and network-aware fee-payer signing. Imported as the
  postinstall-built browser ESM bundle from the `ui/deps/o1js` submodule; the
  byte-identity note from the UI guide applies here too.
- **`o1js` (3.0.0-mesa.final, hoisted)** — compile/prove; the wasm shim exists
  to embed its prover WASM (plonk + kimchi) into the single-file binary and to
  keep its CJS module resolution working inside Bun's virtual filesystem.
