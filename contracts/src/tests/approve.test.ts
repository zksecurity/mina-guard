import { Field, Mina, PrivateKey, Signature, UInt64, AccountUpdate } from 'o1js';
import { EXECUTED_MARKER } from '../constants.js';
import {
  setupLocalBlockchain,
  deployAndSetup,
  proposeTransaction,
  approveTransaction,
  createTransferProposal,
  makeOwnerWitness,
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
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    await approveTransaction(ctx, proposal, 1);

    expect(ctx.approvalStore.getCount(proposalHash)).toEqual(Field(3));
    expect(ctx.nullifierStore.isNullified(proposalHash, ctx.owners[1].pub)).toBe(true);
  });

  it('should allow multiple owners to approve same proposal', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    await approveTransaction(ctx, proposal, 1);
    await approveTransaction(ctx, proposal, 2);

    expect(ctx.approvalStore.getCount(proposalHash)).toEqual(Field(4));
    expect(ctx.nullifierStore.isNullified(proposalHash, ctx.owners[0].pub)).toBe(true);
    expect(ctx.nullifierStore.isNullified(proposalHash, ctx.owners[1].pub)).toBe(true);
    expect(ctx.nullifierStore.isNullified(proposalHash, ctx.owners[2].pub)).toBe(true);
  });

  it('should prevent double-voting (vote nullifier)', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0), ctx.zkAppAddress
    );
    await proposeTransaction(ctx, proposal, 0);

    // Proposer was already auto-approved in proposeTransaction().
    // Try to approve again from same owner.
    await expect(async () => {
      await approveTransaction(ctx, proposal, 0);
    }).toThrow('Vote nullifier root mismatch');
  });

  it('should reject invalid signature', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    // Sign with wrong key (owner3's key but claiming to be owner2)
    const wrongSig = Signature.create(ctx.owners[2].key, [proposalHash]);
    const ownerWitness = makeOwnerWitness(ctx.owners.map((o) => o.pub));
    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
    const nullifierWitness = ctx.nullifierStore.getWitness(proposalHash, ctx.owners[1].pub);

    await expect(async () => {
      const txn = await Mina.transaction(ctx.owners[1].pub, async () => {
        await ctx.zkApp.approveProposal(
          proposal,
          wrongSig,
          ctx.owners[1].pub,
          ownerWitness,
          approvalWitness,
          Field(2),
          nullifierWitness
        );
      });
      await txn.prove();
      await txn.sign([ctx.owners[1].key]).send();
    }).toThrow('Invalid signature');
  });

  it('should reject approval from non-owner', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    const nonOwner = PrivateKey.random();
    const sig = Signature.create(nonOwner, [proposalHash]);
    const ownerWitness = makeOwnerWitness(ctx.owners.map((o) => o.pub));
    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
    const nullifierWitness = ctx.nullifierStore.getWitness(proposalHash, nonOwner.toPublicKey());

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.approveProposal(
          proposal,
          sig,
          nonOwner.toPublicKey(),
          ownerWitness,
          approvalWitness,
          Field(2),
          nullifierWitness
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Owner membership check failed');
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
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    // Get threshold approvals and execute
    await approveTransaction(ctx, proposal, 1);

    // Execute
    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
    const executeTxn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeTransfer(proposal, approvalWitness, Field(3));
    });
    await executeTxn.prove();
    await executeTxn.sign([ctx.deployerKey]).send();

    // Mark executed in off-chain store
    ctx.approvalStore.setCount(proposalHash, EXECUTED_MARKER);

    // Try to approve after execution - should fail
    await expect(async () => {
      await approveTransaction(ctx, proposal, 2);
    }).toThrow('Proposal already executed');
  });
});
