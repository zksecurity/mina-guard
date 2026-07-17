import { describe, expect, test } from 'bun:test';
import { orderEventsForApply } from '../indexer.js';
import type { ChainEvent } from '../mina-client.js';

function ev(type: string, blockHeight: number, txHash: string, slot?: string): ChainEvent {
  return {
    type,
    event: slot ? { slot } : {},
    blockHeight,
    blockHash: `hash-${blockHeight}`,
    parentHash: `hash-${blockHeight - 1}`,
    txHash,
    txMemo: null,
  };
}

describe('orderEventsForApply', () => {
  test('applies events in ascending block order regardless of event type', () => {
    // An ownerChange in an earlier block must be applied before an execution in
    // a later block. The old type-priority sort ranked execution above
    // ownerChange and would have inverted these across the block boundary.
    const ordered = orderEventsForApply([
      ev('execution', 12, 'tx-exec'),
      ev('ownerChange', 11, 'tx-owner'),
    ]);
    expect(ordered.map((e) => e.type)).toEqual(['ownerChange', 'execution']);
  });

  test('never lets a higher-block event precede a lower-block event', () => {
    const ordered = orderEventsForApply([
      ev('thresholdChange', 20, 'tx-a'),
      ev('proposal', 5, 'tx-b'),
      ev('execution', 12, 'tx-c'),
    ]);
    expect(ordered.map((e) => e.blockHeight)).toEqual([5, 12, 20]);
  });

  test('orders same-block events by lifecycle type so a dependency precedes its dependent', () => {
    // Same block, different txs, returned by the archive out of order: the
    // approval and execution must still be applied after their proposal, or the
    // dependent event is dropped (and, once fingerprinted, dropped for good).
    const ordered = orderEventsForApply([
      ev('approval', 9, 'tx-appr'),
      ev('execution', 9, 'tx-exec'),
      ev('proposal', 9, 'tx-prop'),
    ]);
    expect(ordered.map((e) => e.type)).toEqual(['proposal', 'approval', 'execution']);
  });

  test('preserves input order for same-type same-block events (receiver slots)', () => {
    // Same block, same tx, same type: the type key ties, so the input order
    // restored by reverseEventsWithinEachTx must survive (receiver slot order).
    const ordered = orderEventsForApply([
      ev('receiver', 9, 'tx-1', 'r0'),
      ev('receiver', 9, 'tx-1', 'r1'),
      ev('receiver', 9, 'tx-1', 'r2'),
    ]);
    expect(ordered.map((e) => (e.event as { slot: string }).slot)).toEqual(['r0', 'r1', 'r2']);
  });
});
