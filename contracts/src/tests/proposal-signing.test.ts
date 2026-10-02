import { describe, expect, it } from 'bun:test';
import { Field, Poseidon, PrivateKey, Signature } from 'o1js';
import { TransactionProposal } from '../MinaGuard.js';
import { NETWORK_DOMAIN } from '../constants.js';
import { proposalSigningMessage } from '../proposal-signing.js';
import { createTransferProposal } from './test-helpers.js';

describe('proposal signing domains', () => {
  it('separates proposal identity from untagged hashes and other application domains', () => {
    const proposal = createTransferProposal([], Field(1), Field(0), PrivateKey.random().toPublicKey());
    const fields = [...TransactionProposal.toFields(proposal), NETWORK_DOMAIN];
    expect(proposal.hash().toString()).toBe(Poseidon.hashWithPrefix('mina-guard-proposal', fields).toString());
    expect(proposal.hash().toString()).not.toBe(Poseidon.hash(fields).toString());
    expect(proposal.hash().toString()).not.toBe(Poseidon.hashWithPrefix('other-app-proposal', fields).toString());
  });

  it('binds signatures to action, application and proposal', () => {
    const key = PrivateKey.random();
    const hash = Field(123);
    for (const action of ['propose', 'approve'] as const) {
      const message = proposalSigningMessage(hash, action);
      const signature = Signature.create(key, [message]);
      expect(signature.verify(key.toPublicKey(), [message]).toBoolean()).toBe(true);
      for (const other of [hash, proposalSigningMessage(hash, action === 'propose' ? 'approve' : 'propose'),
        proposalSigningMessage(hash.add(1), action), Poseidon.hashWithPrefix(`other-app-${action}`, [hash])]) {
        expect(signature.verify(key.toPublicKey(), [other]).toBoolean()).toBe(false);
      }
    }
  });
});
