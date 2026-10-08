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
Ledger via WebHID) or on an air-gapped machine via the offline CLI. For an authenticated
MinaGuard deployment, the account permissions (`send: proof()`, `editState: proof()`,
`setPermissions: impossible()`) rule out any non-proof path to the balance or state.
Verification-key equality alone does not authenticate those signature-installed permissions:
the backend and online UI must also verify the complete stored permission vector against
`GUARD_PERMISSIONS` before accepting the vault. The UI fetches this snapshot directly from its
configured Mina node and compares it with the pure serialized policy exported by
`contracts/guard-permission-policy`; it does not trust the indexer to report either side of the
comparison. A backend test compares that browser-safe policy with the actual o1js
`GUARD_PERMISSIONS` value so the two representations cannot drift unnoticed.

In the supported creation flow, the signed `deploy()` update installs a temporary permission
vector whose `setPermissions` field is `proof()`. In the same atomic transaction, the proved
`setup()` (root) or `reserveForParent()` (child) update overwrites the complete vector with
`GUARD_PERMISSIONS`, including `setPermissions: impossible()`. This prevents the supported client
from producing a vault with creator-retained signature authority during the stored transaction version. A later version upgrade can make `setVerificationKey` signature-authorized, so the creator-retained deploy key becomes an upgrade authority. Stored-permission checks remain
mandatory because a creator can bypass the supported flow and deploy a lookalike directly.

### Trusted computing base

The code that must be correct for funds to be safe:

| Component | Why it is trusted | Role |
|---|---|---|
| `contracts/src/**` | Defines the circuit: owner membership, proposal hashing, approval counting, replay guards, permissions | The on-chain enforcement layer |
| `ui/lib/multisigClient.worker.ts` | Constructs the `TransactionProposal` structs, proposal hashes, and Merkle witnesses that owners sign and that transactions carry | What you sign is what this code builds |
| `offline-cli/src/` (`build-tx.ts`, `index.ts`, `summary.ts`, `wasm-shim.ts`) | Same construction role for the air-gapped path | Trust-minimized signing path |
| o1js (`o1js@3.0.0`) + `mina-signer@4.1.0` (exact npm pins) | Proof system, hashing (Poseidon), signatures | Cryptographic foundation |
| `desktop/src/preload.js`, `desktop/src/ipc.ts`, `desktop/src/auro/*` | Bridge the transaction payloads Auro signs in the self-contained Electron build (which also embeds the backend in-process) | Desktop signing path |

Everything else — the backend indexer/API, the rest of the UI, the rest of `desktop/`, `deploy/`,
`preview-env/`, `dev-helpers/`, `e2e/` — is **outside the TCB for fund safety** (see the next
section for what a compromise there can and cannot do).

### What a compromised component can do

**Backend (indexer + API).** It holds no keys and its data is a re-indexable materialized
view of public chain events. It cannot forge approvals: every approval requires an owner
signature over the application-tagged, action-specific proposal message, verified in-circuit against `ownersCommitment`. It also
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
At creation, a compromised frontend could also retain the generated deploy key;
the owner threshold does not protect against that key's post-upgrade signature
fallback (accepted risk 9).

**Deploy/infra.** Operational security (servers, firewalls, CI, secrets) is documented in the
private ops repo (`mina-guard-ops/architecture.md`, available to auditors on request) and, for the
in-repo deployment assets, in [`deploy-audit-guide.md`](./deploy-audit-guide.md). By the
non-custodial design above, even host-root compromise cannot move vault funds directly.

### One-time trust at deploy

The account that deploys and runs `setup()` chooses the initial owner set (`setup()` takes
`threshold`, `numOwners`, `initialOwners`). The owners commitment is computed **in-circuit** from
the supplied owner list (`computeSetupOwnersChain` + `assertCoherentSetupOwners`), so the stored
commitment cannot disagree with the announced owners, every active owner is a real curve point,
and no two owners share an x-coordinate (a key and its negation are the same signer) — but the
*choice* of owners at genesis is the deployer's, as in any multisig. Verify the setup events
before depositing.

