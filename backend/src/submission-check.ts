import { PublicKey, TokenId } from 'o1js';
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

/** Mina identifies an account by public key and token. The vault is the
 *  native-MINA account at its address; an update of that address under another
 *  token is a different account and never counts as the vault's. */
const NATIVE_TOKEN_ID = TokenId.toBase58(TokenId.default);

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

/** At most this many checks run at once for one proposal. Two lets two owners
 *  report approvals of the same proposal at the same moment. */
export const MAX_SUBMISSION_CHECKS_PER_PROPOSAL = 2;

/** At most this many checks run at once in total, to bound the load on the
 *  Mina node. With two per proposal, filling every slot takes junk reports
 *  against at least eight proposals at about 2.3 a second (each junk check
 *  lasts about 7 seconds), which is more than the production gateway lets one
 *  address send (120 a minute). */
export const MAX_CONCURRENT_SUBMISSION_CHECKS = 16;

/**
 * Limits how many submission checks run at once. Each check asks the Mina
 * node several times over about 7 seconds, and anyone can ask for one.
 *
 * - The same report (proposal, action and hash) sent again while its check
 *   runs waits for that check instead of starting another.
 * - A proposal gets at most `perProposal` checks at once, so junk reports
 *   against one proposal cannot use up the slots other proposals need.
 * - All proposals together get at most `total` checks at once.
 *
 * The backend cannot tell callers apart: the production gateway sends it no
 * caller address, so every request appears to come from the gateway. The
 * per-proposal limit stands in for a per-caller one. Someone who targets one
 * proposal can still keep its two slots busy; that proposal's honest reports
 * are then refused, and the reporting tab falls back to its own 20-minute lock.
 *
 * `run` returns null when a limit refuses the check.
 */
export function createSubmissionCheckLimiter(
  limits: { total: number; perProposal: number } = {
    total: MAX_CONCURRENT_SUBMISSION_CHECKS,
    perProposal: MAX_SUBMISSION_CHECKS_PER_PROPOSAL,
  },
) {
  const running = new Map<string, Promise<boolean>>();
  const perProposal = new Map<number, number>();
  let total = 0;

  return {
    run(
      report: { proposalId: number; action: string; txHash: string },
      check: () => Promise<boolean>,
    ): Promise<boolean> | null {
      const key = `${report.proposalId}:${report.action}:${report.txHash}`;
      const same = running.get(key);
      if (same) return same;

      const forProposal = perProposal.get(report.proposalId) ?? 0;
      if (total >= limits.total || forProposal >= limits.perProposal) return null;

      total++;
      perProposal.set(report.proposalId, forProposal + 1);
      const result = Promise.resolve().then(check).finally(() => {
        total--;
        const left = (perProposal.get(report.proposalId) ?? 1) - 1;
        if (left > 0) perProposal.set(report.proposalId, left);
        else perProposal.delete(report.proposalId);
        running.delete(key);
      });
      running.set(key, result);
      return result;
    },
    /** Checks running now, for tests. */
    inFlight(): number {
      return total;
    },
  };
}

/**
 * Checks that a reported transaction is a pending approval or execution of
 * the proposal: the node's pool holds it, one of the given accounts (the
 * vault, or for a remote execution also its SubVault), under the native
 * token, emits the matching event from a proof-authorized update, and every
 * update of those accounts requires their current state.
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
    const ours = updates.filter((update) =>
      params.accounts.includes(update.publicKey) && update.tokenId === NATIVE_TOKEN_ID);
    if (!ours.some((update) => emitsProposalEvent(update, params.action, params.proposalHash))) return false;
    // A failed state lookup is retried like a transaction the pool lacks.
    const states = await fetchZkappStates(config, params.accounts);
    if (!states) continue;
    return ours.every((update) => matchesCurrentState(update, states.get(update.publicKey) ?? null));
  }
  return false;
}
