import { Field, Mina, PrivateKey, PublicKey, UInt64 } from 'o1js';
import { Receiver } from '../MinaGuard.js';
import { Destination, EXECUTED_MARKER } from '../constants.js';
import {
  setupLocalBlockchain,
  deployAndSetup,
  deployAndSetupChildGuard,
  makeSignatureInputs,
  createAllocateChildProposal,
  createReclaimChildProposal,
  createDestroyChildProposal,
  createTogglePolicyProposal,
  createDelegateProposal,
  proposeTransaction,
  approveTransaction,
  type TestContext,
} from './test-helpers.js';
import { MinaGuard } from '../MinaGuard.js';
import { ApprovalStore, VoteNullifierStore } from '../storage.js';
import { beforeEach, describe, expect, it } from 'bun:test';

describe('MinaGuard - Child Lifecycle', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupLocalBlockchain();
    await deployAndSetup(ctx, 2);
  });

  async function deployChildGuard(parentAddress = ctx.zkAppAddress) {
    const childKey = PrivateKey.random();
    const childAddress = childKey.toPublicKey();
    const childZkApp = new MinaGuard(childAddress);

    await deployAndSetupChildGuard(
      ctx,
      parentAddress,
      childZkApp,
      childKey,
      childAddress,
      ctx.owners.map((o) => o.pub),
      2,
      [0, 1],
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

  // -- Allocate ---------------------------------------------------------------

  describe('Allocate Children', () => {
    it('should allocate MINA to a child account', async () => {
      const { childAddress } = await deployChildGuard();
      const childBalBefore = Mina.getBalance(childAddress);

      const receivers = [
        new Receiver({ address: childAddress, amount: UInt64.from(1_000_000_000) }),
      ];
      const proposal = createAllocateChildProposal(
        receivers, Field(0), Field(0), ctx.zkAppAddress
      );
      const proposalHash = proposal.hash();
      const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.allocateChildren(proposal, approvalWitness, sigs);
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();

      const childBalAfter = Mina.getBalance(childAddress);
      expect(childBalAfter.toBigInt() - childBalBefore.toBigInt()).toBe(1_000_000_000n);
    });

    it('should allocate to multiple children', async () => {
      const child1 = await deployChildGuard();
      const child2 = await deployChildGuard();

      const receivers = [
        new Receiver({ address: child1.childAddress, amount: UInt64.from(500_000_000) }),
        new Receiver({ address: child2.childAddress, amount: UInt64.from(500_000_000) }),
      ];
      const proposal = createAllocateChildProposal(
        receivers, Field(0), Field(0), ctx.zkAppAddress
      );
      const proposalHash = proposal.hash();
      const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.allocateChildren(proposal, approvalWitness, sigs);
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();

      const child1Bal = Mina.getBalance(child1.childAddress);
      const child2Bal = Mina.getBalance(child2.childAddress);
      // Children were funded with 10 MINA during setup + 0.5 MINA allocated
      expect(child1Bal.toBigInt()).toBeGreaterThanOrEqual(500_000_000n);
      expect(child2Bal.toBigInt()).toBeGreaterThanOrEqual(500_000_000n);
    });

    it('should reject allocate replay', async () => {
      const { childAddress } = await deployChildGuard();

      const receivers = [
        new Receiver({ address: childAddress, amount: UInt64.from(1_000_000_000) }),
      ];
      const proposal = createAllocateChildProposal(
        receivers, Field(0), Field(0), ctx.zkAppAddress
      );
      const proposalHash = proposal.hash();
      const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.allocateChildren(proposal, approvalWitness, sigs);
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();

      await expect(async () => {
        const replayTxn = await Mina.transaction(ctx.deployerAccount, async () => {
          await ctx.zkApp.allocateChildren(proposal, approvalWitness, sigs);
        });
        await replayTxn.prove();
        await replayTxn.sign([ctx.deployerKey]).send();
      }).toThrow();
    });
  });

  // -- Reclaim ----------------------------------------------------------------

  describe('Reclaim to Parent', () => {
    it('should reclaim MINA from child to parent', async () => {
      const { childZkApp, childAddress, childExecutionStore } = await deployChildGuard();
      const reclaimAmount = UInt64.from(1_000_000_000);

      const parentBalBefore = Mina.getBalance(ctx.zkAppAddress);

      const proposal = createReclaimChildProposal(
        reclaimAmount,
        Field(0), Field(0), ctx.zkAppAddress,
        Field(0), ctx.networkId, childAddress,
      );
      const proposalHash = proposal.hash();
      const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);
      const childExecutionWitness = childExecutionStore.getWitness(proposalHash);

      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await childZkApp.reclaimToParent(proposal, sigs, childExecutionWitness, reclaimAmount);
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();

      const parentBalAfter = Mina.getBalance(ctx.zkAppAddress);
      expect(parentBalAfter.toBigInt() - parentBalBefore.toBigInt()).toBe(1_000_000_000n);
    });

    it('should batch reclaim from multiple children in one tx', async () => {
      const child1 = await deployChildGuard();
      const child2 = await deployChildGuard();
      const reclaimAmount = UInt64.from(1_000_000_000);

      const parentBalBefore = Mina.getBalance(ctx.zkAppAddress);

      const proposal1 = createReclaimChildProposal(
        reclaimAmount,
        Field(0), Field(0), ctx.zkAppAddress,
        Field(0), ctx.networkId, child1.childAddress,
      );
      const proposal2 = createReclaimChildProposal(
        reclaimAmount,
        Field(1), Field(0), ctx.zkAppAddress,
        Field(0), ctx.networkId, child2.childAddress,
      );
      const hash1 = proposal1.hash();
      const hash2 = proposal2.hash();
      const sigs1 = makeSignatureInputs(ctx, hash1, [0, 1]);
      const sigs2 = makeSignatureInputs(ctx, hash2, [0, 1]);

      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await child1.childZkApp.reclaimToParent(
          proposal1, sigs1,
          child1.childExecutionStore.getWitness(hash1),
          reclaimAmount
        );
        await child2.childZkApp.reclaimToParent(
          proposal2, sigs2,
          child2.childExecutionStore.getWitness(hash2),
          reclaimAmount
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();

      const parentBalAfter = Mina.getBalance(ctx.zkAppAddress);
      expect(parentBalAfter.toBigInt() - parentBalBefore.toBigInt()).toBe(2_000_000_000n);
    });

    it('should reject replay on same child', async () => {
      const { childZkApp, childAddress, childExecutionStore } = await deployChildGuard();
      const reclaimAmount = UInt64.from(1_000_000_000);

      const proposal = createReclaimChildProposal(
        reclaimAmount,
        Field(0), Field(0), ctx.zkAppAddress,
        Field(0), ctx.networkId, childAddress,
      );
      const proposalHash = proposal.hash();
      const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);

      // First reclaim
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await childZkApp.reclaimToParent(
          proposal, sigs,
          childExecutionStore.getWitness(proposalHash),
          reclaimAmount
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
      childExecutionStore.setCount(proposalHash, EXECUTED_MARKER);

      // Replay should fail
      await expect(async () => {
        const replayTxn = await Mina.transaction(ctx.deployerAccount, async () => {
          await childZkApp.reclaimToParent(
            proposal, sigs,
            childExecutionStore.getWitness(proposalHash),
            reclaimAmount
          );
        });
        await replayTxn.prove();
        await replayTxn.sign([ctx.deployerKey]).send();
      }).toThrow('Child execution root mismatch');
    });

    it('should reject reclaim with wrong amount', async () => {
      const { childZkApp, childAddress, childExecutionStore } = await deployChildGuard();

      const proposal = createReclaimChildProposal(
        UInt64.from(1_000_000_000),
        Field(0), Field(0), ctx.zkAppAddress,
        Field(0), ctx.networkId, childAddress,
      );
      const proposalHash = proposal.hash();
      const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);

      await expect(async () => {
        const txn = await Mina.transaction(ctx.deployerAccount, async () => {
          await childZkApp.reclaimToParent(
            proposal, sigs,
            childExecutionStore.getWitness(proposalHash),
            UInt64.from(2_000_000_000) // wrong amount
          );
        });
        await txn.prove();
        await txn.sign([ctx.deployerKey]).send();
      }).toThrow('Data does not match reclaim amount');
    });

    it('should reject reclaim on a main account', async () => {
      const reclaimAmount = UInt64.from(1_000_000_000);
      const proposal = createReclaimChildProposal(
        reclaimAmount,
        Field(0), Field(0), ctx.zkAppAddress,
        Field(0), ctx.networkId, PublicKey.empty(),
      );
      const proposalHash = proposal.hash();
      const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);

      await expect(async () => {
        const txn = await Mina.transaction(ctx.deployerAccount, async () => {
          await ctx.zkApp.reclaimToParent(
            proposal, sigs,
            new ApprovalStore().getWitness(proposalHash),
            reclaimAmount
          );
        });
        await txn.prove();
        await txn.sign([ctx.deployerKey]).send();
      }).toThrow();
    });
  });

  // -- Destroy ----------------------------------------------------------------

  describe('Destroy Child', () => {
    it('should destroy child and return balance to parent', async () => {
      const { childZkApp, childAddress, childExecutionStore } = await deployChildGuard();

      const childBalBefore = Mina.getBalance(childAddress);
      const parentBalBefore = Mina.getBalance(ctx.zkAppAddress);

      const proposal = createDestroyChildProposal(
        Field(0), Field(0), ctx.zkAppAddress,
        Field(0), ctx.networkId, childAddress,
      );
      const proposalHash = proposal.hash();
      const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);

      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await childZkApp.destroy(
          proposal, sigs,
          childExecutionStore.getWitness(proposalHash),
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();

      const childBalAfter = Mina.getBalance(childAddress);
      const parentBalAfter = Mina.getBalance(ctx.zkAppAddress);

      expect(childBalAfter.toBigInt()).toBe(0n);
      expect(parentBalAfter.toBigInt() - parentBalBefore.toBigInt()).toBe(childBalBefore.toBigInt());
    });

    it('should disable policy after destroy', async () => {
      const { childZkApp, childKey, childAddress, childExecutionStore } = await deployChildGuard();
      const childCtx = makeChildContext(childZkApp, childKey, childAddress);

      const proposal = createDestroyChildProposal(
        Field(0), Field(0), ctx.zkAppAddress,
        Field(0), ctx.networkId, childAddress,
      );
      const proposalHash = proposal.hash();
      const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);

      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await childZkApp.destroy(
          proposal, sigs,
          childExecutionStore.getWitness(proposalHash),
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();

      // Trying to propose on destroyed child should fail
      const delegateProposal = createDelegateProposal(
        PrivateKey.random().toPublicKey(),
        Field(0), Field(0), childAddress,
      );
      await expect(async () => {
        await proposeTransaction(childCtx, delegateProposal, 0);
      }).toThrow('Independent policy disabled');
    });

    it('should reject destroy replay', async () => {
      const { childZkApp, childAddress, childExecutionStore } = await deployChildGuard();

      const proposal = createDestroyChildProposal(
        Field(0), Field(0), ctx.zkAppAddress,
        Field(0), ctx.networkId, childAddress,
      );
      const proposalHash = proposal.hash();
      const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);

      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await childZkApp.destroy(
          proposal, sigs,
          childExecutionStore.getWitness(proposalHash),
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
      childExecutionStore.setCount(proposalHash, EXECUTED_MARKER);

      await expect(async () => {
        const replayTxn = await Mina.transaction(ctx.deployerAccount, async () => {
          await childZkApp.destroy(
            proposal, sigs,
            childExecutionStore.getWitness(proposalHash),
          );
        });
        await replayTxn.prove();
        await replayTxn.sign([ctx.deployerKey]).send();
      }).toThrow('Child execution root mismatch');
    });

    it('should reject destroy on a main account', async () => {
      const proposal = createDestroyChildProposal(
        Field(0), Field(0), ctx.zkAppAddress,
        Field(0), ctx.networkId, PublicKey.empty(),
      );
      const proposalHash = proposal.hash();
      const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);

      await expect(async () => {
        const txn = await Mina.transaction(ctx.deployerAccount, async () => {
          await ctx.zkApp.destroy(
            proposal, sigs,
            new ApprovalStore().getWitness(proposalHash),
          );
        });
        await txn.prove();
        await txn.sign([ctx.deployerKey]).send();
      }).toThrow();
    });
  });

  // -- Toggle Policy ----------------------------------------------------------

  describe('Toggle Policy', () => {
    it('should disable policy on child', async () => {
      const { childZkApp, childKey, childAddress, childExecutionStore } = await deployChildGuard();
      const childCtx = makeChildContext(childZkApp, childKey, childAddress);

      const proposal = createTogglePolicyProposal(
        Field(0), // disable
        Field(0), Field(0), ctx.zkAppAddress,
        Field(0), ctx.networkId, childAddress,
      );
      const proposalHash = proposal.hash();
      const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);

      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await childZkApp.togglePolicy(
          proposal, sigs,
          childExecutionStore.getWitness(proposalHash),
          Field(0),
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
      childExecutionStore.setCount(proposalHash, EXECUTED_MARKER);

      // Child should now reject proposals
      const delegateProposal = createDelegateProposal(
        PrivateKey.random().toPublicKey(),
        Field(0), Field(0), childAddress,
      );
      await expect(async () => {
        await proposeTransaction(childCtx, delegateProposal, 0);
      }).toThrow('Independent policy disabled');
    });

    it('should re-enable policy on child', async () => {
      const { childZkApp, childKey, childAddress, childExecutionStore } = await deployChildGuard();
      const childCtx = makeChildContext(childZkApp, childKey, childAddress);

      // Disable first
      const disableProposal = createTogglePolicyProposal(
        Field(0), Field(0), Field(0), ctx.zkAppAddress,
        Field(0), ctx.networkId, childAddress,
      );
      const disableHash = disableProposal.hash();
      const disableSigs = makeSignatureInputs(ctx, disableHash, [0, 1]);

      let txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await childZkApp.togglePolicy(
          disableProposal, disableSigs,
          childExecutionStore.getWitness(disableHash),
          Field(0),
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
      childExecutionStore.setCount(disableHash, EXECUTED_MARKER);

      // Re-enable
      const enableProposal = createTogglePolicyProposal(
        Field(1), Field(1), Field(0), ctx.zkAppAddress,
        Field(0), ctx.networkId, childAddress,
      );
      const enableHash = enableProposal.hash();
      const enableSigs = makeSignatureInputs(ctx, enableHash, [0, 1]);

      txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await childZkApp.togglePolicy(
          enableProposal, enableSigs,
          childExecutionStore.getWitness(enableHash),
          Field(1),
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
      childExecutionStore.setCount(enableHash, EXECUTED_MARKER);

      // Child should accept proposals again
      const delegateProposal = createDelegateProposal(
        PrivateKey.random().toPublicKey(),
        Field(0), Field(0), childAddress,
      );
      await proposeTransaction(childCtx, delegateProposal, 0);
      // If we get here without throwing, policy is enabled
    });

    it('should reject toggle on a main account', async () => {
      const proposal = createTogglePolicyProposal(
        Field(0), Field(0), Field(0), ctx.zkAppAddress,
        Field(0), ctx.networkId, PublicKey.empty(),
      );
      const proposalHash = proposal.hash();
      const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);

      await expect(async () => {
        const txn = await Mina.transaction(ctx.deployerAccount, async () => {
          await ctx.zkApp.togglePolicy(
            proposal, sigs,
            new ApprovalStore().getWitness(proposalHash),
            Field(0),
          );
        });
        await txn.prove();
        await txn.sign([ctx.deployerKey]).send();
      }).toThrow();
    });

    it('should reject replay on same child', async () => {
      const { childZkApp, childAddress, childExecutionStore } = await deployChildGuard();

      const proposal = createTogglePolicyProposal(
        Field(0), Field(0), Field(0), ctx.zkAppAddress,
        Field(0), ctx.networkId, childAddress,
      );
      const proposalHash = proposal.hash();
      const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);

      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await childZkApp.togglePolicy(
          proposal, sigs,
          childExecutionStore.getWitness(proposalHash),
          Field(0),
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
      childExecutionStore.setCount(proposalHash, EXECUTED_MARKER);

      await expect(async () => {
        const replayTxn = await Mina.transaction(ctx.deployerAccount, async () => {
          await childZkApp.togglePolicy(
            proposal, sigs,
            childExecutionStore.getWitness(proposalHash),
            Field(0),
          );
        });
        await replayTxn.prove();
        await replayTxn.sign([ctx.deployerKey]).send();
      }).toThrow('Child execution root mismatch');
    });

    it('should reject invalid enabled value', async () => {
      const { childZkApp, childAddress, childExecutionStore } = await deployChildGuard();

      const proposal = createTogglePolicyProposal(
        Field(2), // invalid — must be 0 or 1
        Field(0), Field(0), ctx.zkAppAddress,
        Field(0), ctx.networkId, childAddress,
      );
      const proposalHash = proposal.hash();
      const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);

      await expect(async () => {
        const txn = await Mina.transaction(ctx.deployerAccount, async () => {
          await childZkApp.togglePolicy(
            proposal, sigs,
            childExecutionStore.getWitness(proposalHash),
            Field(2),
          );
        });
        await txn.prove();
        await txn.sign([ctx.deployerKey]).send();
      }).toThrow('Enabled must be 0 or 1');
    });
  });

  // -- Child Local Operations -------------------------------------------------

  describe('Child Local Operations', () => {
    it('should allow child to propose and execute locally when policy enabled', async () => {
      const { childZkApp, childKey, childAddress } = await deployChildGuard();
      const childCtx = makeChildContext(childZkApp, childKey, childAddress);
      const blockProducer = PrivateKey.random().toPublicKey();

      const proposal = createDelegateProposal(
        blockProducer,
        Field(0), Field(0), childAddress
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

    it('should block child local execute when policy disabled', async () => {
      const { childZkApp, childKey, childAddress, childExecutionStore } = await deployChildGuard();
      const childCtx = makeChildContext(childZkApp, childKey, childAddress);
      const blockProducer = PrivateKey.random().toPublicKey();

      // Propose and approve while policy is still enabled
      const proposal = createDelegateProposal(
        blockProducer,
        Field(0), Field(0), childAddress
      );
      const proposalHash = await proposeTransaction(childCtx, proposal, 0);
      await approveTransaction(childCtx, proposal, 1);

      // Disable policy
      const toggleProposal = createTogglePolicyProposal(
        Field(0), Field(0), Field(0), ctx.zkAppAddress,
        Field(0), ctx.networkId, childAddress,
      );
      const toggleHash = toggleProposal.hash();
      const toggleSigs = makeSignatureInputs(ctx, toggleHash, [0, 1]);

      const toggleTxn = await Mina.transaction(ctx.deployerAccount, async () => {
        await childZkApp.togglePolicy(
          toggleProposal, toggleSigs,
          childExecutionStore.getWitness(toggleHash),
          Field(0),
        );
      });
      await toggleTxn.prove();
      await toggleTxn.sign([ctx.deployerKey]).send();

      // Execute should fail even though proposal was approved
      await expect(async () => {
        const txn = await Mina.transaction(ctx.deployerAccount, async () => {
          await childZkApp.executeDelegate(
            proposal,
            childCtx.approvalStore.getWitness(proposalHash),
            Field(3),
            blockProducer
          );
        });
        await txn.prove();
        await txn.sign([ctx.deployerKey]).send();
      }).toThrow('Independent policy disabled');
    });
  });
});
