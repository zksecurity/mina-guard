import { Mina, PublicKey, fetchAccount, UInt32 } from 'o1js';
import { MinaGuard } from 'contracts';
import type { Pool } from 'pg';
import type { BackendConfig, } from './config.js';

const EMPTY_PUBLIC_KEY = PublicKey.empty().toBase58();

/** Decoded chain event shape consumed by the indexer. */
export interface ChainEvent {
  type: string;
  event: Record<string, unknown>;
  blockHeight: number;
  blockHash: string;
  parentHash: string;
  txHash: string | null;
  txMemo: string | null;
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

/** Genesis-derived constants used to compute current global slot from wall-clock. */
export interface GenesisConstants {
  /** Genesis Unix timestamp in milliseconds. */
  genesisTimestampMs: number;
  /** Slot duration in milliseconds. */
  slotDurationMs: number;
}

/**
 * Fetches the network's genesis timestamp and slot duration from the daemon.
 * Used to compute `globalSlotSinceGenesis` from wall-clock — the chain's
 * slot counter advances every slot regardless of whether a block is produced,
 * so a wall-clock derivation is more reliable than reading the latest block's
 * slot when blocks stall.
 */
export async function fetchGenesisConstants(
  config: BackendConfig,
): Promise<GenesisConstants> {
  const query = `{
    genesisConstants { genesisTimestamp }
    daemonStatus { consensusConfiguration { slotDuration } }
  }`;
  const response = await graphqlRequest<{
    genesisConstants?: { genesisTimestamp?: string };
    daemonStatus?: { consensusConfiguration?: { slotDuration?: number | string } };
  }>(query, config.minaEndpoint, config.minaFallbackEndpoint);

  const tsRaw = response.genesisConstants?.genesisTimestamp;
  const slotRaw = response.daemonStatus?.consensusConfiguration?.slotDuration;
  if (!tsRaw || slotRaw == null) {
    throw new Error('Failed to fetch genesisConstants/slotDuration from daemon');
  }
  const genesisTimestampMs = Date.parse(tsRaw);
  const slotDurationMs = Number(slotRaw);
  if (!Number.isFinite(genesisTimestampMs) || !Number.isFinite(slotDurationMs) || slotDurationMs <= 0) {
    throw new Error(`Invalid genesisConstants response: timestamp=${tsRaw} slotDuration=${slotRaw}`);
  }
  return { genesisTimestampMs, slotDurationMs };
}

/** Fetches latest block height from archive node to stay aligned with event availability. */
export async function fetchLatestBlockHeight(config: BackendConfig): Promise<number> {
  // Read the tip height from the daemon's bestChain. The previous
  // `networkState { maxBlockHeight }` query targeted the archive endpoint, but
  // that field is part of the *daemon* schema — the archive-node-api rejects it
  // with a generic "Unexpected error.", which wedged the whole indexer tip
  // check. bestChain.consensusState.blockHeight is what the daemon actually
  // exposes (and what fetchBestChainHeaders already relies on).
  const query = `{
    bestChain(maxLength: 1) {
      protocolState {
        consensusState { blockHeight }
      }
    }
  }`;
  const response = await graphqlRequest<{
    bestChain?: Array<{
      protocolState?: { consensusState?: { blockHeight?: string | number } };
    }>;
  }>(query, config.minaEndpoint, config.minaFallbackEndpoint);
  const raw = response.bestChain?.[0]?.protocolState?.consensusState?.blockHeight;
  return Number(raw ?? '0');
}

/**
 * Same as fetchLatestBlockHeight but reads directly from the archive postgres
 * (when DISCOVERY_BACKEND=archive). Bypasses archive-node-api, which has been
 * observed to return generic "Unexpected error." responses on the networkState
 * query when the underlying daemon is mid-block; postgres always has the
 * latest persisted block height.
 */
export async function fetchLatestBlockHeightFromArchive(pool: Pool): Promise<number> {
  const result = await pool.query<{ max: string | null }>(
    `SELECT MAX(height)::text AS max FROM blocks WHERE chain_status <> 'orphaned'`,
  );
  return Number(result.rows[0]?.max ?? '0');
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

/**
 * Discovers candidate zkApp addresses by querying the Mina archive postgres directly,
 * filtered to account updates that install MinaGuard's verification key. Unlike the
 * daemon's bestChain scan (capped at 290 blocks), this reaches arbitrary history.
 *
 * Returns addresses from blocks where:
 *   - chain_status != 'orphaned'  (canonical OR pending — see note below)
 *   - the account update set a verification_key whose hash matches vkHash
 *   - the containing zkapp_command was applied (not failed)
 *   - the block height is in [fromHeight, toHeight] inclusive
 *
 * We include `chain_status = 'pending'` so freshly-deployed contracts (the
 * last ~k blocks) become discoverable without waiting for finalization.
 * `rollbackAboveFork` (`backend/src/indexer.ts`) already deletes Contract rows
 * by `discoveredAtBlock` on every reorg tick, so orphaned pending deploys are
 * cleaned up automatically. Residual risk: a reorg deeper than
 * REORG_DETECTION_WINDOW (~290 blocks) requires operator intervention
 * regardless — Mina's finality horizon makes this effectively impossible in
 * practice.
 *
 * The join shape matches the upstream Mina archive schema verified against the
 * mesa-mut archive (45-table layout, zkapp_verification_key_hashes split from
 * zkapp_verification_keys). If the archive schema shifts in a future Mina release,
 * this query needs revisiting.
 */
export interface DiscoveryCandidate {
  address: string;
  /** Block height attributed to this address's discovery — used as the
   *  contract's discoveredAtBlock so rescan windows are tight around the
   *  deploy. The archive backend populates this with the actual on-chain
   *  deploy block (MIN(blocks.height) from the SQL); the daemon backend
   *  currently approximates it as the tick's chain tip (precise enough
   *  for the rescan since bestChain's ~290-block horizon bounds the
   *  imprecision). */
  deployBlock: number;
}

export async function discoverCandidateAddressesFromArchive(
  pool: Pool,
  vkHash: string,
  fromHeight: number,
  toHeight: number,
): Promise<DiscoveryCandidate[]> {
  const result = await pool.query<{ address: string; deploy_block: string }>(
    `
    SELECT pk.value AS address, MIN(b.height)::text AS deploy_block
    FROM zkapp_account_update_body zaub
    JOIN zkapp_updates zu ON zu.id = zaub.update_id
    JOIN zkapp_verification_keys vk ON vk.id = zu.verification_key_id
    JOIN zkapp_verification_key_hashes vkh ON vkh.id = vk.hash_id
    JOIN account_identifiers ai ON ai.id = zaub.account_identifier_id
    JOIN public_keys pk ON pk.id = ai.public_key_id
    JOIN zkapp_account_update zau ON zau.body_id = zaub.id
    JOIN zkapp_commands zc ON zau.id = ANY(zc.zkapp_account_updates_ids)
    JOIN blocks_zkapp_commands bzc
      ON bzc.zkapp_command_id = zc.id AND bzc.status = 'applied'
    JOIN blocks b ON b.id = bzc.block_id
    WHERE vkh.value = $1
      AND b.chain_status <> 'orphaned'
      AND b.height BETWEEN $2 AND $3
    GROUP BY pk.value
    `,
    [vkHash, fromHeight, toHeight],
  );
  return result.rows.map((r) => ({ address: r.address, deployBlock: Number(r.deploy_block) }));
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

/** Reads the current on-chain MinaGuard state needed by the backend/indexer.
 *  Values are normalized for persistence: the empty-pubkey sentinel used by
 *  root contracts for `parent` is flattened to null so callers don't need to
 *  re-check it at every write site. */
export async function fetchOnChainState(
  address: string
): Promise<{
  threshold: number;
  numOwners: number;
  networkId: string;
  ownersCommitment: string;
  nonce: number;
  configNonce: number;
  parent: string | null;
  parentNonce: number;
  childMultiSigEnabled: boolean;
} | null> {
  const pub = PublicKey.fromBase58(address);
  await fetchAccount({ publicKey: pub });
  const contract = new MinaGuard(pub);

  try {
    const threshold = contract.threshold.get();
    const numOwners = contract.numOwners.get();
    const networkId = contract.networkId.get();
    const ownersCommitment = contract.ownersCommitment.get();
    const nonce = contract.nonce.get();
    const configNonce = contract.configNonce.get();
    const parent = contract.parent.get().toBase58();
    const parentNonce = contract.parentNonce.get();
    const childMultiSigEnabled = contract.childMultiSigEnabled.get();
    return {
      threshold: Number(threshold.toString()),
      numOwners: Number(numOwners.toString()),
      networkId: networkId.toString(),
      ownersCommitment: ownersCommitment.toString(),
      nonce: Number(nonce.toString()),
      configNonce: Number(configNonce.toString()),
      parent: parent === EMPTY_PUBLIC_KEY ? null : parent,
      parentNonce: Number(parentNonce.toString()),
      childMultiSigEnabled: childMultiSigEnabled.toString() === '1',
    };
  } catch {
    return null;
  }
}

/** Number of most-recent best-chain blocks scanned when looking up a submitted
 *  zkApp tx by hash. Window is bounded so each indexer tick stays cheap; a
 *  failed tx that falls out of the window before the indexer catches it stays
 *  reported as 'pending' (acceptable first-cut; upgrade to block-bounded scan
 *  if misses become an issue). */
const TX_STATUS_SCAN_BLOCKS = 20;

/** Looks up a submitted zkApp tx by hash on the Mina daemon (`minaEndpoint`) and
 *  classifies it as still-pending, included-successfully, or failed.
 *
 *  Uses the daemon rather than the archive because only the daemon's
 *  `ZkappCommandResult.failureReason: [{index, failures: [String]}]` exposes
 *  structured failure reasons; archive-node-api has no per-hash lookup.
 *
 *  `'unknown'` means the lookup itself failed (network error, GraphQL error,
 *  upstream 5xx) on both endpoints — the tx's on-chain state is undetermined,
 *  NOT confirmed-absent. Callers must distinguish this from `'pending'`: a
 *  positive `'pending'` means we scanned bestChain and the tx isn't there yet,
 *  whereas `'unknown'` means we couldn't scan at all. Conflating the two lets a
 *  tx that was actually included get misclassified as dropped when the (heavier)
 *  bestChain query fails but a sibling mempool check happens to succeed. */
export async function fetchZkappTxStatus(
  config: BackendConfig,
  txHash: string
): Promise<{ status: 'pending' | 'included' | 'failed' | 'unknown'; reason?: string }> {
  const query = `query TxStatus($maxLength: Int!) {
    bestChain(maxLength: $maxLength) {
      transactions {
        zkappCommands {
          hash
          failureReason {
            failures
          }
        }
      }
    }
  }`;

  try {
    const data = await graphqlRequest<{
      bestChain?: Array<{
        transactions?: {
          zkappCommands?: Array<{
            hash: string;
            failureReason?: Array<{ failures?: string[] | null } | null> | null;
          }>;
        };
      }>;
    }>(query, config.minaEndpoint, config.minaFallbackEndpoint, { maxLength: TX_STATUS_SCAN_BLOCKS });

    for (const block of data.bestChain ?? []) {
      for (const cmd of block.transactions?.zkappCommands ?? []) {
        if (cmd.hash !== txHash) continue;
        const failures = (cmd.failureReason ?? [])
          .flatMap((r) => r?.failures ?? [])
          .filter((s): s is string => typeof s === 'string' && s.length > 0);
        if (failures.length > 0) {
          return { status: 'failed', reason: failures.join('; ') };
        }
        return { status: 'included' };
      }
    }
    return { status: 'pending' };
  } catch (err) {
    // Lookup failed on both primary and fallback endpoints; report 'unknown' so
    // callers don't treat an undetermined tx as confirmed-absent (see doc above).
    console.warn('[mina-client] fetchZkappTxStatus failed', txHash, err);
    return { status: 'unknown' };
  }
}

/** Fetches all zkApp tx hashes currently in the daemon's mempool. Returns null
 *  on network failure so callers can fall back conservatively. */
export async function fetchMempoolHashes(
  config: BackendConfig,
): Promise<Set<string> | null> {
  const query = `{ pooledZkappCommands { hash } }`;
  try {
    const data = await graphqlRequest<{
      pooledZkappCommands?: Array<{ hash: string }>;
    }>(query, config.minaEndpoint, config.minaFallbackEndpoint);
    return new Set((data.pooledZkappCommands ?? []).map((c) => c.hash));
  } catch (err) {
    console.warn('[mina-client] fetchMempoolHashes failed', err);
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

  return rawEvents.map((entry) => {
    const txInfo = (entry.event as any).transactionInfo;
    return {
      type: entry.type,
      event: toSerializableObject((entry.event as any).data),
      blockHeight: Number(entry.blockHeight.toString()),
      blockHash: (entry as any).blockHash as string,
      parentHash: (entry as any).parentBlockHash as string,
      txHash: (txInfo?.transactionHash as string | undefined) ?? null,
      txMemo: (txInfo?.transactionMemo as string | undefined) ?? null,
    };
  });
}

/** Runs a GraphQL request with optional endpoint fallback. */
async function graphqlRequest<T>(
  query: string,
  endpoint: string,
  fallbackEndpoint: string | null,
  variables?: Record<string, unknown>,
): Promise<T> {
  const primary = await runGraphqlQuery<T>(endpoint, query, variables);
  if (primary.ok) return primary.data;

  if (fallbackEndpoint) {
    const fallback = await runGraphqlQuery<T>(fallbackEndpoint, query, variables);
    if (fallback.ok) return fallback.data;
  }

  throw new Error(primary.error ?? 'GraphQL request failed');
}

/** Executes a single GraphQL POST request and returns typed payload/error. */
async function runGraphqlQuery<T>(
  endpoint: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(variables ? { query, variables } : { query }),
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
