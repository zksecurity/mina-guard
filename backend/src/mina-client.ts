import { Mina, PublicKey, fetchAccount, UInt32 } from 'o1js';
import { MinaGuard } from 'contracts';
import type { BackendConfig, } from './config.js';

/** Decoded chain event shape consumed by the indexer. */
export interface ChainEvent {
  type: string;
  event: Record<string, unknown>;
  blockHeight: number;
  blockHash: string;
  parentHash: string;
  txHash: string | null;
}

/** Block identity row returned by the daemon's bestChain query. */
export interface BestChainHeader {
  height: number;
  blockHash: string;
  parentHash: string;
}

/** Configures o1js network endpoints once at process start. */
export function configureNetwork(config: BackendConfig): void {
  Mina.setActiveInstance(
    Mina.Network({
      mina: config.minaEndpoint,
      archive: config.archiveEndpoint,
      ...(config.lightnetAccountManager
        ? { lightnetAccountManager: config.lightnetAccountManager }
        : {}),
    })
  );
}

/**
 * Fetches block identities for the daemon's current bestChain, ordered ascending by height.
 * Used by the reorg-detection path to compare stored BlockHeader hashes against the
 * node's authoritative canonical view.
 */
export async function fetchBestChainHeaders(
  config: BackendConfig,
  maxLength: number,
): Promise<BestChainHeader[]> {
  const query = `{
    bestChain(maxLength: ${maxLength}) {
      stateHash
      protocolState {
        previousStateHash
        consensusState { blockHeight }
      }
    }
  }`;

  type Response = {
    bestChain?: Array<{
      stateHash?: string;
      protocolState?: {
        previousStateHash?: string;
        consensusState?: { blockHeight?: string | number };
      };
    }>;
  };

  const data = await graphqlRequest<Response>(
    query,
    config.minaEndpoint,
    config.minaFallbackEndpoint,
  );

  const headers: BestChainHeader[] = [];
  for (const block of data.bestChain ?? []) {
    const stateHash = block.stateHash;
    const parentHash = block.protocolState?.previousStateHash;
    const heightRaw = block.protocolState?.consensusState?.blockHeight;
    if (!stateHash || !parentHash || heightRaw === undefined) continue;
    const height = Number(heightRaw);
    if (!Number.isFinite(height)) continue;
    headers.push({ height, blockHash: stateHash, parentHash });
  }
  headers.sort((a, b) => a.height - b.height);
  return headers;
}

/** Fetches latest block height from archive node to stay aligned with event availability. */
export async function fetchLatestBlockHeight(config: BackendConfig): Promise<number> {
  const query = `{
    networkState {
      maxBlockHeight { pendingMaxBlockHeight }
    }
  }`;
  const response = await graphqlRequest<{
    networkState?: { maxBlockHeight?: { pendingMaxBlockHeight?: number } };
  }>(query, config.archiveEndpoint, config.archiveFallbackEndpoint);
  const raw = response.networkState?.maxBlockHeight?.pendingMaxBlockHeight;
  return Number(raw ?? '0');
}

/**
 * Discovers candidate zkApp addresses by scanning recent best-chain zkApp account updates.
 * Candidates are later verified via verification key hash.
 */
