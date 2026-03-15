import { Field, Mina, PrivateKey, Signature, UInt64, Bool } from 'o1js';
import { EXECUTED_MARKER } from '../constants.js';
import {
  setupLocalBlockchain,
  deployAndSetup,
  proposeTransaction,
  approveTransaction,
  createDelegateProposal,
  createUndelegateProposal,
  createTransferProposal,
  makeSignatureInputs,
  type TestContext,
} from './test-helpers.js';
import { SignatureInput, SignatureOption } from '../batch-verify.js';
import { beforeEach, describe, expect, it } from 'bun:test';

describe('MinaGuard - Delegate', { timeout: 60_000 }, () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupLocalBlockchain();
    await deployAndSetup(ctx, 2);
  });

  it('should delegate to a block producer via multisig', async () => {
    const blockProducer = PrivateKey.random().toPublicKey();

    const proposal = createDelegateProposal(blockProducer, Field(0), Field(0), ctx.zkAppAddress);
    const proposalHash = await proposeTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);

    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
    const txn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeDelegate(
        proposal,
        approvalWitness,
        Field(3),
        blockProducer
      );
    });
    await txn.prove();
    await txn.sign([ctx.deployerKey]).send();

    // Verify delegate was set
    const delegate = Mina.getAccount(ctx.zkAppAddress).delegate;
    expect(delegate).toBeDefined();
    expect(delegate!.equals(blockProducer).toBoolean()).toBe(true);
  });

  it('should un-delegate (delegate to self) via multisig', { timeout: 60_000 }, async () => {
    // First delegate to someone
    const blockProducer = PrivateKey.random().toPublicKey();
    const proposal1 = createDelegateProposal(blockProducer, Field(0), Field(0), ctx.zkAppAddress);
    const proposalHash1 = await proposeTransaction(ctx, proposal1, 0);
    await approveTransaction(ctx, proposal1, 1);

    const approvalWitness1 = ctx.approvalStore.getWitness(proposalHash1);
    const txn1 = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeDelegate(
        proposal1,
        approvalWitness1,
        Field(3),
        blockProducer
      );
    });
    await txn1.prove();
    await txn1.sign([ctx.deployerKey]).send();

    // Mark executed in off-chain store
    const { EXECUTED_MARKER } = await import('../constants.js');
    ctx.approvalStore.setCount(proposalHash1, EXECUTED_MARKER);

    // Now un-delegate
    const proposal2 = createUndelegateProposal(Field(1), Field(0), ctx.zkAppAddress);
    const proposalHash2 = await proposeTransaction(ctx, proposal2, 0);
    await approveTransaction(ctx, proposal2, 1);

    const approvalWitness2 = ctx.approvalStore.getWitness(proposalHash2);
    // Pass any PublicKey for delegate param - contract ignores it for un-delegation
    const dummyDelegate = PrivateKey.random().toPublicKey();
    const txn2 = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeDelegate(
        proposal2,
        approvalWitness2,
        Field(3),
        dummyDelegate
      );
    });
    await txn2.prove();
    await txn2.sign([ctx.deployerKey]).send();

    // Verify delegate was set back to self
    const delegate = Mina.getAccount(ctx.zkAppAddress).delegate;
    expect(delegate).toBeDefined();
    expect(delegate!.equals(ctx.zkAppAddress).toBoolean()).toBe(true);
  });

  it('should reject delegation with insufficient approvals', async () => {
    const blockProducer = PrivateKey.random().toPublicKey();
    const proposal = createDelegateProposal(blockProducer, Field(0), Field(0), ctx.zkAppAddress);
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    // Only proposer approval exists (threshold = 2)

    await expect(async () => {
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
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Insufficient approvals');
  });

  it('should reject unproposed delegate execution with approvalCount = 0', async () => {
    const blockProducer = PrivateKey.random().toPublicKey();
    const proposal = createDelegateProposal(
      blockProducer, Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = proposal.hash();
    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
    const delegateBefore = Mina.getAccount(ctx.zkAppAddress).delegate;

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeDelegate(
          proposal,
          approvalWitness,
          Field(0),
          blockProducer
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Proposal not found');

    const delegateAfter = Mina.getAccount(ctx.zkAppAddress).delegate;
    expect(delegateAfter).toEqual(delegateBefore);
  });

  it('should reject if proposal data does not match delegate pubkey', async () => {
    const blockProducer = PrivateKey.random().toPublicKey();
    const wrongDelegate = PrivateKey.random().toPublicKey();

    const proposal = createDelegateProposal(blockProducer, Field(0), Field(0), ctx.zkAppAddress);
    const proposalHash = await proposeTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);

    // Pass a different delegate than what's in the proposal data
    await expect(async () => {
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeDelegate(
          proposal,
          approvalWitness,
          Field(3),
          wrongDelegate
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Data does not match delegate');
  });
});

// -- Delegate BatchSig Tests -------------------------------------------------

describe('MinaGuard - Delegate BatchSig', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupLocalBlockchain();
    await deployAndSetup(ctx, 2);
  });

  it('should delegate to a block producer with batch signatures', async () => {
    const blockProducer = PrivateKey.random().toPublicKey();

    const proposal = createDelegateProposal(blockProducer, Field(0), Field(0), ctx.zkAppAddress);
    const proposalHash = proposal.hash();

    const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);
    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

    const txn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeDelegateBatchSig(
        proposal, approvalWitness, sigs, blockProducer
      );
    });
    await txn.prove();
    await txn.sign([ctx.deployerKey]).send();

    const delegate = Mina.getAccount(ctx.zkAppAddress).delegate;
    expect(delegate).toBeDefined();
    expect(delegate!.equals(blockProducer).toBoolean()).toBe(true);
  });

  it('should un-delegate (delegate to self) with batch signatures', async () => {
    // First delegate to someone
    const blockProducer = PrivateKey.random().toPublicKey();
    const proposal1 = createDelegateProposal(blockProducer, Field(0), Field(0), ctx.zkAppAddress);
    const proposalHash1 = proposal1.hash();

    const sigs1 = makeSignatureInputs(ctx, proposalHash1, [0, 1]);
    const approvalWitness1 = ctx.approvalStore.getWitness(proposalHash1);

    const txn1 = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeDelegateBatchSig(
        proposal1, approvalWitness1, sigs1, blockProducer
      );
    });
    await txn1.prove();
    await txn1.sign([ctx.deployerKey]).send();
    ctx.approvalStore.setCount(proposalHash1, EXECUTED_MARKER);

    // Now un-delegate
    const proposal2 = createUndelegateProposal(Field(1), Field(0), ctx.zkAppAddress);
    const proposalHash2 = proposal2.hash();

    const sigs2 = makeSignatureInputs(ctx, proposalHash2, [0, 1]);
    const approvalWitness2 = ctx.approvalStore.getWitness(proposalHash2);
    const dummyDelegate = PrivateKey.random().toPublicKey();

    const txn2 = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeDelegateBatchSig(
        proposal2, approvalWitness2, sigs2, dummyDelegate
      );
    });
    await txn2.prove();
    await txn2.sign([ctx.deployerKey]).send();

    const delegate = Mina.getAccount(ctx.zkAppAddress).delegate;
    expect(delegate).toBeDefined();
    expect(delegate!.equals(ctx.zkAppAddress).toBoolean()).toBe(true);
  });

  it('should reject with insufficient approvals', async () => {
    const blockProducer = PrivateKey.random().toPublicKey();
    const proposal = createDelegateProposal(blockProducer, Field(0), Field(0), ctx.zkAppAddress);
    const proposalHash = proposal.hash();

    const sigs = makeSignatureInputs(ctx, proposalHash, [0]); // only 1 sig, threshold=2
    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeDelegateBatchSig(
          proposal, approvalWitness, sigs, blockProducer
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Insufficient approvals');
  });

  it('should reject if proposal data does not match delegate pubkey', async () => {
    const blockProducer = PrivateKey.random().toPublicKey();
    const wrongDelegate = PrivateKey.random().toPublicKey();

    const proposal = createDelegateProposal(blockProducer, Field(0), Field(0), ctx.zkAppAddress);
    const proposalHash = proposal.hash();

    const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);
    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeDelegateBatchSig(
          proposal, approvalWitness, sigs, wrongDelegate
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Data does not match delegate');
  });

  it('should prevent re-execution', async () => {
    const blockProducer = PrivateKey.random().toPublicKey();
    const proposal = createDelegateProposal(blockProducer, Field(0), Field(0), ctx.zkAppAddress);
    const proposalHash = proposal.hash();

    const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);

    // Execute first time
    const approvalWitness1 = ctx.approvalStore.getWitness(proposalHash);
    const txn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeDelegateBatchSig(
        proposal, approvalWitness1, sigs, blockProducer
      );
    });
    await txn.prove();
    await txn.sign([ctx.deployerKey]).send();
    ctx.approvalStore.setCount(proposalHash, EXECUTED_MARKER);

    // Try to execute again
    await expect(async () => {
      const approvalWitness2 = ctx.approvalStore.getWitness(proposalHash);
      const txn2 = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeDelegateBatchSig(
          proposal, approvalWitness2, sigs, blockProducer
        );
      });
      await txn2.prove();
      await txn2.sign([ctx.deployerKey]).send();
    }).toThrow('Approval root mismatch');
  });

  it('should increment proposalCounter', async () => {
    const counterBefore = ctx.zkApp.proposalCounter.get();
    const blockProducer = PrivateKey.random().toPublicKey();

    const proposal = createDelegateProposal(blockProducer, Field(0), Field(0), ctx.zkAppAddress);
    const proposalHash = proposal.hash();

    const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);
    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

    const txn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeDelegateBatchSig(
        proposal, approvalWitness, sigs, blockProducer
      );
    });
    await txn.prove();
    await txn.sign([ctx.deployerKey]).send();

    expect(ctx.zkApp.proposalCounter.get()).toEqual(counterBefore.add(1));
  });

  it('should reject with invalid signature in batch', async () => {
    const blockProducer = PrivateKey.random().toPublicKey();
    const proposal = createDelegateProposal(blockProducer, Field(0), Field(0), ctx.zkAppAddress);
    const proposalHash = proposal.hash();

    const sigs = makeSignatureInputs(ctx, proposalHash, [0]); // only owner 0 signs validly
    const wrongKey = PrivateKey.random();
    const wrongSig = Signature.create(wrongKey, [proposalHash]);
    sigs[1] = new SignatureInput({
      value: {
        signature: new SignatureOption({ value: wrongSig, isSome: Bool(true) }),
        signer: ctx.owners[1].pub,
      },
      isSome: Bool(true),
    });

    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeDelegateBatchSig(
          proposal, approvalWitness, sigs, blockProducer
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Insufficient approvals');
  });

  it('should reject with wrong configNonce', async () => {
    const blockProducer = PrivateKey.random().toPublicKey();
    const proposal = createDelegateProposal(blockProducer, Field(0), Field(99), ctx.zkAppAddress);
    const proposalHash = proposal.hash();

    const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);
    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeDelegateBatchSig(
          proposal, approvalWitness, sigs, blockProducer
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Config nonce mismatch');
  });

  it('should reject wrong txType', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = proposal.hash();

    const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);
    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeDelegateBatchSig(
          proposal, approvalWitness, sigs, recipient
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Not a delegate tx');
  });
});
