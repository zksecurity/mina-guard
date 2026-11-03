import { describe, expect, it } from 'bun:test';
import { EXECUTION_MEMO_MISMATCH, assertExecutionMemoMatches, memoBadge } from '../lib/memo-check';

const previousDomain = process.env.MINA_NETWORK_DOMAIN;
process.env.MINA_NETWORK_DOMAIN ??= process.env.NEXT_PUBLIC_MINA_NETWORK ?? 'testnet';
const { memoToField } = await import('contracts');
if (previousDomain === undefined) delete process.env.MINA_NETWORK_DOMAIN;
else process.env.MINA_NETWORK_DOMAIN = previousDomain;
const hashMemo = (memo: string) => memoToField(memo).toString();

describe('execution memo binding', () => {
  const approved = 'deposit tag 1001';
  const approvedHash = hashMemo(approved);

  it('allows the memo the owners approved', () => {
    expect(() => assertExecutionMemoMatches(approved, approvedHash, hashMemo)).not.toThrow();
    // A missing memo is the empty memo, which is what the transaction carries.
    expect(() => assertExecutionMemoMatches(null, hashMemo(''), hashMemo)).not.toThrow();
    expect(() => assertExecutionMemoMatches(undefined, hashMemo(''), hashMemo)).not.toThrow();
  });

  it('stops a swapped or missing memo', () => {
    for (const memo of ['deposit tag 6666', `${approved} `, '', null, undefined]) {
      expect(() => assertExecutionMemoMatches(memo, approvedHash, hashMemo)).toThrow(EXECUTION_MEMO_MISMATCH);
    }
  });

  it('shows the proposal mismatch badge for a pending proposal', () => {
    expect(memoBadge({ memoHash: approvedHash, status: 'pending', memoExecutionMatch: null }, false)).toBe('proposalMismatch');
    expect(memoBadge({ memoHash: approvedHash, status: 'pending', memoExecutionMatch: null }, true)).toBeNull();
  });
});
