import { Field, Mina, PrivateKey, Signature, UInt64, Bool } from 'o1js';
import { Receiver } from '../MinaGuard.js';
import { EXECUTED_MARKER } from '../constants.js';
import {
  setupLocalBlockchain,
  deployAndSetup,
  proposeTransaction,
  approveTransaction,
  createTransferProposal,
  fundAccount,
  getBalance,
  makeOwnerWitness,
  makeSignatureInputs,
  sortedInsertAfter,
  type TestContext,
  createAddOwnerProposal,
} from './test-helpers.js';
import { SignatureInput, SignatureOption } from '../batch-verify.js';
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
      [new Receiver({ address: recipient, amount: transferAmount })], Field(0), Field(0), ctx.zkAppAddress
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
      [new Receiver({ address: recipient, amount: UInt64.from(1_000_000_000) })], Field(0), Field(0), ctx.zkAppAddress
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
      [new Receiver({ address: recipient, amount: transferAmount })], Field(0), Field(0), ctx.zkAppAddress
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
      [new Receiver({ address: recipient, amount: transferAmount })], Field(0), Field(0), ctx.zkAppAddress
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
      [new Receiver({ address: recipient, amount: UInt64.from(1_000_000_000) })], Field(0), Field(99), ctx.zkAppAddress
    );

    // Can't even propose this since configNonce mismatch happens at propose time
    await expect(async () => {
      const ownerWitness = makeOwnerWitness(ctx.owners.map((o) => o.pub));
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
      [new Receiver({ address: recipient, amount: UInt64.from(1_000_000_000) })], Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);

    // 2. Perform a governance change (add owner) to bump configNonce to 1
    const newOwner = PrivateKey.random().toPublicKey();
    const addOwnerProposal = createAddOwnerProposal(newOwner, Field(1), Field(0), ctx.zkAppAddress);
    const govTxHash = await proposeTransaction(ctx, addOwnerProposal, 0);
    await approveTransaction(ctx, addOwnerProposal, 1);

    const ownerPubs = ctx.owners.map((o) => o.pub);
    const ownerWitness = makeOwnerWitness(ownerPubs);
    const insertAfter = sortedInsertAfter(ownerPubs, newOwner);
    const govApprovalWitness = ctx.approvalStore.getWitness(govTxHash);
    const govTxn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeOwnerChange(
        addOwnerProposal, govApprovalWitness, Field(3), newOwner, ownerWitness, insertAfter
      );
    });
    await govTxn.prove();
    await govTxn.sign([ctx.deployerKey]).send();
    // Insert in sorted position to maintain base58 ordering
    const b58 = newOwner.toBase58();
    const insertIdx = ctx.owners.findIndex((o) => o.pub.toBase58() > b58);
    ctx.owners.splice(insertIdx === -1 ? ctx.owners.length : insertIdx, 0, { key: PrivateKey.random(), pub: newOwner });
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
      [new Receiver({ address: recipient, amount: transferAmount })], Field(0), Field(0), ctx.zkAppAddress
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

  it('should execute transfer with valid batch signatures', async () => {
    const recipientKey = PrivateKey.random();
    const recipient = recipientKey.toPublicKey();
    await fundAccount(ctx, recipient);

    const transferAmount = UInt64.from(1_000_000_000);
    const proposal = createTransferProposal(
      [new Receiver({ address: recipient, amount: transferAmount })], Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = proposal.hash();

    const balanceBefore = getBalance(recipient);

    const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);

    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
    const txn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeTransferBatchSig(proposal, approvalWitness, sigs);
    });
    await txn.prove();
    await txn.sign([ctx.deployerKey]).send();
    ctx.approvalStore.setCount(proposalHash, EXECUTED_MARKER);

    const balanceAfter = getBalance(recipient);
    expect(balanceAfter.sub(balanceBefore)).toEqual(transferAmount);
  });

  it('should reject with insufficient approvals', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      [new Receiver({ address: recipient, amount: UInt64.from(1_000_000_000) })], Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = proposal.hash();

    const sigs = makeSignatureInputs(ctx, proposalHash, [0]); // only 1 sig, threshold=2

    await expect(async () => {
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeTransferBatchSig(proposal, approvalWitness, sigs);
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Insufficient approvals');
  });

  it('should prevent re-execution', async () => {
    const recipientKey = PrivateKey.random();
    const recipient = recipientKey.toPublicKey();
    await fundAccount(ctx, recipient);

    const transferAmount = UInt64.from(1_000_000_000);
    const proposal = createTransferProposal(
      [new Receiver({ address: recipient, amount: transferAmount })], Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = proposal.hash();

    const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);

    // Execute first time
    const approvalWitness1 = ctx.approvalStore.getWitness(proposalHash);
    const txn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeTransferBatchSig(proposal, approvalWitness1, sigs);
    });
    await txn.prove();
    await txn.sign([ctx.deployerKey]).send();
    ctx.approvalStore.setCount(proposalHash, EXECUTED_MARKER);

    // Try to execute again
    await expect(async () => {
      const approvalWitness2 = ctx.approvalStore.getWitness(proposalHash);
      const txn2 = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeTransferBatchSig(proposal, approvalWitness2, sigs);
      });
      await txn2.prove();
      await txn2.sign([ctx.deployerKey]).send();
    }).toThrow('Approval root mismatch');
  });

  it('should increment proposalCounter on batchSig execute', async () => {
    const recipientKey = PrivateKey.random();
    const recipient = recipientKey.toPublicKey();
    await fundAccount(ctx, recipient);

    const counterBefore = ctx.zkApp.proposalCounter.get();

    const proposal = createTransferProposal(
      [new Receiver({ address: recipient, amount: UInt64.from(1_000_000_000) })], Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = proposal.hash();

    const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);

    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
    const txn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeTransferBatchSig(proposal, approvalWitness, sigs);
    });
    await txn.prove();
    await txn.sign([ctx.deployerKey]).send();

    expect(ctx.zkApp.proposalCounter.get()).toEqual(counterBefore.add(1));
  });

  it('should reject with invalid signature in batch', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      [new Receiver({ address: recipient, amount: UInt64.from(1_000_000_000) })], Field(0), Field(0), ctx.zkAppAddress
    );
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

    await expect(async () => {
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeTransferBatchSig(proposal, approvalWitness, sigs);
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Insufficient approvals');
  });

  it('should reject with wrong configNonce', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      [new Receiver({ address: recipient, amount: UInt64.from(1_000_000_000) })], Field(0), Field(99), ctx.zkAppAddress
    );
    const proposalHash = proposal.hash();

    const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);

    await expect(async () => {
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeTransferBatchSig(proposal, approvalWitness, sigs);
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Config nonce mismatch - governance changed since proposal');
  });

  it('should reject wrong txType', async () => {
    const newOwner = PrivateKey.random().toPublicKey();
    const proposal = createAddOwnerProposal(newOwner, Field(0), Field(0), ctx.zkAppAddress);
    const proposalHash = proposal.hash();

    const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);

    await expect(async () => {
      const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeTransferBatchSig(proposal, approvalWitness, sigs);
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Not a transfer tx');
  });

  // -- Multi-receiver tests --------------------------------------------------

  it('should execute a multi-receiver transfer (on-chain flow)', async () => {
    const recipient1Key = PrivateKey.random();
    const recipient1 = recipient1Key.toPublicKey();
    const recipient2Key = PrivateKey.random();
    const recipient2 = recipient2Key.toPublicKey();
    await fundAccount(ctx, recipient1);
    await fundAccount(ctx, recipient2);

    const amount1 = UInt64.from(500_000_000);
    const amount2 = UInt64.from(300_000_000);
    const proposal = createTransferProposal(
      [new Receiver({ address: recipient1, amount: amount1 }), new Receiver({ address: recipient2, amount: amount2 })],
      Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);

    const balance1Before = getBalance(recipient1);
    const balance2Before = getBalance(recipient2);

    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
    const txn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeTransfer(proposal, approvalWitness, Field(3));
    });
    await txn.prove();
    await txn.sign([ctx.deployerKey]).send();

    expect(getBalance(recipient1).sub(balance1Before)).toEqual(amount1);
    expect(getBalance(recipient2).sub(balance2Before)).toEqual(amount2);
  });

  it('should execute a full 5-receiver transfer (on-chain flow)', async () => {
    const recipients = Array.from({ length: 5 }, () => PrivateKey.random());
    for (const r of recipients) {
      await fundAccount(ctx, r.toPublicKey());
    }

    const amounts = [100_000_000, 200_000_000, 300_000_000, 150_000_000, 250_000_000];
    const proposal = createTransferProposal(
      recipients.map((r, i) => new Receiver({ address: r.toPublicKey(), amount: UInt64.from(amounts[i]) })),
      Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);

    const balancesBefore = recipients.map((r) => getBalance(r.toPublicKey()));

    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
    const txn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeTransfer(proposal, approvalWitness, Field(3));
    });
    await txn.prove();
    await txn.sign([ctx.deployerKey]).send();

    for (let i = 0; i < 5; i++) {
      const gained = getBalance(recipients[i].toPublicKey()).sub(balancesBefore[i]);
      expect(gained).toEqual(UInt64.from(amounts[i]));
    }
  });

  it('should execute a multi-receiver transfer via batch sig', async () => {
    const recipient1Key = PrivateKey.random();
    const recipient1 = recipient1Key.toPublicKey();
    const recipient2Key = PrivateKey.random();
    const recipient2 = recipient2Key.toPublicKey();
    const recipient3Key = PrivateKey.random();
    const recipient3 = recipient3Key.toPublicKey();
    await fundAccount(ctx, recipient1);
    await fundAccount(ctx, recipient2);
    await fundAccount(ctx, recipient3);

    const amount1 = UInt64.from(400_000_000);
    const amount2 = UInt64.from(300_000_000);
    const amount3 = UInt64.from(200_000_000);
    const proposal = createTransferProposal(
      [new Receiver({ address: recipient1, amount: amount1 }), new Receiver({ address: recipient2, amount: amount2 }), new Receiver({ address: recipient3, amount: amount3 })],
      Field(0), Field(0), ctx.zkAppAddress
    );
    const proposalHash = proposal.hash();

    const balance1Before = getBalance(recipient1);
    const balance2Before = getBalance(recipient2);
    const balance3Before = getBalance(recipient3);

    const sigs = makeSignatureInputs(ctx, proposalHash, [0, 1]);
    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);

    const txn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeTransferBatchSig(proposal, approvalWitness, sigs);
    });
    await txn.prove();
    await txn.sign([ctx.deployerKey]).send();

    expect(getBalance(recipient1).sub(balance1Before)).toEqual(amount1);
    expect(getBalance(recipient2).sub(balance2Before)).toEqual(amount2);
    expect(getBalance(recipient3).sub(balance3Before)).toEqual(amount3);
  });
});
