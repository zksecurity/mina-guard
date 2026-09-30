'use client';
import { checkTransactionState, nodeAccountReader } from './transaction-preflight';
import { getMinaGuardConfig } from './endpoints';
import { existingProposalHash } from './proposal-preparation';

export type RetryEligibility = { status: 'eligible' | 'existing' | 'executed' | 'invalid' | 'review' | 'unknown'; message?: string; executionHash?: string; proposalHash?: string };
export type PreflightContext = { action: 'propose' | 'approve' | 'execute' | 'deploy'; address: string; actor?: string; proposal?: import('./types').Proposal; configNonce?: number; input?: import('./types').NewProposalInput };
export type PreflightView = { kind: 'checking' | 'stores' | 'stale' | 'existing' | 'unavailable' | 'executed' | 'invalid' | 'review'; message?: string; offline: boolean; canRebuild: boolean; executionHash?: string; proposalHash?: string };
const listeners = new Set<() => void>();
let view: PreflightView | null = null;
let choice: ((value: 'retry' | 'rebuild' | 'cancel') => void) | null = null;
let hosts = 0;
let generation = 0;
export const preflightGeneration = () => generation;
export const PREFLIGHT_CANCELLED = 'Transaction cancelled before broadcast.';
export const PREFLIGHT_REBUILD = 'MINAGUARD_REBUILD_TRANSACTION';
export const subscribePreflight = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getPreflightView = () => view;
export function choosePreflight(value: 'retry' | 'rebuild' | 'cancel') { choice?.(value); }
function publish(next: PreflightView | null) { view = next; listeners.forEach(fn => fn()); }
export function mountPreflight() { hosts++; return () => { hosts--; generation++; if (!hosts) { choosePreflight('cancel'); publish(null); } }; }

/** Waits only for an explicit user decision; never broadcasts stale state. */
async function runPreflightCheck(
  txJson: string,
  assess: () => Promise<RetryEligibility>,
  offline = false,
  canRebuild = true,
  beforeCheck?: () => Promise<void>,
): Promise<void> {
  const config = JSON.stringify(getMinaGuardConfig());
  const endpoint = getMinaGuardConfig().minaEndpoint;
  const started = generation;
  for (;;) {
    if (generation !== started) throw new Error(PREFLIGHT_CANCELLED);
    publish({ kind: 'checking', offline, canRebuild: false });
    try { await beforeCheck?.(); } catch (error) { publish(null); throw error; }
    const result = await checkTransactionState(txJson, nodeAccountReader(endpoint));
    if (generation !== started) { publish(null); throw new Error(PREFLIGHT_CANCELLED); }
    if (JSON.stringify(getMinaGuardConfig()) !== config) {
      publish(null); throw new Error('Network changed. Prepare a new transaction.');
    }
    if (result.status === 'current') { publish(null); return; }
    let eligibility: RetryEligibility = { status: 'unknown' };
    if (result.status === 'stale') {
      try { eligibility = await assess(); } catch { /* Fail closed when indexer or node is unavailable. */ }
    }
    if (!hosts || generation !== started) { publish(null); throw new Error(PREFLIGHT_CANCELLED); }
    const decision = await new Promise<'retry' | 'rebuild' | 'cancel'>(resolve => {
      choice = resolve;
      publish({
        kind: result.status === 'unavailable' || eligibility.status === 'unknown' ? 'unavailable'
          : eligibility.status === 'eligible' ? 'stale' : eligibility.status,
        offline, canRebuild: canRebuild && eligibility.status === 'eligible',
        message: eligibility.message, executionHash: eligibility.executionHash, proposalHash: eligibility.proposalHash,
      });
    });
    choice = null;
    publish(null);
    if (decision === 'cancel') throw new Error(PREFLIGHT_CANCELLED);
    if (decision === 'rebuild') throw new Error(PREFLIGHT_REBUILD);
  }
}

let gateBusy = false;

/** Only the verified-store assertions qualify; network and unrelated errors keep their normal handling. */
export function isStoreStateMismatch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /^Rebuilt (owner list|approval map|vote nullifier map|child execution map) does not match /.test(message) &&
    message.endsWith('The indexed events do not reproduce this state yet; wait for the indexer to catch up and retry.');
}

/** Offer retry for mismatched stores, or open a proposal that already exists. */
export async function withStoreRecovery<T>(prepare: () => Promise<T>, offline = false): Promise<T> {
  const started = generation;
  const config = JSON.stringify(getMinaGuardConfig());
  for (;;) {
    if (generation !== started) throw new Error(PREFLIGHT_CANCELLED);
    if (JSON.stringify(getMinaGuardConfig()) !== config) throw new Error('Network changed. Prepare a new transaction.');
    try {
      const result = await prepare();
      // An offline request must not download after navigation/config changes.
      // Online completion may already represent a broadcast and must retain its result.
      if (offline && generation !== started) throw new Error(PREFLIGHT_CANCELLED);
      if (offline && JSON.stringify(getMinaGuardConfig()) !== config) throw new Error('Network changed. Prepare a new transaction.');
      return result;
    }
    catch (error) {
      const proposalHash = existingProposalHash(error);
      if (!proposalHash && !isStoreStateMismatch(error)) throw error;
      if (!hosts || generation !== started) throw new Error(PREFLIGHT_CANCELLED);
      if (gateBusy) throw error;
      gateBusy = true;
      try {
        const decision = await new Promise<'retry' | 'rebuild' | 'cancel'>(resolve => {
          choice = resolve;
          publish({ kind: proposalHash ? 'existing' : 'stores', proposalHash: proposalHash ?? undefined, offline, canRebuild: false });
        });
        if (proposalHash || decision !== 'retry') throw new Error(PREFLIGHT_CANCELLED);
      } finally { gateBusy = false; choice = null; publish(null); }
    }
  }
}

export async function preflightBeforeSend(...args: Parameters<typeof runPreflightCheck>): Promise<void> {
  if (gateBusy) throw new Error('Resolve the current transaction check before starting another.');
  gateBusy = true;
  try { await runPreflightCheck(...args); }
  finally { gateBusy = false; choice = null; publish(null); }
}

export function preflightFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Account_app_state_precondition_unsatisfied')
    ? 'The vault changed before this transaction could be accepted. Refresh the proposal and prepare a new transaction if the action is still available.'
    : message;
}