export async function discoverCandidateAddresses(
  config: BackendConfig,
  blockWindow: number
): Promise<string[]> {
  const query = `{
    bestChain(maxLength: ${blockWindow}) {
      transactions {
        zkappCommands {
          zkappCommand {
            accountUpdates {
              body {
                publicKey
                update {
                  verificationKey {
                    hash
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;

  type CandidateResponse = {
    bestChain?: Array<{
      transactions?: {
        zkappCommands?: Array<{
          zkappCommand?: {
            accountUpdates?: Array<{
              body?: {
                publicKey?: string;
                update?: { verificationKey?: { hash?: string | null } | null } | null;
              };
            }>;
          };
        }>;
      };
    }>;
  };

  const data = await graphqlRequest<CandidateResponse>(
    query,
    config.minaEndpoint,
    config.minaFallbackEndpoint
  );

  const addresses = new Set<string>();
  for (const block of data.bestChain ?? []) {
    for (const cmd of block.transactions?.zkappCommands ?? []) {
      for (const update of cmd.zkappCommand?.accountUpdates ?? []) {
        const body = update.body;
        if (!body?.publicKey) continue;
        if (body.update?.verificationKey?.hash) {
          addresses.add(body.publicKey);
        }
      }
    }
  }

  return [...addresses];
}

/** Reads the current verification key hash for an account if present. */
export async function fetchVerificationKeyHash(address: string): Promise<string | null> {
  const pub = PublicKey.fromBase58(address);
  const accountResult = await fetchAccount({ publicKey: pub });
  const hash =
    (accountResult.account as any)?.zkapp?.verificationKey?.hash ??
    (accountResult.account as any)?.verificationKey?.hash;
  return hash?.toString() ?? null;
}

/** Reads on-chain MinaGuard state fields (threshold, numOwners, networkId, ownersCommitment). */
export async function fetchOnChainState(
  address: string
): Promise<{ threshold: number; numOwners: number; networkId: string; ownersCommitment: string } | null> {
  const pub = PublicKey.fromBase58(address);
  await fetchAccount({ publicKey: pub });
  const contract = new MinaGuard(pub);

  try {
    const threshold = contract.threshold.get();
    const numOwners = contract.numOwners.get();
    const networkId = contract.networkId.get();
    const ownersCommitment = contract.ownersCommitment.get();
    return {
      threshold: Number(threshold.toString()),
      numOwners: Number(numOwners.toString()),
      networkId: networkId.toString(),
      ownersCommitment: ownersCommitment.toString(),
    };
  } catch {
    return null;
  }
}

/** Fetches decoded MinaGuard events for a contract within a block range. */
export async function fetchDecodedContractEvents(
  address: string,
  fromHeight: number,
  toHeight: number
): Promise<ChainEvent[]> {
  const contract = new MinaGuard(PublicKey.fromBase58(address));
  // TODO: restore toHeight once archive node supports upper-bound filtering
  const rawEvents = await contract.fetchEvents(UInt32.from(fromHeight));

  return rawEvents.map((entry) => ({
    type: entry.type,
    event: toSerializableObject((entry.event as any).data),
    blockHeight: Number(entry.blockHeight.toString()),
    blockHash: (entry as any).blockHash as string,
    parentHash: (entry as any).parentBlockHash as string,
    txHash: ((entry.event as any).transactionInfo?.transactionHash as string | undefined) ?? null,
  }));
}

/** Runs a GraphQL request with optional endpoint fallback. */
async function graphqlRequest<T>(
  query: string,
  endpoint: string,
  fallbackEndpoint: string | null
): Promise<T> {
  const primary = await runGraphqlQuery<T>(endpoint, query);
  if (primary.ok) return primary.data;

  if (fallbackEndpoint) {
    const fallback = await runGraphqlQuery<T>(fallbackEndpoint, query);
    if (fallback.ok) return fallback.data;
  }

  throw new Error(primary.error ?? 'GraphQL request failed');
}

/** Executes a single GraphQL POST request and returns typed payload/error. */
async function runGraphqlQuery<T>(
  endpoint: string,
  query: string
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!response.ok) {
      return { ok: false, error: `${response.status} ${response.statusText}` };
    }

    const json = (await response.json()) as {
      data?: T;
      errors?: Array<{ message?: string }>;
    };

    if (json.errors?.length) {
      return { ok: false, error: json.errors.map((e) => e.message ?? 'GraphQL error').join('; ') };
    }

    if (!json.data) {
      return { ok: false, error: 'GraphQL response missing data' };
    }

    return { ok: true, data: json.data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown request error',
    };
  }
}

/** Converts o1js event values into plain JSON-serializable objects. */
function toSerializableObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return { value: serializeValue(value) };
  }

  const entries = Object.entries(value as Record<string, unknown>).map(([key, current]) => [
    key,
    serializeValue(current),
  ]);
  return Object.fromEntries(entries);
}

/** Serializes common o1js wrapped values to string-friendly representations. */
function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();

  if (typeof value === 'object' && 'toBase58' in (value as Record<string, unknown>)) {
    const base58 = (value as { toBase58: () => string }).toBase58;
    if (typeof base58 === 'function') return base58.call(value);
  }

  if (typeof value === 'object' && 'toString' in (value as Record<string, unknown>)) {
    const toStringFn = (value as { toString: () => string }).toString;
    if (typeof toStringFn === 'function') return toStringFn.call(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, current]) => [
        key,
        serializeValue(current),
      ])
    );
  }

  return String(value);
}
