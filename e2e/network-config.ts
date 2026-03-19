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

const LIGHTNET_CONFIG: NetworkConfig = {
  mode: 'lightnet',
  minaEndpoint: 'http://127.0.0.1:8080/graphql',
  archiveEndpoint: 'http://127.0.0.1:8282',
  accountManagerUrl: 'http://127.0.0.1:8181',
  backendUrl: 'http://localhost:4000',
  frontendUrl: 'http://localhost:3000',
  blockTimeMs: 3_000,
  indexerPollIntervalMs: 5_000,
  indexerTimeoutMs: 240_000,
  bannerTimeoutMs: 600_000,
  testStepTimeoutMs: 15 * 60 * 1_000,
  settlementWaitMs: 30_000,
  expiryBlockOffset: 2,
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
