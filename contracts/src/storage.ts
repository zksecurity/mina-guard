import { Bool, Field, MerkleMap, PublicKey, Poseidon } from 'o1js';
import { computeOwnerChain, PublicKeyOption, OwnerWitness } from './list-commitment.js';
import { MAX_OWNERS } from './constants.js';

// -- Serialization helpers ---------------------------------------------------

interface SerializedMerkleMap {
  entries: Record<string, string>;
}

function serializeMerkleMap(
  map: MerkleMap,
  keys: Field[]
): SerializedMerkleMap {
  const entries: Record<string, string> = {};
  for (const key of keys) {
    entries[key.toString()] = map.get(key).toString();
  }
  return { entries };
}

function deserializeMerkleMap(data: SerializedMerkleMap): {
  map: MerkleMap;
  keys: Field[];
} {
  const map = new MerkleMap();
  const keys: Field[] = [];
  for (const [keyStr, valueStr] of Object.entries(data.entries)) {
    const key = Field(keyStr);
    map.set(key, Field(valueStr));
    keys.push(key);
  }
  return { map, keys };
}

// -- OwnerStore --------------------------------------------------------------

export class OwnerStore {
  owners: PublicKey[];

  constructor() {
    this.owners = [];
  }

  /** Insert owner in ascending base58 order. */
  addSorted(owner: PublicKey): void {
    const b58 = owner.toBase58();
    const idx = this.owners.findIndex((o) => o.toBase58() > b58);
    if (idx === -1) {
      this.owners.push(owner);
    } else {
      this.owners.splice(idx, 0, owner);
    }
  }

  /**
   * Returns the owner immediately before `target` in the sorted list,
   * or null if `target` would be the first element.
   */
  sortedPredecessor(target: PublicKey): PublicKey | null {
    const b58 = target.toBase58();
    let pred: PublicKey | null = null;
    for (const o of this.owners) {
      if (o.toBase58() < b58) pred = o;
    }
    return pred;
  }

  /** Insert owner after the given key. If afterOwner is null, prepend. */
  insertAfter(owner: PublicKey, afterOwner: PublicKey | null): void {
    if (afterOwner === null) {
      this.owners.unshift(owner);
      return;
    }
    const idx = this.owners.findIndex(
      (o) => o.toBase58() === afterOwner.toBase58()
    );
    if (idx === -1) throw new Error('afterOwner not found');
    this.owners.splice(idx + 1, 0, owner);
  }

  remove(owner: PublicKey): void {
    this.owners = this.owners.filter(
      (o) => o.toBase58() !== owner.toBase58()
    );
  }

  isOwner(owner: PublicKey): boolean {
    return this.owners.some((o) => o.toBase58() === owner.toBase58());
  }

  getCommitment(): Field {
    return computeOwnerChain(this.owners);
  }

  getWitness(): OwnerWitness {
    const owners = this.owners.map(
      (pk) => new PublicKeyOption({ value: pk, isSome: Bool(true) })
    );
    while (owners.length < MAX_OWNERS) {
      owners.push(PublicKeyOption.none());
    }
    return new OwnerWitness({ owners });
  }

  get length(): number {
    return this.owners.length;
  }

  serialize(): string {
    return JSON.stringify({
      owners: this.owners.map((a) => a.toBase58()),
    });
  }

  static deserialize(json: string): OwnerStore {
    const data = JSON.parse(json);
    const store = new OwnerStore();
    store.owners = (data.owners as string[]).map((a) =>
      PublicKey.fromBase58(a)
    );
    return store;
  }
}


// -- ApprovalStore -----------------------------------------------------------

export class ApprovalStore {
  map: MerkleMap;
  keys: Field[];

  constructor() {
    this.map = new MerkleMap();
    this.keys = [];
  }

  getCount(proposalHash: Field): Field {
    return this.map.get(proposalHash);
  }

  setCount(proposalHash: Field, count: Field): void {
    this.map.set(proposalHash, count);
    if (!this.keys.find((k) => k.toString() === proposalHash.toString())) {
      this.keys.push(proposalHash);
    }
  }

  getWitness(proposalHash: Field) {
    return this.map.getWitness(proposalHash);
  }

  isExecuted(proposalHash: Field): boolean {
    return this.map.get(proposalHash).toString() === Field(0).sub(1).toString();
  }

  getRoot(): Field {
    return this.map.getRoot();
  }

  serialize(): string {
    return JSON.stringify({
      entries: serializeMerkleMap(this.map, this.keys),
    });
  }

  static deserialize(json: string): ApprovalStore {
    const data = JSON.parse(json);
    const store = new ApprovalStore();
    const { map, keys } = deserializeMerkleMap(data.entries);
    store.map = map;
    store.keys = keys;
    return store;
  }
}

// -- VoteNullifierStore ------------------------------------------------------

export class VoteNullifierStore {
  map: MerkleMap;

  constructor() {
    this.map = new MerkleMap();
  }

  private nullifierKey(proposalHash: Field, approver: PublicKey): Field {
    return Poseidon.hash([proposalHash, ...approver.toFields()]);
  }

  isNullified(proposalHash: Field, approver: PublicKey): boolean {
    return this.map.get(this.nullifierKey(proposalHash, approver)).toString() === '1';
  }

  nullify(proposalHash: Field, approver: PublicKey): void {
    this.map.set(this.nullifierKey(proposalHash, approver), Field(1));
  }

  getWitness(proposalHash: Field, approver: PublicKey) {
    return this.map.getWitness(this.nullifierKey(proposalHash, approver));
  }

  getRoot(): Field {
    return this.map.getRoot();
  }
}
