import { PublicKey } from 'o1js';
import { MinaGuard } from 'contracts';
import type { BackendConfig } from './config.js';
import { fetchZkappCommandUpdates, type ZkappCommandUpdate } from './mina-client.js';

// o1js prefixes each event with its index in the sorted list of event names.
const EVENT_NAMES = Object.keys(new MinaGuard(PublicKey.empty()).events).sort();
const EVENT_INDEX = {
  approve: String(EVENT_NAMES.indexOf('approval')),
  execute: String(EVENT_NAMES.indexOf('execution')),
} as const;

/** Waits before each lookup: the honest UI reports a transaction right after
 *  broadcasting it, so it may need a few seconds to reach this node's pool. */
export const LOOKUP_DELAYS_MS = [0, 1000, 2000, 4000];

/**
 * True when an account update emits the approval or execution event for this
 * proposal. Both events start with the proposal hash. The update must be
 * proof-authorized, because anyone can attach events to an account without
 * one; a proof can only come from the account's own MinaGuard methods.
 */
export function emitsProposalEvent(
  update: ZkappCommandUpdate,
  action: 'approve' | 'execute',
  proposalHash: string,
): boolean {
  if (!update.isProved) return false;
  return update.events.some((fields) => {
    if (fields[0] !== EVENT_INDEX[action] || fields.length < 2) return false;
    try {
      return BigInt(fields[1]) === BigInt(proposalHash);
    } catch {
      return false;
    }
  });
}

/**
 * Checks that a reported transaction is a real approval or execution of the
 * proposal: the node knows it, in its pool or a recent block, and one of the
 * given accounts (the vault, or for a remote execution its SubVault) emits the
 * matching event from a proof-authorized update.
 */
export async function verifySubmittedTransaction(
  config: BackendConfig,
  params: { txHash: string; action: 'approve' | 'execute'; proposalHash: string; accounts: string[] },
  delaysMs: readonly number[] = LOOKUP_DELAYS_MS,
): Promise<boolean> {
  for (const delay of delaysMs) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const updates = await fetchZkappCommandUpdates(config, params.txHash);
    if (!updates) continue;
    return updates.some((update) =>
      params.accounts.includes(update.publicKey)
      && emitsProposalEvent(update, params.action, params.proposalHash));
  }
  return false;
}
