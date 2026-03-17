import { Field, PrivateKey } from 'o1js';
import { OwnerStore, ApprovalStore, VoteNullifierStore } from '../storage.js';
import { EXECUTED_MARKER } from '../constants.js';
import { computeOwnerChain } from '../list-commitment.js';
import { describe, expect, it } from 'bun:test';

describe('OwnerStore', () => {
  it('should add and check owners', () => {
    const store = new OwnerStore();
    const owner1 = PrivateKey.random().toPublicKey();
    const owner2 = PrivateKey.random().toPublicKey();

    store.add(owner1);
    store.add(owner2);

    expect(store.isOwner(owner1)).toBe(true);
    expect(store.isOwner(owner2)).toBe(true);
    expect(store.isOwner(PrivateKey.random().toPublicKey())).toBe(false);
    expect(store.length).toBe(2);
  });

  it('should remove owners', () => {
    const store = new OwnerStore();
    const owner1 = PrivateKey.random().toPublicKey();
    const owner2 = PrivateKey.random().toPublicKey();

    store.add(owner1);
    store.add(owner2);
    store.remove(owner1);

    expect(store.isOwner(owner1)).toBe(false);
    expect(store.isOwner(owner2)).toBe(true);
    expect(store.length).toBe(1);
  });

  it('should compute correct commitment', () => {
    const store = new OwnerStore();
    const owner1 = PrivateKey.random().toPublicKey();
    const owner2 = PrivateKey.random().toPublicKey();
    store.add(owner1);
    store.add(owner2);

    const sorted = [owner1, owner2].sort((a, b) => a.toBase58().localeCompare(b.toBase58()));
    expect(store.getCommitment()).toEqual(computeOwnerChain(sorted));
  });

  it('should generate valid witness', () => {
    const store = new OwnerStore();
    const owner1 = PrivateKey.random().toPublicKey();
    const owner2 = PrivateKey.random().toPublicKey();
    store.add(owner1);
    store.add(owner2);

    const witness = store.getWitness();
    // Witness should have MAX_OWNERS entries, first 2 filled
    expect(witness.owners[0].isSome.toBoolean()).toBe(true);
    expect(witness.owners[1].isSome.toBoolean()).toBe(true);
    expect(witness.owners[2].isSome.toBoolean()).toBe(false);
  });

  it('should serialize and deserialize', () => {
    const store = new OwnerStore();
    const owner1 = PrivateKey.random().toPublicKey();
    const owner2 = PrivateKey.random().toPublicKey();
    store.add(owner1);
    store.add(owner2);

    const json = store.serialize();
    const restored = OwnerStore.deserialize(json);

    expect(restored.getCommitment()).toEqual(store.getCommitment());
    expect(restored.length).toBe(2);
    expect(restored.isOwner(owner1)).toBe(true);
    expect(restored.isOwner(owner2)).toBe(true);
  });

  it('should insert after a specific owner', () => {
    const store = new OwnerStore();
    const owner1 = PrivateKey.random().toPublicKey();
    const owner2 = PrivateKey.random().toPublicKey();
    const owner3 = PrivateKey.random().toPublicKey();
    store.add(owner1);
    store.add(owner2);

    // insertAfter bypasses sorting — it places owner3 directly after the first sorted owner
    const first = store.owners[0];
    const second = store.owners[1];
    store.insertAfter(owner3, first);

    expect(store.getCommitment()).toEqual(computeOwnerChain([first, owner3, second]));
  });

  it('should prepend when insertAfter is null', () => {
    const store = new OwnerStore();
    const owner1 = PrivateKey.random().toPublicKey();
    const owner2 = PrivateKey.random().toPublicKey();
    store.add(owner1);

    store.insertAfter(owner2, null);

    expect(store.getCommitment()).toEqual(computeOwnerChain([owner2, owner1]));
  });

  it('should maintain sorted order on add', () => {
    const store = new OwnerStore();
    const keys = Array.from({ length: 5 }, () => PrivateKey.random().toPublicKey());
    for (const k of keys) store.add(k);

    const base58s = store.owners.map(o => o.toBase58());
    const sorted = [...base58s].sort();
    expect(base58s).toEqual(sorted);
  });

  it('should produce same commitment regardless of insertion order', () => {
    const keys = Array.from({ length: 4 }, () => PrivateKey.random().toPublicKey());

    const store1 = new OwnerStore();
    for (const k of keys) store1.add(k);

    const store2 = new OwnerStore();
    for (const k of [...keys].reverse()) store2.add(k);

    expect(store1.getCommitment()).toEqual(store2.getCommitment());
  });

  it('findInsertAfter returns none for first sorted position', () => {
    const store = new OwnerStore();
    const keys = Array.from({ length: 3 }, () => PrivateKey.random().toPublicKey());
    keys.sort((a, b) => a.toBase58().localeCompare(b.toBase58()));
    store.add(keys[1]);
    store.add(keys[2]);

    const result = store.findInsertAfter(keys[0]);
    expect(result.isSome.toBoolean()).toBe(false);
  });

  it('findInsertAfter returns predecessor for middle position', () => {
    const store = new OwnerStore();
    const keys = Array.from({ length: 3 }, () => PrivateKey.random().toPublicKey());
    keys.sort((a, b) => a.toBase58().localeCompare(b.toBase58()));
    store.add(keys[0]);
    store.add(keys[2]);

    const result = store.findInsertAfter(keys[1]);
    expect(result.isSome.toBoolean()).toBe(true);
    expect(result.value.toBase58()).toBe(keys[0].toBase58());
  });

  it('findInsertAfter returns last owner for append position', () => {
    const store = new OwnerStore();
    const keys = Array.from({ length: 3 }, () => PrivateKey.random().toPublicKey());
    keys.sort((a, b) => a.toBase58().localeCompare(b.toBase58()));
    store.add(keys[0]);
    store.add(keys[1]);

    const result = store.findInsertAfter(keys[2]);
    expect(result.isSome.toBoolean()).toBe(true);
    expect(result.value.toBase58()).toBe(keys[1].toBase58());
  });
});

