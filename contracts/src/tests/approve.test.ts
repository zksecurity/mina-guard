import { Field, Mina, PrivateKey, Signature, UInt64, AccountUpdate } from 'o1js';
import { EXECUTED_SENTINEL } from '../MinaGuard.js';
import {
  setupLocalBlockchain,
  deployAndSetup,
  proposeTransaction,
  approveTransaction,
  createTransferProposal,
  type TestContext,
} from './test-helpers.js';
import { beforeEach, describe, expect, it } from 'bun:test';

describe('MinaGuard - Approve', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupLocalBlockchain();
    await deployAndSetup(ctx, 2);
  });

  it('should allow owner to approve with valid signature', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0)
    );
    const txHash = await proposeTransaction(ctx, proposal, 0);

    await approveTransaction(ctx, proposal, 0);

    expect(ctx.approvalStore.getCount(txHash)).toEqual(Field(1));
    expect(ctx.nullifierStore.isNullified(txHash, ctx.owners[0].pub)).toBe(true);
  });

  it('should allow multiple owners to approve same proposal', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0)
    );
    const txHash = await proposeTransaction(ctx, proposal, 0);

    await approveTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);

    expect(ctx.approvalStore.getCount(txHash)).toEqual(Field(2));
    expect(ctx.nullifierStore.isNullified(txHash, ctx.owners[0].pub)).toBe(true);
    expect(ctx.nullifierStore.isNullified(txHash, ctx.owners[1].pub)).toBe(true);
  });

  it('should prevent double-voting (vote nullifier)', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0)
    );
    await proposeTransaction(ctx, proposal, 0);

    await approveTransaction(ctx, proposal, 0);

    // Try to approve again from same owner
    await expect(async () => {
      await approveTransaction(ctx, proposal, 0);
    }).toThrow();
  });

  it('should reject invalid signature', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0)
    );
    const txHash = await proposeTransaction(ctx, proposal, 0);

    // Sign with wrong key (owner2's key but claiming to be owner1)
    const wrongSig = Signature.create(ctx.owners[1].key, [txHash]);
    const ownerWitness = ctx.ownerStore.getWitness(ctx.owners[0].pub);
    const approvalWitness = ctx.approvalStore.getWitness(txHash);
    const nullifierWitness = ctx.nullifierStore.getWitness(txHash, ctx.owners[0].pub);

    await expect(async () => {
      const txn = await Mina.transaction(ctx.owners[0].pub, async () => {
        await ctx.zkApp.approveTx(
          proposal,
          wrongSig,
          ctx.owners[0].pub,
          ownerWitness,
          approvalWitness,
          Field(0),
          nullifierWitness
        );
      });
      await txn.prove();
      await txn.sign([ctx.owners[0].key, ctx.zkAppKey]).send();
    }).toThrow();
  });

  it('should reject approval from non-owner', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0)
    );
    const txHash = await proposeTransaction(ctx, proposal, 0);

    const nonOwner = PrivateKey.random();
    const sig = Signature.create(nonOwner, [txHash]);
    const fakeWitness = ctx.ownerStore.getWitness(nonOwner.toPublicKey());
    const approvalWitness = ctx.approvalStore.getWitness(txHash);
    const nullifierWitness = ctx.nullifierStore.getWitness(txHash, nonOwner.toPublicKey());

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.approveTx(
          proposal,
          sig,
          nonOwner.toPublicKey(),
          fakeWitness,
          approvalWitness,
          Field(0),
          nullifierWitness
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();
    }).toThrow();
  });

  it('should reject approval on executed proposal', async () => {
    const recipientKey = PrivateKey.random();
    const recipient = recipientKey.toPublicKey();

    // Fund recipient account first
    const fundTxn = await Mina.transaction(ctx.deployerAccount, async () => {
      AccountUpdate.fundNewAccount(ctx.deployerAccount);
      const update = AccountUpdate.createSigned(ctx.deployerAccount);
      update.send({ to: recipient, amount: UInt64.from(1_000_000) });
    });
    await fundTxn.prove();
    await fundTxn.sign([ctx.deployerKey]).send();

    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0)
    );
    const txHash = await proposeTransaction(ctx, proposal, 0);

    // Get 2 approvals and execute
    await approveTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);

    // Execute
    const approvalWitness = ctx.approvalStore.getWitness(txHash);
    const executeTxn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.execute(proposal, approvalWitness, Field(2));
    });
    await executeTxn.prove();
    await executeTxn.sign([ctx.deployerKey, ctx.zkAppKey]).send();

    // Mark executed in off-chain store
    ctx.approvalStore.setCount(txHash, EXECUTED_SENTINEL);

    // Try to approve after execution - should fail
    await expect(async () => {
      await approveTransaction(ctx, proposal, 2);
    }).toThrow();
  });
});
