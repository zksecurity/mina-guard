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

Three builders, one per action:

- **All bundles** carry `version: 1`, `minaNetwork` (`testnet`/`mainnet`,
  resolved at call time from the runtime config, devnet mapping to `testnet` —
  it selects the o1js network id, i.e. the fee-payer signature domain, and the
  CLI refuses the bundle if it doesn't match the network domain the CLI was
  started with, see stage 2), the contract address, the typed fee-payer
  address, **account snapshots** (GraphQL `FetchedAccount` shape, fetched live
  from the Mina node: the contract, the fee payer, and the child account when
  relevant), and the contract's **full event history** (paged out of the
  indexer's `/events` API and reversed to chronological order).
- **Propose** additionally carries the `input` (the `NewProposalInput` the
  form built) and a **fresh `configNonce`** (re-fetched from the backend
  immediately before export, mirroring the online flow's staleness guard).
- **Execute** additionally carries `receiverAccountExists` (per-receiver
  existence, probed against the node — determines account-creation funding),
  and for child actions the child address plus the **child's** event history;
  for CREATE_CHILD executes it derives `childOwners`/`childThreshold` from the
  child's `createChildConfig` events (`parseChildConfigFromEvents`).

After building, the UI surfaces **pre-transfer warnings** from data already in
the bundle (fee payer account missing; fee payer balance under 1 MINA;
receivers needing the 1 MINA account-creation fee) and downloads the bundle as
`<action>-<id>-<timestamp>.json`.

> Endpoint note: the Mina endpoint used for snapshots/broadcast — and the
> `minaNetwork` written into bundles, which selects the CLI's fee-payer
> signature domain — are resolved at call time through `getMinaGuardConfig()`
> (devnet maps to the `testnet` domain), so the desktop shell's runtime
> `window.__minaGuardConfig` override applies, same as the worker path. Only
> the backend `API_BASE` is fixed at build time (`NEXT_PUBLIC_API_BASE_URL`),
> which the desktop build sets explicitly.

### 2. Sign (`offline-cli/src/`)

```
MINA_PRIVATE_KEY=EKE... ./mina-guard-cli <bundle.json> [--yes] > signed.json
```

For mainnet bundles, additionally set `MINA_NETWORK_DOMAIN=mainnet` — it
selects the circuit's compile-time network domain (unset ⇒ testnet), and the
CLI rejects a bundle whose `minaNetwork` doesn't match it (step 6 below).
Progress goes to stderr; stdout stays pure JSON. The flow
(`index.ts` → `summary.ts` → `build-tx.ts`):

1. **Version gate** (`bundle.version === 1`), then **summary + confirmation**
   *before any compile/prove/sign work and before the key is touched*:
   `renderBundleSummary` prints the action, a loud `*** MAINNET ***` banner
   when applicable, contract, fee payer, fee, nonce, memo, proposal hash (for
   approve/execute), expiry, and the per-type body (receivers with amounts and
   a total, owner/threshold/delegate targets, sub-vault config). On a real
   terminal the operator must answer `y`; `--yes` /
   `MINA_GUARD_ASSUME_YES=1` skips the prompt, and **no attached TTY means it
   proceeds without asking** (visible in the log) — piped/CI use.
2. **Network setup** (`configureNetwork`): an o1js `Mina.Network` with dummy
   endpoints — the CLI never dials out. `getNetworkState` is patched to return
   defaults so network preconditions are set but only validated at broadcast.
   `bundle.minaNetwork` selects the o1js network id (mainnet vs testnet
   fee-payer signature domain).
3. **Account injection**: every bundled snapshot goes into o1js's account
   cache via `addCachedAccount` — nonces, balances, zkApp state, verification
   keys all come from the bundle.
4. **Merkle store reconstruction** (`rebuildStores`): replays the bundled
   event history into fresh `OwnerStore` / `ApprovalStore` /
   `VoteNullifierStore` instances — the same event-sourcing the web worker
   does from indexer data (`setupOwner` sorted inserts, `ownerChange`
   add/remove, `proposal` → count + proposer nullifier, `approval` →
   monotonically-increasing count + nullifier, `execution` → executed marker;
   child executions feed a separate `childExecutionRoot` map).
5. **Proposal struct + in-circuit signature**: for *propose* the struct is
   built from `bundle.input` (mirroring the worker's builders 1:1, including
   `memoHash = memoToField(input.memo ?? '')`); for *approve*/*execute* it is
   rebuilt from `bundle.proposal` (including the bundled `memoHash`). The CLI
   recomputes `proposalHash = proposal.hash()` and signs it with mina-signer's
   `signFields`. That call uses the **'devnet' signature domain by design and
   must stay that way** — o1js's in-circuit `Signature.verify` always uses the
   devnet prefix regardless of network; cross-network replay of proposals is
   instead prevented by the compile-time `NETWORK_DOMAIN` constant hashed into
   every proposal (`contracts/src/constants.ts`: `Field(1)` mainnet, `Field(2)`
   testnet, selected by `MINA_NETWORK_DOMAIN` — appended in
   `TransactionProposal.hash()`, `MinaGuard.ts:92`), plus the `guardAddress`
   and `configNonce` fields inside the struct. Because the constant is baked
   into the circuit, each network also has a **structurally distinct
   verification key** — a wrong-domain proof fails on-chain, not just in app
   logic.
6. **Compile + prove**: before compiling, the CLI **rejects a
   network-mismatched bundle** — `bundle.minaNetwork` must agree with the
   `MINA_NETWORK_DOMAIN` the process was started with (unset ⇒ testnet), so a
   testnet-domain run can't build proofs for mainnet proposals or vice versa
   (`build-tx.ts:701-716`). Then `MinaGuard.compile` with a filesystem cache
   (`./cache`, CWD-relative — the repo ships prover/verifier keys + SRS under
   `offline-cli/cache/` to skip the multi-minute first compile; the binary
   itself does not embed them). The cache is keyed to the circuit, so each
   network domain compiles its own entries. Proving takes minutes on typical
   hardware. `SKIP_PROOFS=1` swaps in dummy proofs (test hook — see focus
   point 6).
7. **Fee-payer signing** (`signFeePayer`): the proved tx JSON is wrapped and
   signed with mina-signer's **network-aware** `signZkappCommand`, which signs
   the fee payer *and* any fee-payer-owned signed account updates against the
   full commitment (the memo is round-tripped through `decodeTxMemo` so the
   commitment matches what o1js built). For CREATE_CHILD proposes,
   `signChildAccount` then signs the child's deploy update with the bundled
   child key and **grafts only those authorizations** back, so it can't wipe
   the fee-payer signature `signZkappCommand` just produced.
8. Output to stdout:

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

Execute handling mirrors the worker per type: local executes count
`AccountUpdate.fundNewAccount(executor, N)` **from the hash-bound
`proposalStruct.receivers`** (never the raw bundle array), using
`receiverAccountExists` to decide which receivers need funding; CREATE_CHILD
executes re-derive the child config hash and require it to equal
`proposal.data` (tamper check) and refuse an already-initialized child; child
lifecycle executes (reclaim/destroy/toggle multisig) run against the child
with the reconstructed `childExecutionRoot` witness. The broadcast memo on
executes is the bundle's `proposal.memo` — indexer-derived plaintext, advisory
only (same three-roles analysis as in the UI guide).

### 3. Broadcast (`UploadSignedResponse`, `ui/components/OfflineSigningFlow.tsx`)

The upload path validates before broadcasting:

- must parse as JSON with `type: 'offline-signed-tx'` (a helpful error tells
  the user when they uploaded the *bundle* instead of the signed output);
- `version === 1`; `action` must be in the page's accept-list; `transaction`
  must be present;
- **binding checks**: the response's `contractAddress` must equal the vault
  open on the page, and — on the proposal detail page — `proposalHash` must
  equal the proposal being viewed. A signed file for a different vault or
  proposal is rejected outright. (The propose page can only bind by contract:
  the proposal hash is new by definition.)

It then POSTs the `sendZkapp` mutation straight to the frontend-configured
Mina endpoint and maps common node rejections to actionable messages
(`Invalid_signature` → wrong key for the fee-payer address;
`Invalid_proof` → verification key changed since export, re-export;
`Insufficient_fee`). On success it records a pending tx (keyed by the typed
fee-payer address) so the normal pending-tx/lock reconciliation machinery
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
  and signed. The **only** defense is the CLI's summary + confirmation step —
  the operator must actually read it. Everything the hash covers is rendered
  (type, receivers/amounts + total, targets, nonce, expiry, memo, network,
  contract, fee payer). For propose the displayed memo *is* the string that
  gets hashed.
- **Approve bundles *claim* an existing proposal.** Tampering with any
  hash-covered field makes the CLI recompute a different `proposalHash`; the
  contract then fails the approval witness (`Proposal not found`) — the owner
  cannot be tricked into approving a proposal that doesn't exist. The residual
  attack is a **consistent swap**: replace the whole `proposal` object with a
  *different real pending proposal* — the CLI would faithfully produce a valid
  approval for it. Again the summary is the defense: the operator should
  verify the rendered contents (and the proposal hash) against what they
  expect from an out-of-band channel (the UI on the online machine, other
  owners). One caveat inside that check: the summary's **Memo line for
  approve/execute is the bundle's advisory plaintext** (`proposal.memo`),
  which is *not* covered by the hash (`memoHash` is) — a tampered bundle can
  pair a fabricated memo string with a real proposal's fields. Judge the
  proposal by its receivers/amounts/type, not its memo (same conclusion as
  the memo analysis in the UI guide).
- **Execute bundles** carry the least authority: execution is permissionless
  on-chain, so the worst a swapped execute bundle achieves is executing a
  *different fully-approved* proposal — something anyone could do anyway. A
  lying `receiverAccountExists` map makes the tx fail or misprice the
  executor-signed account-creation fee (bounded to 1 MINA per receiver slot).
- **`childPrivateKey` (createChild propose bundles) is the one secret-ish
  field.** It only has power to sign the child's *deploy* account update —
  after deployment all child state changes require proofs, not that key — but
  a bundle carrying it should still be treated as sensitive in transport.
  (Currently the UI never exports such a bundle; the field matters for
  hand-built ones.)

**Response transport (air gap → online) is also untrusted.** The response is
a fully signed and proved transaction: any mutation breaks the fee-payer
signature (it covers the full commitment) or the proof. The UI's binding
checks (contract + proposal hash) stop a *valid but different* signed file
from being broadcast in the wrong context, and the node verifies everything
that matters anyway. Broadcasting is not privileged.

**The CLI binary itself is the sharpest supply-chain point.** It is the very
program that will see `MINA_PRIVATE_KEY` and whose summary screen the operator
trusts — an attacker-supplied binary can lie about what it signs, and the
elaborate bundle-tamper analysis above is moot. The UI's download links point
at a **GitHub release** of this repo (`NEXT_PUBLIC_OFFLINE_CLI_RELEASE_URL`,
defaulting to the latest release), built and draft-published by CI together
with a `SHA256SUMS` file and `minaguard-vk-hash.txt` (see Build &
distribution). This replaces the earlier design where the *backend* compiled
and served the binary on demand — the party you trust at download time is now
the release pipeline (repo maintainers + GitHub Actions) rather than whoever
operates a backend host. Two caveats keep their teeth: `SHA256SUMS` ships in
the *same release* as the binaries, so checking it verifies transport
integrity, not publisher honesty; and the VK-hash fingerprint must match the
deployment you sign for. For high-assurance use, build the CLI from audited
source yourself and/or verify hashes out-of-band. Related hygiene: passing
the key as an inline env var can land in shell history/process listings on
shared machines.

#### Suggested focus points

**1. Summary faithfulness & duplicated-logic drift (`summary.ts` ↔
`build-tx.ts` ↔ `worker.ts` ↔ `contracts`).** The CLI deliberately duplicates
rather than imports UI logic (`normalizeTxType`, `uiTxTypeToField`,
`buildReceiversForProposal`, `buildProposalDataField`, a verbatim
`decodeTxMemo` copy, the `NewProposalInput` mirror, `ZKAPP_TX_FEE` "must match
the worker"). Any drift between the copies changes what is signed versus what
is shown/expected — and since the confirmation step is the propose-path's
entire defense, the summary has to render exactly the fields that feed
`proposal.hash()` and the outer tx (fee included).

**2. The approve-swap scenario.** The operator's ability to catch a
consistent swap rests entirely on the summary — and today the confirmation
screen prints the bundle's *claimed* `p.proposalHash`, while the recomputed
hash is only logged after confirmation. That, plus the advisory-memo caveat
above, bounds what the confirmation step can actually catch.

**3. Signature-domain split.** In-circuit proposal-hash signatures use
mina-signer's `signFields` with its fixed devnet domain (the code comments say
this must never be made network-aware, because o1js `Signature.verify` always
uses the devnet prefix); the fee payer is signed with the **network-aware**
`signZkappCommand`. Each half carries an invariant: cross-network replay of
proposals is blocked by the compile-time `NETWORK_DOMAIN` baked into the
proposal hash *and* the VK (plus `guardAddress`/`configNonce`/nonce) — the
`compileContract` bundle↔domain gate (`build-tx.ts:701-716`) is the UX-level
check, the per-network VK is the on-chain enforcement — and the fee-payer
domain (`minaNetwork`) has to match the chain the tx is broadcast to. Note
the two are set by *different* inputs (an env var vs. a bundle field); the
gate is what keeps them from silently diverging.

**4. Store reconstruction from bundled events (`rebuildStores`).** Same class
of concern as the worker's indexer-fed reconstruction (UI guide, focus
point 3), but the inputs here come from the *bundle file*: malicious or
reordered events steer owner ordering, approval counts, and nullifier roots.
The failure mode should always be a failing tx (witness mismatch), never a tx
against attacker-chosen state.

**5. Fee counting & account snapshots.** `countNewReceiverAccounts` derives
strictly from the hash-bound `proposalStruct.receivers` (bundle rows beyond
`MAX_RECEIVERS` can't inflate the fee). Account snapshots (nonce/balance/VK)
are attacker-controlled inputs; wrong ones should only be able to yield
failing transactions, not misdirected ones.

**6. `SKIP_PROOFS=1` runtime hatch (`build-tx.ts:699`, dummy-proof path
`726-737`).** Unlike the web
UI's compile-time-gated test hooks, this ships in every binary and is enabled
by an env var. 

**7. Confirmation policy (`confirmOrExit`).** No TTY ⇒ proceed without
prompting (with a log line); `--yes`/`MINA_GUARD_ASSUME_YES` skip it; an
unreadable `/dev/tty` despite a TTY also proceeds. These auto-proceed defaults
sit in tension with the "operator's last line of defense" role the summary
plays, especially in scripted setups.

**8. Upload validation completeness (`UploadSignedResponse`).** The binding
checks stop cross-vault/cross-proposal broadcast; the propose page can bind
only by contract, and the UI records `response.proposalHash` into pending-tx
tracking — a lying value should only be able to desync tracking.

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
├── cache/              # Committed o1js compile cache (prover/verifier keys, SRS)
│                       #   — skips the first-run compile; keyed to the circuit
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
on a three-leg runner matrix (each leg smoke-tests its own-arch binary — it
must reach the usage message, which exercises module init and the embedded
WASM), signs the macOS ones, then a single aggregation job attaches one
canonical `SHA256SUMS` plus `minaguard-vk-hash.txt` (a copy of
`contracts/.vk-hash`, which carries one VK hash per network) and publishes
everything as a **draft** release for manual review. `workflow_dispatch` runs
the same build as a dry run with CI artifacts only. The UI's download panel
links the binary and the `SHA256SUMS` of the release configured via
`NEXT_PUBLIC_OFFLINE_CLI_RELEASE_URL` (defaulting to `releases/latest`);
deployments should pin a release whose VK hash matches their deployed
contracts. The CLI inlines the circuit, so that hash comparison is what ties
a downloaded binary to the deployment it can actually produce proofs for.

The `offline-cli/cache/` directory in the repo holds the compile cache so the
first run doesn't spend minutes generating keys; the CLI looks for `./cache`
relative to its working directory and regenerates (slowly) if absent. The
cache is circuit-keyed (and therefore per-network-domain): after a contract
change, stale entries are simply recompiled.

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
