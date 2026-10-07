import { PublicKey } from 'o1js';
import { MinaGuard } from 'contracts';
import type { BackendConfig } from './config.js';
import { fetchPooledZkappCommand, fetchZkappStates, type ZkappCommandUpdate } from './mina-client.js';

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
  return update.events.some((fields) =>
    fields.length >= 2 && sameField(fields[0], EVENT_INDEX[action]) && sameField(fields[1], proposalHash));
}

/**
 * True when every app-state value the update requires equals the account's
 * current state. A valid proof alone is not enough: anyone can prove a
 * MinaGuard method against made-up state (say, an owner list that includes
 * them), and only these conditions, checked when a block applies the
 * transaction, would reject it. Every approval and execution changes the
 * state it requires, so a transaction already in a block fails this too.
 * An update whose conditions the node did not report fails as well.
 */
export function matchesCurrentState(update: ZkappCommandUpdate, state: string[] | null): boolean {
  if (update.stateConditions === null) return false;
  return update.stateConditions.every((required, i) =>
    required === null || (state !== null && i < state.length && sameField(required, state[i])));
}

const DECIMAL = /^\d+$/;

/** Equal field values. Only decimal strings count, so a blank value never matches. */
function sameField(a: string, b: string): boolean {
  return DECIMAL.test(a) && DECIMAL.test(b) && BigInt(a) === BigInt(b);
}

/**
 * Checks that a reported transaction is a pending approval or execution of
 * the proposal: the node's pool holds it, one of the given accounts (the
 * vault, or for a remote execution also its SubVault) emits the matching
 * event from a proof-authorized update, and every update of those accounts
 * requires their current state.
 */
export async function verifySubmittedTransaction(
  config: BackendConfig,
  params: { txHash: string; action: 'approve' | 'execute'; proposalHash: string; accounts: string[] },
  delaysMs: readonly number[] = LOOKUP_DELAYS_MS,
): Promise<boolean> {
  for (const delay of delaysMs) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const updates = await fetchPooledZkappCommand(config, params.txHash);
    if (!updates) continue;
    const ours = updates.filter((update) => params.accounts.includes(update.publicKey));
    if (!ours.some((update) => emitsProposalEvent(update, params.action, params.proposalHash))) return false;
    // A failed state lookup is retried like a transaction the pool lacks.
    const states = await fetchZkappStates(config, params.accounts);
    if (!states) continue;
    return ours.every((update) => matchesCurrentState(update, states.get(update.publicKey) ?? null));
  }
  return false;
}
