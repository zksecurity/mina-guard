import { describe, it, expect } from 'bun:test';
import { Bool, PrivateKey, Provable, PublicKey } from 'o1js';
import {
  PublicKeyOption,
  computeOwnerChain,
  assertOwnerMembership,
  addOwnerToCommitment,
  removeOwnerFromCommitment,
} from '../list-commitment.js';
import { INITIAL_OWNER_CHAIN, MAX_OWNERS } from '../constants.js';

/** Build an OwnerWitness (PublicKeyOption[] of size MAX_OWNERS) from a plain PublicKey[]. */
function makeWitness(owners: PublicKey[]): PublicKeyOption[] {
  const witness: PublicKeyOption[] = owners.map(
    (pk) => new PublicKeyOption({ value: pk, isSome: Bool(true) })
  );
  while (witness.length < MAX_OWNERS) {
    witness.push(PublicKeyOption.none());
  }
  return witness;
}

/** Shorthand to create a some(pk) option for insertAfter. */
function after(pk: PublicKey): PublicKeyOption {
  return new PublicKeyOption({ value: pk, isSome: Bool(true) });
}

// Pre-generate test keys
const keyA = PrivateKey.random().toPublicKey();
const keyB = PrivateKey.random().toPublicKey();
const keyC = PrivateKey.random().toPublicKey();

describe('computeOwnerChain', () => {
  it('empty array returns INITIAL_OWNER_CHAIN', () => {
    expect(computeOwnerChain([]).toBigInt()).toBe(INITIAL_OWNER_CHAIN.toBigInt());
  });

  it('single key produces a different hash than INITIAL_OWNER_CHAIN', () => {
    const h = computeOwnerChain([keyA]);
    expect(h.toBigInt()).not.toBe(INITIAL_OWNER_CHAIN.toBigInt());
  });

  it('same keys in same order produce same hash', () => {
    const h1 = computeOwnerChain([keyA, keyB]);
    const h2 = computeOwnerChain([keyA, keyB]);
    expect(h1.toBigInt()).toBe(h2.toBigInt());
  });

  it('order matters: [A, B] != [B, A]', () => {
    const h1 = computeOwnerChain([keyA, keyB]);
    const h2 = computeOwnerChain([keyB, keyA]);
    expect(h1.toBigInt()).not.toBe(h2.toBigInt());
  });
});

describe('assertOwnerMembership', () => {
  it('passes when shouldBeOwner=true and key is in list', async () => {
    const owners = [keyA, keyB];
    const commitment = computeOwnerChain(owners);
    const witness = makeWitness(owners);

    await Provable.runAndCheck(() => {
      assertOwnerMembership(commitment, keyA, witness);
    });
  });

  it('passes for single-owner list', async () => {
    const owners = [keyA];
    const commitment = computeOwnerChain(owners);
    const witness = makeWitness(owners);

    await Provable.runAndCheck(() => {
      assertOwnerMembership(commitment, keyA, witness);
    });
  });

  it('fails when key is NOT in list', async () => {
    const owners = [keyA, keyB];
    const commitment = computeOwnerChain(owners);
    const witness = makeWitness(owners);

    await expect(
      Provable.runAndCheck(() => {
        assertOwnerMembership(commitment, keyC, witness);
      })
    ).rejects.toThrow();
  });

  it('fails with wrong commitment', async () => {
    const owners = [keyA, keyB];
    const wrongCommitment = computeOwnerChain([keyA]);
    const witness = makeWitness(owners);

    await expect(
      Provable.runAndCheck(() => {
        assertOwnerMembership(wrongCommitment, keyA, witness);
      })
    ).rejects.toThrow();
  });

  it('fails when witness order does not match commitment', async () => {
    const commitment = computeOwnerChain([keyA, keyB]);
    const witness = makeWitness([keyB, keyA]);

    await expect(
      Provable.runAndCheck(() => {
        assertOwnerMembership(commitment, keyA, witness);
      })
    ).rejects.toThrow();
  });
});

