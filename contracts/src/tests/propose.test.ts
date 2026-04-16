import { Field, Mina, PrivateKey, PublicKey, Signature, UInt64 } from 'o1js';
import { Receiver, TransactionProposal } from '../MinaGuard.js';
import { MAX_RECEIVERS, TxType, Destination } from '../constants.js';
import {
  setupLocalBlockchain,
  deployAndSetup,
  proposeTransaction,
  createTransferProposal,
  createThresholdProposal,
  createUndelegateProposal,
  makeOwnerWitness,
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
      [new Receiver({ address: recipient, amount: UInt64.from(1_000_000_000) })],
      Field(1),
      Field(0),
      ctx.zkAppAddress
    );

    const proposalHash = await proposeTransaction(ctx, proposal, 0);

    expect(ctx.zkApp.nonce.get()).toEqual(Field(0));
    expect(ctx.approvalStore.getCount(proposalHash)).toEqual(Field(2));
    expect(ctx.nullifierStore.isNullified(proposalHash, ctx.owners[0].pub)).toBe(true);
  });

  it('should reject proposal from non-owner', async () => {
    const nonOwner = PrivateKey.random();
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      [new Receiver({ address: recipient, amount: UInt64.from(1_000_000_000) })],
      Field(1),
      Field(0),
      ctx.zkAppAddress
    );

    const ownerWitness = makeOwnerWitness(ctx.owners.map((o) => o.pub));
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
          ownerWitness,
          nonOwner.toPublicKey(),
          signature,
          nullifierWitness,
          approvalWitness
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Claimed owner not a member of owners.');
  });

  it('should reject proposal with wrong configNonce', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      [new Receiver({ address: recipient, amount: UInt64.from(1_000_000_000) })],
      Field(1),
      Field(99), // wrong configNonce
      ctx.zkAppAddress
    );

    await expect(async () => {
      const ownerWitness = makeOwnerWitness(ctx.owners.map((o) => o.pub));
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
      await txn.sign([ctx.owners[0].key]).send();
    }).toThrow('Config nonce mismatch');
  });

  it('should reject proposal with wrong networkId', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      [new Receiver({ address: recipient, amount: UInt64.from(1_000_000_000) })],
      Field(1),
      Field(0),
      ctx.zkAppAddress,
      Field(0),
      Field(99) // wrong networkId
    );

    await expect(async () => {
      const ownerWitness = makeOwnerWitness(ctx.owners.map((o) => o.pub));
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
      await txn.sign([ctx.owners[0].key]).send();
    }).toThrow('Network ID mismatch');
  });

  it('should reject proposal with wrong guardAddress', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const wrongGuard = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      [new Receiver({ address: recipient, amount: UInt64.from(1_000_000_000) })],
      Field(1),
      Field(0),
      wrongGuard
    );

    await expect(async () => {
      const ownerWitness = makeOwnerWitness(ctx.owners.map((o) => o.pub));
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
      await txn.sign([ctx.owners[0].key]).send();
    }).toThrow('Guard address mismatch');
  });

  it('should not change execution nonce across multiple proposals', async () => {
    const recipient = PrivateKey.random().toPublicKey();

    const proposal1 = createTransferProposal(
      [new Receiver({ address: recipient, amount: UInt64.from(1_000_000_000) })], Field(1), Field(0), ctx.zkAppAddress
    );
    await proposeTransaction(ctx, proposal1, 0);
    expect(ctx.zkApp.nonce.get()).toEqual(Field(0));

    const proposal2 = createTransferProposal(
      [new Receiver({ address: recipient, amount: UInt64.from(2_000_000_000) })], Field(2), Field(0), ctx.zkAppAddress
    );
    await proposeTransaction(ctx, proposal2, 1);
    expect(ctx.zkApp.nonce.get()).toEqual(Field(0));
  });
});

