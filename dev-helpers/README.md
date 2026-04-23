# MinaGuard Dev Helpers CLI

`dev-helpers` is a standalone CLI tool for common MinaGuard developer tasks.
It uses [`commander`](https://www.npmjs.com/package/commander) for argument parsing.

All commands are invoked directly with Bun:

```bash
bun run dev-helpers/cli.ts <group> <command> [options]
```

Secrets are printed to stdout only.  
No helper command writes `.env` files or any secret file automatically.

## Commands

### Help

```bash
bun run dev-helpers/cli.ts help
```

### Verification Key Hash

Compile MinaGuard locally and print the verification key hash:

```bash
bun run --filter contracts build
bun run dev-helpers/cli.ts vk-hash compile
```

`vk-hash compile` can take a while on first run because circuit compilation is expensive.

Output includes:

- `MINAGUARD_VK_HASH=<hash>`
- `vkHash=<hash>`

Read verification key hash from a deployed zkApp address:

```bash
bun run dev-helpers/cli.ts vk-hash address --address B62...
```

Optional custom endpoint:

```bash
bun run dev-helpers/cli.ts vk-hash address --address B62... --mina-endpoint https://api.minascan.io/node/devnet/v1/graphql
```

Endpoint resolution order:

1. `--mina-endpoint`
2. `MINA_ENDPOINT` environment variable
3. Devnet default: `https://api.minascan.io/node/devnet/v1/graphql`

### Keys

Generate a new private/public key pair:

```bash
bun run dev-helpers/cli.ts key gen
```

Derive public key from an existing private key:

```bash
bun run dev-helpers/cli.ts key pub --private-key EK...
```

Validate private key format:

```bash
bun run dev-helpers/cli.ts key validate --private-key EK...
```

Validation output:

- valid key: `valid=true` and `publicKey=<B62...>`
- invalid key: `valid=false` (exit code `1`)

### Lightnet Funding

Fund all public keys listed in `dev-helpers/.env` via the lightnet account manager:

```bash
bun run dev-helpers/cli.ts lightnet-fund
```

This is useful for local preview or e2e setups where you already have fixed test accounts.

### Lightnet Fixture

Deploy a set of real on-chain fixture contracts to the local preview lightnet:

```bash
bun run dev-helpers/cli.ts lightnet-fixture --main-address B62...
```

The default scenario is `minimal`, which is optimized for quick manual UI testing.

Optional scenario and custom preview base URL:

```bash
bun run dev-helpers/cli.ts lightnet-fixture \
  --main-address B62... \
  --scenario minimal \
  --preview-base-url https://localhost:10001/preview/1
```

What it does:

- acquires one funded lightnet deployer account
- generates two extra local signer accounts for fixture activity
- includes your `--main-address` as owner `#0` on every deployed contract
- deploys real MinaGuard contracts and submits real propose / approve / execute transactions
- waits for the preview backend indexer to ingest the resulting events
- prints a JSON summary of the created contract addresses and seeded scenarios

Available scenarios:

- `minimal`:
- 2 vaults
- 2 executed proposals per vault
- each vault ends with your main address as the lone owner with threshold 1
- best when you want to connect one wallet and test quickly

- `full`:
- `Transfers`: one executed proposal, one approved-and-ready proposal, one pending proposal
- `Add Owner`: one approved-and-ready proposal
- `Remove Owner`: one approved-and-ready proposal
- `Threshold`: one approved-and-ready proposal
- `Delegate`: one approved-and-ready proposal

This command is meant for proofs-disabled preview/lightnet flows. It creates real on-chain state, so the backend and UI stay consistent without DB-only mocking.

## Failure Modes

- Unknown command: prints help and exits `1`.
- Missing required flags: prints usage error and exits `1`.
- Missing contracts build for `vk-hash compile`: prompts to run `bun run --filter contracts build`.
- Network/account errors for `vk-hash address`: prints clear runtime error and exits `1`.
