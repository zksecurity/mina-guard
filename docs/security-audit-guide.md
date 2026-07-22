# Security Model — Trust Boundaries, Invariants & Accepted Risks

This document is the **entry point for a security review** of MinaGuard: what the
system protects, which code is trusted, the invariants it relies on and where each
is enforced and tested, and the risks we knowingly accept. It describes the system
**as of the commit it ships with** — mechanism detail lives in the per-component
audit guides and is linked, not restated.

The audit-guide series this file heads:

- [`contracts-audit-guide.md`](./contracts-audit-guide.md) — the on-chain circuit (the trust anchor).
- [`backend-audit-guide.md`](./backend-audit-guide.md) — the indexer + read API (untrusted for integrity).
- [`ui-audit-guide.md`](./ui-audit-guide.md) — the online web UI and its blind-signing threat model.
- [`desktop-audit-guide.md`](./desktop-audit-guide.md) — the self-contained Electron build.
- [`offline-audit-guide.md`](./offline-audit-guide.md) — the air-gapped signing path (CLI + bundle format).
- [`deploy-audit-guide.md`](./deploy-audit-guide.md) — deployment topology and operator-facing surfaces.

Reading order for an audit: this file → [`contracts-audit-guide.md`](./contracts-audit-guide.md) →
[`backend-audit-guide.md`](./backend-audit-guide.md) → [`offline-audit-guide.md`](./offline-audit-guide.md) →
[`ui-audit-guide.md`](./ui-audit-guide.md) → [`desktop-audit-guide.md`](./desktop-audit-guide.md).

---

## Trust model

### What MinaGuard protects

MinaGuard is a **non-custodial** hierarchical multisig vault. Funds held by a guard
contract move only when a proposal reaches its owner-signature threshold and a proven
contract method executes it. No server in the system holds a key that can move vault
funds: owner signatures are produced in the owners' own wallets (Auro extension or
Ledger via WebHID) or on an air-gapped machine via the offline CLI, and the contract's
account permissions (`send: proof()`, `editState: proof()`, `setPermissions: impossible()`)
rule out any non-proof path to the balance or state.

### Trusted computing base

The code that must be correct for funds to be safe:

| Component | Why it is trusted | Role |
|---|---|---|
| `contracts/src/**` | Defines the circuit: owner membership, proposal hashing, approval counting, replay guards, permissions | The on-chain enforcement layer |
| `ui/lib/multisigClient.worker.ts` | Constructs the `TransactionProposal` structs, proposal hashes, and Merkle witnesses that owners sign and that transactions carry | What you sign is what this code builds |
| `offline-cli/src/` (`build-tx.ts`, `index.ts`, `summary.ts`, `wasm-shim.ts`) | Same construction role for the air-gapped path | Trust-minimized signing path |
| o1js (`o1js@3.0.0-mesa.final`) + `mina-signer` (built from the pinned `ui/deps/o1js` submodule) | Proof system, hashing (Poseidon), signatures | Cryptographic foundation |
| `desktop/src/preload.js`, `desktop/src/ipc.ts`, `desktop/src/auro/*` | Bridge the transaction payloads Auro signs in the self-contained Electron build (which also embeds the backend in-process) | Desktop signing path |

Everything else — the backend indexer/API, the rest of the UI, the rest of `desktop/`, `deploy/`,
`preview-env/`, `dev-helpers/`, `e2e/` — is **outside the TCB for fund safety** (see the next
section for what a compromise there can and cannot do).

### What a compromised component can do

