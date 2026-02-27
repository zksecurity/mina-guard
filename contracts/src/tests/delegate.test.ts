import { Field, Mina, PrivateKey, UInt64 } from 'o1js';
import { ownerKey } from '../MinaGuard.js';
import {
  setupLocalBlockchain,
  deployAndSetup,
  proposeTransaction,
  approveTransaction,
  createDelegateProposal,
  createUndelegateProposal,
  type TestContext,
} from './test-helpers.js';
import { beforeEach, describe, expect, it } from 'bun:test';

describe('MinaGuard - Delegate', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupLocalBlockchain();
    await deployAndSetup(ctx, 2);
  });

  it('should delegate to a block producer via multisig', async () => {
    const blockProducer = PrivateKey.random().toPublicKey();

    const proposal = createDelegateProposal(blockProducer, Field(0), Field(0));
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    await approveTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);

    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
    const txn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeDelegate(
        proposal,
        approvalWitness,
        Field(2),
        blockProducer
      );
    });
    await txn.prove();
    await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();

    // Verify delegate was set
    const delegate = Mina.getAccount(ctx.zkAppAddress).delegate;
    expect(delegate).toBeDefined();
    expect(delegate!.equals(blockProducer).toBoolean()).toBe(true);
  });

  it('should un-delegate (delegate to self) via multisig', async () => {
    // First delegate to someone
    const blockProducer = PrivateKey.random().toPublicKey();
    const proposal1 = createDelegateProposal(blockProducer, Field(0), Field(0));
    const proposalHash1 = await proposeTransaction(ctx, proposal1, 0);
    await approveTransaction(ctx, proposal1, 0);
    await approveTransaction(ctx, proposal1, 1);

    const approvalWitness1 = ctx.approvalStore.getWitness(proposalHash1);
    const txn1 = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeDelegate(
        proposal1,
        approvalWitness1,
        Field(2),
        blockProducer
      );
    });
    await txn1.prove();
    await txn1.sign([ctx.deployerKey, ctx.zkAppKey]).send();

    // Mark executed in off-chain store
    const { EXECUTED_SENTINEL } = await import('../MinaGuard.js');
    ctx.approvalStore.setCount(proposalHash1, EXECUTED_SENTINEL);

    // Now un-delegate
    const proposal2 = createUndelegateProposal(Field(1), Field(0));
    const proposalHash2 = await proposeTransaction(ctx, proposal2, 0);
    await approveTransaction(ctx, proposal2, 0);
    await approveTransaction(ctx, proposal2, 1);

    const approvalWitness2 = ctx.approvalStore.getWitness(proposalHash2);
    // Pass any PublicKey for delegate param — contract ignores it for un-delegation
    const dummyDelegate = PrivateKey.random().toPublicKey();
    const txn2 = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeDelegate(
        proposal2,
        approvalWitness2,
        Field(2),
        dummyDelegate
      );
    });
    await txn2.prove();
    await txn2.sign([ctx.deployerKey, ctx.zkAppKey]).send();

    // Verify delegate was set back to self
    const delegate = Mina.getAccount(ctx.zkAppAddress).delegate;
    expect(delegate).toBeDefined();
    expect(delegate!.equals(ctx.zkAppAddress).toBoolean()).toBe(true);
  });

  it('should reject delegation with insufficient approvals', async () => {
    const blockProducer = PrivateKey.random().toPublicKey();
    const proposal = createDelegateProposal(blockProducer, Field(0), Field(0));
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    // Only 1 approval (threshold = 2)
    await approveTransaction(ctx, proposal, 0);

    await expect(async () => {
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeDelegate(
          proposal,
          approvalWitness,
          Field(1),
          blockProducer
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();
    }).toThrow();
  });

  it('should reject if proposal data does not match delegate pubkey', async () => {
    const blockProducer = PrivateKey.random().toPublicKey();
    const wrongDelegate = PrivateKey.random().toPublicKey();

    const proposal = createDelegateProposal(blockProducer, Field(0), Field(0));
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    await approveTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);

    // Pass a different delegate than what's in the proposal data
    await expect(async () => {
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeDelegate(
          proposal,
          approvalWitness,
          Field(2),
          wrongDelegate
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();
    }).toThrow();
  });
});
