import { Field, MerkleMap, PublicKey, Poseidon } from 'o1js';
import { ownerKey } from './types.js';

/**
 * Off-chain storage for MerkleMap state.
 * In production this would be backed by IPFS/Arweave/a database.
 * For MVP, this is an in-memory store that can be serialized to JSON.
 */

// ── Serialization helpers ────────────────────────────────────────────

export interface SerializedMerkleMap {
  entries: Record<string, string>; // key (Field.toString) -> value (Field.toString)
}

export function serializeMerkleMap(
  map: MerkleMap,
  keys: Field[]
): SerializedMerkleMap {
  const entries: Record<string, string> = {};
  for (const key of keys) {
    const value = map.get(key);
    entries[key.toString()] = value.toString();
  }
  return { entries };
}

export function deserializeMerkleMap(data: SerializedMerkleMap): {
  map: MerkleMap;
  keys: Field[];
} {
  const map = new MerkleMap();
  const keys: Field[] = [];
  for (const [keyStr, valueStr] of Object.entries(data.entries)) {
    const key = Field(keyStr);
    const value = Field(valueStr);
    map.set(key, value);
    keys.push(key);
  }
  return { map, keys };
}

// ── MultisigStorage: manages all off-chain MerkleMap state ──────────

export class MultisigStorage {
  owners: MerkleMap;
  ownerKeys: Field[];
  ownerAddresses: PublicKey[];

  pendingTxs: MerkleMap;
  pendingTxKeys: Field[];

  approvals: MerkleMap;
  approvalKeys: Field[];

  guards: MerkleMap;
  guardKeys: Field[];

  // Track which owners approved which tx: txId -> Set<ownerKeyString>
  approvalDetails: Map<string, Set<string>>;

  voteNullifiers: MerkleMap;

  constructor() {
    this.owners = new MerkleMap();
    this.ownerKeys = [];
    this.ownerAddresses = [];

    this.pendingTxs = new MerkleMap();
    this.pendingTxKeys = [];

    this.approvals = new MerkleMap();
    this.approvalKeys = [];

    this.guards = new MerkleMap();
    this.guardKeys = [];

    this.approvalDetails = new Map();

    this.voteNullifiers = new MerkleMap();
  }

  // ── Owner management ───────────────────────────────────────────

  addOwner(owner: PublicKey): void {
    const key = ownerKey(owner);
    this.owners.set(key, Field(1));
    this.ownerKeys.push(key);
    this.ownerAddresses.push(owner);
  }

  removeOwner(owner: PublicKey): void {
    const key = ownerKey(owner);
    this.owners.set(key, Field(0));
    this.ownerKeys = this.ownerKeys.filter((k) => k.toString() !== key.toString());
    this.ownerAddresses = this.ownerAddresses.filter(
      (a) => a.toBase58() !== owner.toBase58()
    );
  }

  isOwner(owner: PublicKey): boolean {
    const key = ownerKey(owner);
    return this.owners.get(key).toString() === '1';
  }

  getOwnerWitness(owner: PublicKey) {
    const key = ownerKey(owner);
    return this.owners.getWitness(key);
  }

  // ── Pending transactions ───────────────────────────────────────

  addPendingTx(nonce: Field, txHash: Field): void {
    this.pendingTxs.set(nonce, txHash);
    this.pendingTxKeys.push(nonce);
  }

  removePendingTx(nonce: Field): void {
    this.pendingTxs.set(nonce, Field(0));
    this.pendingTxKeys = this.pendingTxKeys.filter(
      (k) => k.toString() !== nonce.toString()
    );
  }

  getPendingTxWitness(nonce: Field) {
    return this.pendingTxs.getWitness(nonce);
  }

  // ── Approvals ──────────────────────────────────────────────────

  getApprovalCount(txId: Field): Field {
    return this.approvals.get(txId);
  }

  setApprovalCount(txId: Field, count: Field): void {
    this.approvals.set(txId, count);
    if (!this.approvalKeys.find((k) => k.toString() === txId.toString())) {
      this.approvalKeys.push(txId);
    }
  }

  getApprovalWitness(txId: Field) {
    return this.approvals.getWitness(txId);
  }

  recordApproval(txId: Field, owner: PublicKey): boolean {
    const txIdStr = txId.toString();
    const ownerStr = owner.toBase58();

    if (!this.approvalDetails.has(txIdStr)) {
      this.approvalDetails.set(txIdStr, new Set());
    }
    const approvers = this.approvalDetails.get(txIdStr)!;
    if (approvers.has(ownerStr)) return false; // already approved
    approvers.add(ownerStr);
    return true;
  }

  hasApproved(txId: Field, owner: PublicKey): boolean {
    const txIdStr = txId.toString();
    const ownerStr = owner.toBase58();
    return this.approvalDetails.get(txIdStr)?.has(ownerStr) ?? false;
  }

  getApprovers(txId: Field): string[] {
    return Array.from(this.approvalDetails.get(txId.toString()) ?? []);
  }

  // ── Nullifiers ─────────────────────────────────────────────────────
  initVoteNullifier(nullifier: Field) {
    this.voteNullifiers.set(nullifier, Field(0));
  }

  storeVoteNullifier(nullifier: Field) {
    this.voteNullifiers.set(nullifier, Field(1));
  }

  getVoteNullifierWitness(nullifier: Field) {
    return this.voteNullifiers.getWitness(nullifier);
  }

  isVoteNullified(nullifier: Field) {
    return this.voteNullifiers.get(nullifier).equals(Field(1));
  }

  // ── Guards ─────────────────────────────────────────────────────

  addGuard(guardHash: Field): void {
    this.guards.set(guardHash, Field(1));
    this.guardKeys.push(guardHash);
  }

  getGuardWitness(guardHash: Field) {
    return this.guards.getWitness(guardHash);
  }

  // ── Serialization ──────────────────────────────────────────────

  serialize(): string {
    return JSON.stringify({
      owners: serializeMerkleMap(this.owners, this.ownerKeys),
      ownerAddresses: this.ownerAddresses.map((a) => a.toBase58()),
      pendingTxs: serializeMerkleMap(this.pendingTxs, this.pendingTxKeys),
      approvals: serializeMerkleMap(this.approvals, this.approvalKeys),
      guards: serializeMerkleMap(this.guards, this.guardKeys),
      approvalDetails: Object.fromEntries(
        Array.from(this.approvalDetails.entries()).map(([k, v]) => [
          k,
          Array.from(v),
        ])
      ),
    });
  }

  static deserialize(json: string): MultisigStorage {
    const data = JSON.parse(json);
    const storage = new MultisigStorage();

    const ownersData = deserializeMerkleMap(data.owners);
    storage.owners = ownersData.map;
    storage.ownerKeys = ownersData.keys;
    storage.ownerAddresses = (data.ownerAddresses as string[]).map((a) =>
      PublicKey.fromBase58(a)
    );

    const pendingData = deserializeMerkleMap(data.pendingTxs);
    storage.pendingTxs = pendingData.map;
    storage.pendingTxKeys = pendingData.keys;

    const approvalsData = deserializeMerkleMap(data.approvals);
    storage.approvals = approvalsData.map;
    storage.approvalKeys = approvalsData.keys;

    const guardsData = deserializeMerkleMap(data.guards);
    storage.guards = guardsData.map;
    storage.guardKeys = guardsData.keys;

    storage.approvalDetails = new Map(
      Object.entries(data.approvalDetails as Record<string, string[]>).map(
        ([k, v]) => [k, new Set(v)]
      )
    );

    return storage;
  }
}
