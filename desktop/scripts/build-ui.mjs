#!/usr/bin/env node
// Builds ../ui for the desktop app, or with --check validates the build inputs
// without building. Called from desktop's `build:ui` and `check:build-inputs`
// npm scripts and from the release workflow's preflight job.
//
// The UI build environment is assembled here (rules in build-ui-env.mjs) and
// nowhere else, so what the preflight job validates is what the platform
// builds bake:
//   1. Start from the caller's environment minus every NEXT_PUBLIC_* variable
//      and MINA_NETWORK_DOMAIN, so nothing inherited from a shell or a runner
//      can change the bundle.
//   2. Apply desktop/.env (optional, git-ignored). It may not set the fixed
//      inputs or the VK hash; whatever else it sets is validated too.
//   3. Apply the fixed desktop inputs: the embedded backend on loopback, the
//      lite indexer, mainnet, the MinaGuard gateway endpoints and the explorer.
//   4. Read the mainnet VK hash through contracts/scripts/read-vk-hash.sh, the
//      one validated parser of contracts/.vk-hash.
// `next build` would also load ui/.env, ui/.env.production, ui/.env.local and
// ui/.env.production.local behind this script's back, so both modes refuse to
// run while any of them exists. Both modes also require BUILD_NETWORK_DOMAIN
// in src/config-store.ts to name the same network, or the app would accept
// test-network nodes for mainnet proofs. `--check` then runs
// deploy/validate-mainnet-build-config.py --desktop in that environment, which
// compares the hash with the reviewed pin. Without --check it runs
// `bun run build` in ../ui with that environment.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILD_NETWORK,
  DESKTOP_BUILD_INPUTS,
  VK_HASH_VAR,
  composeBuildEnv,
  findNextEnvFiles,
  parseDotEnv,
  readBuildNetworkDomain,
} from './build-ui-env.mjs';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopDir, '..');
const uiDir = resolve(repoRoot, 'ui');

function readVkHash() {
  const script = resolve(repoRoot, 'contracts', 'scripts', 'read-vk-hash.sh');
  return execFileSync('bash', [script, BUILD_NETWORK], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main(argv) {
  const check = argv.includes('--check');
  if (argv.some((arg) => arg !== '--check')) {
    console.error('usage: node scripts/build-ui.mjs [--check]');
    process.exit(2);
  }

  const nextEnvFiles = findNextEnvFiles(uiDir);
  if (nextEnvFiles.length > 0) {
    throw new Error(
      `ui/${nextEnvFiles.join(', ui/')} would be loaded by next build outside the environment ` +
      'validated here; remove or rename it, and put local overrides in desktop/.env',
    );
  }

  const dotEnvPath = resolve(desktopDir, '.env');
  const dotEnv = existsSync(dotEnvPath) ? parseDotEnv(readFileSync(dotEnvPath, 'utf8')) : {};
  const env = composeBuildEnv({ inherited: process.env, dotEnv, vkHash: readVkHash() });

  const configStore = readFileSync(resolve(desktopDir, 'src', 'config-store.ts'), 'utf8');
  const domain = readBuildNetworkDomain(configStore);
  if (domain !== BUILD_NETWORK) {
    throw new Error(`BUILD_NETWORK_DOMAIN in src/config-store.ts is ${domain}, but this build bakes ${BUILD_NETWORK}`);
  }

  for (const key of [...Object.keys(DESKTOP_BUILD_INPUTS), VK_HASH_VAR]) console.log(`${key}=${env[key]}`);
  const extra = Object.keys(dotEnv);
  console.log(extra.length ? `desktop/.env also sets: ${extra.join(' ')}` : 'desktop/.env: none');

  if (check) {
    run('python3', [resolve(repoRoot, 'deploy', 'validate-mainnet-build-config.py'), '--desktop'], { env });
    return;
  }
  run('bun', ['run', 'build'], { cwd: uiDir, env });
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`build-ui: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