`deploy()`, `setup()`, and `reserveForParent()` are separately callable and each authorized by
proof alone with no deployer binding, so a guard left deployed-but-uninitialized can be front-run:
anyone can call `setup()` with their own owner set, or `reserveForParent()` to bind the address to
an attacker parent (permanently blocking the legitimate `setup()`). Callers therefore MUST include
`deploy()` and `setup()`/`reserveForParent()` in the SAME transaction so no uninitialized on-chain
window exists. Atomicity is also required for permission safety: `deploy()` deliberately leaves
`setPermissions` open to a MinaGuard proof until the initialization proof installs and seals the
final vector. This is a caller obligation, not something the circuit enforces (see the doc-comments
on `deploy()`/`setup()`/`reserveForParent()` in `MinaGuard.ts`).

## Invariants

The authoritative mechanism descriptions live in
[`contracts-audit-guide.md` § Security properties](./contracts-audit-guide.md#security-properties).
This table maps each claim to its enforcement point and primary test coverage (all paths under
`contracts/src/`; tests under `contracts/src/tests/`).

| Invariant | Enforced in | Primary tests |
|---|---|---|
| Only owners can propose / approve | `propose()`, `approveProposal()` via `assertOwnerMembership` against `ownersCommitment` | `propose.test.ts`, `approve.test.ts`, `list-commitment.test.ts` |
| Approvals cannot be forged | `propose()` / `approveProposal()` verify an owner signature over the application-tagged, action-specific proposal message in-circuit (`signature.verify(owner, [proposalSigningMessage(proposalHash, action)])`) — membership alone is not enough | `propose.test.ts`, `approve.test.ts` ("reject invalid signature") |
| Signature purpose is explicit | Distinct propose/approve digests over the application-tagged proposal hash; empty and non-empty memos share a length-prefixed domain | `proposal-signing.test.ts`, `memo.test.ts`, cross-action rejection in `propose.test.ts` / `approve.test.ts` |
| No double-voting | vote nullifier map keyed `hash(proposalHash, approver)` | `approve.test.ts` |
| Approvals bind to exact content | approvals keyed by `TransactionProposal.hash()` (includes `guardAddress`, `destination`, `childAccount`) | `propose.test.ts`, `approve.test.ts` |
| Only native MINA is transferable | `propose()` asserts `proposal.tokenId == 1` (`TokenId.default`) — `executeTransfers` sends on the default token, so a different token ID is rejected at proposal time | `propose.test.ts` ("reject a proposal with a non-native tokenId") |
| Cannot approve a nonexistent proposal | approval slot must be `>= PROPOSED_MARKER` | `approve.test.ts` |
| No LOCAL re-execution | `EXECUTED_MARKER` overwrites the approval slot | `execute.test.ts` |
| No REMOTE re-execution | child's `childExecutionRoot` marks executed proposals | `child.test.ts` |
| Threshold met before execution | every `execute*` verifies count ≥ `threshold` against `approvalRoot` | `execute.test.ts` |
| What executes is exactly what was approved | `execute*` recomputes `proposal.hash()` from the caller-supplied struct and requires threshold on that hash — receivers, amounts, and `data` cannot deviate from the approved payload | `execute.test.ts` |
| Execution is permissionless | no owner gate on any `execute*` — once threshold is met, anyone can submit execution, subject to funding transaction and recipient account-creation costs; see the accepted risk below | `execute.test.ts` ("allow anyone to trigger execution") |
| Stale proposals invalidated | `configNonce` match + execution-nonce ordering (`nonce` / `parentNonce`) | `governance.test.ts`, `execute.test.ts` |
| Time-bounded proposals | UInt32 `expirySlot`; ledger enforces inclusion by the deadline for propose, approve, and LOCAL/REMOTE execute (zero means no expiry) | Fast `expiry.test.ts` checks the deadline |
| Mainnet/test-network proposal replay prevented | compile-time `NETWORK_DOMAIN` (`Field(1)` mainnet / `Field(2)` testnet and devnet) folded into every proposal hash (`constants.ts`, `TransactionProposal.hash()`), producing distinct mainnet and test-network VKs — there is no `networkId` field or state | `network-domain.test.ts` rejects missing/invalid/conflicting selections; `check-vk-hash` CI compiles the two distinct domains and generates all three labeled VK entries |
| Cross-contract / cross-child replay prevented | `guardAddress` and `childAccount` inside the proposal hash; children assert `childAccount == this.address` | `child.test.ts` |
| Setup owner list coherent with commitment | commitment computed in-circuit; duplicate owners and non-empty padding rejected | `setup.test.ts`, `list-commitment.test.ts` |
| Executed child config = displayed config | `reservedConfigHash` committed at `reserveForParent`; `executeSetupChild` binds `proposal.data` and `reservedConfigHash` to the recomputed hash, then clears the consumed reservation | `child.test.ts`, `reservation.test.ts` |
| Reservation has valid governance and root-parent state | Shared initial-governance bounds; no self-parenting; attached account preconditions require a nonzero parent owners commitment and empty parent field. This does not pin the parent's verification key | `reservation.test.ts` |
| Child cannot be hijacked between deploy and setup | Caller obligation, **not** a circuit invariant: callers MUST bundle `deploy()` + `reserveForParent()` (or `setup()`) into ONE transaction — none is deployer-bound. The circuit only enforces that `setup()` and `reserveForParent()` require `parent == empty` (write-once), so a separately-deployed guard can be front-run before it is reserved/set up | `child.test.ts` |
| Hierarchy depth capped at two levels | REMOTE proposals (including `CREATE_CHILD`) are rejected on any guard whose `parent != empty` — children cannot spawn children | `child.test.ts` |
| Parent recovery remains available for initialized children | `executeReclaimToParent` / `executeDestroy` skip `childMultiSigEnabled`, but require initialization. Direct deposits to a reserved child cannot be reclaimed before setup | `child.test.ts` |
| Allocations require initialized child state | Each non-empty recipient has nonzero `ownersCommitment` and `parent == sender`, constrained on the credited account update. These checks do not pin the recipient verification key. Ordinary transfers and external deposits remain unrestricted by this rule | `child.test.ts`, offline CLI allocation round-trip |
| Parent state drift and forged prover views void REMOTE approvals | child attaches a RootVault AccountUpdate beneath its proof update and pins parent state via account preconditions | `child.test.ts` (all four lifecycle methods plus an opt-in genuine-proof regression) |
| REMOTE proposal freshness is bound to the target child | parent attaches the nonce-authority AccountUpdate beneath its propose/approve proof and pins child `ownersCommitment`, `parent`, and `parentNonce` | `child.test.ts` (forged child state during propose and approve) |
| Governance preserves `0 < threshold ≤ numOwners ≤ MAX_OWNERS` | `setup()`, `executeOwnerChange()`, `executeThresholdChange()` all assert the bounds — the vault can be neither locked (threshold unreachable) nor unbounded | `setup.test.ts`, `governance.test.ts` |
| No hidden signature authority during the stored transaction version | In the supported atomic flow, proof-authorized `setup()`/`reserveForParent()` overwrite the creator-controlled deployment vector with `GUARD_PERMISSIONS` and seal `setPermissions: impossible()`; backend and online UI reject externally deployed accounts whose stored vector differs. `setVerificationKey` has a version-dependent signature fallback; see accepted risk 9 | `setup.test.ts`, `child.test.ts`, `vault-security.test.ts`, `routes-subscribe.test.ts`, `indexer-archive-discovery.test.ts`, `indexer-autosubscribe.test.ts` |

Off-chain, one invariant matters for the trust argument above: **clients recompute the hash they
sign from the fields they display and verify it equals the selected proposal's identity** —
`ui/lib/multisigClient.worker.ts` and `offline-cli/src/build-tx.ts` reconstruct the
`TransactionProposal` struct and call `.hash()` locally, then `assertRecomputedProposalHash` aborts
the approve or execute before any signature if the recomputed hash does not match the proposal the
owner selected. (Propose mints a fresh proposal with no prior identity, so it has nothing to match
against and skips the check.) The worker updates cached owner, approval and nullifier
stores with later indexed events using `contracts/src/store-checkpoint.ts` and the
shared, order-independent `contracts/src/event-rebuild.ts`. The CLI reconstructs
version 1 checkpoint leaves from version 1 requests; requests without checkpoints are rejected. Both clients
refuse to prove unless the result reproduces on-chain state (the worker reads the Mina node, the
CLI the bundle's account snapshot); events are unauthenticated, so the per-event roots the
contract emits only locate a divergence and are never trusted on their own. Covered by
`event-rebuild.test.ts`, `store-checkpoint.test.ts` and the offline CLI end-to-end tests. Persisted roots are not trust anchors: restored leaves are rehashed, then compared against the node (online) or bundled snapshot (offline).

CI generates `contracts/.vk-hash` for each source commit. It reuses cached
testnet and mainnet hashes when the circuit inputs match, or compiles both in
parallel on a cache miss; devnet reuses the testnet hash. Release and deploy
jobs verify the artifact's source commit before using it. Operators must also
compare the actual deployed VK with that network's generated hash; CI cannot
attest an independently built deployment artifact.

## Accepted risks and known limitations

| # | Risk | Status |
|---|---|---|
| 1 | **`networkId` is deployer-supplied.** Cross-network replay protection formerly relied on the deployer choosing distinct `networkId` values per network; the same keypair deployed on two networks with the same `networkId` would accept each other's proposals. | Fixed for mainnet versus Mina test networks (PR #93, hardened here): the explicit compile-time `NETWORK_DOMAIN` separates `mainnet` from the shared `testnet`/`devnet` domain. A build with an unset or invalid domain fails. Distinct test chains using `Field(2)` are not separated by this protocol; verify the installed VK and actual chain identity when deploying. |
| 2 | **Wallets sign field arrays, not human-readable payloads.** An owner's wallet displays the signature payload (a hash), so payload comprehension depends on the client. Mitigations: client-side hash recomputation (see Trust model), the threshold, and the offline CLI's decoded summary. | Accepted, structural mitigations in place |
| 3 | **Archive discovery trusts pending blocks.** `DISCOVERY_BACKEND=archive` includes `chain_status = 'pending'` blocks so fresh deploys are discoverable without waiting for finalization. `rollbackAboveFork` (`backend/src/indexer.ts`) already deletes `Contract` rows by `discoveredAtBlock` on every reorg tick, so orphaned pending deploys are cleaned up automatically. Residual risk: a reorg deeper than `REORG_DETECTION_WINDOW` (~290 blocks) requires operator intervention regardless — covered by row 4. | Accepted |
| 4 | **Reorgs deeper than 290 blocks are not auto-handled** ([`backend-audit-guide.md` § Failure semantics](./backend-audit-guide.md#failure-semantics)). Matches Mina's ~290-block finality horizon; deeper forks require operator intervention. Display-layer only. | Accepted |
| 5 | **Memo plaintext is not on-chain.** Only `memoHash` is committed; the plaintext travels as the transaction memo, and a failed base58 decode stores the raw string for display. The hash is always authoritative. | Accepted by design |
| 6 | **F-2026-19130: executors fund new transfer recipients.** The vault sends only approved transfer amounts. The executor pays the account-creation cost (currently 1 MINA per new recipient slot) and the transaction fee, without vault reimbursement. Account existence can change between proposal and execution. If no one pays, an approved transfer can delay higher-nonce proposals because execution requires the next nonce. Owners can execute it themselves or approve and execute a same-nonce replacement. The UI warns at proposal and approval, and estimates the creation cost again before online execution or offline signing. | Accepted residual liveness and executor-cost risk; no contract funding or nonce-ordering change; audit retest is not claimed |
| 7 | **F-2026-19133: a root vault has no key-loss recovery path.** If fewer independently held owner keys remain available than the threshold, no proposal can lower the threshold, replace an owner, or move funds. Operators must choose an owner count above the threshold by a redundancy margin they accept, keep those keys independently controlled and recoverable, and understand that losing too many keys can permanently strand the root vault's funds. A child vault has parent-authorized reclaim/destroy paths; a root vault does not. | Accepted product design; no emergency recovery key or timelocked bypass is provided |
| 8 | **Vault events are unauthenticated.** Events need no permission, so any account update can attach events to a vault. The indexer keeps only events whose emitting account update is `Proof`-authorized (the archive API's `authorizationKind`): those come from the vault's own methods, proved against its verification key, which admission already checks is canonical. Undecodable events from its own updates, and events that fail to apply, are recorded with `applyError` and no state change, so none of these can halt indexing or vanish silently. The signature-authorized `deployed` event is not indexed; nothing reads it. Residual: the filter relies on the network verifying proofs (a dev chain with proof verification disabled would accept a dummy proof), and an archive without `authorizationKind` (older than Archive-Node-API v0.0.8) makes indexing fail closed. Clients still check rebuilt stores against the chain before proving. | Mitigated; residual accepted |
| 9 | **F-2026-19216 / F-2026-19225: transaction-version upgrades expose the deploy key; recovery uses that same trusted key.** Mina reinterprets `setVerificationKey: impossibleDuringCurrentVersion()` as signature-authorized once the stored version is older than the network version. A creator who kept the deploy key, or anyone who obtains it, may replace the vault circuit without owner approval. The creation flow offers an optional creation-time local key download and warns the creator; every vault detail page warns other owners. If a fork breaks the existing proofs and the deploy key was not backed up, the vault may become unusable with funds stuck. Owners who do not accept the key-holder trust must coordinate evacuation before a version upgrade, moving SubVault balances before the root balance. For an older-version vault with the same reviewed VK, the UI and backend allow an ordinary proved action to refresh the stored version if Mina accepts its proof; the UI then checks the on-chain result. The deploy-key fallback remains active until that action succeeds. If the installed VK differs from the reviewed replacement, the UI exports a separate v2 migration request; the MinaGuard offline CLI checks the pinned replacement VK by compiling the release, signs with the saved deploy and fee payer keys, and the UI checks the signed command and fresh node state before broadcast. This does not grant the owners a quorum-approved upgrade or guarantee a future fork will support either transaction. There is no proactive upgrade alert, automatic migration, or emergency evacuation workflow. | Disclosed proof path and key-backed migration path; underlying governance bypass remains an accepted creator-trust risk. Fork-specific compatibility and release hashes require review before use. |

Mina's [verification-key permission RFC](https://github.com/MinaProtocol/mina/blob/4.0.0-mainnet/rfcs/0052-verification-key-permissions.md)
specifies the signature fallback for an older stored transaction version. The
exact migration behavior is determined for each protocol upgrade, so owners
must check the announced fork plan before relying on either key recovery or
pre-upgrade evacuation. The first successful account update on an older-version
vault refreshes its stored transaction version, even if the verification key is
unchanged. A key-signed no-op account update can therefore refresh the stored
version while leaving a broken proof circuit installed. Do not use it as a recovery step
without establishing post-fork proof compatibility; otherwise replace the
verification key with a verified compatible key before that window closes.

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
