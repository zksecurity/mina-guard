import { Field, PrivateKey } from 'o1js';
import { OwnerStore, ApprovalStore, VoteNullifierStore } from '../storage.js';
import { EXECUTED_SENTINEL } from '../MinaGuard.js';
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
    expect(store.addresses.length).toBe(2);
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
    expect(store.addresses.length).toBe(1);
    expect(store.keys.length).toBe(1);
  });

  it('should generate valid witness', () => {
    const store = new OwnerStore();
    const owner = PrivateKey.random().toPublicKey();
    store.add(owner);

    const witness = store.getWitness(owner);
    const [root, key] = witness.computeRootAndKey(Field(1));
    expect(root).toEqual(store.getRoot());
  });

  it('should serialize and deserialize', () => {
    const store = new OwnerStore();
    const owner1 = PrivateKey.random().toPublicKey();
    const owner2 = PrivateKey.random().toPublicKey();
    store.add(owner1);
    store.add(owner2);

    const json = store.serialize();
    const restored = OwnerStore.deserialize(json);

    expect(restored.getRoot()).toEqual(store.getRoot());
    expect(restored.addresses.length).toBe(2);
    expect(restored.isOwner(owner1)).toBe(true);
    expect(restored.isOwner(owner2)).toBe(true);
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

    store.setCount(proposalHash, EXECUTED_SENTINEL);
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
