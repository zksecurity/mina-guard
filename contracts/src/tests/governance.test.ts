import { Field, Mina, PrivateKey, Signature, UInt64, PublicKey, Bool } from 'o1js';
import { EXECUTED_MARKER } from '../constants.js';
import { TransactionProposal } from '../MinaGuard.js';
import { TxType } from '../constants.js';
import { ownerKey } from '../utils.js';
import {
  setupLocalBlockchain,
  deployAndSetup,
  proposeTransaction,
  approveTransaction,
  createAddOwnerProposal,
  createRemoveOwnerProposal,
  createThresholdProposal,
  makeOwnerWitness,
  getOwnersCommitment,
  type TestContext,
} from './test-helpers.js';
import { PublicKeyOption, computeOwnerChain } from '../list-commitment.js';
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

      const ownerWitness = makeOwnerWitness(ctx.owners.map((o) => o.pub));
      const lastOwner = ctx.owners[ctx.owners.length - 1].pub;
      const insertAfter = new PublicKeyOption({ value: lastOwner, isSome: Bool(true) });
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeOwnerChange(
          proposal,
          approvalWitness,
          Field(3),
          newOwner,
          ownerWitness,
          insertAfter
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();

      expect(ctx.zkApp.numOwners.get()).toEqual(Field(4));

      // Verify commitment matches expected
      const expectedCommitment = computeOwnerChain([...ctx.owners.map((o) => o.pub), newOwner]);
      expect(ctx.zkApp.ownersCommitment.get()).toEqual(expectedCommitment);
    });

    it('should reject adding an already-existing owner', async () => {
      const existingOwner = ctx.owners[1].pub;

      const proposal = createAddOwnerProposal(existingOwner, Field(0), Field(0), ctx.zkAppAddress);
      const proposalHash = await proposeTransaction(ctx, proposal, 0);
      await approveTransaction(ctx, proposal, 1);

      const ownerWitness = makeOwnerWitness(ctx.owners.map((o) => o.pub));
      const lastOwner = ctx.owners[ctx.owners.length - 1].pub;
      const insertAfter = new PublicKeyOption({ value: lastOwner, isSome: Bool(true) });
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

      await expect(async () => {
        const txn = await Mina.transaction(ctx.deployerAccount, async () => {
          await ctx.zkApp.executeOwnerChange(
            proposal,
            approvalWitness,
            Field(3),
            existingOwner,
            ownerWitness,
            insertAfter
          );
        });
        await txn.prove();
        await txn.sign([ctx.deployerKey]).send();
      }).toThrow('Owner change not valid');
    });

    it('should reject unproposed owner change with approvalCount = 0', async () => {
      const newOwner = PrivateKey.random().toPublicKey();
      const proposal = createAddOwnerProposal(newOwner, Field(0), Field(0), ctx.zkAppAddress);
      const proposalHash = proposal.hash();
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const ownerWitness = makeOwnerWitness(ctx.owners.map((o) => o.pub));
      const commitmentBefore = ctx.zkApp.ownersCommitment.get();
      const numOwnersBefore = ctx.zkApp.numOwners.get();

      await expect(async () => {
        const txn = await Mina.transaction(ctx.deployerAccount, async () => {
          await ctx.zkApp.executeOwnerChange(
            proposal, approvalWitness, Field(0), newOwner, ownerWitness, PublicKeyOption.none()
          );
        });
        await txn.prove();
        await txn.sign([ctx.deployerKey]).send();
      }).toThrow('Proposal not found');

      expect(ctx.zkApp.ownersCommitment.get()).toEqual(commitmentBefore);
      expect(ctx.zkApp.numOwners.get()).toEqual(numOwnersBefore);
    });

    it('should increment configNonce after adding owner', async () => {
      const newOwner = PrivateKey.random().toPublicKey();

      const proposal = createAddOwnerProposal(newOwner, Field(0), Field(0), ctx.zkAppAddress);
      const proposalHash = await proposeTransaction(ctx, proposal, 0);
      await approveTransaction(ctx, proposal, 1);

      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const ownerWitness = makeOwnerWitness(ctx.owners.map((o) => o.pub));
      const lastOwner = ctx.owners[ctx.owners.length - 1].pub;
      const insertAfter = new PublicKeyOption({ value: lastOwner, isSome: Bool(true) });

      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeOwnerChange(
          proposal, approvalWitness, Field(3), newOwner, ownerWitness, insertAfter
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();

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

      const ownerWitness = makeOwnerWitness(ctx.owners.map((o) => o.pub));
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeOwnerChange(
          proposal,
          approvalWitness,
          Field(3),
          ownerToRemove,
          ownerWitness,
          PublicKeyOption.none()
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();

      expect(ctx.zkApp.numOwners.get()).toEqual(Field(2));

      // Verify commitment matches expected (owners[0], owners[1])
      const expectedCommitment = computeOwnerChain([ctx.owners[0].pub, ctx.owners[1].pub]);
      expect(ctx.zkApp.ownersCommitment.get()).toEqual(expectedCommitment);
    });

    it('should reject removal if it would go below threshold', async () => {
      // First remove one owner (3 -> 2, threshold = 2, ok)
      const ownerToRemove1 = ctx.owners[2].pub;
      const proposal1 = createRemoveOwnerProposal(ownerToRemove1, Field(0), Field(0), ctx.zkAppAddress);
      const proposalHash1 = await proposeTransaction(ctx, proposal1, 0);
      await approveTransaction(ctx, proposal1, 1);

      const ownerWitness1 = makeOwnerWitness(ctx.owners.map((o) => o.pub));
      const approvalWitness1 = ctx.approvalStore.getWitness(proposalHash1);
      const txn1 = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeOwnerChange(
          proposal1, approvalWitness1, Field(3), ownerToRemove1, ownerWitness1, PublicKeyOption.none()
        );
      });
      await txn1.prove();
      await txn1.sign([ctx.deployerKey]).send();
      // Update off-chain owners list
      ctx.owners.splice(2, 1);
      ctx.approvalStore.setCount(proposalHash1, EXECUTED_MARKER);

      // Now try to remove another (2 -> 1, threshold = 2, should fail)
      const ownerToRemove2 = ctx.owners[1].pub;
      const proposal2 = createRemoveOwnerProposal(
        ownerToRemove2, Field(1), Field(1), ctx.zkAppAddress // configNonce is now 1
      );
      const proposalHash2 = await proposeTransaction(ctx, proposal2, 0);
      await approveTransaction(ctx, proposal2, 1);

      const ownerWitness2 = makeOwnerWitness(ctx.owners.map((o) => o.pub));
      const approvalWitness2 = ctx.approvalStore.getWitness(proposalHash2);

      await expect(async () => {
        const txn2 = await Mina.transaction(ctx.deployerAccount, async () => {
          await ctx.zkApp.executeOwnerChange(
            proposal2, approvalWitness2, Field(3), ownerToRemove2, ownerWitness2, PublicKeyOption.none()
          );
        });
        await txn2.prove();
        await txn2.sign([ctx.deployerKey]).send();
      }).toThrow('Cannot remove: would go below threshold');
    });

    it('should reject removing a non-existent owner', async () => {
      const nonOwner = PrivateKey.random().toPublicKey();

      const proposal = createRemoveOwnerProposal(nonOwner, Field(0), Field(0), ctx.zkAppAddress);
      const proposalHash = await proposeTransaction(ctx, proposal, 0);
      await approveTransaction(ctx, proposal, 1);

      const ownerWitness = makeOwnerWitness(ctx.owners.map((o) => o.pub));
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

      await expect(async () => {
        const txn = await Mina.transaction(ctx.deployerAccount, async () => {
          await ctx.zkApp.executeOwnerChange(
            proposal, approvalWitness, Field(3), nonOwner, ownerWitness, PublicKeyOption.none()
          );
        });
        await txn.prove();
        await txn.sign([ctx.deployerKey]).send();
      }).toThrow('Owner change not valid');
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
      await txn.sign([ctx.deployerKey]).send();

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
        await txn.sign([ctx.deployerKey]).send();
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
        await txn.sign([ctx.deployerKey]).send();
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
        await txn.sign([ctx.deployerKey]).send();
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
      await txn.sign([ctx.deployerKey]).send();

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
      await txn1.sign([ctx.deployerKey]).send();
      ctx.approvalStore.setCount(proposalHash1, EXECUTED_MARKER);

      // Now try to propose with old configNonce (0) - should fail
      const recipient = PrivateKey.random().toPublicKey();
      const oldProposal = new TransactionProposal({
        to: recipient,
        amount: UInt64.from(1_000_000_000),
        tokenId: Field(0),
        txType: TxType.TRANSFER,
        data: Field(0),
        uid: Field(1),
        configNonce: Field(0), // old configNonce
        expiryBlock: Field(0),
        networkId: Field(1),
        guardAddress: ctx.zkAppAddress,
      });

      await expect(async () => {
        const ownerWitness = makeOwnerWitness(ctx.owners.map((o) => o.pub));
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
        await txn.sign([ctx.owners[0].key]).send();
      }).toThrow('Config nonce mismatch');
    });
  });
});
