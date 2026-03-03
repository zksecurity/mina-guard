import { Field, Mina, PrivateKey, Signature, UInt64 } from 'o1js';
import { EXECUTED_MARKER } from '../MinaGuard.js';
import { ownerKey } from '../utils.js';
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
import { BatchVerifySigsProof, BatchVerifyInput, BatchVerifyOutput } from '../BatchVerifyProgram.js';
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
      recipient, transferAmount, Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    await approveTransaction(ctx, proposal, 1);

    const balanceBefore = getBalance(recipient);

    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
    const executeTxn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeTransfer(proposal, approvalWitness, Field(3));
    });
    await executeTxn.prove();
    await executeTxn.sign([ctx.deployerKey]).send();

    const balanceAfter = getBalance(recipient);
    expect(balanceAfter.sub(balanceBefore)).toEqual(transferAmount);
  });

  it('should reject execution with insufficient approvals', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    // Only proposer approval exists (threshold = 2)

    await expect(async () => {
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeTransfer(proposal, approvalWitness, Field(2));
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Insufficient approvals');
  });

  it('should reject unproposed transfer execution with approvalCount = 0', async () => {
    const recipientKey = PrivateKey.random();
    const recipient = recipientKey.toPublicKey();
    await fundAccount(ctx, recipient);

    const transferAmount = UInt64.from(1_000_000_000);
    const proposal = createTransferProposal(
      recipient, transferAmount, Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = proposal.hash();
    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
    const balanceBefore = getBalance(recipient);

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeTransfer(proposal, approvalWitness, Field(0));
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Proposal not found');

    const balanceAfter = getBalance(recipient);
    expect(balanceAfter.sub(balanceBefore)).toEqual(UInt64.from(0));
  });

  it('should prevent re-execution of same proposal', async () => {
    const recipientKey = PrivateKey.random();
    const recipient = recipientKey.toPublicKey();
    await fundAccount(ctx, recipient);

    const transferAmount = UInt64.from(1_000_000_000);
    const proposal = createTransferProposal(
      recipient, transferAmount, Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    await approveTransaction(ctx, proposal, 1);

    // Execute first time
    const approvalWitness1 = ctx.approvalStore.getWitness(proposalHash);
    const executeTxn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeTransfer(proposal, approvalWitness1, Field(3));
    });
    await executeTxn.prove();
    await executeTxn.sign([ctx.deployerKey]).send();
    ctx.approvalStore.setCount(proposalHash, EXECUTED_MARKER);

    // Try to execute again
    await expect(async () => {
      const approvalWitness2 = ctx.approvalStore.getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeTransfer(proposal, approvalWitness2, Field(10));
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow("Approval root mismatch");

    await expect(async () => {
      const approvalWitness2 = ctx.approvalStore.getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeTransfer(proposal, approvalWitness2, EXECUTED_MARKER);
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow("Proposal already executed");
  });

  it('should reject execution with wrong configNonce 1', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    // Create proposal with wrong configNonce
    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(99), ctx.zkAppAddress
    );

    // Can't even propose this since configNonce mismatch happens at propose time
    await expect(async () => {
      const ownerWitness = ctx.ownerStore.getWitness(ctx.owners[0].pub);
      const sig = Signature.create(ctx.owners[0].key, [proposal.hash()]);
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
          sig,
          nullifierWitness,
          approvalWitness
        );
      });
      await txn.prove();
      await txn.sign([ctx.owners[0].key]).send();
    }).toThrow('Config nonce mismatch');
  });

  it('should reject execution with wrong configNonce 2', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    await fundAccount(ctx, recipient);

    // 1. Propose and approve a transfer with configNonce=0
    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);

    // 2. Perform a governance change (add owner) to bump configNonce to 1
    const newOwner = PrivateKey.random().toPublicKey();
    const addOwnerProposal = createAddOwnerProposal(newOwner, Field(1), Field(0), ctx.zkAppAddress);
    const govTxHash = await proposeTransaction(ctx, addOwnerProposal, 0);
    await approveTransaction(ctx, addOwnerProposal, 1);

    const ownerMerkleWitness = ctx.ownerStore.map.getWitness(ownerKey(newOwner));
    const govApprovalWitness = ctx.approvalStore.getWitness(govTxHash);
    const govTxn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeOwnerChange(
        addOwnerProposal, govApprovalWitness, Field(3), newOwner, ownerMerkleWitness
      );
    });
    await govTxn.prove();
    await govTxn.sign([ctx.deployerKey]).send();
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
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Config nonce mismatch - governance changed since proposal');
  });

  it('should allow anyone to trigger execution (not just owners)', async () => {
    const recipientKey = PrivateKey.random();
    const recipient = recipientKey.toPublicKey();
    await fundAccount(ctx, recipient);

    const transferAmount = UInt64.from(1_000_000_000);
    const proposal = createTransferProposal(
      recipient, transferAmount, Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    await approveTransaction(ctx, proposal, 1);

    // Execute from deployer (not an owner)
    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
    const executeTxn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeTransfer(proposal, approvalWitness, Field(3));
    });
    await executeTxn.prove();
    await executeTxn.sign([ctx.deployerKey]).send();

    const balanceAfter = getBalance(recipient);
    const received = balanceAfter.sub(UInt64.from(1_000_000));
    expect(received).toEqual(UInt64.from(1_000_000_000));
  });
});

