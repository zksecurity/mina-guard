import { Field, Mina, PrivateKey, Signature, UInt64 } from 'o1js';
import { TransactionProposal, TxType } from '../MinaGuard.js';
import {
  setupLocalBlockchain,
  deployAndSetup,
  proposeTransaction,
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

  it('should allow owner to propose and auto-approve a transfer', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient,
      UInt64.from(1_000_000_000),
      Field(0),
      Field(0),
      ctx.zkAppAddress
    );

    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    expect(ctx.zkApp.proposalNonce.get()).toEqual(Field(1));
    expect(ctx.approvalStore.getCount(proposalHash)).toEqual(Field(2));
    expect(ctx.nullifierStore.isNullified(proposalHash, ctx.owners[0].pub)).toBe(true);
  });

  it('should reject proposal from non-owner', async () => {
    const nonOwner = PrivateKey.random();
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient,
      UInt64.from(1_000_000_000),
      Field(0),
      Field(0),
      ctx.zkAppAddress
    );

    const fakeWitness = ctx.ownerStore.getWitness(nonOwner.toPublicKey());
    const signature = Signature.create(nonOwner, [proposal.hash()]);
    const nullifierWitness = ctx.nullifierStore.getWitness(
      proposal.hash(),
      nonOwner.toPublicKey()
    );
    const approvalWitness = ctx.approvalStore.getWitness(proposal.hash());

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.propose(
          proposal,
          fakeWitness,
          nonOwner.toPublicKey(),
          signature,
          nullifierWitness,
          approvalWitness
        );
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
      Field(0),
      ctx.zkAppAddress
    );

    await expect(async () => {
      const ownerWitness = ctx.ownerStore.getWitness(ctx.owners[0].pub);
      const signature = Signature.create(ctx.owners[0].key, [proposal.hash()]);
      const nullifierWitness = ctx.nullifierStore.getWitness(
        proposal.hash(),
        ctx.owners[0].pub
      );
      const approvalWitness = ctx.approvalStore.getWitness(proposal.hash());
      const txn = await Mina.transaction(ctx.owners[0].pub, async () => {
        await ctx.zkApp.propose(
          proposal,
          ownerWitness,
          ctx.owners[0].pub,
          signature,
          nullifierWitness,
          approvalWitness
        );
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
      Field(99), // wrong configNonce
      ctx.zkAppAddress
    );

    await expect(async () => {
      const ownerWitness = ctx.ownerStore.getWitness(ctx.owners[0].pub);
      const signature = Signature.create(ctx.owners[0].key, [proposal.hash()]);
      const nullifierWitness = ctx.nullifierStore.getWitness(
        proposal.hash(),
        ctx.owners[0].pub
      );
      const approvalWitness = ctx.approvalStore.getWitness(proposal.hash());
      const txn = await Mina.transaction(ctx.owners[0].pub, async () => {
        await ctx.zkApp.propose(
          proposal,
          ownerWitness,
          ctx.owners[0].pub,
          signature,
          nullifierWitness,
          approvalWitness
        );
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
      ctx.zkAppAddress,
      Field(0),
      Field(99) // wrong networkId
    );

    await expect(async () => {
      const ownerWitness = ctx.ownerStore.getWitness(ctx.owners[0].pub);
      const signature = Signature.create(ctx.owners[0].key, [proposal.hash()]);
      const nullifierWitness = ctx.nullifierStore.getWitness(
        proposal.hash(),
        ctx.owners[0].pub
      );
      const approvalWitness = ctx.approvalStore.getWitness(proposal.hash());
      const txn = await Mina.transaction(ctx.owners[0].pub, async () => {
        await ctx.zkApp.propose(
          proposal,
          ownerWitness,
          ctx.owners[0].pub,
          signature,
          nullifierWitness,
          approvalWitness
        );
      });
      await txn.prove();
      await txn.sign([ctx.owners[0].key, ctx.zkAppKey]).send();
    }).toThrow();
  });

  it('should reject proposal with wrong guardAddress', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const wrongGuard = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient,
      UInt64.from(1_000_000_000),
      Field(0),
      Field(0),
      wrongGuard
    );

    await expect(async () => {
      const ownerWitness = ctx.ownerStore.getWitness(ctx.owners[0].pub);
      const signature = Signature.create(ctx.owners[0].key, [proposal.hash()]);
      const nullifierWitness = ctx.nullifierStore.getWitness(
        proposal.hash(),
        ctx.owners[0].pub
      );
      const approvalWitness = ctx.approvalStore.getWitness(proposal.hash());
      const txn = await Mina.transaction(ctx.owners[0].pub, async () => {
        await ctx.zkApp.propose(
          proposal,
          ownerWitness,
          ctx.owners[0].pub,
          signature,
          nullifierWitness,
          approvalWitness
        );
      });
      await txn.prove();
      await txn.sign([ctx.owners[0].key, ctx.zkAppKey]).send();
    }).toThrow();
  });

  it('should increment nonce across multiple proposals', async () => {
    const recipient = PrivateKey.random().toPublicKey();

    const proposal1 = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0), ctx.zkAppAddress
    );
    await proposeTransaction(ctx, proposal1, 0);
    expect(ctx.zkApp.proposalNonce.get()).toEqual(Field(1));

    const proposal2 = createTransferProposal(
      recipient, UInt64.from(2_000_000_000), Field(1), Field(0), ctx.zkAppAddress
    );
    await proposeTransaction(ctx, proposal2, 1);
    expect(ctx.zkApp.proposalNonce.get()).toEqual(Field(2));
  });
});
