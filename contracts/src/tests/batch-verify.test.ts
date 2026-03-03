import { Field, PrivateKey, Signature } from 'o1js';
import { BatchVerifySigs, BatchVerifyInput } from '../BatchVerifyProgram.js';
import { ownerKey } from '../utils.js';
import { OwnerStore } from '../storage.js';
import { describe, expect, it, beforeAll } from 'bun:test';

/** Sort private keys by ascending ownerKey hash. */
function sortByHash(keys: PrivateKey[]): PrivateKey[] {
  return [...keys].sort((a, b) => {
    const ha = ownerKey(a.toPublicKey()).toBigInt();
    const hb = ownerKey(b.toPublicKey()).toBigInt();
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  });
}

const TIMEOUT = 1_000_000; // ~16 min, recursive proofs are slow

describe('BatchVerifySigs', () => {
  beforeAll(async () => {
    await BatchVerifySigs.compile();
  }, TIMEOUT);

  it('should verify a single approval', async () => {
    const owner = PrivateKey.random();
    const proposalHash = Field(123);

    const store = new OwnerStore();
    store.add(owner.toPublicKey());

    const input = new BatchVerifyInput({
      proposalHash,
      ownersRoot: store.getRoot(),
    });

    const sig = Signature.create(owner, [proposalHash]);
    const witness = store.getWitness(owner.toPublicKey());

    const { proof } = await BatchVerifySigs.firstVerification(input, sig, owner.toPublicKey(), witness);

    expect(proof.publicOutput.approvalCount).toEqual(Field(1));
    expect(proof.publicOutput.approverHash).toEqual(ownerKey(owner.toPublicKey()));
    expect(await BatchVerifySigs.verify(proof)).toBe(true);
  }, TIMEOUT);

  it('should chain two approvals', async () => {
    const ownerA = PrivateKey.random();
    const ownerB = PrivateKey.random();
    const proposalHash = Field(456);

    const store = new OwnerStore();
    store.add(ownerA.toPublicKey());
    store.add(ownerB.toPublicKey());

    const input = new BatchVerifyInput({
      proposalHash,
      ownersRoot: store.getRoot(),
    });

    const [first, second] = sortByHash([ownerA, ownerB]);

    const sig1 = Signature.create(first, [proposalHash]);
    const w1 = store.getWitness(first.toPublicKey());
    const { proof: proof1 } = await BatchVerifySigs.firstVerification(input, sig1, first.toPublicKey(), w1);

    const sig2 = Signature.create(second, [proposalHash]);
    const w2 = store.getWitness(second.toPublicKey());
    const { proof: proof2 } = await BatchVerifySigs.addVerification(input, proof1, sig2, second.toPublicKey(), w2);

    expect(proof2.publicOutput.approvalCount).toEqual(Field(2));
    expect(proof2.publicOutput.approverHash).toEqual(ownerKey(second.toPublicKey()));
    expect(await BatchVerifySigs.verify(proof2)).toBe(true);
  }, TIMEOUT);

  it('should chain three approvals', async () => {
    const owners = [PrivateKey.random(), PrivateKey.random(), PrivateKey.random()];
    const proposalHash = Field(789);

    const store = new OwnerStore();
    for (const o of owners) store.add(o.toPublicKey());

    const input = new BatchVerifyInput({
      proposalHash,
      ownersRoot: store.getRoot(),
    });

    const sorted = sortByHash(owners);

    const sig1 = Signature.create(sorted[0], [proposalHash]);
    const w1 = store.getWitness(sorted[0].toPublicKey());
    const { proof: proof1 } = await BatchVerifySigs.firstVerification(input, sig1, sorted[0].toPublicKey(), w1);

    const sig2 = Signature.create(sorted[1], [proposalHash]);
    const w2 = store.getWitness(sorted[1].toPublicKey());
    const { proof: proof2 } = await BatchVerifySigs.addVerification(input, proof1, sig2, sorted[1].toPublicKey(), w2);

    const sig3 = Signature.create(sorted[2], [proposalHash]);
    const w3 = store.getWitness(sorted[2].toPublicKey());
    const { proof: proof3 } = await BatchVerifySigs.addVerification(input, proof2, sig3, sorted[2].toPublicKey(), w3);

    expect(proof3.publicOutput.approvalCount).toEqual(Field(3));
    expect(await BatchVerifySigs.verify(proof3)).toBe(true);
  }, TIMEOUT);

  it('should reject duplicate signer (wrong order)', async () => {
    const owner = PrivateKey.random();
    const proposalHash = Field(111);

    const store = new OwnerStore();
    store.add(owner.toPublicKey());

    const input = new BatchVerifyInput({
      proposalHash,
      ownersRoot: store.getRoot(),
    });

    const sig = Signature.create(owner, [proposalHash]);
    const witness = store.getWitness(owner.toPublicKey());

    const { proof: proof1 } = await BatchVerifySigs.firstVerification(input, sig, owner.toPublicKey(), witness);

    await expect(async () => {
      await BatchVerifySigs.addVerification(input, proof1, sig, owner.toPublicKey(), witness);
    }).toThrow();
  }, TIMEOUT);

  it('should reject non-owner', async () => {
    const owner = PrivateKey.random();
    const nonOwner = PrivateKey.random();
    const proposalHash = Field(222);

    const store = new OwnerStore();
    store.add(owner.toPublicKey());

    const input = new BatchVerifyInput({
      proposalHash,
      ownersRoot: store.getRoot(),
    });

    const sig = Signature.create(nonOwner, [proposalHash]);
    const witness = store.getWitness(nonOwner.toPublicKey());

    await expect(async () => {
      await BatchVerifySigs.firstVerification(input, sig, nonOwner.toPublicKey(), witness);
    }).toThrow();
  }, TIMEOUT);

  it('should reject invalid signature', async () => {
    const owner = PrivateKey.random();
    const wrongKey = PrivateKey.random();
    const proposalHash = Field(333);

    const store = new OwnerStore();
    store.add(owner.toPublicKey());

    const input = new BatchVerifyInput({
      proposalHash,
      ownersRoot: store.getRoot(),
    });

    // Sign with wrong key
    const sig = Signature.create(wrongKey, [proposalHash]);
    const witness = store.getWitness(owner.toPublicKey());

    await expect(async () => {
      await BatchVerifySigs.firstVerification(input, sig, owner.toPublicKey(), witness);
    }).toThrow();
  }, TIMEOUT);

  it('should reject wrong owners root', async () => {
    const owner = PrivateKey.random();
    const proposalHash = Field(444);

    const store = new OwnerStore();
    store.add(owner.toPublicKey());

    // Use a different root
    const wrongStore = new OwnerStore();
    wrongStore.add(PrivateKey.random().toPublicKey());

    const input = new BatchVerifyInput({
      proposalHash,
      ownersRoot: wrongStore.getRoot(),
    });

    const sig = Signature.create(owner, [proposalHash]);
    const witness = store.getWitness(owner.toPublicKey());

    await expect(async () => {
      await BatchVerifySigs.firstVerification(input, sig, owner.toPublicKey(), witness);
    }).toThrow();
  }, TIMEOUT);

  it('should reject mismatched proposal hash in recursive step', async () => {
    const ownerA = PrivateKey.random();
    const ownerB = PrivateKey.random();

    const store = new OwnerStore();
    store.add(ownerA.toPublicKey());
    store.add(ownerB.toPublicKey());

    const [first, second] = sortByHash([ownerA, ownerB]);

    const hash1 = Field(555);
    const hash2 = Field(666);

    const input1 = new BatchVerifyInput({ proposalHash: hash1, ownersRoot: store.getRoot() });
    const input2 = new BatchVerifyInput({ proposalHash: hash2, ownersRoot: store.getRoot() });

    const sig1 = Signature.create(first, [hash1]);
    const w1 = store.getWitness(first.toPublicKey());
    const { proof: proof1 } = await BatchVerifySigs.firstVerification(input1, sig1, first.toPublicKey(), w1);

    // Try to chain with a different proposal hash
    const sig2 = Signature.create(second, [hash2]);
    const w2 = store.getWitness(second.toPublicKey());

    await expect(async () => {
      await BatchVerifySigs.addVerification(input2, proof1, sig2, second.toPublicKey(), w2);
    }).toThrow();
  }, TIMEOUT);
});
