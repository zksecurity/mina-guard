import { describe, expect, it } from 'bun:test';
import { Field, Poseidon, PrivateKey } from 'o1js';
import { childConfigHash, ownerChainLink, voteNullifierKey } from '../hash-domains.js';

describe('commitment hash domains', () => {
  it('keeps equal field lists separate across owner links, votes, and child configs', () => {
    const owner = PrivateKey.random().toPublicKey();
    const first = Field(42);
    const fields = [first, ...owner.toFields()];

    const hashes = [
      ownerChainLink(first, owner).toString(),
      voteNullifierKey(first, owner).toString(),
      childConfigHash(first, owner.x, owner.isOdd.toField()).toString(),
    ];

    expect(new Set(hashes).size).toBe(3);
    expect(hashes).not.toContain(Poseidon.hash(fields).toString());
  });
});
