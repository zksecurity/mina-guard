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
├── onchain-flow.test.ts      # On-chain flow tests (disabled — superseded by offchain-flow)
├── offchain-flow.test.ts     # Offchain batch-sig flow tests (primary)
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

## Debugging

- Playwright HTML report is generated at `e2e/playwright-report/` (run `bunx playwright show-report` to view)
- Traces and screenshots are captured on failure (in `e2e/test-results/`)
- Logs are prefixed with `[e2e-setup]`, `[e2e-teardown]`, and `[e2e]` for easy filtering
