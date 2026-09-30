'use client';
import { checkTransactionState, nodeAccountReader } from './transaction-preflight';
import { getMinaGuardConfig } from './endpoints';

export type RetryEligibility = { status: 'eligible' | 'executed' | 'invalid' | 'review' | 'unknown'; message?: string; executionHash?: string };
export type PreflightContext = { action: 'propose' | 'approve' | 'execute' | 'deploy'; address: string; actor?: string; proposal?: import('./types').Proposal; configNonce?: number; input?: import('./types').NewProposalInput };
export type PreflightView = { kind: 'checking' | 'stale' | 'unavailable' | 'executed' | 'invalid' | 'review'; message?: string; offline: boolean; canRebuild: boolean; executionHash?: string };
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
        message: eligibility.message, executionHash: eligibility.executionHash,
      });
    });
    choice = null;
    publish(null);
    if (decision === 'cancel') throw new Error(PREFLIGHT_CANCELLED);
    if (decision === 'rebuild') throw new Error(PREFLIGHT_REBUILD);
  }
}

let gateBusy = false;
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
