import { Field, Mina, PrivateKey, UInt64 } from 'o1js';
import { EXECUTED_MARKER, ownerKey } from '../MinaGuard.js';
import {
  setupLocalBlockchain,
  deployAndSetup,
  proposeTransaction,
  approveTransaction,
  createTransferProposal,
  fundAccount,
  getBalance,
  type TestContext,
  createAddOwnerProposal,
} from './test-helpers.js';
import { beforeEach, describe, expect, it } from 'bun:test';

describe('MinaGuard - Execute', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupLocalBlockchain();
    await deployAndSetup(ctx, 2);
  });

  it('should execute a transfer after threshold approvals', async () => {
    const recipientKey = PrivateKey.random();
    const recipient = recipientKey.toPublicKey();
    await fundAccount(ctx, recipient);

    const transferAmount = UInt64.from(1_000_000_000);
    const proposal = createTransferProposal(
      recipient, transferAmount, Field(0), Field(0)
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    await approveTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);

    const balanceBefore = getBalance(recipient);

    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
    const executeTxn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeTransfer(proposal, approvalWitness, Field(3));
    });
    await executeTxn.prove();
    await executeTxn.sign([ctx.deployerKey, ctx.zkAppKey]).send();

    const balanceAfter = getBalance(recipient);
    expect(balanceAfter.sub(balanceBefore)).toEqual(transferAmount);
  });

  it('should reject execution with insufficient approvals', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0)
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    // Only 1 approval (threshold = 2)
    await approveTransaction(ctx, proposal, 0);

    await expect(async () => {
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeTransfer(proposal, approvalWitness, Field(2));
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();
    }).toThrow();
  });

  it('should prevent re-execution of same proposal', async () => {
    const recipientKey = PrivateKey.random();
    const recipient = recipientKey.toPublicKey();
    await fundAccount(ctx, recipient);

    const transferAmount = UInt64.from(1_000_000_000);
    const proposal = createTransferProposal(
      recipient, transferAmount, Field(0), Field(0)
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    await approveTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);

    // Execute first time
    const approvalWitness1 = ctx.approvalStore.getWitness(proposalHash);
    const executeTxn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeTransfer(proposal, approvalWitness1, Field(3));
    });
    await executeTxn.prove();
    await executeTxn.sign([ctx.deployerKey, ctx.zkAppKey]).send();
    ctx.approvalStore.setCount(proposalHash, EXECUTED_MARKER);

    // Try to execute again
    await expect(async () => {
      const approvalWitness2 = ctx.approvalStore.getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeTransfer(proposal, approvalWitness2, Field(2));
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();
    }).toThrow();
  });

  it('should reject execution with wrong configNonce 1', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    // Create proposal with wrong configNonce
    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(99)
    );

    // Can't even propose this since configNonce mismatch happens at propose time
    await expect(async () => {
      const ownerWitness = ctx.ownerStore.getWitness(ctx.owners[0].pub);
      const approvalWitness = ctx.approvalStore.getWitness(proposal.hash());
      const txn = await Mina.transaction(ctx.owners[0].pub, async () => {
        await ctx.zkApp.propose(proposal, ownerWitness, ctx.owners[0].pub, approvalWitness);
      });
      await txn.prove();
      await txn.sign([ctx.owners[0].key, ctx.zkAppKey]).send();
    }).toThrow();
  });

  it('should reject execution with wrong configNonce 2', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    await fundAccount(ctx, recipient);

    // 1. Propose and approve a transfer with configNonce=0
    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0)
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);

    // 2. Perform a governance change (add owner) to bump configNonce to 1
    const newOwner = PrivateKey.random().toPublicKey();
    const addOwnerProposal = createAddOwnerProposal(newOwner, Field(1), Field(0));
    const govTxHash = await proposeTransaction(ctx, addOwnerProposal, 0);
    await approveTransaction(ctx, addOwnerProposal, 0);
    await approveTransaction(ctx, addOwnerProposal, 1);

    const ownerMerkleWitness = ctx.ownerStore.map.getWitness(ownerKey(newOwner));
    const govApprovalWitness = ctx.approvalStore.getWitness(govTxHash);
    const govTxn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeOwnerChange(
        addOwnerProposal, govApprovalWitness, Field(3), newOwner, ownerMerkleWitness
      );
    });
    await govTxn.prove();
    await govTxn.sign([ctx.deployerKey, ctx.zkAppKey]).send();
    ctx.ownerStore.add(newOwner);
    ctx.approvalStore.setCount(govTxHash, EXECUTED_MARKER);

    // configNonce is now 1, but the transfer proposal was created with configNonce=0
    expect(ctx.zkApp.configNonce.get()).toEqual(Field(1));

    // 3. Try to execute the old transfer proposal, should fail at execute's configNonce check
    await expect(async () => {
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeTransfer(proposal, approvalWitness, Field(3));
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();
    }).toThrow();
  });

  it('should allow anyone to trigger execution (not just owners)', async () => {
    const recipientKey = PrivateKey.random();
    const recipient = recipientKey.toPublicKey();
    await fundAccount(ctx, recipient);

    const transferAmount = UInt64.from(1_000_000_000);
    const proposal = createTransferProposal(
      recipient, transferAmount, Field(0), Field(0)
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    await approveTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);

    // Execute from deployer (not an owner)
    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
    const executeTxn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeTransfer(proposal, approvalWitness, Field(3));
    });
    await executeTxn.prove();
    await executeTxn.sign([ctx.deployerKey, ctx.zkAppKey]).send();

    const balanceAfter = getBalance(recipient);
    const received = balanceAfter.sub(UInt64.from(1_000_000));
    expect(received).toEqual(UInt64.from(1_000_000_000));
  });
});
