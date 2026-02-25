import {
  Field,
  Mina,
  PrivateKey,
  PublicKey,
  AccountUpdate,
  MerkleMap,
  Poseidon,
  Signature,
  UInt64,
} from 'o1js';
import { MultisigWallet } from './MultisigWallet.js';
import { TransactionProposal, TxType, ownerKey } from './types.js';
import { MultisigStorage } from './storage.js';

describe('MultisigWallet', () => {
  let deployerKey: PrivateKey;
  let deployerAccount: PublicKey;
  let zkAppKey: PrivateKey;
  let zkAppAddress: PublicKey;
  let zkApp: MultisigWallet;

  // 3 owners for testing
  let owner1Key: PrivateKey;
  let owner1: PublicKey;
  let owner2Key: PrivateKey;
  let owner2: PublicKey;
  let owner3Key: PrivateKey;
  let owner3: PublicKey;

  let storage: MultisigStorage;

  // Skipping compile for local tests with proofsEnabled: false
  // For deployment, compile() would be called with proofsEnabled: true

  beforeEach(async () => {
    const Local = await Mina.LocalBlockchain({ proofsEnabled: false });
    Mina.setActiveInstance(Local);

    deployerKey = Local.testAccounts[0].key;
    deployerAccount = Local.testAccounts[0];

    owner1Key = Local.testAccounts[1].key;
    owner1 = Local.testAccounts[1];
    owner2Key = Local.testAccounts[2].key;
    owner2 = Local.testAccounts[2];
    owner3Key = Local.testAccounts[3].key;
    owner3 = Local.testAccounts[3];

    zkAppKey = PrivateKey.random();
    zkAppAddress = zkAppKey.toPublicKey();
    zkApp = new MultisigWallet(zkAppAddress);

    // Set up off-chain storage with 3 owners
    storage = new MultisigStorage();
    storage.addOwner(owner1);
    storage.addOwner(owner2);
    storage.addOwner(owner3);
  });

  async function deployAndSetup(threshold: number = 2) {
    // Deploy
    const deployTxn = await Mina.transaction(deployerAccount, async () => {
      AccountUpdate.fundNewAccount(deployerAccount);
      await zkApp.deploy();
    });
    await deployTxn.prove();
    await deployTxn.sign([deployerKey, zkAppKey]).send();

    // Fund the wallet with some MINA
    const fundTxn = await Mina.transaction(deployerAccount, async () => {
      const update = AccountUpdate.createSigned(deployerAccount);
      update.send({ to: zkAppAddress, amount: UInt64.from(10_000_000_000) });
    });
    await fundTxn.prove();
    await fundTxn.sign([deployerKey]).send();

    // Setup with owners and threshold
    const emptyMapRoot = new MerkleMap().getRoot();
    const setupTxn = await Mina.transaction(deployerAccount, async () => {
      await zkApp.setup(
        storage.owners.getRoot(),
        Field(threshold),
        Field(3),
        emptyMapRoot
      );
    });
    await setupTxn.prove();
    await setupTxn.sign([deployerKey, zkAppKey]).send();
  }

  // ── Deployment & Setup ──────────────────────────────────────────

  it('should deploy and setup with owners and threshold', async () => {
    await deployAndSetup(2);

    expect(zkApp.ownersRoot.get()).toEqual(storage.owners.getRoot());
    expect(zkApp.threshold.get()).toEqual(Field(2));
    expect(zkApp.numOwners.get()).toEqual(Field(3));
    expect(zkApp.txNonce.get()).toEqual(Field(0));
  });

  it('should reject double setup', async () => {
    await deployAndSetup(2);

    await expect(async () => {
      const emptyMapRoot = new MerkleMap().getRoot();
      const txn = await Mina.transaction(deployerAccount, async () => {
        await zkApp.setup(storage.owners.getRoot(), Field(2), Field(3), emptyMapRoot);
      });
      await txn.prove();
      await txn.sign([deployerKey, zkAppKey]).send();
    }).rejects.toThrow();
  });

  // ── Propose ─────────────────────────────────────────────────────

  it('should allow owner to propose a transfer', async () => {
    await deployAndSetup(2);

    const recipient = PrivateKey.random().toPublicKey();
    const proposal = new TransactionProposal({
      to: recipient,
      amount: UInt64.from(1_000_000_000),
      tokenId: Field(0),
      txType: TxType.TRANSFER,
      data: Field(0),
      nonce: Field(0),
    });

    const ownerWitness = storage.getOwnerWitness(owner1);
    const txn = await Mina.transaction(owner1, async () => {
      await zkApp.propose(proposal, ownerWitness, owner1);
    });
    await txn.prove();
    await txn.sign([owner1Key, zkAppKey]).send();

    // Nonce should be incremented
    expect(zkApp.txNonce.get()).toEqual(Field(1));

    // Update off-chain storage
    const txHash = proposal.hash();
    storage.addPendingTx(Field(0), txHash);
  });

  it('should reject proposal from non-owner', async () => {
    await deployAndSetup(2);

    const nonOwner = PrivateKey.random();
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = new TransactionProposal({
      to: recipient,
      amount: UInt64.from(1_000_000_000),
      tokenId: Field(0),
      txType: TxType.TRANSFER,
      data: Field(0),
      nonce: Field(0),
    });

    // Use a witness for the non-owner (which won't match)
    const fakeOwnerWitness = storage.getOwnerWitness(
      nonOwner.toPublicKey()
    );

    await expect(async () => {
      const txn = await Mina.transaction(deployerAccount, async () => {
        await zkApp.propose(proposal, fakeOwnerWitness, nonOwner.toPublicKey());
      });
      await txn.prove();
      await txn.sign([deployerKey, zkAppKey]).send();
    }).rejects.toThrow();
  });

  // ── Approve ─────────────────────────────────────────────────────

  it('should allow owners to approve a transaction', async () => {
    await deployAndSetup(2);

    // Propose
    const recipient = PrivateKey.random().toPublicKey();
    const proposal = new TransactionProposal({
      to: recipient,
      amount: UInt64.from(1_000_000_000),
      tokenId: Field(0),
      txType: TxType.TRANSFER,
      data: Field(0),
      nonce: Field(0),
    });

    const ownerWitness = storage.getOwnerWitness(owner1);
    const proposeTxn = await Mina.transaction(owner1, async () => {
      await zkApp.propose(proposal, ownerWitness, owner1);
    });
    await proposeTxn.prove();
    await proposeTxn.sign([owner1Key, zkAppKey]).send();

    const txHash = proposal.hash();
    const txId = Field(0);

    // Initialize approval count to 0 in off-chain storage
    storage.setApprovalCount(txId, Field(0));
    // Update on-chain approval root to match
    // For the first approval, the approval map has txId -> 0

    // Owner1 approves
    const sig1 = Signature.create(owner1Key, [txHash]);
    const approvalWitness1 = storage.getApprovalWitness(txId);

    const approve1Txn = await Mina.transaction(owner1, async () => {
      await zkApp.approveTx(
        txId,
        txHash,
        sig1,
        owner1,
        storage.getOwnerWitness(owner1),
        approvalWitness1,
        Field(0) // current count = 0
      );
    });
    await approve1Txn.prove();
    await approve1Txn.sign([owner1Key, zkAppKey]).send();

    // Update off-chain storage
    storage.setApprovalCount(txId, Field(1));
    storage.recordApproval(txId, owner1);

    // Owner2 approves
    const sig2 = Signature.create(owner2Key, [txHash]);
    const approvalWitness2 = storage.getApprovalWitness(txId);

    const approve2Txn = await Mina.transaction(owner2, async () => {
      await zkApp.approveTx(
        txId,
        txHash,
        sig2,
        owner2,
        storage.getOwnerWitness(owner2),
        approvalWitness2,
        Field(1) // current count = 1
      );
    });
    await approve2Txn.prove();
    await approve2Txn.sign([owner2Key, zkAppKey]).send();

    // Update off-chain storage
    storage.setApprovalCount(txId, Field(2));
    storage.recordApproval(txId, owner2);

    expect(storage.getApprovalCount(txId)).toEqual(Field(2));
  });

  // ── Execute ─────────────────────────────────────────────────────

  it('should execute a transfer after threshold approvals', async () => {
    await deployAndSetup(2);

    const recipientKey = PrivateKey.random();
    const recipient = recipientKey.toPublicKey();

    // Fund recipient account
    const fundRecipientTxn = await Mina.transaction(
      deployerAccount,
      async () => {
        AccountUpdate.fundNewAccount(deployerAccount);
        const update = AccountUpdate.createSigned(deployerAccount);
        update.send({ to: recipient, amount: UInt64.from(1_000_000) });
      }
    );
    await fundRecipientTxn.prove();
    await fundRecipientTxn.sign([deployerKey]).send();

    const transferAmount = UInt64.from(1_000_000_000);
    const proposal = new TransactionProposal({
      to: recipient,
      amount: transferAmount,
      tokenId: Field(0),
      txType: TxType.TRANSFER,
      data: Field(0),
      nonce: Field(0),
    });

    // Propose
    const proposeTxn = await Mina.transaction(owner1, async () => {
      await zkApp.propose(
        proposal,
        storage.getOwnerWitness(owner1),
        owner1
      );
    });
    await proposeTxn.prove();
    await proposeTxn.sign([owner1Key, zkAppKey]).send();

    const txHash = proposal.hash();
    const txId = Field(0);
    storage.setApprovalCount(txId, Field(0));

    // Approve from owner1
    const sig1 = Signature.create(owner1Key, [txHash]);
    const approve1Txn = await Mina.transaction(owner1, async () => {
      await zkApp.approveTx(
        txId,
        txHash,
        sig1,
        owner1,
        storage.getOwnerWitness(owner1),
        storage.getApprovalWitness(txId),
        Field(0)
      );
    });
    await approve1Txn.prove();
    await approve1Txn.sign([owner1Key, zkAppKey]).send();
    storage.setApprovalCount(txId, Field(1));

    // Approve from owner2
    const sig2 = Signature.create(owner2Key, [txHash]);
    const approve2Txn = await Mina.transaction(owner2, async () => {
      await zkApp.approveTx(
        txId,
        txHash,
        sig2,
        owner2,
        storage.getOwnerWitness(owner2),
        storage.getApprovalWitness(txId),
        Field(1)
      );
    });
    await approve2Txn.prove();
    await approve2Txn.sign([owner2Key, zkAppKey]).send();
    storage.setApprovalCount(txId, Field(2));

    // Get balance before execution
    const balanceBefore = Mina.getBalance(recipient);

    // Execute
    const executeTxn = await Mina.transaction(deployerAccount, async () => {
      await zkApp.execute(
        proposal,
        storage.getApprovalWitness(txId),
        Field(2)
      );
    });
    await executeTxn.prove();
    await executeTxn.sign([deployerKey, zkAppKey]).send();

    // Check balance after
    const balanceAfter = Mina.getBalance(recipient);
    expect(balanceAfter.sub(balanceBefore)).toEqual(transferAmount);
  });

  it('should reject execution with insufficient approvals', async () => {
    await deployAndSetup(2);

    const recipient = PrivateKey.random().toPublicKey();
    const proposal = new TransactionProposal({
      to: recipient,
      amount: UInt64.from(1_000_000_000),
      tokenId: Field(0),
      txType: TxType.TRANSFER,
      data: Field(0),
      nonce: Field(0),
    });

    // Propose
    const proposeTxn = await Mina.transaction(owner1, async () => {
      await zkApp.propose(
        proposal,
        storage.getOwnerWitness(owner1),
        owner1
      );
    });
    await proposeTxn.prove();
    await proposeTxn.sign([owner1Key, zkAppKey]).send();

    const txId = Field(0);
    const txHash = proposal.hash();
    storage.setApprovalCount(txId, Field(0));

    // Only 1 approval
    const sig1 = Signature.create(owner1Key, [txHash]);
    const approve1Txn = await Mina.transaction(owner1, async () => {
      await zkApp.approveTx(
        txId,
        txHash,
        sig1,
        owner1,
        storage.getOwnerWitness(owner1),
        storage.getApprovalWitness(txId),
        Field(0)
      );
    });
    await approve1Txn.prove();
    await approve1Txn.sign([owner1Key, zkAppKey]).send();
    storage.setApprovalCount(txId, Field(1));

    // Try to execute with only 1 approval (threshold = 2)
    await expect(async () => {
      const executeTxn = await Mina.transaction(
        deployerAccount,
        async () => {
          await zkApp.execute(
            proposal,
            storage.getApprovalWitness(txId),
            Field(1)
          );
        }
      );
      await executeTxn.prove();
      await executeTxn.sign([deployerKey, zkAppKey]).send();
    }).rejects.toThrow();
  });

  // ── Change Threshold ────────────────────────────────────────────

  it('should change threshold via multisig approval', async () => {
    await deployAndSetup(2);

    const newThreshold = Field(3);
    const proposal = new TransactionProposal({
      to: PublicKey.empty(),
      amount: UInt64.from(0),
      tokenId: Field(0),
      txType: TxType.CHANGE_THRESHOLD,
      data: newThreshold,
      nonce: Field(0),
    });

    // Propose
    const proposeTxn = await Mina.transaction(owner1, async () => {
      await zkApp.propose(
        proposal,
        storage.getOwnerWitness(owner1),
        owner1
      );
    });
    await proposeTxn.prove();
    await proposeTxn.sign([owner1Key, zkAppKey]).send();

    const txHash = proposal.hash();
    const txId = Field(0);
    storage.setApprovalCount(txId, Field(0));

    // Approve from owner1
    const sig1 = Signature.create(owner1Key, [txHash]);
    const approve1Txn = await Mina.transaction(owner1, async () => {
      await zkApp.approveTx(
        txId,
        txHash,
        sig1,
        owner1,
        storage.getOwnerWitness(owner1),
        storage.getApprovalWitness(txId),
        Field(0)
      );
    });
    await approve1Txn.prove();
    await approve1Txn.sign([owner1Key, zkAppKey]).send();
    storage.setApprovalCount(txId, Field(1));

    // Approve from owner2
    const sig2 = Signature.create(owner2Key, [txHash]);
    const approve2Txn = await Mina.transaction(owner2, async () => {
      await zkApp.approveTx(
        txId,
        txHash,
        sig2,
        owner2,
        storage.getOwnerWitness(owner2),
        storage.getApprovalWitness(txId),
        Field(1)
      );
    });
    await approve2Txn.prove();
    await approve2Txn.sign([owner2Key, zkAppKey]).send();
    storage.setApprovalCount(txId, Field(2));

    // Execute threshold change
    const changeTxn = await Mina.transaction(deployerAccount, async () => {
      await zkApp.changeThreshold(
        proposal,
        newThreshold,
        storage.getApprovalWitness(txId),
        Field(2)
      );
    });
    await changeTxn.prove();
    await changeTxn.sign([deployerKey, zkAppKey]).send();

    expect(zkApp.threshold.get()).toEqual(Field(3));
  });

  // ── Add Owner ───────────────────────────────────────────────────

  it('should add a new owner via multisig approval', async () => {
    await deployAndSetup(2);

    const newOwnerKey = PrivateKey.random();
    const newOwner = newOwnerKey.toPublicKey();
    const newOwnerHash = Poseidon.hash(newOwner.toFields());

    const proposal = new TransactionProposal({
      to: PublicKey.empty(),
      amount: UInt64.from(0),
      tokenId: Field(0),
      txType: TxType.ADD_OWNER,
      data: newOwnerHash,
      nonce: Field(0),
    });

    // Propose
    const proposeTxn = await Mina.transaction(owner1, async () => {
      await zkApp.propose(
        proposal,
        storage.getOwnerWitness(owner1),
        owner1
      );
    });
    await proposeTxn.prove();
    await proposeTxn.sign([owner1Key, zkAppKey]).send();

    const txHash = proposal.hash();
    const txId = Field(0);
    storage.setApprovalCount(txId, Field(0));

    // Approve from owner1
    const sig1 = Signature.create(owner1Key, [txHash]);
    const approve1Txn = await Mina.transaction(owner1, async () => {
      await zkApp.approveTx(
        txId,
        txHash,
        sig1,
        owner1,
        storage.getOwnerWitness(owner1),
        storage.getApprovalWitness(txId),
        Field(0)
      );
    });
    await approve1Txn.prove();
    await approve1Txn.sign([owner1Key, zkAppKey]).send();
    storage.setApprovalCount(txId, Field(1));

    // Approve from owner2
    const sig2 = Signature.create(owner2Key, [txHash]);
    const approve2Txn = await Mina.transaction(owner2, async () => {
      await zkApp.approveTx(
        txId,
        txHash,
        sig2,
        owner2,
        storage.getOwnerWitness(owner2),
        storage.getApprovalWitness(txId),
        Field(1)
      );
    });
    await approve2Txn.prove();
    await approve2Txn.sign([owner2Key, zkAppKey]).send();
    storage.setApprovalCount(txId, Field(2));

    // Execute add owner
    const newOwnerMerkleWitness = storage.owners.getWitness(
      ownerKey(newOwner)
    );

    const addOwnerTxn = await Mina.transaction(
      deployerAccount,
      async () => {
        await zkApp.addOwner(
          proposal,
          newOwner,
          storage.getApprovalWitness(txId),
          Field(2),
          newOwnerMerkleWitness
        );
      }
    );
    await addOwnerTxn.prove();
    await addOwnerTxn.sign([deployerKey, zkAppKey]).send();

    // Verify
    expect(zkApp.numOwners.get()).toEqual(Field(4));

    // Update off-chain storage
    storage.addOwner(newOwner);
    expect(zkApp.ownersRoot.get()).toEqual(storage.owners.getRoot());
  });

  // ── Serialization ───────────────────────────────────────────────

  it('should serialize and deserialize storage', () => {
    storage.addPendingTx(Field(0), Field(123));
    storage.setApprovalCount(Field(0), Field(2));
    storage.recordApproval(Field(0), owner1);
    storage.recordApproval(Field(0), owner2);

    const json = storage.serialize();
    const restored = MultisigStorage.deserialize(json);

    expect(restored.owners.getRoot()).toEqual(storage.owners.getRoot());
    expect(restored.ownerAddresses.length).toBe(3);
    expect(restored.getApprovalCount(Field(0))).toEqual(Field(2));
    expect(restored.hasApproved(Field(0), owner1)).toBe(true);
    expect(restored.hasApproved(Field(0), owner2)).toBe(true);
    expect(restored.hasApproved(Field(0), owner3)).toBe(false);
  });
});
