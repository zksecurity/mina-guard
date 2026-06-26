import { describe, it, expect } from 'bun:test';
import { Bool, Field, PrivateKey, Provable, PublicKey } from 'o1js';
import {
  PublicKeyOption,
  OwnerWitness,
  computeOwnerChain,
  computeSetupOwnersChain,
  assertCoherentSetupOwners,
  assertOwnerMembership,
  addOwnerToCommitment,
  removeOwnerFromCommitment,
} from '../list-commitment.js';
import { INITIAL_OWNER_CHAIN, MAX_OWNERS } from '../constants.js';

/** Build an OwnerWitness from a plain PublicKey[]. */
function makeWitness(owners: PublicKey[]): OwnerWitness {
  const ownerOptions: PublicKeyOption[] = owners.map(
    (pk) => new PublicKeyOption({ value: pk, isSome: Bool(true) })
  );
  while (ownerOptions.length < MAX_OWNERS) {
    ownerOptions.push(PublicKeyOption.none());
  }
  return new OwnerWitness({ owners: ownerOptions });
}

/** Shorthand to create a some(pk) option for insertAfter. */
function after(pk: PublicKey): PublicKeyOption {
  return new PublicKeyOption({ value: pk, isSome: Bool(true) });
}

/** Pad a compact owner list to MAX_OWNERS with PublicKey.empty() at the end. */
function padToMax(real: PublicKey[]): PublicKey[] {
  const padded = [...real];
  while (padded.length < MAX_OWNERS) {
    padded.push(PublicKey.empty());
  }
  return padded.slice(0, MAX_OWNERS);
}

// Pre-generate test keys
const keyA = PrivateKey.random().toPublicKey();
const keyB = PrivateKey.random().toPublicKey();
const keyC = PrivateKey.random().toPublicKey();
const keyD = PrivateKey.random().toPublicKey();

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

describe('computeSetupOwnersChain', () => {
  it('matches computeOwnerChain for a padded list with numOwners = N', () => {
    const real = [keyA, keyB, keyC];
    const h = computeSetupOwnersChain(padToMax(real), Field(real.length));
    expect(h.toBigInt()).toBe(computeOwnerChain(real).toBigInt());
  });

  it('numOwners = 0 returns INITIAL_OWNER_CHAIN', () => {
    const h = computeSetupOwnersChain(padToMax([keyA, keyB]), Field(0));
    expect(h.toBigInt()).toBe(INITIAL_OWNER_CHAIN.toBigInt());
  });

  it('full list (numOwners = 2) matches computeOwnerChain([A, B])', () => {
    const h = computeSetupOwnersChain(padToMax([keyA, keyB]), Field(2));
    expect(h.toBigInt()).toBe(computeOwnerChain([keyA, keyB]).toBigInt());
  });

  it('ignores padding: single real owner matches computeOwnerChain([A])', () => {
    const h = computeSetupOwnersChain(padToMax([keyA]), Field(1));
    expect(h.toBigInt()).toBe(computeOwnerChain([keyA]).toBigInt());
  });

  it('numOwners is sensitive: Field(2) != Field(3) for the same array', () => {
    const padded = padToMax([keyA, keyB, keyC]);
    const h2 = computeSetupOwnersChain(padded, Field(2));
    const h3 = computeSetupOwnersChain(padded, Field(3));
    expect(h2.toBigInt()).not.toBe(h3.toBigInt());
  });
});

describe('assertCoherentSetupOwners', () => {
  it('passes for distinct active owners with empty padding', async () => {
    await Provable.runAndCheck(() => {
      assertCoherentSetupOwners(padToMax([keyA, keyB, keyC]), Field(3));
    });
  });

  it('passes for a single owner', async () => {
    await Provable.runAndCheck(() => {
      assertCoherentSetupOwners(padToMax([keyA]), Field(1));
    });
  });

  it('passes despite many duplicate empty() padding slots', async () => {
    // numOwners = 2, the remaining 18 slots are all PublicKey.empty() (equal to
    // each other) — the active-gate must keep dedup from firing on them.
    await Provable.runAndCheck(() => {
      assertCoherentSetupOwners(padToMax([keyA, keyB]), Field(2));
    });
  });

  it('fails on a duplicate active owner', async () => {
    // keyA at slots 0 and 1, both active (numOwners = 3).
    await expect(
      Provable.runAndCheck(() => {
        assertCoherentSetupOwners(padToMax([keyA, keyA, keyB]), Field(3));
      })
    ).rejects.toThrow();
  });

  it('fails on a non-empty padding slot', async () => {
    // Real owner planted at index 2, but numOwners = 2 so index 2 is inactive
    // and must be empty.
    await expect(
      Provable.runAndCheck(() => {
        assertCoherentSetupOwners(padToMax([keyA, keyB, keyC]), Field(2));
      })
    ).rejects.toThrow();
  });
});
