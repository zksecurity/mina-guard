import { Field, MerkleMap, PublicKey, Poseidon } from 'o1js';
import { ownerKey } from './MinaGuard.js';

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
  map: MerkleMap;
  keys: Field[];
  addresses: PublicKey[];

  constructor() {
    this.map = new MerkleMap();
    this.keys = [];
    this.addresses = [];
  }

  add(owner: PublicKey): void {
    const key = ownerKey(owner);
    this.map.set(key, Field(1));
    this.keys.push(key);
    this.addresses.push(owner);
  }

  remove(owner: PublicKey): void {
    const key = ownerKey(owner);
    this.map.set(key, Field(0));
    this.keys = this.keys.filter((k) => k.toString() !== key.toString());
    this.addresses = this.addresses.filter(
      (a) => a.toBase58() !== owner.toBase58()
    );
  }

  isOwner(owner: PublicKey): boolean {
    return this.map.get(ownerKey(owner)).toString() === '1';
  }

  getWitness(owner: PublicKey) {
    return this.map.getWitness(ownerKey(owner));
  }

  getRoot(): Field {
    return this.map.getRoot();
  }

  serialize(): string {
    return JSON.stringify({
      entries: serializeMerkleMap(this.map, this.keys),
      addresses: this.addresses.map((a) => a.toBase58()),
    });
  }

  static deserialize(json: string): OwnerStore {
    const data = JSON.parse(json);
    const store = new OwnerStore();
    const { map, keys } = deserializeMerkleMap(data.entries);
    store.map = map;
    store.keys = keys;
    store.addresses = (data.addresses as string[]).map((a) =>
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

  getCount(txHash: Field): Field {
    return this.map.get(txHash);
  }

  setCount(txHash: Field, count: Field): void {
    this.map.set(txHash, count);
    if (!this.keys.find((k) => k.toString() === txHash.toString())) {
      this.keys.push(txHash);
    }
  }

  getWitness(txHash: Field) {
    return this.map.getWitness(txHash);
  }

  isExecuted(txHash: Field): boolean {
    return this.map.get(txHash).toString() === Field(0).sub(1).toString();
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

  private nullifierKey(txHash: Field, approver: PublicKey): Field {
    return Poseidon.hash([txHash, ...approver.toFields()]);
  }

  isNullified(txHash: Field, approver: PublicKey): boolean {
    return this.map.get(this.nullifierKey(txHash, approver)).toString() === '1';
  }

  nullify(txHash: Field, approver: PublicKey): void {
    this.map.set(this.nullifierKey(txHash, approver), Field(1));
  }

  getWitness(txHash: Field, approver: PublicKey) {
    return this.map.getWitness(this.nullifierKey(txHash, approver));
  }

  getRoot(): Field {
    return this.map.getRoot();
  }
}
