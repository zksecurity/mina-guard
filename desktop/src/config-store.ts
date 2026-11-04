import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { matchesBuildProofDomain, parseNodeNetworkId } from './network-id.js';
import type { NetworkId } from './network-id.js';

export type { NetworkId } from './network-id.js';

/** Proof-domain network this build's UI bundle was compiled for. Must match the
 *  NEXT_PUBLIC_MINA_NETWORK passed to `build:ui` in package.json — the
 *  circuit's NETWORK_DOMAIN is baked in at that build, so a proposal proved here
 *  only verifies against contracts in this proof domain. Testnet and devnet
 *  share Field(2); mainnet uses Field(1). */
export const BUILD_NETWORK_DOMAIN: 'mainnet' | 'testnet' = 'mainnet';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// PublicKey.empty().toBase58(). The one-block range validates the archive's
// event query shape without backfilling any vault history during setup.
const ARCHIVE_PROBE_ADDRESS = 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyBQL9TDb3nvBG';
// TokenId.toBase58(TokenId.default), matching the backend's event filter.
const ARCHIVE_PROBE_TOKEN_ID = 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf';
const ARCHIVE_PROBE_QUERY = `query ArchiveProbe($input: EventFilterOptionsInput!) {
  networkState { maxBlockHeight { pendingMaxBlockHeight } }
  events(input: $input) {
    blockInfo { height stateHash parentHash }
    eventData { transactionInfo { hash memo status authorizationKind } data }
  }
}`;

/** POSTs a GraphQL query and returns the response's `data`. Throws a
 *  user-displayable error when the endpoint is unreachable or rejects a
 *  required query. */
async function probeGraphql(
  label: string,
  url: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(`${label} is unreachable: ${describeError(err)}`);
  }
  if (!res.ok) {
    throw new Error(`${label} returned HTTP ${res.status}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error(`${label} did not return a GraphQL response (HTTP ${res.status})`);
  }
  if (!isRecord(json)) {
    throw new Error(`${label} did not return a GraphQL response (HTTP ${res.status})`);
  }
  if (json.errors !== undefined) {
    if (!Array.isArray(json.errors) || json.errors.length > 0) {
      const first = Array.isArray(json.errors) ? json.errors[0] : null;
      const reason = isRecord(first) && typeof first.message === 'string'
        ? truncate(first.message)
        : 'GraphQL error';
      throw new Error(`${label} rejected the required query: ${reason}`);
    }
  }
  if (!isRecord(json.data)) {
    throw new Error(`${label} did not return GraphQL data`);
  }
  return json.data;
}

const NODE_PROBE_QUERY =
  '{ networkID bestChain(maxLength: 1) { protocolState { consensusState { blockHeight } } } }';

// Mina's finality depth. An archive further behind the node than this is
// missing events the indexer needs, and returns them as an empty list rather
// than an error, so vaults would never appear.
const ARCHIVE_MAX_LAG_BLOCKS = 290;

/** A non-negative block height from a GraphQL number or decimal string. */
function parseHeight(raw: unknown): number | null {
  const valid = typeof raw === 'number'
    || (typeof raw === 'string' && /^(0|[1-9][0-9]*)$/.test(raw));
  const height = Number(raw);
  return valid && Number.isSafeInteger(height) && height >= 0 ? height : null;
}

/** Verifies the node network and the archive queries needed by the indexer.
 *  Callers must not persist endpoints when this check fails. */
export async function verifyEndpoints(
  minaEndpoint: string,
  archiveEndpoint: string,
): Promise<NetworkId> {
  const [minaData, archiveData] = await Promise.all([
    probeGraphql('Mina endpoint', minaEndpoint, NODE_PROBE_QUERY),
    probeGraphql('Archive endpoint', archiveEndpoint, ARCHIVE_PROBE_QUERY, {
      input: { address: ARCHIVE_PROBE_ADDRESS, tokenId: ARCHIVE_PROBE_TOKEN_ID, from: 0, to: 1 },
    }),
  ]);
  const maxHeight = isRecord(archiveData.networkState)
    ? archiveData.networkState.maxBlockHeight
    : null;
  const archiveHeight = parseHeight(isRecord(maxHeight) ? maxHeight.pendingMaxBlockHeight : null);
  if (archiveHeight === null) {
    throw new Error('Archive endpoint did not report a valid pending block height');
  }
  if (!Array.isArray(archiveData.events)) {
    throw new Error('Archive endpoint did not return a bounded events list');
  }
  const detected = parseNodeNetworkId(minaData.networkID);
  // This build's proof circuit is compiled for one network (BUILD_NETWORK_DOMAIN);
  // proposals proved here won't verify against contracts on a different network.
  // Reject a mismatched node loudly at setup instead of letting proofs fail
  // cryptically downstream. Endpoints must not be persisted on rejection — the
  // callers treat a throw here as "do not save / do not wipe the DB".
  if (!matchesBuildProofDomain(detected, BUILD_NETWORK_DOMAIN)) {
    throw new Error(
      `Network mismatch: this is a ${BUILD_NETWORK_DOMAIN} build, but the node at ` +
      `${minaEndpoint} reports ${detected}. Point it at a ${BUILD_NETWORK_DOMAIN} node, ` +
      `or install the ${detected} build of MinaGuard.`,
    );
  }
  const tip = Array.isArray(minaData.bestChain) ? minaData.bestChain.at(-1) : null;
  const state = isRecord(tip) && isRecord(tip.protocolState) ? tip.protocolState.consensusState : null;
  const nodeHeight = parseHeight(isRecord(state) ? state.blockHeight : null);
  if (nodeHeight === null) {
    throw new Error('Mina endpoint did not report its best chain height; is the node synced?');
  }
  if (nodeHeight - archiveHeight > ARCHIVE_MAX_LAG_BLOCKS) {
    throw new Error(
      `Archive endpoint is ${nodeHeight - archiveHeight} blocks behind the Mina node ` +
      `(${archiveHeight} vs ${nodeHeight}), so recent vault activity would be missing. ` +
      'Use an archive that is in sync with the node.',
    );
  }
  return detected;
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
      // A config written before networkId was saved: assume this build's
      // network. Startup rechecks the node, so a wrong guess reopens setup.
      : BUILD_NETWORK_DOMAIN;
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
