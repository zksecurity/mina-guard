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

/** Turns a fetch/startup failure into a short human-readable reason. Undici
 *  wraps the real network error ("getaddrinfo ENOTFOUND …", "connect
 *  ECONNREFUSED …") in a generic "fetch failed" TypeError whose `cause` chain
 *  holds the details, so unwrap it. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return truncate(String(err));
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'connection timed out';
  let message = err.message;
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur instanceof Error && cur.cause !== undefined; depth++) {
    cur = cur.cause;
    if (cur instanceof AggregateError && cur.errors.length > 0) cur = cur.errors[0];
    if (cur instanceof Error && cur.message) message = cur.message;
  }
  return truncate(message);
}

function truncate(message: string): string {
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

/** POSTs a GraphQL query and returns the response's `data`. Throws a
 *  user-displayable error when the endpoint is unreachable or does not answer
 *  like a GraphQL server. */
async function probeGraphql(
  label: string,
  url: string,
  query: string,
): Promise<Record<string, unknown> | undefined> {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(`${label} is unreachable: ${describeError(err)}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error(`${label} did not return a GraphQL response (HTTP ${res.status})`);
  }
  if (typeof json !== 'object' || json === null || (!('data' in json) && !('errors' in json))) {
    throw new Error(`${label} did not return a GraphQL response (HTTP ${res.status})`);
  }
  return (json as { data?: Record<string, unknown> }).data;
}

/** Verifies both endpoints actually answer GraphQL and detects the network ID
 *  from the node. Throws with a user-displayable message when either endpoint
 *  is unreachable — callers must not persist the endpoints in that case. URL
 *  heuristics are used only when the node is reachable but does not expose
 *  `networkID`; reachability itself is never guessed. */
export async function verifyEndpoints(
  minaEndpoint: string,
  archiveEndpoint: string,
): Promise<NetworkId> {
  const [minaData] = await Promise.all([
    probeGraphql('Mina endpoint', minaEndpoint, '{ networkID }'),
    probeGraphql('Archive endpoint', archiveEndpoint, '{ __typename }'),
  ]);
  const raw = typeof minaData?.networkID === 'string' ? minaData.networkID.toLowerCase() : '';
  if (raw.includes('mainnet')) return 'mainnet';
  if (raw.includes('devnet')) return 'devnet';
  if (raw.includes('testnet')) return 'testnet';
  // Node reachable but no usable networkID — guess from the URL.
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
      : 'testnet';
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
