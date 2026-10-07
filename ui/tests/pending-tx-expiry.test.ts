/**
 * A pending approve/execute record locks the vault in this tab until the tx
 * resolves. When the backend refuses to record the tx, nothing will report a
 * failure, so the record must expire after 20 minutes instead of a day.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  PENDING_TXS_CHANGED,
  REPORT_ANSWER_GRACE_MS,
  UNTRACKED_PENDING_TX_TTL_MS,
  backendNoLongerTracks,
  getPendingTxs,
  markPendingTxRecorded,
  markPendingTxUntracked,
  prunePendingTxs,
  reportUnanswered,
  savePendingTx,
  type PendingTx,
} from '../lib/storage';
import { reportSubmission } from '../lib/api';

const VAULT = 'B62qkYgXmsk3R65YGNG41Zqu61hf9X1qBktDPzZkkthkSnukbXLPCAY';
const SIGNER = 'B62qoG5Yk4iVxpyczUrBNpwtx2xunhL48dydN53A2VjoRwF8NUjtL3';
const MINUTE = 60_000;

const previous = { window: globalThis.window, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
const store = new Map<string, string>();
let changes = 0;

function record(proposalHash: string, txHash: string, ageMs: number, untracked?: boolean): PendingTx {
  return {
    kind: 'approve', contractAddress: VAULT, proposalHash, txHash, signerPubkey: SIGNER,
    createdAt: new Date(Date.now() - ageMs).toISOString(),
    ...(untracked ? { untracked } : {}),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  store.clear();
  changes = 0;
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
  } as unknown as Storage;
  globalThis.window = {
    dispatchEvent: (event: Event) => {
      if (event.type === PENDING_TXS_CHANGED) changes++;
      return true;
    },
  } as unknown as Window & typeof globalThis;
});

afterEach(() => {
  globalThis.window = previous.window;
  globalThis.localStorage = previous.localStorage;
  globalThis.fetch = previous.fetch;
});

describe('pending records the backend refused to track', () => {
  test('expire after 20 minutes, while tracked records last the day', () => {
    expect(UNTRACKED_PENDING_TX_TTL_MS).toBe(20 * MINUTE);
    savePendingTx(record('1', 'tracked-old', 25 * MINUTE));
    savePendingTx(record('2', 'untracked-old', 25 * MINUTE, true));
    savePendingTx(record('3', 'untracked-new', 5 * MINUTE, true));
    expect(getPendingTxs().map((r) => r.txHash)).toEqual(['tracked-old', 'untracked-new']);
  });

  test('a SubVault creation expires after 20 minutes too: a failed one is never reported', () => {
    const create = (proposalHash: string, txHash: string, ageMs: number): PendingTx => ({
      ...record(proposalHash, txHash, ageMs), kind: 'create',
    });
    savePendingTx(create('8', 'create-new', 5 * MINUTE));
    savePendingTx(create('9', 'create-old', 25 * MINUTE));
    expect(getPendingTxs().map((r) => r.txHash)).toEqual(['create-new']);
  });

  test('marking touches only the record for that transaction', () => {
    savePendingTx(record('1', 'tx-a', 0));
    changes = 0;
    markPendingTxUntracked(VAULT, '1', 'approve', 'tx-other');
    expect(getPendingTxs()[0].untracked).toBeUndefined();
    expect(changes).toBe(0);
    markPendingTxUntracked(VAULT, '1', 'approve', 'tx-a');
    expect(getPendingTxs()[0].untracked).toBe(true);
    expect(changes).toBe(1);
  });

  test('pruning deletes expired records and tells listeners only when it deleted one', () => {
    savePendingTx(record('1', 'tx-a', 5 * MINUTE, true));
    changes = 0;
    prunePendingTxs();
    expect(changes).toBe(0);
    // Same record, now past its 20 minutes.
    store.set('mina-guard-ui-pending-txs', JSON.stringify([record('1', 'tx-a', 21 * MINUTE, true)]));
    prunePendingTxs();
    expect(changes).toBe(1);
    expect(JSON.parse(store.get('mina-guard-ui-pending-txs') ?? 'null')).toEqual([]);
  });
});

describe('reportSubmission', () => {
  for (const [label, respond, untracked] of [
    ['an accepted report marks the record recorded', async () => new Response('{}', { status: 200 }), undefined],
    ['a refused report marks the record untracked', async () => new Response('{}', { status: 422 }), true],
    ['a busy backend marks the record untracked', async () => new Response('{}', { status: 429 }), true],
    ['an unreachable backend marks the record untracked', async () => { throw new Error('offline'); }, true],
  ] as const) {
    test(label, async () => {
      globalThis.fetch = respond as unknown as typeof fetch;
      savePendingTx(record('1', 'tx-a', 0));
      reportSubmission(VAULT, '1', 'approve', 'tx-a');
      await settle();
      await settle();
      expect(getPendingTxs()[0].untracked).toBe(untracked);
      expect(getPendingTxs()[0].recorded).toBe(untracked ? undefined : true);
    });
  }

  test('marking a report recorded touches only that transaction', () => {
    savePendingTx(record('1', 'tx-a', 0));
    savePendingTx(record('2', 'tx-b', 0));
    markPendingTxRecorded(VAULT, '1', 'approve', 'tx-a');
    expect(getPendingTxs().map((r) => r.recorded)).toEqual([true, undefined]);
  });
});

describe('backendNoLongerTracks', () => {
  const row = (hash: string | null) => ({ lastApproveTxHash: hash, lastExecuteTxHash: null });
  const mine = { ...record('1', 'tx-mine', 0), recorded: true };

  test('is true once a recorded report is not the hash the backend tracks', () => {
    expect(backendNoLongerTracks(mine, row('tx-other'))).toBe(true); // replaced, still live
    // The replacement already failed, or was applied and cleared before this
    // poll: the backend will never report tx-mine's failure either way.
    expect(backendNoLongerTracks(mine, row(null))).toBe(true);
    expect(backendNoLongerTracks(mine, row('tx-mine'))).toBe(false);
  });

  test('does not judge a report the backend has not answered', () => {
    const unanswered = record('1', 'tx-mine', 0);
    expect(backendNoLongerTracks(unanswered, row(null))).toBe(false);
    expect(backendNoLongerTracks(unanswered, row('tx-other'))).toBe(false);
  });

  test('compares the field for the record kind', () => {
    const execute = { ...mine, kind: 'execute' as const };
    expect(backendNoLongerTracks(execute, { lastApproveTxHash: 'tx-other', lastExecuteTxHash: 'tx-mine' })).toBe(false);
    expect(backendNoLongerTracks(execute, { lastApproveTxHash: 'tx-mine', lastExecuteTxHash: null })).toBe(true);
  });
});

describe('reportUnanswered', () => {
  test('flags a report with no answer after the grace, and nothing else', () => {
    const fresh = record('1', 'tx-a', MINUTE);
    const stale = record('1', 'tx-a', REPORT_ANSWER_GRACE_MS + MINUTE);
    expect(reportUnanswered(fresh)).toBe(false);
    expect(reportUnanswered(stale)).toBe(true);
    expect(reportUnanswered({ ...stale, recorded: true })).toBe(false);
    expect(reportUnanswered({ ...stale, untracked: true })).toBe(false);
    expect(reportUnanswered({ ...stale, kind: 'create' })).toBe(false);
  });
});