describe('MinaGuard - Execute Transfer BatchSig', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupLocalBlockchain();
    await deployAndSetup(ctx, 2);
  });

  async function makeDummyProof(proposalHash: Field, ownersRoot: Field, approvalCount: Field) {
    return await BatchVerifySigsProof.dummy(
      new BatchVerifyInput({ proposalHash, ownersRoot }),
      new BatchVerifyOutput({ approvalCount, approverHash: Field(0) }),
      1
    );
  }

  it('should execute transfer with valid batch proof', async () => {
    const recipientKey = PrivateKey.random();
    const recipient = recipientKey.toPublicKey();
    await fundAccount(ctx, recipient);

    const transferAmount = UInt64.from(1_000_000_000);
    const proposal = createTransferProposal(
      recipient, transferAmount, Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    const balanceBefore = getBalance(recipient);

    const ownersRoot = ctx.ownerStore.getRoot();
    const dummyProof = await makeDummyProof(proposalHash, ownersRoot, Field(2));

    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
    const txn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeTransferBatchSig(proposal, approvalWitness, dummyProof);
    });
    await txn.prove();
    await txn.sign([ctx.deployerKey]).send();

    const balanceAfter = getBalance(recipient);
    expect(balanceAfter.sub(balanceBefore)).toEqual(transferAmount);
  });

  it('should reject with insufficient approvals in proof', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    const ownersRoot = ctx.ownerStore.getRoot();
    const dummyProof = await makeDummyProof(proposalHash, ownersRoot, Field(1));

    await expect(async () => {
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeTransferBatchSig(proposal, approvalWitness, dummyProof);
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Insufficient approvals');
  });

  it('should reject with wrong proposal hash in proof', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0), ctx.zkAppAddress
    );
    await proposeTransaction(ctx, proposal, 0);

    const ownersRoot = ctx.ownerStore.getRoot();
    const wrongHash = Field(999);
    const dummyProof = await makeDummyProof(wrongHash, ownersRoot, Field(2));

    await expect(async () => {
      const proposalHash = proposal.hash();
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeTransferBatchSig(proposal, approvalWitness, dummyProof);
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow();
  });

  it('should reject with wrong owners root in proof', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    const wrongOwnersRoot = Field(12345);
    const dummyProof = await makeDummyProof(proposalHash, wrongOwnersRoot, Field(2));

    await expect(async () => {
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeTransferBatchSig(proposal, approvalWitness, dummyProof);
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow();
  });

  it('should prevent re-execution', async () => {
    const recipientKey = PrivateKey.random();
    const recipient = recipientKey.toPublicKey();
    await fundAccount(ctx, recipient);

    const transferAmount = UInt64.from(1_000_000_000);
    const proposal = createTransferProposal(
      recipient, transferAmount, Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    const ownersRoot = ctx.ownerStore.getRoot();
    const dummyProof = await makeDummyProof(proposalHash, ownersRoot, Field(2));

    // Execute first time
    const approvalWitness1 = ctx.approvalStore.getWitness(proposalHash);
    const txn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeTransferBatchSig(proposal, approvalWitness1, dummyProof);
    });
    await txn.prove();
    await txn.sign([ctx.deployerKey]).send();
    ctx.approvalStore.setCount(proposalHash, EXECUTED_MARKER);

    // Try to execute again
    await expect(async () => {
      const dummyProof2 = await makeDummyProof(proposalHash, ownersRoot, Field(2));
      const approvalWitness2 = ctx.approvalStore.getWitness(proposalHash);
      const txn2 = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeTransferBatchSig(proposal, approvalWitness2, dummyProof2);
      });
      await txn2.prove();
      await txn2.sign([ctx.deployerKey]).send();
    }).toThrow('Approval root mismatch');
  });

  it('should reject if proposal not proposed', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      recipient, UInt64.from(1_000_000_000), Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = proposal.hash();

    const ownersRoot = ctx.ownerStore.getRoot();
    const dummyProof = await makeDummyProof(proposalHash, ownersRoot, Field(2));

    await expect(async () => {
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeTransferBatchSig(proposal, approvalWitness, dummyProof);
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Approval root mismatch');
  });

  it('should reject wrong txType', async () => {
    const newOwner = PrivateKey.random().toPublicKey();
    const proposal = createAddOwnerProposal(newOwner, Field(0), Field(0), ctx.zkAppAddress);
    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    const ownersRoot = ctx.ownerStore.getRoot();
    const dummyProof = await makeDummyProof(proposalHash, ownersRoot, Field(2));

    await expect(async () => {
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeTransferBatchSig(proposal, approvalWitness, dummyProof);
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Not a transfer tx');
  });
});
