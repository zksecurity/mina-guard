# E2E Tests

End-to-end tests for MinaGuard using [Playwright](https://playwright.dev/). The test suite exercises the full lifecycle — deploy, propose, approve, execute — against a real Mina network through the UI with a mock wallet.

## Prerequisites

- [Bun](https://bun.sh/) installed
- Playwright browsers installed: `bunx playwright install` (from `e2e/`)

For **lightnet** mode you also need the `zkapp-cli` (`zk`) installed globally:

```bash
npm install -g zkapp-cli
```

Pin the lightnet Docker image to a known-good digest (one-time per machine, because upstream periodically publishes broken content to the floating tag):

```bash
./dev-helpers/pin-lightnet.sh
```

## Quick start (lightnet)

Lightnet is the default mode. The test harness automatically builds the contracts/frontend, starts a local Mina network, backend, and frontend, then tears everything down when done.

```bash
cd e2e
bun install
bun test
```

This will:

1. Start a local lightnet (`zk lightnet start`)
2. Acquire 3 funded test accounts from the lightnet account manager
3. Reset the backend database and start the backend + frontend
4. Run the Playwright tests
5. Stop all services on teardown

## Running against devnet

Set `NETWORK=devnet` and provide 3 funded devnet accounts.

### 1. Create your env file

```bash
cp .env.devnet.example .env.devnet
```

Edit `.env.devnet` and fill in the keys for 3 funded accounts. You can fund accounts via the [Mina faucet](https://faucet.minaprotocol.com).

```
NETWORK=devnet

DEVNET_ACCOUNT_1_PK=B62q...
DEVNET_ACCOUNT_1_SK=EKE...
DEVNET_ACCOUNT_2_PK=B62q...
DEVNET_ACCOUNT_2_SK=EKE...
DEVNET_ACCOUNT_3_PK=B62q...
DEVNET_ACCOUNT_3_SK=EKE...
```

You can optionally override the Mina and archive endpoints:

```
DEVNET_MINA_ENDPOINT=https://api.minascan.io/node/devnet/v1/graphql
DEVNET_ARCHIVE_ENDPOINT=https://api.minascan.io/archive/devnet/v1/graphql
```

### 2. Run

```bash
NETWORK=devnet bun test
```

Devnet tests are significantly slower (~45 min) due to ~3-minute block times and real proof generation.

### Verification key hash

On devnet the backend needs the MinaGuard verification key hash (`MINAGUARD_VK_HASH`) to filter out unrelated contracts. The setup **automatically compiles** the contract to extract this hash before starting the backend. The first compilation is slow (~2-5 min), but subsequent runs use a cache.

To skip the compilation step, set the hash explicitly in `.env.devnet`:

```
MINAGUARD_VK_HASH=12345...
```

You can obtain the hash manually with:

```bash
bun run dev-helpers/cli.ts vk-hash compile
```

## Configuration

All timing and endpoint settings are centralised in [network-config.ts](network-config.ts). Key differences between modes:

|                       | Lightnet       | Devnet           |
| --------------------- | -------------- | ---------------- |
| Block time            | ~3 s           | ~3 min           |
| Proof generation      | Skipped        | Real             |
| Test timeout          | 15 min         | 45 min           |
| Accounts              | Auto-acquired  | Manual (3 keys)  |
| Services              | Auto-managed   | Auto-managed     |

## Project structure

```
e2e/
├── playwright.config.ts      # Playwright configuration
├── network-config.ts         # Network mode, endpoints, and timing
├── global-setup.ts           # Starts lightnet/backend/frontend before tests
├── global-teardown.ts        # Stops all services after tests
├── helpers.ts                # Wallet mock, API helpers, indexer polling
├── onchain-flow.test.ts      # On-chain proposal lifecycle tests
├── .env.devnet.example       # Template for devnet account keys
└── .env.devnet               # Your local devnet config (git-ignored)
```

## CI

In CI (`CI=true`), the global setup skips starting lightnet, backend, and frontend — those are expected to be running already (e.g. via Docker services or prior workflow steps). The setup still acquires test accounts and waits for services to be healthy.

## Verbose mode

By default, `bun test` inside `e2e/` runs Playwright through the workspace filter which suppresses real-time output. To see full setup logs, test progress, and service output as they happen, run from the **monorepo root**:

```bash
# Lightnet
bun run test:e2e:verbose

# Devnet
NETWORK=devnet bun run test:e2e:verbose
```

This invokes Playwright directly and streams all `[e2e-setup]`, `[e2e]`, and `[e2e-teardown]` logs to your terminal.

## Test coverage

55 serial tests in `onchain-flow.test.ts`, split into on-chain lifecycle tests and UI validation tests. All run in a single browser page with periodic page recycles to keep WASM memory under the V8 heap limit.

### Contract lifecycle (tests 1–11)

- Deploy MinaGuard contract and verify initial state (1 owner, threshold 1/1)
- Add owner → propose, execute
- Change threshold to 2/2 → propose, execute
- Transfer MINA → propose, approve (2nd signer), execute
- Verify Settings and Transactions pages

### Owner & threshold management (tests 12–17)

- Lower threshold back to 1/2 → propose, approve, execute
- Remove owner → propose, execute
- Verify state after removal

### Delegation (tests 18–22)

- Set delegate → propose, execute, verify delegate card
- Undelegate → propose, execute

### Proposal expiry (tests 23–25)

- Propose transfer with near-future expiry block
- Wait for expiry and verify execute button is hidden
- State checkpoint before subaccount tests

### Subaccount lifecycle (tests 26–37)

- Create child → propose, finalize deployment, verify in UI tree
- Fund contracts for allocation tests
- Allocate (parent → child) → propose, execute
- Reclaim (child → parent) → propose, execute
- Disable child multi-sig → propose, execute
- Destroy child → propose, execute

### Delete proposal (tests 38–39)

- Propose a transfer, then create a delete proposal targeting it
- Execute delete and verify original proposal is invalidated

### Final state (test 40)

- Verify owner count, threshold, transaction counts across all tabs

### Form validation (tests 41–53)

UI-only tests — no on-chain transactions.

- **Transfer**: invalid address, negative/zero amount, missing comma, duplicate recipients, extra commas/whitespace
- **Add owner**: duplicate owner, invalid B62 address
- **Threshold**: value exceeding owner count, same-as-current rejection
- **Non-existent proposal**: 404 handling for invalid proposal hash
- **Remove owner**: removing below threshold, removing non-owner
- **Delegate**: empty/invalid address, undelegate toggle
- **Destroy subaccount**: confirmation checkbox required
- **Nonce**: zero, negative, decimal, non-numeric values
- **Action buttons**: executed/invalidated proposals have no actions, expired proposals have no execute button
- **Tab counts**: transaction list tab counts match API response

## Compile cache (IndexedDB)

The frontend caches o1js prover/verifier keys in IndexedDB so that page reloads skip the expensive key-generation WASM step. Cold compile takes ~280s; cached compile takes ~155s.

**Size**: ~1.7GB across ~24 entries. This is large but within the storage budgets of major browsers — Google Docs offline, Figma, VS Code for Web, Unity WebGL games, and mapping apps all store hundreds of MB to multi-GB in IndexedDB.

**Storage limits**: Chrome allows each origin up to ~6% of total disk (e.g. ~15GB on a 256GB drive). Firefox and Safari have smaller budgets. The cache checks `navigator.storage.estimate()` before writing and disables writes if less than 2GB is available.

**Eviction**: browsers may evict "best-effort" storage when disk pressure is high, prioritizing least-recently-used origins. Users can also clear the cache manually via Settings → Compile Cache → "Clear Compile Cache", or through browser DevTools (Application → IndexedDB → `o1js-compile-cache`).

**Page recycling**: on-chain e2e tests reload the page every ~15 transactions to release accumulated WASM memory (~30-40MB per transaction). The compile cache makes this viable — without it, each reload would require a full ~280s cold compile.

## Debugging

- Playwright HTML report is generated at `e2e/playwright-report/` (run `bunx playwright show-report` to view)
- Traces and screenshots are captured on failure (in `e2e/test-results/`)
- Logs are prefixed with `[e2e-setup]`, `[e2e-teardown]`, and `[e2e]` for easy filtering
