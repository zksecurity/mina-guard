import { describe, test, expect } from 'bun:test';
import { deriveInvalidReason, type ContractState } from '../proposal-record.js';

type ProposalFixture = {
  nonce: string | null;
  configNonce: string | null;
  destination: string | null;
  txType: string | null;
};

function proposal(fields: Partial<ProposalFixture> = {}): ProposalFixture {
  return {
    nonce: null,
    configNonce: null,
    destination: null,
    txType: null,
    ...fields,
  };
}

function parent(fields: Partial<ContractState> = {}): ContractState {
  return { nonce: null, parentNonce: null, configNonce: null, ...fields };
}

describe('deriveInvalidReason', () => {
  describe('config_nonce_stale', () => {
    test('returns config_nonce_stale when proposal.configNonce < parent.configNonce', () => {
      expect(
        deriveInvalidReason(proposal({ configNonce: '0' }), parent({ configNonce: 1 }), null),
      ).toBe('config_nonce_stale');
    });

    test('takes precedence over proposal_nonce_stale when both apply', () => {
      expect(
        deriveInvalidReason(
          proposal({ configNonce: '0', nonce: '1', destination: 'local' }),
          parent({ configNonce: 5, nonce: 10 }),
          null,
        ),
      ).toBe('config_nonce_stale');
    });

    test('returns null when proposal.configNonce == parent.configNonce (strict less-than)', () => {
      expect(
        deriveInvalidReason(proposal({ configNonce: '3' }), parent({ configNonce: 3 }), null),
      ).toBeNull();
    });

    test('returns null when parent.configNonce is null', () => {
      expect(
        deriveInvalidReason(proposal({ configNonce: '5' }), parent({ configNonce: null }), null),
      ).toBeNull();
    });

    test('returns null when proposal.configNonce is null', () => {
      expect(
        deriveInvalidReason(proposal({ configNonce: null }), parent({ configNonce: 5 }), null),
      ).toBeNull();
    });
  });

  describe('proposal_nonce_stale (LOCAL)', () => {
    test('flags LOCAL proposal with nonce <= parent.nonce', () => {
      expect(
        deriveInvalidReason(
          proposal({ nonce: '3', destination: 'local' }),
          parent({ nonce: 3 }),
          null,
        ),
      ).toBe('proposal_nonce_stale');
    });

    test('flags LOCAL when proposal.nonce strictly less', () => {
      expect(
        deriveInvalidReason(
          proposal({ nonce: '2', destination: 'local' }),
          parent({ nonce: 5 }),
          null,
        ),
      ).toBe('proposal_nonce_stale');
    });

    test('does not flag when proposal.nonce > parent.nonce', () => {
      expect(
        deriveInvalidReason(
          proposal({ nonce: '6', destination: 'local' }),
          parent({ nonce: 5 }),
          null,
        ),
      ).toBeNull();
    });

    test('does not flag when parent.nonce is null', () => {
      expect(
        deriveInvalidReason(
          proposal({ nonce: '1', destination: 'local' }),
          parent({ nonce: null }),
          null,
        ),
      ).toBeNull();
    });

    test('treats null destination as LOCAL (defaults to local path)', () => {
      expect(
        deriveInvalidReason(
          proposal({ nonce: '1', destination: null }),
          parent({ nonce: 5 }),
          null,
        ),
      ).toBe('proposal_nonce_stale');
    });
  });

  describe('proposal_nonce_stale (REMOTE non-CREATE_CHILD)', () => {
    test('flags REMOTE proposal with nonce <= child.parentNonce', () => {
      expect(
        deriveInvalidReason(
          proposal({ nonce: '2', destination: 'remote', txType: '7' }),
          parent(),
          { nonce: null, parentNonce: 5, configNonce: null },
        ),
      ).toBe('proposal_nonce_stale');
    });

    test('does not use parent.nonce for REMOTE path', () => {
      // parent.nonce is high (would flag LOCAL), child.parentNonce is low
      // (would not flag REMOTE). Should return null — i.e., remote path
      // consulted child only.
      expect(
        deriveInvalidReason(
          proposal({ nonce: '5', destination: 'remote', txType: '7' }),
          parent({ nonce: 100 }),
          { nonce: null, parentNonce: 0, configNonce: null },
        ),
      ).toBeNull();
    });

    test('does not flag when child.parentNonce is null', () => {
      expect(
        deriveInvalidReason(
          proposal({ nonce: '1', destination: 'remote', txType: '7' }),
          parent(),
          { nonce: null, parentNonce: null, configNonce: null },
        ),
      ).toBeNull();
    });

    test('does not flag when child state is missing entirely', () => {
      expect(
        deriveInvalidReason(
          proposal({ nonce: '1', destination: 'remote', txType: '7' }),
          parent(),
          null,
        ),
      ).toBeNull();
    });

    test('does not flag when proposal.nonce > child.parentNonce', () => {
      expect(
        deriveInvalidReason(
          proposal({ nonce: '10', destination: 'remote', txType: '7' }),
          parent(),
          { nonce: null, parentNonce: 5, configNonce: null },
        ),
      ).toBeNull();
    });
  });

  describe('CREATE_CHILD bypass', () => {
    test('txType="5" skips nonce-stale check entirely, even when nonce would be stale', () => {
      expect(
        deriveInvalidReason(
          proposal({ nonce: '0', destination: 'remote', txType: '5' }),
          parent({ nonce: 10 }),
          { nonce: null, parentNonce: 10, configNonce: null },
        ),
      ).toBeNull();
    });

    test('CREATE_CHILD still triggers config_nonce_stale (config check runs first, bypass is only nonce)', () => {
      expect(
        deriveInvalidReason(
          proposal({ nonce: '0', configNonce: '0', destination: 'remote', txType: '5' }),
          parent({ configNonce: 1 }),
          null,
        ),
      ).toBe('config_nonce_stale');
    });
  });

  describe('null / malformed inputs', () => {
    test('returns null when parent state is null entirely', () => {
      expect(
        deriveInvalidReason(proposal({ nonce: '1', destination: 'local' }), null, null),
      ).toBeNull();
    });

    test('returns null when proposal.nonce is null', () => {
      expect(
        deriveInvalidReason(
          proposal({ nonce: null, destination: 'local' }),
          parent({ nonce: 5 }),
          null,
        ),
      ).toBeNull();
    });

    test('returns null when proposal.nonce is non-numeric', () => {
      expect(
        deriveInvalidReason(
          proposal({ nonce: 'not-a-number', destination: 'local' }),
          parent({ nonce: 5 }),
          null,
        ),
      ).toBeNull();
    });

    test('returns null when proposal.configNonce is non-numeric (falls through to nonce check)', () => {
      expect(
        deriveInvalidReason(
          proposal({ configNonce: 'not-a-number', nonce: '6', destination: 'local' }),
          parent({ configNonce: 1, nonce: 5 }),
          null,
        ),
      ).toBeNull();
    });
  });
});
