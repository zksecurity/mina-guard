import { expect, test } from 'bun:test';
import { Field, MerkleMap } from 'o1js';
import { isStoreStateMismatch } from '../lib/preflight-flow';

test('recognizes real verified-store assertion errors without treating other failures as lag', async () => {
  const previousDomain = process.env.MINA_NETWORK_DOMAIN;
  process.env.MINA_NETWORK_DOMAIN ??= process.env.NEXT_PUBLIC_MINA_NETWORK ?? 'testnet';
  const { assertStoresMatchChain, assertChildExecutionMapMatchesChain, rebuildStores } = await import('contracts');
  if (previousDomain === undefined) delete process.env.MINA_NETWORK_DOMAIN;
  else process.env.MINA_NETWORK_DOMAIN = previousDomain;
  const stores = rebuildStores([]);
  for (const state of [{ ownersCommitment: Field(1) }, { approvalRoot: Field(1) }, { voteNullifierRoot: Field(1) }]) {
    let failure: unknown;
    try { assertStoresMatchChain(stores, state); } catch (error) { failure = error; }
    expect(isStoreStateMismatch(failure)).toBe(true);
  }
  let childFailure: unknown;
  try { assertChildExecutionMapMatchesChain(new MerkleMap(), Field(1)); } catch (error) { childFailure = error; }
  expect(isStoreStateMismatch(childFailure)).toBe(true);
  for (const message of ['Network unavailable', 'Approval root mismatch', 'Invalid checkpoint owners', 'Store reconstruction failed']) {
    expect(isStoreStateMismatch(new Error(message))).toBe(false);
  }
});
