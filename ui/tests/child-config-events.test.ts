import { describe, expect, it } from 'bun:test';
import { parseChildConfigFromEvents } from '../lib/api';

const child = 'B62qchildAddress';
const owner = 'B62qownerAddressOne';
const reservation = [
  { eventType: 'createChildConfig', payload: {
    proposalHash: 'caller supplied label', childAccount: child, threshold: '1', numOwners: '1',
  } },
  { eventType: 'createChildOwner', payload: {
    proposalHash: 'another caller supplied label', owner, index: '0',
  } },
];

describe('child reservation event parsing', () => {
  it('uses the child address and slot index, without trusting proposalHash labels', () => {
    expect(parseChildConfigFromEvents(reservation, child)).toEqual({ owners: [owner], threshold: 1 });
  });

  it('rejects a reservation for another child', () => {
    expect(() => parseChildConfigFromEvents(reservation, 'another-child'))
      .toThrow('address mismatch');
  });

  it('rejects duplicate owner slots', () => {
    expect(() => parseChildConfigFromEvents([...reservation, reservation[1]], child))
      .toThrow('missing or duplicated');
  });
});
