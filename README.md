# Mina Guard - Multisig Wallet on Mina

A multisig (multi-signature) wallet built on [Mina Protocol](https://minaprotocol.com/) using [o1js](https://docs.minaprotocol.com/zkapps/o1js). Owners collectively manage funds through configurable approval thresholds, with all authorization verified via zero-knowledge proofs.

## Architecture

This is an npm workspaces monorepo with two packages:

```
contracts/   → o1js smart contract, types, off-chain storage
ui/          → Next.js 14 web interface with Auro Wallet integration
```

### Smart Contract

The `MultisigWallet` contract stores eight on-chain fields - owner set (Merkle root), threshold, owner count, tx nonce, vote/approval roots, guard root, and config nonce. All ownership and vote checks use MerkleMap witnesses so the contract scales without on-chain storage growth.

**Supported operations:**

| Method | Description |
|---|---|
| `setup` | One-time initialization with owners and threshold |
| `propose` | Owner proposes and signs/approves a new transaction in one call |
| `approveTx` | Owner approves a pending transaction (double-vote prevented) |
| `execute` | Execute a transfer once threshold is met |
| `addOwner` / `removeOwner` | Add or remove an owner (requires multisig approval) |
| `changeThreshold` | Update the approval threshold (requires multisig approval) |
| `registerGuard` | Register a guard module (requires multisig approval) |

### UI

Next.js 14 (App Router) with TailwindCSS. Pages include a dashboard, transaction list, proposal form, transaction detail view, and settings for managing owners and threshold. State is managed via React Context and persisted to localStorage for off-chain MerkleMap data.

## Getting Started

### Prerequisites

- Node.js >= 18
- npm >= 9

### Install

```bash
npm install
```

### Development

```bash
# Start the UI dev server
npm run dev

# Run contract tests
npm test

# Build everything (contracts + UI)
npm run build
```

### Workspace Commands

```bash
# Contracts only
npm test --workspace=contracts
npm run build --workspace=contracts

# UI only
npm run dev --workspace=ui
npm run build --workspace=ui
npm run lint --workspace=ui
```

## Tech Stack

- **Contracts:** o1js v1.9.0, TypeScript, Jest
- **UI:** Next.js 14, React 18, TailwindCSS, Auro Wallet
- **Monorepo:** npm workspaces

## Project Structure

```
contracts/
  src/
    MultisigWallet.ts      # Main smart contract
    types.ts               # Transaction types, witnesses, events
    storage.ts             # Off-chain MerkleMap state management
    MultisigWallet.test.ts # Contract test suite
    index.ts               # Public exports
ui/
  app/                     # Next.js pages (dashboard, transactions, settings)
  components/              # React components (Header, Sidebar, TransactionCard, etc.)
  hooks/                   # useWallet, useMultisig, useTransactions
  lib/                     # Types, Auro Wallet client, localStorage storage, contract bridge
```

## License

See [LICENSE](LICENSE) for details.
