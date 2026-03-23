import { Field, Mina, PrivateKey, PublicKey, Signature, UInt64, Bool } from 'o1js';
import { Receiver } from '../MinaGuard.js';
import { EXECUTED_MARKER, ExecutionMode } from '../constants.js';
import {
  setupLocalBlockchain,
  deployAndSetup,
  deployAndSetupGuard,
  proposeTransaction,
  approveTransaction,
  createDelegateProposal,
  createUndelegateProposal,
  createTransferProposal,
  makeSignatureInputs,
  type TestContext,
} from './test-helpers.js';
import { SignatureInput, SignatureOption } from '../batch-verify.js';
import { MinaGuard } from '../MinaGuard.js';
import { ApprovalStore, VoteNullifierStore } from '../storage.js';
import { beforeEach, describe, expect, it } from 'bun:test';

describe('MinaGuard - Delegate', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupLocalBlockchain();
    await deployAndSetup(ctx, 2);
  });

  async function deployChildGuard(parentAddress = ctx.zkAppAddress) {
    const childKey = PrivateKey.random();
    const childAddress = childKey.toPublicKey();
    const childZkApp = new MinaGuard(childAddress);

    await deployAndSetupGuard(
      ctx.deployerAccount,
      ctx.deployerKey,
      childZkApp,
      childKey,
      childAddress,
      ctx.owners.map((o) => o.pub),
      ctx.networkId,
      2,
      parentAddress
    );

    return {
      childZkApp,
      childKey,
      childAddress,
      childExecutionStore: new ApprovalStore(),
    };
  }

  function makeChildContext(
    childZkApp: MinaGuard,
    childKey: PrivateKey,
    childAddress: PublicKey
  ): TestContext {
    return {
      ...ctx,
      zkApp: childZkApp,
      zkAppKey: childKey,
      zkAppAddress: childAddress,
      approvalStore: new ApprovalStore(),
      nullifierStore: new VoteNullifierStore(),
    };
  }

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

  it('should un-delegate (delegate to self) via multisig', async () => {
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

  it('should execute delegate on a specific child via parent approvals', async () => {
    const { childZkApp, childAddress, childExecutionStore } =
      await deployChildGuard();
    const blockProducer = PrivateKey.random().toPublicKey();

    const proposal = createDelegateProposal(
      blockProducer,
      Field(0),
      Field(0),
      ctx.zkAppAddress,
      Field(0),
      ctx.networkId,
      childAddress,
      ExecutionMode.CHILD
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);

    const parentApprovalWitness = ctx.approvalStore.getWitness(proposalHash);
    const childExecutionWitness = childExecutionStore.getWitness(proposalHash);
    const txn = await Mina.transaction(ctx.deployerAccount, async () => {
      await childZkApp.child_executeDelegate(
        proposal,
        parentApprovalWitness,
        Field(3),
        childExecutionWitness,
        blockProducer
      );
    });
    await txn.prove();
    await txn.sign([ctx.deployerKey]).send();
    childExecutionStore.setCount(proposalHash, Field(1));

    const childDelegate = Mina.getAccount(childAddress).delegate;
    expect(childDelegate).toBeDefined();
    expect(childDelegate!.equals(blockProducer).toBoolean()).toBe(true);
  });

  it('should reject a specifically targeted child proposal on a different child', async () => {
    const { childZkApp } = await deployChildGuard();
    const otherChildAddress = PrivateKey.random().toPublicKey();
    const blockProducer = PrivateKey.random().toPublicKey();

    const proposal = createDelegateProposal(
      blockProducer,
      Field(0),
      Field(0),
      ctx.zkAppAddress,
      Field(0),
      ctx.networkId,
      otherChildAddress,
      ExecutionMode.CHILD
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);

    await expect(async () => {
      const parentApprovalWitness = ctx.approvalStore.getWitness(proposalHash);
      const childExecutionWitness = new ApprovalStore().getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await childZkApp.child_executeDelegate(
          proposal,
          parentApprovalWitness,
          Field(3),
          childExecutionWitness,
          blockProducer
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Proposal not for this child');
  });

  it('should allow wildcard child proposals to execute once per linked child', async () => {
    const childOne = await deployChildGuard();
    const childTwo = await deployChildGuard();
    const blockProducer = PrivateKey.random().toPublicKey();

    const proposal = createDelegateProposal(
      blockProducer,
      Field(0),
      Field(0),
      ctx.zkAppAddress,
      Field(0),
      ctx.networkId,
      PublicKey.empty(),
      ExecutionMode.CHILD
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);

    const parentApprovalWitness = ctx.approvalStore.getWitness(proposalHash);

    const childOneTxn = await Mina.transaction(ctx.deployerAccount, async () => {
      await childOne.childZkApp.child_executeDelegate(
        proposal,
        parentApprovalWitness,
        Field(3),
        childOne.childExecutionStore.getWitness(proposalHash),
        blockProducer
      );
    });
    await childOneTxn.prove();
    await childOneTxn.sign([ctx.deployerKey]).send();
    childOne.childExecutionStore.setCount(proposalHash, Field(1));

    const childTwoTxn = await Mina.transaction(ctx.deployerAccount, async () => {
      await childTwo.childZkApp.child_executeDelegate(
        proposal,
        parentApprovalWitness,
        Field(3),
        childTwo.childExecutionStore.getWitness(proposalHash),
        blockProducer
      );
    });
    await childTwoTxn.prove();
    await childTwoTxn.sign([ctx.deployerKey]).send();
    childTwo.childExecutionStore.setCount(proposalHash, Field(1));

    const childOneDelegate = Mina.getAccount(childOne.childAddress).delegate;
    const childTwoDelegate = Mina.getAccount(childTwo.childAddress).delegate;
    expect(childOneDelegate).toBeDefined();
    expect(childTwoDelegate).toBeDefined();
    expect(childOneDelegate!.equals(blockProducer).toBoolean()).toBe(true);
    expect(childTwoDelegate!.equals(blockProducer).toBoolean()).toBe(true);
  });

  it('should reject replaying a wildcard child proposal on the same child', async () => {
    const { childZkApp, childAddress, childExecutionStore } =
      await deployChildGuard();
    const blockProducer = PrivateKey.random().toPublicKey();

    const proposal = createDelegateProposal(
      blockProducer,
      Field(0),
      Field(0),
      ctx.zkAppAddress,
      Field(0),
      ctx.networkId,
      PublicKey.empty(),
      ExecutionMode.CHILD
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);

    const parentApprovalWitness = ctx.approvalStore.getWitness(proposalHash);
    const firstTxn = await Mina.transaction(ctx.deployerAccount, async () => {
      await childZkApp.child_executeDelegate(
        proposal,
        parentApprovalWitness,
        Field(3),
        childExecutionStore.getWitness(proposalHash),
        blockProducer
      );
    });
    await firstTxn.prove();
    await firstTxn.sign([ctx.deployerKey]).send();
    childExecutionStore.setCount(proposalHash, Field(1));

    await expect(async () => {
      const replayTxn = await Mina.transaction(ctx.deployerAccount, async () => {
        await childZkApp.child_executeDelegate(
          proposal,
          parentApprovalWitness,
          Field(3),
          childExecutionStore.getWitness(proposalHash),
          blockProducer
        );
      });
      await replayTxn.prove();
      await replayTxn.sign([ctx.deployerKey]).send();
    }).toThrow('Child execution root mismatch');

    const childDelegate = Mina.getAccount(childAddress).delegate;
    expect(childDelegate).toBeDefined();
    expect(childDelegate!.equals(blockProducer).toBoolean()).toBe(true);
  });

  it('should reject child execution on a main account', async () => {
    const blockProducer = PrivateKey.random().toPublicKey();
    const proposal = createDelegateProposal(
      blockProducer,
      Field(0),
      Field(0),
      ctx.zkAppAddress,
      Field(0),
      ctx.networkId,
      PublicKey.empty(),
      ExecutionMode.CHILD
    );
    const proposalHash = proposal.hash();

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.child_executeDelegate(
          proposal,
          ctx.approvalStore.getWitness(proposalHash),
          Field(0),
          new ApprovalStore().getWitness(proposalHash),
          blockProducer
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Not a child account');
  });

  it('should reject child execution when guardAddress does not match the parent', async () => {
    const { childZkApp } = await deployChildGuard();
    const blockProducer = PrivateKey.random().toPublicKey();
    const wrongParent = PrivateKey.random().toPublicKey();
    const proposal = createDelegateProposal(
      blockProducer,
      Field(0),
      Field(0),
      wrongParent,
      Field(0),
      ctx.networkId,
      PublicKey.empty(),
      ExecutionMode.CHILD
    );
    const proposalHash = proposal.hash();

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await childZkApp.child_executeDelegate(
          proposal,
          ctx.approvalStore.getWitness(proposalHash),
          Field(0),
          new ApprovalStore().getWitness(proposalHash),
          blockProducer
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow();
  });

  it('should allow a child to execute a local proposal with its own approvals', async () => {
    const { childZkApp, childKey, childAddress } = await deployChildGuard();
    const childCtx = makeChildContext(childZkApp, childKey, childAddress);
    const blockProducer = PrivateKey.random().toPublicKey();

    const proposal = createDelegateProposal(
      blockProducer,
      Field(0),
      Field(0),
      childAddress
    );
    const proposalHash = await proposeTransaction(childCtx, proposal, 0);
    await approveTransaction(childCtx, proposal, 1);

    const approvalWitness = childCtx.approvalStore.getWitness(proposalHash);
    const txn = await Mina.transaction(ctx.deployerAccount, async () => {
      await childZkApp.executeDelegate(
        proposal,
        approvalWitness,
        Field(3),
        blockProducer
      );
    });
    await txn.prove();
    await txn.sign([ctx.deployerKey]).send();

    const childDelegate = Mina.getAccount(childAddress).delegate;
    expect(childDelegate).toBeDefined();
    expect(childDelegate!.equals(blockProducer).toBoolean()).toBe(true);
  });

  it('should reject child-routed proposals through local execute paths', async () => {
    const { childZkApp, childAddress } = await deployChildGuard();
    const blockProducer = PrivateKey.random().toPublicKey();

    const proposal = createDelegateProposal(
      blockProducer,
      Field(0),
      Field(0),
      ctx.zkAppAddress,
      Field(0),
      ctx.networkId,
      childAddress,
      ExecutionMode.CHILD
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeDelegate(
          proposal,
          ctx.approvalStore.getWitness(proposalHash),
          Field(3),
          blockProducer
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Not a local execution proposal');

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await childZkApp.executeDelegate(
          proposal,
          new ApprovalStore().getWitness(proposalHash),
          Field(0),
          blockProducer
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Not a local execution proposal');
  });

  it('should reject proposing a child-routed proposal on a child account', async () => {
    const { childZkApp, childKey, childAddress } = await deployChildGuard();
    const childCtx = makeChildContext(childZkApp, childKey, childAddress);
    const blockProducer = PrivateKey.random().toPublicKey();

    const proposal = createDelegateProposal(
      blockProducer,
      Field(0),
      Field(0),
      childAddress,
      Field(0),
      ctx.networkId,
      PublicKey.empty(),
      ExecutionMode.CHILD
    );

    await expect(async () => {
      await proposeTransaction(childCtx, proposal, 0);
    }).toThrow('Child-routed proposals must be stored on a parent guard');
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
    sigs.inputs[1] = new SignatureInput({
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
      [new Receiver({ address: recipient, amount: UInt64.from(1_000_000_000) })], Field(0), Field(0), ctx.zkAppAddress
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
