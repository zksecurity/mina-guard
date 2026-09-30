import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { AccountUpdate, Cache, Field, Mina, Poseidon, PrivateKey, PublicKey } from 'o1js';
import { MinaGuard, SetupOwnersInput } from '../MinaGuard.js';
import { MAX_OWNERS } from '../constants.js';
import { computeOwnerChain } from '../list-commitment.js';
import {
  deployAndSetup,
  deployAndSetupChildGuard,
  setupLocalBlockchain,
  toFixedSetupOwners,
  type TestContext,
} from './test-helpers.js';

const realProofIt = process.env.RUN_REAL_PROOF_TESTS === '1' ? it : it.skip;

describe('Reserved child configuration', () => {
  let ctx: TestContext;
  let childKey: PrivateKey;
  let child: MinaGuard;

  beforeAll(async () => {
    if (process.env.RUN_REAL_PROOF_TESTS === '1') {
      await MinaGuard.compile({ cache: Cache.FileSystem('../cache') });
    }
  });

  beforeEach(async () => {
    ctx = await setupLocalBlockchain(3);
    await deployAndSetup(ctx, 2);
    childKey = PrivateKey.random();
    child = new MinaGuard(childKey.toPublicKey());
  });

  async function reserve(parent = ctx.zkAppAddress, threshold = 2, numOwners = 3) {
    return Mina.transaction(ctx.deployerAccount, async () => {
      AccountUpdate.fundNewAccount(ctx.deployerAccount);
      await child.deploy();
      await child.reserveForParent(
        parent, Field(123), Field(threshold), Field(numOwners),
        new SetupOwnersInput({ owners: toFixedSetupOwners(ctx.owners.map((o) => o.pub)) }),
      );
    });
  }

  it.each([
    [0, 3, 'Threshold must be > 0'],
    [4, 3, 'Owners must be >= threshold'],
    [1, 0, 'Owners must be >= threshold'],
    [1, MAX_OWNERS + 1, 'Too many owners'],
  ])('rejects threshold %i and owner count %i before reservation', async (threshold, count, error) => {
    await expect(reserve(ctx.zkAppAddress, threshold, count)).rejects.toThrow(error);
    expect(Mina.hasAccount(child.address)).toBe(false);
  });

  // o1js may fail while fetching the absent parent before checking constraints.
  it('rejects an empty parent', async () => {
    await expect(reserve(PublicKey.empty())).rejects.toThrow();
  });

  it('rejects self-parenting', async () => {
    await expect(reserve(child.address)).rejects.toThrow();
  });

  it('rejects an ordinary wallet as parent', async () => {
    await expect(reserve(ctx.deployerAccount)).rejects.toThrow();
    expect(Mina.hasAccount(child.address)).toBe(false);
  });

  it('rejects an uninitialized guard as parent', async () => {
    const key = PrivateKey.random();
    const parent = new MinaGuard(key.toPublicKey());
    const tx = await Mina.transaction(ctx.deployerAccount, async () => {
      AccountUpdate.fundNewAccount(ctx.deployerAccount);
      await parent.deploy();
    });
    await tx.prove();
    await tx.sign([ctx.deployerKey, key]).send();
    await expect(reserve(parent.address)).rejects.toThrow('Parent must be initialized');
  });

  it('rejects an initialized child as parent', async () => {
    const key = PrivateKey.random();
    const parent = new MinaGuard(key.toPublicKey());
    await deployAndSetupChildGuard(
      ctx, ctx.zkAppAddress, parent, key, parent.address,
      ctx.owners.map((o) => o.pub), 2, [0, 1],
    );
    await expect(reserve(parent.address)).rejects.toThrow('Parent must be a root guard');
    expect(Mina.hasAccount(child.address)).toBe(false);
  });

  it('commits a valid configuration and includes ledger-bound parent preconditions', async () => {
    const tx = await reserve();
    const json = JSON.parse(tx.toJSON());
    const parentUpdate = json.accountUpdates.find((update: any) =>
      update.body.publicKey === ctx.zkAppAddress.toBase58());
    expect(parentUpdate).toBeDefined();
    const reservationUpdate = json.accountUpdates.find((update: any) =>
      update.body.publicKey === child.address.toBase58() && update.body.authorizationKind.isProved);
    expect(parentUpdate.body.callDepth).toBe(reservationUpdate.body.callDepth + 1);
    const state = parentUpdate.body.preconditions.account.state;
    expect(state[0]).toBe(ctx.zkApp.ownersCommitment.get().toString());
    const empty = PublicKey.empty().toFields();
    expect(state[7]).toBe(empty[0].toString());
    expect(state[8]).toBe(empty[1].toString());
    await tx.prove();
    await tx.sign([ctx.deployerKey, childKey]).send();
    expect(child.reservedConfigHash.get()).toEqual(Poseidon.hash([
      computeOwnerChain(ctx.owners.map((o) => o.pub)), Field(2), Field(3),
    ]));
    expect(child.ownersCommitment.get()).toEqual(Field(0));
    await expect(async () => {
      const repeat = await Mina.transaction(ctx.deployerAccount, async () => {
        await child.reserveForParent(
          ctx.zkAppAddress, Field(123), Field(2), Field(3),
          new SetupOwnersInput({ owners: toFixedSetupOwners(ctx.owners.map((o) => o.pub)) }),
        );
      });
      await repeat.prove();
      await repeat.sign([ctx.deployerKey]).send();
    }).toThrow();
  });

  realProofIt('reserves and initializes a child with genuine proofs, consuming the reservation', async () => {
    // Parent fixture setup uses fast proofs; all child lifecycle transactions
    // below are proved and verified by the local ledger with proofs enabled.
    Mina.activeInstance.proofsEnabled = true;
    await deployAndSetupChildGuard(
      ctx, ctx.zkAppAddress, child, childKey, child.address,
      ctx.owners.map((o) => o.pub), 2, [0, 1],
    );
    expect(child.reservedConfigHash.get()).toEqual(Field(0));
    expect(child.ownersCommitment.get()).toEqual(computeOwnerChain(ctx.owners.map((o) => o.pub)));
    expect(child.parent.get()).toEqual(ctx.zkAppAddress);
    expect(child.threshold.get()).toEqual(Field(2));
  });
});
