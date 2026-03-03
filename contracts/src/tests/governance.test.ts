import { Field, Mina, PrivateKey, Signature, UInt64, PublicKey } from 'o1js';
import { EXECUTED_MARKER, ownerKey, TransactionProposal, TxType } from '../MinaGuard.js';
import {
  setupLocalBlockchain,
  deployAndSetup,
  proposeTransaction,
  approveTransaction,
  createAddOwnerProposal,
  createRemoveOwnerProposal,
  createThresholdProposal,
  type TestContext,
} from './test-helpers.js';
import { beforeEach, describe, expect, it } from 'bun:test';

describe('MinaGuard - Governance', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupLocalBlockchain();
    await deployAndSetup(ctx, 2);
  });

  // -- Add Owner -----------------------------------------------------------

  describe('addOwner', () => {
    it('should add a new owner via multisig', async () => {
      const newOwnerKey = PrivateKey.random();
      const newOwner = newOwnerKey.toPublicKey();

      const proposal = createAddOwnerProposal(newOwner, Field(0), Field(0), ctx.zkAppAddress);
      const proposalHash = await proposeTransaction(ctx, proposal, 0);
      await approveTransaction(ctx, proposal, 1);

      const newOwnerMerkleWitness = ctx.ownerStore.map.getWitness(
        ownerKey(newOwner)
      );
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeOwnerChange(
          proposal,
          approvalWitness,
          Field(3),
          newOwner,
          newOwnerMerkleWitness
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();

      expect(ctx.zkApp.numOwners.get()).toEqual(Field(4));

      // Update off-chain and verify root matches
      ctx.ownerStore.add(newOwner);
      expect(ctx.zkApp.ownersRoot.get()).toEqual(ctx.ownerStore.getRoot());
    });

    it('should reject adding an already-existing owner', async () => {
      const existingOwner = ctx.owners[1].pub;

      const proposal = createAddOwnerProposal(existingOwner, Field(0), Field(0), ctx.zkAppAddress);
      const proposalHash = await proposeTransaction(ctx, proposal, 0);
      await approveTransaction(ctx, proposal, 1);

      const ownerMerkleWitness = ctx.ownerStore.map.getWitness(
        ownerKey(existingOwner)
      );
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

      await expect(async () => {
        const txn = await Mina.transaction(ctx.deployerAccount, async () => {
          await ctx.zkApp.executeOwnerChange(
            proposal,
            approvalWitness,
            Field(3),
            existingOwner,
            ownerMerkleWitness
          );
        });
        await txn.prove();
        await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();
      }).toThrow('Owner root mismatch');
    });

    it('should reject unproposed owner change with approvalCount = 0', async () => {
      const newOwner = PrivateKey.random().toPublicKey();
      const proposal = createAddOwnerProposal(newOwner, Field(0), Field(0), ctx.zkAppAddress);
      const proposalHash = proposal.hash();
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const ownerWitness = ctx.ownerStore.map.getWitness(ownerKey(newOwner));
      const ownersRootBefore = ctx.zkApp.ownersRoot.get();
      const numOwnersBefore = ctx.zkApp.numOwners.get();

      await expect(async () => {
        const txn = await Mina.transaction(ctx.deployerAccount, async () => {
          await ctx.zkApp.executeOwnerChange(
            proposal, approvalWitness, Field(0), newOwner, ownerWitness
          );
        });
        await txn.prove();
        await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();
      }).toThrow('Proposal not found');

      expect(ctx.zkApp.ownersRoot.get()).toEqual(ownersRootBefore);
      expect(ctx.zkApp.numOwners.get()).toEqual(numOwnersBefore);
    });

    it('should increment configNonce after adding owner', async () => {
      const newOwner = PrivateKey.random().toPublicKey();

      const proposal = createAddOwnerProposal(newOwner, Field(0), Field(0), ctx.zkAppAddress);
      const proposalHash = await proposeTransaction(ctx, proposal, 0);
      await approveTransaction(ctx, proposal, 1);

      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const ownerMerkleWitness = ctx.ownerStore.map.getWitness(ownerKey(newOwner));

      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeOwnerChange(
          proposal, approvalWitness, Field(3), newOwner, ownerMerkleWitness
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();

      expect(ctx.zkApp.configNonce.get()).toEqual(Field(1));
    });
  });

  // -- Remove Owner --------------------------------------------------------

  describe('removeOwner', () => {
    it('should remove an owner via multisig', async () => {
      const ownerToRemove = ctx.owners[2].pub;

      const proposal = createRemoveOwnerProposal(ownerToRemove, Field(0), Field(0), ctx.zkAppAddress);
      const proposalHash = await proposeTransaction(ctx, proposal, 0);
      await approveTransaction(ctx, proposal, 1);

      const ownerMerkleWitness = ctx.ownerStore.map.getWitness(
        ownerKey(ownerToRemove)
      );
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeOwnerChange(
          proposal,
          approvalWitness,
          Field(3),
          ownerToRemove,
          ownerMerkleWitness
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();

      expect(ctx.zkApp.numOwners.get()).toEqual(Field(2));

      // Update off-chain and verify root
      ctx.ownerStore.remove(ownerToRemove);
      expect(ctx.zkApp.ownersRoot.get()).toEqual(ctx.ownerStore.getRoot());
    });

    it('should reject removal if it would go below threshold', async () => {
      // First remove one owner (3 -> 2, threshold = 2, ok)
      const ownerToRemove1 = ctx.owners[2].pub;
      const proposal1 = createRemoveOwnerProposal(ownerToRemove1, Field(0), Field(0), ctx.zkAppAddress);
      const proposalHash1 = await proposeTransaction(ctx, proposal1, 0);
      await approveTransaction(ctx, proposal1, 1);

      const ownerWitness1 = ctx.ownerStore.map.getWitness(ownerKey(ownerToRemove1));
      const approvalWitness1 = ctx.approvalStore.getWitness(proposalHash1);
      const txn1 = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeOwnerChange(
          proposal1, approvalWitness1, Field(3), ownerToRemove1, ownerWitness1
        );
      });
      await txn1.prove();
      await txn1.sign([ctx.deployerKey, ctx.zkAppKey]).send();
      ctx.ownerStore.remove(ownerToRemove1);
      ctx.approvalStore.setCount(proposalHash1, EXECUTED_MARKER);

      // Now try to remove another (2 -> 1, threshold = 2, should fail)
      const ownerToRemove2 = ctx.owners[1].pub;
      const proposal2 = createRemoveOwnerProposal(
        ownerToRemove2, Field(1), Field(1), ctx.zkAppAddress // configNonce is now 1
      );
      const proposalHash2 = await proposeTransaction(ctx, proposal2, 0);
      await approveTransaction(ctx, proposal2, 1);

      const ownerWitness2 = ctx.ownerStore.map.getWitness(ownerKey(ownerToRemove2));
      const approvalWitness2 = ctx.approvalStore.getWitness(proposalHash2);

      await expect(async () => {
        const txn2 = await Mina.transaction(ctx.deployerAccount, async () => {
          await ctx.zkApp.executeOwnerChange(
            proposal2, approvalWitness2, Field(3), ownerToRemove2, ownerWitness2
          );
        });
        await txn2.prove();
        await txn2.sign([ctx.deployerKey, ctx.zkAppKey]).send();
      }).toThrow('Cannot remove: would go below threshold');
    });

    it('should reject removing a non-existent owner', async () => {
      const nonOwner = PrivateKey.random().toPublicKey();

      const proposal = createRemoveOwnerProposal(nonOwner, Field(0), Field(0), ctx.zkAppAddress);
      const proposalHash = await proposeTransaction(ctx, proposal, 0);
      await approveTransaction(ctx, proposal, 1);

      const ownerMerkleWitness = ctx.ownerStore.map.getWitness(ownerKey(nonOwner));
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

      await expect(async () => {
        const txn = await Mina.transaction(ctx.deployerAccount, async () => {
          await ctx.zkApp.executeOwnerChange(
            proposal, approvalWitness, Field(3), nonOwner, ownerMerkleWitness
          );
        });
        await txn.prove();
        await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();
      }).toThrow('Owner root mismatch');
    });
  });

  // -- Change Threshold ----------------------------------------------------

  describe('changeThreshold', () => {
    it('should change threshold via multisig', async () => {
      const newThreshold = Field(3);
      const proposal = createThresholdProposal(newThreshold, Field(0), Field(0), ctx.zkAppAddress);
      const proposalHash = await proposeTransaction(ctx, proposal, 0);
      await approveTransaction(ctx, proposal, 1);

      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeThresholdChange(
          proposal, approvalWitness, Field(3), newThreshold
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();

      expect(ctx.zkApp.threshold.get()).toEqual(Field(3));
    });

    it('should reject threshold = 0', async () => {
      const newThreshold = Field(0);
      const proposal = createThresholdProposal(newThreshold, Field(0), Field(0), ctx.zkAppAddress);
      const proposalHash = await proposeTransaction(ctx, proposal, 0);
      await approveTransaction(ctx, proposal, 1);

      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

      await expect(async () => {
        const txn = await Mina.transaction(ctx.deployerAccount, async () => {
          await ctx.zkApp.executeThresholdChange(
            proposal, approvalWitness, Field(3), newThreshold
          );
        });
        await txn.prove();
        await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();
      }).toThrow('Threshold must be > 0');
    });

    it('should reject unproposed threshold change with approvalCount = 0', async () => {
      const newThreshold = Field(1);
      const proposal = createThresholdProposal(newThreshold, Field(0), Field(0), ctx.zkAppAddress);
      const proposalHash = proposal.hash();
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const thresholdBefore = ctx.zkApp.threshold.get();

      await expect(async () => {
        const txn = await Mina.transaction(ctx.deployerAccount, async () => {
          await ctx.zkApp.executeThresholdChange(
            proposal, approvalWitness, Field(0), newThreshold
          );
        });
        await txn.prove();
        await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();
      }).toThrow('Proposal not found');

      expect(ctx.zkApp.threshold.get()).toEqual(thresholdBefore);
    });

    it('should reject threshold above numOwners', async () => {
      const newThreshold = Field(10); // Only 3 owners
      const proposal = createThresholdProposal(newThreshold, Field(0), Field(0), ctx.zkAppAddress);
      const proposalHash = await proposeTransaction(ctx, proposal, 0);
      await approveTransaction(ctx, proposal, 1);

      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

      await expect(async () => {
        const txn = await Mina.transaction(ctx.deployerAccount, async () => {
          await ctx.zkApp.executeThresholdChange(
            proposal, approvalWitness, Field(3), newThreshold
          );
        });
        await txn.prove();
        await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();
      }).toThrow('Threshold cannot exceed owner count');
    });

    it('should increment configNonce after threshold change', async () => {
      const newThreshold = Field(1);
      const proposal = createThresholdProposal(newThreshold, Field(0), Field(0), ctx.zkAppAddress);
      const proposalHash = await proposeTransaction(ctx, proposal, 0);
      await approveTransaction(ctx, proposal, 1);

      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeThresholdChange(
          proposal, approvalWitness, Field(3), newThreshold
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();

      expect(ctx.zkApp.configNonce.get()).toEqual(Field(1));
    });

    it('should invalidate old proposals after governance change', async () => {
      // Change threshold first (configNonce goes to 1)
      const newThreshold = Field(1);
      const thresholdProposal = createThresholdProposal(newThreshold, Field(0), Field(0), ctx.zkAppAddress);
      const proposalHash1 = await proposeTransaction(ctx, thresholdProposal, 0);
      await approveTransaction(ctx, thresholdProposal, 1);

      const approvalWitness1 = ctx.approvalStore.getWitness(proposalHash1);
      const txn1 = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeThresholdChange(
          thresholdProposal, approvalWitness1, Field(3), newThreshold
        );
      });
      await txn1.prove();
      await txn1.sign([ctx.deployerKey, ctx.zkAppKey]).send();
      ctx.approvalStore.setCount(proposalHash1, EXECUTED_MARKER);

      // Now try to propose with old configNonce (0) - should fail
      const recipient = PrivateKey.random().toPublicKey();
      const oldProposal = new TransactionProposal({
        to: recipient,
        amount: UInt64.from(1_000_000_000),
        tokenId: Field(0),
        txType: TxType.TRANSFER,
        data: Field(0),
        nonce: Field(1),
        configNonce: Field(0), // old configNonce
        expiryBlock: Field(0),
        networkId: Field(1),
        guardAddress: ctx.zkAppAddress,
      });

      await expect(async () => {
        const ownerWitness = ctx.ownerStore.getWitness(ctx.owners[0].pub);
        const sig = Signature.create(ctx.owners[0].key, [oldProposal.hash()]);
        const nullifierWitness = ctx.nullifierStore.getWitness(
          oldProposal.hash(),
          ctx.owners[0].pub
        );
        const approvalWitness = ctx.approvalStore.getWitness(oldProposal.hash());
        const txn = await Mina.transaction(ctx.owners[0].pub, async () => {
          await ctx.zkApp.propose(
            oldProposal,
            ownerWitness,
            ctx.owners[0].pub,
            sig,
            nullifierWitness,
            approvalWitness
          );
        });
        await txn.prove();
        await txn.sign([ctx.owners[0].key, ctx.zkAppKey]).send();
      }).toThrow('Config nonce mismatch');
    });
  });
});
