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

## Failure Modes

- Unknown command: prints help and exits `1`.
- Missing required flags: prints usage error and exits `1`.
- Missing contracts build for `vk-hash compile`: prompts to run `bun run --filter contracts build`.
- Network/account errors for `vk-hash address`: prints clear runtime error and exits `1`.