describe('MinaGuard - Propose shape rules', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupLocalBlockchain();
    await deployAndSetup(ctx, 2);
  });

  function emptyReceivers(): Receiver[] {
    return Array.from({ length: MAX_RECEIVERS }, () => Receiver.empty());
  }

  function receiversWithSlot0(address: PublicKey): Receiver[] {
    const arr = emptyReceivers();
    arr[0] = new Receiver({ address, amount: UInt64.from(0) });
    return arr;
  }

  function buildProposal(overrides: Partial<{
    receivers: Receiver[];
    txType: Field;
    data: Field;
    nonce: Field;
    configNonce: Field;
    expiryBlock: Field;
    networkId: Field;
    guardAddress: PublicKey;
    destination: Field;
    childAccount: PublicKey;
  }>): TransactionProposal {
    return new TransactionProposal({
      receivers: overrides.receivers ?? emptyReceivers(),
      tokenId: Field(0),
      txType: overrides.txType ?? TxType.TRANSFER,
      data: overrides.data ?? Field(0),
      nonce: overrides.nonce ?? Field(1),
      configNonce: overrides.configNonce ?? Field(0),
      expiryBlock: overrides.expiryBlock ?? Field(0),
      networkId: overrides.networkId ?? Field(1),
      guardAddress: overrides.guardAddress ?? ctx.zkAppAddress,
      destination: overrides.destination ?? Destination.LOCAL,
      childAccount: overrides.childAccount ?? PublicKey.empty(),
    });
  }

  async function tryPropose(proposal: TransactionProposal): Promise<void> {
    const ownerWitness = makeOwnerWitness(ctx.owners.map((o) => o.pub));
    const signature = Signature.create(ctx.owners[0].key, [proposal.hash()]);
    const nullifierWitness = ctx.nullifierStore.getWitness(proposal.hash(), ctx.owners[0].pub);
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
    await txn.sign([ctx.owners[0].key]).send();
  }

  // -- Unknown txType --------------------------------------------------------

  it('should reject proposal with unknown txType', async () => {
    const proposal = buildProposal({ txType: Field(99) });
    await expect(async () => {
      await tryPropose(proposal);
    }).toThrow('Unknown txType');
  });

  // -- Rule 1: ADD_OWNER / REMOVE_OWNER require non-empty slot 0 -------------

  it('should reject ADD_OWNER with empty receivers[0]', async () => {
    const proposal = buildProposal({ txType: TxType.ADD_OWNER });
    await expect(async () => {
      await tryPropose(proposal);
    }).toThrow('addOwner/removeOwner requires target pubkey in receivers[0]');
  });

  it('should reject REMOVE_OWNER with empty receivers[0]', async () => {
    const proposal = buildProposal({ txType: TxType.REMOVE_OWNER });
    await expect(async () => {
      await tryPropose(proposal);
    }).toThrow('addOwner/removeOwner requires target pubkey in receivers[0]');
  });

  // -- Rule 2: CHANGE_THRESHOLD requires empty slot 0 ------------------------

  it('should reject CHANGE_THRESHOLD with non-empty receivers[0]', async () => {
    const stray = PrivateKey.random().toPublicKey();
    const proposal = buildProposal({
      txType: TxType.CHANGE_THRESHOLD,
      receivers: receiversWithSlot0(stray),
      data: Field(2),
    });
    await expect(async () => {
      await tryPropose(proposal);
    }).toThrow('changeThreshold must have empty receivers[0]');
  });

  // -- Rule 3: non-transfer requires at most one receiver --------------------

  it('should reject ADD_OWNER with extra non-empty receiver in slot 1', async () => {
    const newOwner = PrivateKey.random().toPublicKey();
    const stray = PrivateKey.random().toPublicKey();
    const receivers = receiversWithSlot0(newOwner);
    receivers[1] = new Receiver({ address: stray, amount: UInt64.from(0) });
    const proposal = buildProposal({ txType: TxType.ADD_OWNER, receivers });
    await expect(async () => {
      await tryPropose(proposal);
    }).toThrow('Non-transfer proposal has extra receivers');
  });

  it('should reject REMOVE_OWNER with extra non-empty receiver in slot 1', async () => {
    const ownerToRemove = PrivateKey.random().toPublicKey();
    const stray = PrivateKey.random().toPublicKey();
    const receivers = receiversWithSlot0(ownerToRemove);
    receivers[1] = new Receiver({ address: stray, amount: UInt64.from(0) });
    const proposal = buildProposal({ txType: TxType.REMOVE_OWNER, receivers });
    await expect(async () => {
      await tryPropose(proposal);
    }).toThrow('Non-transfer proposal has extra receivers');
  });

  it('should reject SET_DELEGATE with extra non-empty receiver in slot 1', async () => {
    const delegate = PrivateKey.random().toPublicKey();
    const stray = PrivateKey.random().toPublicKey();
    const receivers = receiversWithSlot0(delegate);
    receivers[1] = new Receiver({ address: stray, amount: UInt64.from(0) });
    const proposal = buildProposal({ txType: TxType.SET_DELEGATE, receivers });
    await expect(async () => {
      await tryPropose(proposal);
    }).toThrow('Non-transfer proposal has extra receivers');
  });

  it('should reject CHANGE_THRESHOLD with extra non-empty receiver in slot 1', async () => {
    const stray = PrivateKey.random().toPublicKey();
    const receivers = emptyReceivers();
    receivers[1] = new Receiver({ address: stray, amount: UInt64.from(0) });
    const proposal = buildProposal({
      txType: TxType.CHANGE_THRESHOLD,
      receivers,
      data: Field(2),
    });
    await expect(async () => {
      await tryPropose(proposal);
    }).toThrow('Non-transfer proposal has extra receivers');
  });

  // -- Rule 4: non-threshold must have data = 0 ------------------------------

  it('should reject ADD_OWNER with non-zero data', async () => {
    const newOwner = PrivateKey.random().toPublicKey();
    const proposal = buildProposal({
      txType: TxType.ADD_OWNER,
      receivers: receiversWithSlot0(newOwner),
      data: Field(42),
    });
    await expect(async () => {
      await tryPropose(proposal);
    }).toThrow('data must be zero for this txType');
  });

  it('should reject REMOVE_OWNER with non-zero data', async () => {
    const ownerToRemove = PrivateKey.random().toPublicKey();
    const proposal = buildProposal({
      txType: TxType.REMOVE_OWNER,
      receivers: receiversWithSlot0(ownerToRemove),
      data: Field(42),
    });
    await expect(async () => {
      await tryPropose(proposal);
    }).toThrow('data must be zero for this txType');
  });

  it('should reject TRANSFER with non-zero data', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const receivers = emptyReceivers();
    receivers[0] = new Receiver({ address: recipient, amount: UInt64.from(1_000_000_000) });
    const proposal = buildProposal({ txType: TxType.TRANSFER, receivers, data: Field(42) });
    await expect(async () => {
      await tryPropose(proposal);
    }).toThrow('data must be zero for this txType');
  });

  it('should reject SET_DELEGATE with non-zero data', async () => {
    const delegate = PrivateKey.random().toPublicKey();
    const proposal = buildProposal({
      txType: TxType.SET_DELEGATE,
      receivers: receiversWithSlot0(delegate),
      data: Field(42),
    });
    await expect(async () => {
      await tryPropose(proposal);
    }).toThrow('data must be zero for this txType');
  });

  // -- Positive cases --------------------------------------------------------

  it('should accept undelegate proposal with empty receivers[0]', async () => {
    const proposal = createUndelegateProposal(Field(1), Field(0), ctx.zkAppAddress);
    const proposalHash = await proposeTransaction(ctx, proposal, 0);
    expect(ctx.approvalStore.getCount(proposalHash)).toEqual(Field(2));
    expect(ctx.zkApp.nonce.get()).toEqual(Field(0));
  });

  it('should accept batch TRANSFER with multiple non-empty receivers', async () => {
    const r1 = PrivateKey.random().toPublicKey();
    const r2 = PrivateKey.random().toPublicKey();
    const r3 = PrivateKey.random().toPublicKey();
    const proposal = createTransferProposal(
      [
        new Receiver({ address: r1, amount: UInt64.from(1_000_000_000) }),
        new Receiver({ address: r2, amount: UInt64.from(2_000_000_000) }),
        new Receiver({ address: r3, amount: UInt64.from(3_000_000_000) }),
      ],
      Field(1),
      Field(0),
      ctx.zkAppAddress
    );
    const proposalHash = await proposeTransaction(ctx, proposal, 0);
    expect(ctx.approvalStore.getCount(proposalHash)).toEqual(Field(2));
    expect(ctx.zkApp.nonce.get()).toEqual(Field(0));
  });

  it('should accept CHANGE_THRESHOLD with non-zero data (the new threshold)', async () => {
    const proposal = createThresholdProposal(Field(2), Field(1), Field(0), ctx.zkAppAddress);
    const proposalHash = await proposeTransaction(ctx, proposal, 0);
    expect(ctx.approvalStore.getCount(proposalHash)).toEqual(Field(2));
    expect(ctx.zkApp.nonce.get()).toEqual(Field(0));
  });
});