**Backend (indexer + API).** It holds no keys and its data is a re-indexable materialized
view of public chain events. It cannot forge approvals: every approval requires an owner
signature over the proposal hash, verified in-circuit against `ownersCommitment`. It also
cannot trick an owner into approving something other than what it displays: on the approve and
execute paths the UI worker and the offline CLI **recompute the proposal hash from the proposal
fields themselves and verify it equals the selected proposal's identity**
(`assertRecomputedProposalHash` in `multisigClient.worker.ts` and `build-tx.ts`, PR #111),
aborting before any signature or execution if the two differ. So even if the backend serves the
fields of a *different* real proposal under a given `proposalHash` — the case a bare
existence check would miss, since that slot does exist — the client-side mismatch is caught and
nothing is signed. The damage ceiling for a fully compromised backend is therefore
**censorship and denial of service**: hiding proposals, showing stale state, causing failed
transactions. (The one surface where a lying indexer's data is *displayed* but not
action-bound — the memo badge — is analyzed in [`ui-audit-guide.md`](./ui-audit-guide.md) focus
point 3, and is display-bounded.)

**Frontend.** A tampered frontend is the primary systemic risk: it could construct a malicious
proposal and present it as benign. Two structural defenses bound this: the **threshold** — the
attacker must deceive `threshold` independent signers, each signing in their own wallet — and
the **offline CLI**, which lets an owner reconstruct, verify, and sign entirely from a bundle on
an air-gapped machine (`renderBundleSummary` prints the full decoded payload and `confirmOrExit`
requires explicit confirmation before anything is signed). Owners with material funds at stake
should treat the offline path as the reference signing flow. The self-contained
[desktop build](./desktop-audit-guide.md) shrinks the remote-frontend dependency from "the hosting
operator, continuously" to "the installer you obtained, once."

**Deploy/infra.** Operational security (servers, firewalls, CI, secrets) is documented in the
private ops repo (`mina-guard-ops/architecture.md`, available to auditors on request) and, for the
in-repo deployment assets, in [`deploy-audit-guide.md`](./deploy-audit-guide.md). By the
non-custodial design above, even host-root compromise cannot move vault funds directly.

### One-time trust at deploy

The account that deploys and runs `setup()` chooses the initial owner set (`setup()` takes
`threshold`, `numOwners`, `initialOwners`). The owners commitment is computed **in-circuit** from
the supplied owner list (`computeSetupOwnersChain` + `assertCoherentSetupOwners`), so the stored
commitment cannot disagree with the announced owners — but the *choice* of owners at genesis is
the deployer's, as in any multisig. Verify the setup events before depositing.

`deploy()`, `setup()`, and `reserveForParent()` are separately callable and each authorized by
proof alone with no deployer binding, so a guard left deployed-but-uninitialized can be front-run:
anyone can call `setup()` with their own owner set, or `reserveForParent()` to bind the address to
an attacker parent (permanently blocking the legitimate `setup()`). Callers therefore MUST include
`deploy()` and `setup()`/`reserveForParent()` in the SAME transaction so no uninitialized on-chain
window exists — this is a caller obligation, not something the circuit enforces (see the #112
doc-comments on `deploy()`/`setup()`/`reserveForParent()` in `MinaGuard.ts`).

## Invariants

The authoritative mechanism descriptions live in
[`contracts-audit-guide.md` § Security properties](./contracts-audit-guide.md#security-properties).
This table maps each claim to its enforcement point and primary test coverage (all paths under
`contracts/src/`; tests under `contracts/src/tests/`).

| Invariant | Enforced in | Primary tests |
|---|---|---|
| Only owners can propose / approve | `propose()`, `approveProposal()` via `assertOwnerMembership` against `ownersCommitment` | `propose.test.ts`, `approve.test.ts`, `list-commitment.test.ts` |
| Approvals cannot be forged | `propose()` / `approveProposal()` verify an owner signature over the proposal hash in-circuit (`signature.verify(owner, [proposalHash])`) — membership alone is not enough | `propose.test.ts`, `approve.test.ts` ("reject invalid signature") |
| No double-voting | vote nullifier map keyed `hash(proposalHash, approver)` | `approve.test.ts` |
| Approvals bind to exact content | approvals keyed by `TransactionProposal.hash()` (includes `guardAddress`, `destination`, `childAccount`) | `propose.test.ts`, `approve.test.ts` |
| Only native MINA is transferable | `propose()` asserts `proposal.tokenId == 0` — `executeTransfers` always sends on the default token, so a non-zero tokenId is rejected at proposal time and can never be approved as a MINA send | `propose.test.ts` ("reject a proposal with a non-zero tokenId") |
| Cannot approve a nonexistent proposal | approval slot must be `>= PROPOSED_MARKER` | `approve.test.ts` |
| No LOCAL re-execution | `EXECUTED_MARKER` overwrites the approval slot | `execute.test.ts` |
| No REMOTE re-execution | child's `childExecutionRoot` marks executed proposals | `child.test.ts` |
| Threshold met before execution | every `execute*` verifies count ≥ `threshold` against `approvalRoot` | `execute.test.ts` |
| What executes is exactly what was approved | `execute*` recomputes `proposal.hash()` from the caller-supplied struct and requires threshold on that hash — receivers, amounts, and `data` cannot deviate from the approved payload | `execute.test.ts` |
| Execution is permissionless (liveness) | no owner gate on any `execute*` — once threshold is met, anyone can execute; a non-cooperating proposer cannot strand an approved proposal | `execute.test.ts` ("allow anyone to trigger execution") |
| Stale proposals invalidated | `configNonce` match + execution-nonce ordering (`nonce` / `parentNonce`) | `governance.test.ts`, `execute.test.ts` |
| Time-bounded proposals | optional `expirySlot` vs `globalSlotSinceGenesis` | `execute.test.ts` |
| Cross-network replay prevented | compile-time `NETWORK_DOMAIN` (Field(1) mainnet / Field(2) testnet/devnet) folded into every proposal hash (`constants.ts`, `TransactionProposal.hash()`), producing a structurally distinct VK per network — there is no `networkId` field or state | no unit test; the per-network VK is pinned by the `check-vk-hash` CI job against `contracts/.vk-hash` |
| Cross-contract / cross-child replay prevented | `guardAddress` and `childAccount` inside the proposal hash; children assert `childAccount == this.address` | `child.test.ts` |
| Setup owner list coherent with commitment | commitment computed in-circuit; duplicate owners and non-empty padding rejected | `setup.test.ts`, `list-commitment.test.ts` |
| Executed child config = displayed config | `reservedConfigHash` written once at `reserveForParent`; `executeSetupChild` binds `proposal.data` and `reservedConfigHash` to the recomputed hash | `child.test.ts` |
| Child cannot be hijacked between deploy and setup | Caller obligation, **not** a circuit invariant: callers MUST bundle `deploy()` + `reserveForParent()` (or `setup()`) into ONE transaction — none is deployer-bound. The circuit only enforces that `setup()` and `reserveForParent()` require `parent == empty` (write-once), so a separately-deployed guard can be front-run before it is reserved/set up | `child.test.ts` |
| Hierarchy depth capped at two levels | REMOTE proposals (including `CREATE_CHILD`) are rejected on any guard whose `parent != empty` — children cannot spawn children | `child.test.ts` |
| Parent can always recover child funds | `executeReclaimToParent` / `executeDestroy` deliberately skip the `childMultiSigEnabled` check — disabling a child never strands its balance | `child.test.ts` |
| Parent state drift voids REMOTE approvals | child pins parent state via AccountUpdate preconditions | `child.test.ts` |
| Governance preserves `0 < threshold ≤ numOwners ≤ MAX_OWNERS` | `setup()`, `executeOwnerChange()`, `executeThresholdChange()` all assert the bounds — the vault can be neither locked (threshold unreachable) nor unbounded | `setup.test.ts`, `governance.test.ts` |
| No permission downgrade / VK swap | `setPermissions: impossible()`, `setVerificationKey: impossibleDuringCurrentVersion()` set in `deploy()` | `setup.test.ts` |

Off-chain, one invariant matters for the trust argument above: **clients recompute the hash they
sign from the fields they display and verify it equals the selected proposal's identity** —
`ui/lib/multisigClient.worker.ts` and `offline-cli/src/build-tx.ts` reconstruct the
`TransactionProposal` struct and call `.hash()` locally, then `assertRecomputedProposalHash` aborts
the approve or execute before any signature if the recomputed hash does not match the proposal the
owner selected. (Propose mints a fresh proposal with no prior identity, so it has nothing to match
against and skips the check.)

The deployed verification key is pinned in CI: `contracts/.vk-hash` holds canonical hashes for
testnet and mainnet (`testnet=` and `mainnet=` labeled entries — each network produces a structurally
distinct VK because `NETWORK_DOMAIN` is baked into the circuit at compile time), and the
`check-vk-hash` job recompiles both and fails on drift whenever a change touches VK-affecting paths
or `contracts/.vk-hash` (it skips the compile otherwise, so it does not run on every push), so the
reviewed source and the on-chain VK cannot silently diverge.

## Accepted risks and known limitations

| # | Risk | Status |
|---|---|---|
| 1 | **`networkId` is deployer-supplied.** Cross-network replay protection formerly relied on the deployer choosing distinct `networkId` values per network; the same keypair deployed on two networks with the same `networkId` would accept each other's proposals. | Fixed (PR #93): `NETWORK_DOMAIN` (Field(1) mainnet / Field(2) testnet) is now a compile-time circuit constant baked into every proposal hash, producing structurally distinct VKs per network — cross-network replay is impossible regardless of `networkId` choice. |
| 2 | **Wallets sign field arrays, not human-readable payloads.** An owner's wallet displays the signature payload (a hash), so payload comprehension depends on the client. Mitigations: client-side hash recomputation (see Trust model), the threshold, and the offline CLI's decoded summary. | Accepted, structural mitigations in place |
| 3 | **Archive discovery trusts pending blocks.** `DISCOVERY_BACKEND=archive` includes `chain_status = 'pending'` blocks so fresh deploys are discoverable without waiting for finalization. `rollbackAboveFork` (`backend/src/indexer.ts`) already deletes `Contract` rows by `discoveredAtBlock` on every reorg tick, so orphaned pending deploys are cleaned up automatically. Residual risk: a reorg deeper than `REORG_DETECTION_WINDOW` (~290 blocks) requires operator intervention regardless — covered by row 4. | Accepted |
| 4 | **Reorgs deeper than 290 blocks are not auto-handled** ([`backend-audit-guide.md` § Failure semantics](./backend-audit-guide.md#failure-semantics)). Matches Mina's ~290-block finality horizon; deeper forks require operator intervention. Display-layer only. | Accepted |
| 5 | **Memo plaintext is not on-chain.** Only `memoHash` is committed; the plaintext travels as the transaction memo, and a failed base58 decode stores the raw string for display. The hash is always authoritative. | Accepted by design |
| 6 | **`mina-signer` is built from a pinned o1js fork submodule** (`ui/deps/o1js`), byte-identical to the `o1js@3.0.0-mesa.final` release; the plan is to switch to the standalone npm package. | Accepted; migration planned |

Operational and UI-level quirks (state staleness windows, preview-cache behavior) are tracked in
[`KNOWN_ISSUES.md`](../KNOWN_ISSUES.md). Infrastructure risks and their mitigations live in the
private ops repo's risk register.

## Scope guidance for auditors

- **In scope (fund safety):** `contracts/src/**`, `ui/lib/multisigClient.worker.ts`,
  `offline-cli/src/**`, the desktop signing path (`desktop/src/preload.js`, `desktop/src/ipc.ts`,
  `desktop/src/auro/*`), and the bundle format in [`offline-audit-guide.md`](./offline-audit-guide.md).
- **Context (availability/display):** `backend/**`, remaining `ui/**`, remaining `desktop/**`
  (`main.ts`, `config-*.ts`, `hid-picker.ts`, `backend-embed.ts`, `assets/`, `scripts/`).
- **Out of scope in this repo:** `deploy/`, `preview-env/`, `dev-helpers/`, `e2e/`. Deployment and
  operations are covered by the private ops repo, shared with auditors under the engagement; the
  in-repo deployment assets are described in [`deploy-audit-guide.md`](./deploy-audit-guide.md) for
  context only.

Pin the commit under review; this document and the linked audit guides are maintained against the
tip of the branch they ship on.

## Reporting a vulnerability

Report suspected vulnerabilities privately via GitHub's private vulnerability reporting on this
repository (Security → Report a vulnerability). Please do not open public issues for security reports.
