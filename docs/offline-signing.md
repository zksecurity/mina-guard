# Offline Signing Architecture

Mina Guard supports air-gapped transaction signing. The workflow is:

1. **Export** — The web UI builds a JSON bundle containing all data needed to construct, prove, and sign a transaction without network access.
2. **Sign** — On an air-gapped machine, the CLI reads the bundle, compiles the contract, generates a zero-knowledge proof, signs the transaction, and outputs a signed response JSON.
3. **Broadcast** — Back on the online machine, upload the signed response in the UI. It broadcasts the pre-signed transaction directly to the Mina GraphQL endpoint.

No private key ever touches a networked machine.

---

## Bundle Format (version 1)

Every bundle is a JSON file with `version: 1` and an `action` field (`propose`, `approve`, or `execute`).

### Common Fields (`BundleBase`)

| Field | Type | Purpose |
|-------|------|---------|
| `version` | `1` | Format version for forward compatibility |
| `minaNetwork` | `"testnet" \| "mainnet"` | Determines o1js network ID for signature domain separation |
| `contractAddress` | `string` | The multisig contract being operated on |
| `feePayerAddress` | `string` | Public key of the signer (must match `MINA_PRIVATE_KEY`) |
| `accounts` | `Record<string, object>` | On-chain account snapshots (GraphQL `FetchedAccount` shape) |
| `events` | `Array<{ eventType, payload }>` | Contract event history for Merkle store reconstruction |

### `accounts` — Why?

The CLI has no network access. It needs account state (nonce, balance, zkApp state, verification key) to construct valid account updates. The UI snapshots all relevant accounts at export time and the CLI injects them via `addCachedAccount`.

Accounts included:
- The multisig contract itself (zkApp state, verification key)
- The fee payer (nonce, balance)
- Receiver accounts (execute only — to determine `fundNewAccount`)
- Child contract (child-related actions only)

### `events` — Why?

The contract uses three on-chain Merkle maps (OwnerStore, ApprovalStore, VoteNullifierStore). The web app builds these incrementally from live event streams. The CLI has no network, so the bundle includes the full event history. The CLI replays events to reconstruct the same Merkle roots.

Event types: `setupOwner`, `ownerChange`, `ownerChangeBatch`, `proposal`, `approval`, `execution`, `executionBatch`.

---

## Action: `propose`

Creates a new proposal on the multisig.

Additional fields:

| Field | Type | Purpose |
|-------|------|---------|
| `action` | `"propose"` | |
| `configNonce` | `number` | Current governance nonce (invalidates proposal if config changes) |
| `networkId` | `string` | Network identifier embedded in proposal hash |
| `input.txType` | `string` | Transaction type (`transfer`, `addOwner`, `removeOwner`, `changeThreshold`, `setDelegate`, `reclaimChild`, `destroyChild`, `enableChildMultiSig`) |
| `input.nonce` | `number` | Proposal nonce (for ordering/uniqueness within a nonce space) |
| `input.receivers` | `[{ address, amount }]` | Transfer recipients (transfer only) |
| `input.newOwner` | `string` | Address to add (addOwner only) |
| `input.removeOwnerAddress` | `string` | Address to remove (removeOwner only) |
| `input.newThreshold` | `number` | New signing threshold (changeThreshold only) |
| `input.delegate` | `string` | Delegate address (setDelegate only) |
| `input.childAccount` | `string` | Target child contract (child actions only) |
| `input.expirySlot` | `number` | Optional global slot after which proposal expires |

---

## Action: `approve`

Casts an approval vote on an existing proposal.

Additional fields:

| Field | Type | Purpose |
|-------|------|---------|
| `action` | `"approve"` | |
| `proposal` | `object` | Full proposal data (hash, proposer, parameters) — needed to reconstruct the proposal hash on-chain |

The `proposal` object mirrors what the backend stores: `proposalHash`, `proposer`, `toAddress`, `txType`, `data`, `nonce`, `configNonce`, `expirySlot`, `networkId`, `guardAddress`, `destination`, `childAccount`, `receivers`.

---

## Action: `execute`

Executes a fully-approved proposal, applying its effects on-chain.

Additional fields:

| Field | Type | Purpose |
|-------|------|---------|
| `action` | `"execute"` | |
| `proposal` | `object` | Same as approve |
| `receiverAccountExists` | `Record<string, boolean>` | Whether each receiver address already has an on-chain account |
| `childAddress` | `string?` | Child contract address (child actions) |
| `childEvents` | `Array<{ eventType, payload }>?` | Child contract events for rebuilding child Merkle stores |

### `receiverAccountExists` — Why?

When sending MINA to an address that has never received tokens, the transaction must pay a 1 MINA account creation fee (`fundNewAccount`). The CLI can't check this on-chain, so the UI pre-fetches each receiver's existence and includes it in the bundle.

### Limitation: `createChild`

The `createChild` transaction type cannot be executed offline because it requires deploying a new zkApp, which needs the child's private key for the deployment account update. This key is generated in the browser and never leaves it.

---

## Pre-Export Validation

After building a bundle, the UI inspects the bundled account snapshots and warns the user before they transfer the file to the air-gapped machine:

- **No fee payer account** — The `feePayerAddress` has no on-chain account. The transaction will fail.
- **Low fee payer balance** — Balance is below 1 MINA, likely insufficient for transaction fees.
- **New receiver accounts** (execute only) — Receivers without on-chain accounts require 1 MINA each for account creation (`fundNewAccount`). The warning shows how many extra MINA the fee payer needs.

These checks use data already fetched for the bundle — no extra network calls.

---

## Signed Response Format

The CLI outputs:

```json
{
  "version": 1,
  "type": "offline-signed-tx",
  "action": "propose | approve | execute",
  "contractAddress": "B62q...",
  "proposalHash": "abc123...",
  "transaction": { /* sendZkapp-compatible JSON */ }
}
```

The `transaction` field is the fully signed and proved zkApp command, ready to pass to `sendZkapp` on any Mina GraphQL endpoint.

---

## CLI Binary

The CLI is a self-contained Bun-compiled binary. It bundles:
- The `o1js` library (including the Kimchi/Plonk prover)
- `plonk_wasm_bg.wasm` (embedded via a filesystem shim)
- `mina-signer` (for field signing and fee payer authorization)
- The MinaGuard contract code

Build:
```bash
cd offline-cli
bun build --compile --target=bun-<os>-<arch> src/index.ts \
  --outfile dist/mina-guard-cli-<os>-<arch> \
  --define 'process.versions.node=""'
```

The `--define` trick prevents o1js from taking Node.js-specific code paths that don't exist in the Bun runtime.

---

## Security Model

- Private keys never leave the air-gapped machine.
- The bundle contains only public on-chain data (account states, events) — no secrets.
- The signed response contains the proved transaction — it can only perform the exact action specified in the bundle.
- The UI validates the response's `action` field matches what was exported before broadcasting.
