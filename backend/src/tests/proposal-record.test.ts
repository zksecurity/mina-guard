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

// ---------------------------------------------------------------------------
// deriveStatus — expiry is a read-time slot comparison, not chain behaviour.
// Replaces e2e steps 23-24 (propose expiring transfer, wait for expiry).
// ---------------------------------------------------------------------------

import {
  deriveStatus,
  computeProposalMemoMatch,
  computeMemoExecutionMatch,
} from '../proposal-record.js';
import { memoToField } from 'contracts';
import type { Proposal } from '../generated/prisma/index.js';

const asProposal = (fields: Partial<Proposal>): Proposal => fields as Proposal;

describe('deriveStatus', () => {
  test('executed wins over expiry and invalidation', () => {
    expect(
      deriveStatus(asProposal({ expirySlot: '10' }), true, 100, 'config_nonce_stale'),
    ).toBe('executed');
  });

  test('expired when latestSlot is past a positive expirySlot', () => {
    expect(deriveStatus(asProposal({ expirySlot: '10' }), false, 11, null)).toBe('expired');
  });

  test('not expired at exactly the expiry slot (strict greater-than)', () => {
    expect(deriveStatus(asProposal({ expirySlot: '10' }), false, 10, null)).toBe('pending');
  });

  test('expirySlot 0 means no expiry', () => {
    expect(deriveStatus(asProposal({ expirySlot: '0' }), false, 1_000_000, null)).toBe('pending');
  });

  test('null expirySlot means no expiry', () => {
    expect(deriveStatus(asProposal({ expirySlot: null }), false, 1_000_000, null)).toBe('pending');
  });

  test('non-numeric expirySlot is ignored', () => {
    expect(deriveStatus(asProposal({ expirySlot: 'garbage' }), false, 1_000_000, null)).toBe('pending');
  });

  test('expired wins over invalidated', () => {
    expect(
      deriveStatus(asProposal({ expirySlot: '10' }), false, 11, 'proposal_nonce_stale'),
    ).toBe('expired');
  });

  test('invalidated when invalidReason set and not executed/expired', () => {
    expect(
      deriveStatus(asProposal({ expirySlot: '0' }), false, 5, 'proposal_nonce_stale'),
    ).toBe('invalidated');
  });
});

// ---------------------------------------------------------------------------
// Memo match derivation — both flags are pure functions of persisted hashes.
// Replaces e2e steps 25a-25c (memo lifecycle incl. the stripped-memo mismatch);
// the happy path still runs end-to-end on the main transfer (steps 7-9).
// ---------------------------------------------------------------------------

describe('memo match derivation', () => {
  const memo = 'e2e-test-memo';
  const hash = memoToField(memo).toString();

  test('proposalMemoMatch true when memo hashes to memoHash', () => {
    expect(computeProposalMemoMatch(memo, hash)).toBe(true);
  });

  test('proposalMemoMatch false when memo does not hash to memoHash', () => {
    expect(computeProposalMemoMatch('tampered', hash)).toBe(false);
  });

  test('proposalMemoMatch null when memo missing', () => {
    expect(computeProposalMemoMatch(null, hash)).toBeNull();
  });

  test('proposalMemoMatch null when memoHash missing or zero (no memo committed)', () => {
    expect(computeProposalMemoMatch(memo, null)).toBeNull();
    expect(computeProposalMemoMatch(memo, '0')).toBeNull();
  });

  test('memoExecutionMatch true when executed tx carried the committed memo', () => {
    expect(computeMemoExecutionMatch(hash, hash)).toBe(true);
  });

  test('memoExecutionMatch false when executed tx memo was stripped or replaced', () => {
    expect(computeMemoExecutionMatch(hash, memoToField('different').toString())).toBe(false);
  });

  test('memoExecutionMatch null before execution or without a committed memoHash', () => {
    expect(computeMemoExecutionMatch(hash, null)).toBeNull();
    expect(computeMemoExecutionMatch(null, hash)).toBeNull();
  });
});
