import { Field, Mina, AccountUpdate, UInt64 } from 'o1js';
import { EMPTY_MERKLE_MAP_ROOT } from '../MinaGuard.js';
import { setupLocalBlockchain, deployAndSetup, type TestContext } from './test-helpers.js';
import { beforeEach, describe, expect, it } from 'bun:test';

describe('MinaGuard - Setup', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupLocalBlockchain();
  });

  it('should deploy and setup with owners and threshold', async () => {
    await deployAndSetup(ctx, 2);

    expect(ctx.zkApp.ownersRoot.get()).toEqual(ctx.ownerStore.getRoot());
    expect(ctx.zkApp.threshold.get()).toEqual(Field(2));
    expect(ctx.zkApp.numOwners.get()).toEqual(Field(3));
    expect(ctx.zkApp.proposalNonce.get()).toEqual(Field(0));
    expect(ctx.zkApp.configNonce.get()).toEqual(Field(0));
    expect(ctx.zkApp.approvalRoot.get()).toEqual(EMPTY_MERKLE_MAP_ROOT);
    expect(ctx.zkApp.voteNullifierRoot.get()).toEqual(EMPTY_MERKLE_MAP_ROOT);
  });

  it('should reject double setup', async () => {
    await deployAndSetup(ctx, 2);

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.setup(
          ctx.ownerStore.getRoot(),
          Field(2),
          Field(3),
          Field(1)
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();
    }).toThrow();
  });

  it('should reject threshold = 0', async () => {
    const { zkApp, zkAppKey, deployerKey, deployerAccount, ownerStore } = ctx;

    // Deploy only
    const deployTxn = await Mina.transaction(deployerAccount, async () => {
      AccountUpdate.fundNewAccount(deployerAccount);
      await zkApp.deploy();
    });
    await deployTxn.prove();
    await deployTxn.sign([deployerKey, zkAppKey]).send();

    await expect(async () => {
      const txn = await Mina.transaction(deployerAccount, async () => {
        await zkApp.setup(ownerStore.getRoot(), Field(0), Field(3), Field(1));
      });
      await txn.prove();
      await txn.sign([deployerKey, zkAppKey]).send();
    }).toThrow();
  });

  it('should reject numOwners < threshold', async () => {
    const { zkApp, zkAppKey, deployerKey, deployerAccount, ownerStore } = ctx;

    const deployTxn = await Mina.transaction(deployerAccount, async () => {
      AccountUpdate.fundNewAccount(deployerAccount);
      await zkApp.deploy();
    });
    await deployTxn.prove();
    await deployTxn.sign([deployerKey, zkAppKey]).send();

    await expect(async () => {
      const txn = await Mina.transaction(deployerAccount, async () => {
        await zkApp.setup(ownerStore.getRoot(), Field(5), Field(3), Field(1));
      });
      await txn.prove();
      await txn.sign([deployerKey, zkAppKey]).send();
    }).toThrow();
  });

  // TODO: fix
  it.skip('should allow wallet to receive MINA', async () => {
    await deployAndSetup(ctx, 2);

    const balanceBefore = Mina.getBalance(ctx.zkAppAddress);

    const sendTxn = await Mina.transaction(ctx.deployerAccount, async () => {
      const update = AccountUpdate.createSigned(ctx.deployerAccount);
      update.send({ to: ctx.zkAppAddress, amount: UInt64.from(1_000_000) });
    });
    await sendTxn.prove();
    await sendTxn.sign([ctx.deployerKey]).send();

    const balanceAfter = Mina.getBalance(ctx.zkAppAddress);
    expect(balanceAfter.sub(balanceBefore)).toEqual(UInt64.from(1_000_000));
  });
});
