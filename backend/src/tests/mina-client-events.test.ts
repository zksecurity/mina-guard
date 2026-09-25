import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { PrivateKey, UInt32 } from 'o1js';
import { MinaGuard } from 'contracts';
import { fetchDecodedContractEvents, isFromAppliedTransaction } from '../mina-client.js';

function rawEvent(proposalHash: string, status: string | undefined) {
  return {
    type: 'approval',
    blockHeight: UInt32.from(7),
    blockHash: 'hash-7',
    parentBlockHash: 'hash-6',
    event: {
      data: { proposalHash, approvalCount: '3' },
      transactionInfo: { transactionHash: `tx-${proposalHash}`, transactionStatus: status, transactionMemo: '' },
    },
  };
}

describe('failed-transaction events', () => {
  afterEach(() => {
    spyOn(MinaGuard.prototype, 'fetchEvents').mockRestore();
  });

  test('isFromAppliedTransaction drops only an explicit failure', () => {
    expect(isFromAppliedTransaction('applied')).toBe(true);
    expect(isFromAppliedTransaction('failed')).toBe(false);
    expect(isFromAppliedTransaction('FAILED')).toBe(false);
    expect(isFromAppliedTransaction('')).toBe(true); // local chains
    expect(isFromAppliedTransaction(undefined)).toBe(true);
  });

  test('fetchDecodedContractEvents never returns events of a failed transaction', async () => {
    spyOn(MinaGuard.prototype, 'fetchEvents').mockResolvedValue([
      rawEvent('11', 'applied'),
      rawEvent('12', 'failed'),
      rawEvent('13', ''),
    ] as never);
    const address = PrivateKey.random().toPublicKey().toBase58();
    const events = await fetchDecodedContractEvents(address, 0, 10);
    expect(events.map((e) => e.event.proposalHash)).toEqual(['11', '13']);
    expect(events.map((e) => e.txHash)).toEqual(['tx-11', 'tx-13']);
  });
});
