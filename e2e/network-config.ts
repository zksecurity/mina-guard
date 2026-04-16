/**
 * Centralised network configuration for E2E tests.
 *
 * Set NETWORK=devnet to run against Mina devnet instead of a local lightnet.
 * When using devnet, provide funded account keys in e2e/.env.devnet or as
 * environment variables: DEVNET_ACCOUNT_{1,2,3}_{PK,SK}
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Only load e2e/.env.devnet when NETWORK=devnet is explicitly set.
// Variables already set in the environment take precedence.
const envDevnetPath = resolve(import.meta.dirname, '.env.devnet');
if (process.env.NETWORK === 'devnet' && existsSync(envDevnetPath)) {
  const content = readFileSync(envDevnetPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    // Don't override existing env vars
    if (process.env[key] === undefined && value) {
      process.env[key] = value;
    }
  }
}

export type NetworkMode = 'lightnet' | 'devnet';

export interface TestAccount {
  publicKey: string;
  privateKey: string;
}

export interface NetworkConfig {
  mode: NetworkMode;
  minaEndpoint: string;
  archiveEndpoint: string;
  accountManagerUrl: string | null;
  backendUrl: string;
  frontendUrl: string;
  // Timing
  blockTimeMs: number;
  indexerPollIntervalMs: number;
  indexerTimeoutMs: number;
  bannerTimeoutMs: number;
  testStepTimeoutMs: number;
  settlementWaitMs: number;
  expiryBlockOffset: number;
  skipProofs: boolean;
}

// E2E_* env vars override these defaults so the suite can be pointed at
// docker-compose service DNS names (lightnet, db, backend) from the inline
// runner container in preview-env/docker-compose.e2e.yml.
const LIGHTNET_CONFIG: NetworkConfig = {
  mode: 'lightnet',
  minaEndpoint: process.env.E2E_MINA_ENDPOINT ?? 'http://127.0.0.1:8080/graphql',
  archiveEndpoint: process.env.E2E_ARCHIVE_ENDPOINT ?? 'http://127.0.0.1:8282',
  accountManagerUrl: process.env.E2E_ACCOUNT_MANAGER ?? 'http://127.0.0.1:8181',
  backendUrl: process.env.E2E_BACKEND_URL ?? 'http://localhost:4000',
  frontendUrl: process.env.E2E_FRONTEND_URL ?? 'http://localhost:3000',
  blockTimeMs: 3_000,
  indexerPollIntervalMs: 5_000,
  indexerTimeoutMs: 240_000,
  // Banner wait covers first-test compile + tx build + broadcast + inclusion.
  // Local serial worst-case is ~90-120s on 8 vCPUs, but CI on 4 vCPUs with
  // `next dev` on-demand bundling pushes first-test compile close to 180s.
  // 5 min covers both environments without masking real hangs.
  bannerTimeoutMs: 900_000,
  // Per-test hard cap, strictly greater than bannerTimeoutMs so the banner
  // wait has time to surface a clear error before the outer cap fires.
  testStepTimeoutMs: 20 * 60 * 1_000,
  // Pad after an approval tx before executing, to let on-chain state
  // propagate. 12s = 4 blocks at SLOT_TIME=3s, still comfortably above
  // physical settlement floor, and saves ~18s per approve/execute pair.
  settlementWaitMs: 12_000,
  // Offset is in blocks; at 3s blocks this gives us ~15s of live window
  // for the propose-with-expiry test before it expires.
  expiryBlockOffset: 5,
  skipProofs: true,
};

function buildDevnetConfig(): NetworkConfig {
  return {
    mode: 'devnet',
    minaEndpoint:
      process.env.DEVNET_MINA_ENDPOINT ??
      'https://api.minascan.io/node/devnet/v1/graphql',
    archiveEndpoint:
      process.env.DEVNET_ARCHIVE_ENDPOINT ??
      'https://api.minascan.io/archive/devnet/v1/graphql',
    accountManagerUrl: null,
    backendUrl: 'http://localhost:4000',
    frontendUrl: 'http://localhost:3000',
    blockTimeMs: 180_000,
    indexerPollIntervalMs: 15_000,
    indexerTimeoutMs: 900_000,
    bannerTimeoutMs: 1_800_000,
    testStepTimeoutMs: 45 * 60 * 1_000,
    settlementWaitMs: 300_000,
    expiryBlockOffset: 10,
    skipProofs: false,
    };
}

let _config: NetworkConfig | null = null;

export function getNetworkConfig(): NetworkConfig {
  if (_config) return _config;
  const mode = (process.env.NETWORK ?? 'lightnet') as NetworkMode;
  if (mode !== 'lightnet' && mode !== 'devnet') {
    throw new Error(`Invalid NETWORK value: ${mode}. Use "lightnet" or "devnet".`);
  }
  _config = mode === 'devnet' ? buildDevnetConfig() : { ...LIGHTNET_CONFIG };
  return _config;
}

export function getDevnetAccounts(): TestAccount[] {
  const accounts: TestAccount[] = [];
  for (let i = 1; i <= 3; i++) {
    const pk = process.env[`DEVNET_ACCOUNT_${i}_PK`];
    const sk = process.env[`DEVNET_ACCOUNT_${i}_SK`];
    if (!pk || !sk) {
      throw new Error(
        `Missing env var DEVNET_ACCOUNT_${i}_PK or DEVNET_ACCOUNT_${i}_SK. ` +
          'Provide 3 funded devnet accounts in e2e/.env.devnet or as env vars.',
      );
    }
    accounts.push({ publicKey: pk, privateKey: sk });
  }
  return accounts;
}