describe('ApprovalStore', () => {
  it('should track approval counts', () => {
    const store = new ApprovalStore();
    const proposalHash = Field(12345);

    store.setCount(proposalHash, Field(0));
    expect(store.getCount(proposalHash)).toEqual(Field(0));

    store.setCount(proposalHash, Field(2));
    expect(store.getCount(proposalHash)).toEqual(Field(2));
  });

  it('should track executed status', () => {
    const store = new ApprovalStore();
    const proposalHash = Field(12345);

    store.setCount(proposalHash, Field(2));
    expect(store.isExecuted(proposalHash)).toBe(false);

    store.setCount(proposalHash, EXECUTED_MARKER);
    expect(store.isExecuted(proposalHash)).toBe(true);
  });

  it('should generate valid witness', () => {
    const store = new ApprovalStore();
    const proposalHash = Field(12345);
    store.setCount(proposalHash, Field(3));

    const witness = store.getWitness(proposalHash);
    const [root] = witness.computeRootAndKey(Field(3));
    expect(root).toEqual(store.getRoot());
  });

  it('should not duplicate keys', () => {
    const store = new ApprovalStore();
    const proposalHash = Field(12345);

    store.setCount(proposalHash, Field(1));
    store.setCount(proposalHash, Field(2));
    store.setCount(proposalHash, Field(3));

    expect(store.keys.length).toBe(1);
  });

  it('should serialize and deserialize', () => {
    const store = new ApprovalStore();
    store.setCount(Field(1), Field(2));
    store.setCount(Field(2), Field(5));

    const json = store.serialize();
    const restored = ApprovalStore.deserialize(json);

    expect(restored.getRoot()).toEqual(store.getRoot());
    expect(restored.getCount(Field(1))).toEqual(Field(2));
    expect(restored.getCount(Field(2))).toEqual(Field(5));
    expect(restored.keys.length).toBe(2);
  });
});

describe('VoteNullifierStore', () => {
  it('should track nullification', () => {
    const store = new VoteNullifierStore();
    const proposalHash = Field(12345);
    const approver = PrivateKey.random().toPublicKey();

    expect(store.isNullified(proposalHash, approver)).toBe(false);

    store.nullify(proposalHash, approver);
    expect(store.isNullified(proposalHash, approver)).toBe(true);
  });

  it('should handle different approvers independently', () => {
    const store = new VoteNullifierStore();
    const proposalHash = Field(12345);
    const approver1 = PrivateKey.random().toPublicKey();
    const approver2 = PrivateKey.random().toPublicKey();

    store.nullify(proposalHash, approver1);

    expect(store.isNullified(proposalHash, approver1)).toBe(true);
    expect(store.isNullified(proposalHash, approver2)).toBe(false);
  });

  it('should handle different proposalHashes independently', () => {
    const store = new VoteNullifierStore();
    const proposalHash1 = Field(111);
    const proposalHash2 = Field(222);
    const approver = PrivateKey.random().toPublicKey();

    store.nullify(proposalHash1, approver);

    expect(store.isNullified(proposalHash1, approver)).toBe(true);
    expect(store.isNullified(proposalHash2, approver)).toBe(false);
  });

  it('should generate valid witness', () => {
    const store = new VoteNullifierStore();
    const proposalHash = Field(12345);
    const approver = PrivateKey.random().toPublicKey();

    // Before nullification, value should be 0
    const witness = store.getWitness(proposalHash, approver);
    const [root] = witness.computeRootAndKey(Field(0));
    expect(root).toEqual(store.getRoot());
  });
});