describe('addOwnerToCommitment', () => {
  it('returns chain matching computeOwnerChain with new owner appended', async () => {
    const owners = [keyA, keyB];
    const commitment = computeOwnerChain(owners);
    const witness = makeWitness(owners);
    const expected = computeOwnerChain([keyA, keyB, keyC]);

    await Provable.runAndCheck(() => {
      const [result, valid] = addOwnerToCommitment(commitment, keyC, witness, after(keyB));
      result.assertEquals(expected);
      valid.assertTrue();
    });
  });

  it('can insert after the first key', async () => {
    const owners = [keyA, keyB];
    const commitment = computeOwnerChain(owners);
    const witness = makeWitness(owners);
    const expected = computeOwnerChain([keyA, keyC, keyB]);

    await Provable.runAndCheck(() => {
      const [result, valid] = addOwnerToCommitment(commitment, keyC, witness, after(keyA));
      result.assertEquals(expected);
      valid.assertTrue();
    });
  });

  it('can prepend with insertAfter=none', async () => {
    const owners = [keyA, keyB];
    const commitment = computeOwnerChain(owners);
    const witness = makeWitness(owners);
    const expected = computeOwnerChain([keyC, keyA, keyB]);

    await Provable.runAndCheck(() => {
      const [result, valid] = addOwnerToCommitment(commitment, keyC, witness, PublicKeyOption.none());
      result.assertEquals(expected);
      valid.assertTrue();
    });
  });

  it('returns invalid if owner already exists', async () => {
    const owners = [keyA, keyB];
    const commitment = computeOwnerChain(owners);
    const witness = makeWitness(owners);

    await Provable.runAndCheck(() => {
      const [, valid] = addOwnerToCommitment(commitment, keyA, witness, after(keyB));
      valid.assertFalse();
    });
  });

  it('returns invalid if owner already exists even with prepend', async () => {
    const owners = [keyA, keyB];
    const commitment = computeOwnerChain(owners);
    const witness = makeWitness(owners);

    await Provable.runAndCheck(() => {
      const [, valid] = addOwnerToCommitment(commitment, keyA, witness, PublicKeyOption.none());
      valid.assertFalse();
    });
  });

  it('returns invalid if insertAfter key not found', async () => {
    const owners = [keyA, keyB];
    const commitment = computeOwnerChain(owners);
    const witness = makeWitness(owners);

    await Provable.runAndCheck(() => {
      const [, valid] = addOwnerToCommitment(commitment, keyC, witness, after(keyC));
      valid.assertFalse();
    });
  });

  it('returns invalid with wrong commitment', async () => {
    const owners = [keyA, keyB];
    const wrongCommitment = computeOwnerChain([keyA]);
    const witness = makeWitness(owners);

    await Provable.runAndCheck(() => {
      const [, valid] = addOwnerToCommitment(wrongCommitment, keyC, witness, after(keyB));
      valid.assertFalse();
    });
  });
});

