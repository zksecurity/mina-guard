import { Field, Mina, PrivateKey, Signature, UInt64 } from 'o1js';
import { TransactionProposal, TxType } from '../MinaGuard.js';
import {
  setupLocalBlockchain,
  deployAndSetup,
  proposeTransaction,
  proposeAndApproveTransaction,
  createTransferProposal,
  type TestContext,
} from './test-helpers.js';
import { beforeEach, describe, expect, it } from 'bun:test';

describe('MinaGuard - Propose', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupLocalBlockchain();
    await deployAndSetup(ctx, 2);
  });

  it('should allow owner to propose a transfer', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient,
      UInt64.from(1_000_000_000),
      Field(0),
      Field(0)
    );

    await proposeTransaction(ctx, proposal, 0);

    expect(ctx.zkApp.proposalNonce.get()).toEqual(Field(1));
  });

  it('should reject proposal from non-owner', async () => {
    const nonOwner = PrivateKey.random();
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient,
      UInt64.from(1_000_000_000),
      Field(0),
      Field(0)
    );

    const fakeWitness = ctx.ownerStore.getWitness(nonOwner.toPublicKey());

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.propose(proposal, fakeWitness, nonOwner.toPublicKey());
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();
    }).toThrow();
  });

  it('should reject proposal with wrong nonce', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient,
      UInt64.from(1_000_000_000),
      Field(5), // wrong nonce
      Field(0)
    );

    await expect(async () => {
      const ownerWitness = ctx.ownerStore.getWitness(ctx.owners[0].pub);
      const txn = await Mina.transaction(ctx.owners[0].pub, async () => {
        await ctx.zkApp.propose(proposal, ownerWitness, ctx.owners[0].pub);
      });
      await txn.prove();
      await txn.sign([ctx.owners[0].key, ctx.zkAppKey]).send();
    }).toThrow();
  });

  it('should reject proposal with wrong configNonce', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient,
      UInt64.from(1_000_000_000),
      Field(0),
      Field(99) // wrong configNonce
    );

    await expect(async () => {
      const ownerWitness = ctx.ownerStore.getWitness(ctx.owners[0].pub);
      const txn = await Mina.transaction(ctx.owners[0].pub, async () => {
        await ctx.zkApp.propose(proposal, ownerWitness, ctx.owners[0].pub);
      });
      await txn.prove();
      await txn.sign([ctx.owners[0].key, ctx.zkAppKey]).send();
    }).toThrow();
  });

  it('should reject proposal with wrong networkId', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient,
      UInt64.from(1_000_000_000),
      Field(0),
      Field(0),
      Field(0),
      Field(99) // wrong networkId
    );

    await expect(async () => {
      const ownerWitness = ctx.ownerStore.getWitness(ctx.owners[0].pub);
      const txn = await Mina.transaction(ctx.owners[0].pub, async () => {
        await ctx.zkApp.propose(proposal, ownerWitness, ctx.owners[0].pub);
      });
      await txn.prove();
      await txn.sign([ctx.owners[0].key, ctx.zkAppKey]).send();
    }).toThrow();
  });

  it('should allow proposeAndApprove', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient,
      UInt64.from(1_000_000_000),
      Field(0),
      Field(0)
    );

    const proposalHash = await proposeAndApproveTransaction(ctx, proposal, 0);

    expect(ctx.zkApp.proposalNonce.get()).toEqual(Field(1));
    // Approval count should be 1 in off-chain store
    expect(ctx.approvalStore.getCount(proposalHash)).toEqual(Field(1));
    // Nullifier should be set
    expect(ctx.nullifierStore.isNullified(proposalHash, ctx.owners[0].pub)).toBe(true);
  });

  it('should increment nonce across multiple proposals', async () => {
    const recipient = PrivateKey.random().toPublicKey();

    const proposal1 = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0)
    );
    await proposeTransaction(ctx, proposal1, 0);
    expect(ctx.zkApp.proposalNonce.get()).toEqual(Field(1));

    const proposal2 = createTransferProposal(
      recipient, UInt64.from(2_000_000_000), Field(1), Field(0)
    );
    await proposeTransaction(ctx, proposal2, 1);
    expect(ctx.zkApp.proposalNonce.get()).toEqual(Field(2));
  });
});
