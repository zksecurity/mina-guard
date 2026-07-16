import { describe, expect, test } from 'bun:test';
import { orderEventsForApply } from '../indexer.js';
import type { ChainEvent } from '../mina-client.js';

function ev(type: string, blockHeight: number, txHash: string): ChainEvent {
  return {
    type,
    event: {},
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

  test('is stable: events in the same block keep their input (emission) order', () => {
    const ordered = orderEventsForApply([
      ev('proposal', 9, 'tx-1'),
      ev('receiver', 9, 'tx-1'),
      ev('approval', 9, 'tx-2'),
    ]);
    expect(ordered.map((e) => e.type)).toEqual(['proposal', 'receiver', 'approval']);
  });
});