describe('removeOwnerFromCommitment', () => {
  it('returns chain matching computeOwnerChain without removed owner', async () => {
    const owners = [keyA, keyB, keyC];
    const commitment = computeOwnerChain(owners);
    const witness = makeWitness(owners);
    const expected = computeOwnerChain([keyA, keyC]);

    await Provable.runAndCheck(() => {
      const [result, valid] = removeOwnerFromCommitment(commitment, keyB, witness);
      result.assertEquals(expected);
      valid.assertTrue();
    });
  });

  it('can remove first owner', async () => {
    const owners = [keyA, keyB];
    const commitment = computeOwnerChain(owners);
    const witness = makeWitness(owners);
    const expected = computeOwnerChain([keyB]);

    await Provable.runAndCheck(() => {
      const [result, valid] = removeOwnerFromCommitment(commitment, keyA, witness);
      result.assertEquals(expected);
      valid.assertTrue();
    });
  });

  it('can remove last owner', async () => {
    const owners = [keyA, keyB];
    const commitment = computeOwnerChain(owners);
    const witness = makeWitness(owners);
    const expected = computeOwnerChain([keyA]);

    await Provable.runAndCheck(() => {
      const [result, valid] = removeOwnerFromCommitment(commitment, keyB, witness);
      result.assertEquals(expected);
      valid.assertTrue();
    });
  });

  it('removing sole owner yields INITIAL_OWNER_CHAIN', async () => {
    const owners = [keyA];
    const commitment = computeOwnerChain(owners);
    const witness = makeWitness(owners);

    await Provable.runAndCheck(() => {
      const [result, valid] = removeOwnerFromCommitment(commitment, keyA, witness);
      result.assertEquals(INITIAL_OWNER_CHAIN);
      valid.assertTrue();
    });
  });

  it('returns invalid if owner does not exist', async () => {
    const owners = [keyA, keyB];
    const commitment = computeOwnerChain(owners);
    const witness = makeWitness(owners);

    await Provable.runAndCheck(() => {
      const [, valid] = removeOwnerFromCommitment(commitment, keyC, witness);
      valid.assertFalse();
    });
  });

  it('returns invalid with wrong commitment', async () => {
    const owners = [keyA, keyB];
    const wrongCommitment = computeOwnerChain([keyA]);
    const witness = makeWitness(owners);

    await Provable.runAndCheck(() => {
      const [, valid] = removeOwnerFromCommitment(wrongCommitment, keyB, witness);
      valid.assertFalse();
    });
  });

  it('returns invalid when witness order does not match commitment', async () => {
    const commitment = computeOwnerChain([keyA, keyB]);
    const witness = makeWitness([keyB, keyA]);

    await Provable.runAndCheck(() => {
      const [, valid] = removeOwnerFromCommitment(commitment, keyA, witness);
      valid.assertFalse();
    });
  });
});

describe('round-trips', () => {
  it('addOwner then removeOwner returns original chain', async () => {
    const owners = [keyA, keyB];
    const original = computeOwnerChain(owners);
    const witness = makeWitness(owners);
    const withC = computeOwnerChain([keyA, keyB, keyC]);
    const witnessWithC = makeWitness([keyA, keyB, keyC]);

    await Provable.runAndCheck(() => {
      const [added, addValid] = addOwnerToCommitment(original, keyC, witness, after(keyB));
      addValid.assertTrue();
      added.assertEquals(withC);
      const [removed, remValid] = removeOwnerFromCommitment(withC, keyC, witnessWithC);
      remValid.assertTrue();
      removed.assertEquals(original);
    });
  });

  it('removeOwner then addOwner returns original chain', async () => {
    const owners = [keyA, keyB, keyC];
    const original = computeOwnerChain(owners);
    const witness = makeWitness(owners);
    const withoutB = computeOwnerChain([keyA, keyC]);
    const witnessWithoutB = makeWitness([keyA, keyC]);

    await Provable.runAndCheck(() => {
      const [removed, remValid] = removeOwnerFromCommitment(original, keyB, witness);
      remValid.assertTrue();
      removed.assertEquals(withoutB);
      const [added, addValid] = addOwnerToCommitment(withoutB, keyB, witnessWithoutB, after(keyA));
      addValid.assertTrue();
      added.assertEquals(original);
    });
  });

  it('prepend then remove returns original chain', async () => {
    const owners = [keyA, keyB];
    const original = computeOwnerChain(owners);
    const witness = makeWitness(owners);
    const withC = computeOwnerChain([keyC, keyA, keyB]);
    const witnessWithC = makeWitness([keyC, keyA, keyB]);

    await Provable.runAndCheck(() => {
      const [added, addValid] = addOwnerToCommitment(original, keyC, witness, PublicKeyOption.none());
      addValid.assertTrue();
      added.assertEquals(withC);
      const [removed, remValid] = removeOwnerFromCommitment(withC, keyC, witnessWithC);
      remValid.assertTrue();
      removed.assertEquals(original);
    });
  });
});
