import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';

export type NetworkId = 'mainnet' | 'devnet' | 'testnet';

export interface UserConfig {
  minaEndpoint: string;
  archiveEndpoint: string;
  networkId: NetworkId;
}

export function configPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

export function dbPath(): string {
  return join(app.getPath('userData'), 'minaguard.db');
}

/** Derives a networkId from the node endpoint URL by matching common host/path patterns. */
export function deriveNetworkId(minaEndpoint: string): NetworkId {
  const lower = minaEndpoint.toLowerCase();
  if (lower.includes('devnet')) return 'devnet';
  if (lower.includes('testnet') || lower.includes('lightnet') || lower.includes('localhost') || lower.includes('127.0.0.1')) {
    return 'testnet';
  }
  return 'mainnet';
}

export function readConfig(): UserConfig | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<UserConfig>;
    if (typeof parsed.minaEndpoint !== 'string' || typeof parsed.archiveEndpoint !== 'string') {
      return null;
    }
    const networkId: NetworkId = parsed.networkId === 'mainnet' || parsed.networkId === 'devnet' || parsed.networkId === 'testnet'
      ? parsed.networkId
      : deriveNetworkId(parsed.minaEndpoint);
    return {
      minaEndpoint: parsed.minaEndpoint,
      archiveEndpoint: parsed.archiveEndpoint,
      networkId,
    };
  } catch (err) {
    console.error('[desktop] failed to read config.json', err);
    return null;
  }
}

/** Atomically writes config by writing to a tmp file and renaming. */
export function writeConfig(cfg: UserConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  renameSync(tmp, path);
}

/** Deletes the SQLite DB file and any sidecar journal/WAL files if they exist. */
export function deleteDatabase(): void {
  const base = dbPath();
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      rmSync(base + suffix, { force: true });
    } catch (err) {
      console.error(`[desktop] failed to delete ${base + suffix}`, err);
    }
  }
}
