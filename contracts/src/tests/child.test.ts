import {
  AccountUpdate,
  Cache,
  Field,
  MerkleMap,
  MerkleMapWitness,
  Mina,
  Permissions,
  Poseidon,
  PrivateKey,
  PublicKey,
  Signature,
  UInt64,
} from 'o1js';
import { MinaGuard, Receiver, SetupOwnersInput, TransactionProposal } from '../MinaGuard.js';
import { ApprovalStore, VoteNullifierStore } from '../storage.js';
import { EMPTY_MERKLE_MAP_ROOT, EXECUTED_MARKER, PROPOSED_MARKER, TxType, Destination } from '../constants.js';
import {
  setupLocalBlockchain,
  deployAndSetup,
  deployAndSetupChildGuard,
  proposeAndApproveOnParent,
  proposeTransaction,
  approveTransaction,
  createCreateChildProposal,
  createAllocateChildProposal,
  createReclaimChildProposal,
  createDestroyChildProposal,
  createEnableChildMultiSigProposal,
  createThresholdProposal,
  createTransferProposal,
  createAddOwnerProposal,
  createDelegateProposal,
  makeOwnerWitness,
  sortedInsertAfter,
  toFixedSetupOwners,
  getBalance,
  type TestContext,
  nonCurvePublicKey,
} from './test-helpers.js';
import { computeOwnerChain } from '../list-commitment.js';
import {
  GUARD_DEPLOY_PERMISSIONS,
  GUARD_PERMISSIONS,
} from '../guard-permissions.js';
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';

const RUN_REAL_PROOF_TESTS = process.env.RUN_REAL_PROOF_TESTS === '1';
const realProofIt = RUN_REAL_PROOF_TESTS ? it : it.skip;

const ROOT_STATE_SLOT = {
  ownersCommitment: 0,
  threshold: 1,
  approvalRoot: 5,
  configNonce: 6,
} as const;

const CHILD_NONCE_STATE_SLOT = {
  ownersCommitment: 0,
  parentX: 7,
  parentIsOdd: 8,
  parentNonce: 9,
} as const;

describe('MinaGuard - Child Lifecycle', () => {
  let parentCtx: TestContext;
  let childZkApp: MinaGuard;
  let childKey: PrivateKey;
  let childAddress: PublicKey;
  let childExecutionMap: MerkleMap;

  beforeAll(async () => {
    if (RUN_REAL_PROOF_TESTS) {
      // check-vk-hash populates this same repository cache before invoking the
      // opt-in real-proof regression in CI.
      await MinaGuard.compile({ cache: Cache.FileSystem('../cache') });
    }
  });

  /**
   * Produces the parent's approval witness + count for a REMOTE proposal
   * whose owner signatures have already been recorded in parentCtx's
   * approvalStore.
   */
  function parentApprovalInputs(proposalHash: Field) {
    return {
      parentApprovalWitness: parentCtx.approvalStore.getWitness(proposalHash),
      parentApprovalCount: parentCtx.approvalStore.getCount(proposalHash),
    };
  }

  function childExecutionWitnessFor(proposalHash: Field): MerkleMapWitness {
    return childExecutionMap.getWitness(proposalHash);
  }

  function markChildExecutedOffChain(proposalHash: Field): void {
    childExecutionMap.set(proposalHash, EXECUTED_MARKER);
  }

  beforeEach(async () => {
    parentCtx = await setupLocalBlockchain(3);
    await deployAndSetup(parentCtx, 2);

    childKey = PrivateKey.random();
    childAddress = childKey.toPublicKey();
    childZkApp = new MinaGuard(childAddress);
    childExecutionMap = new MerkleMap();
  });

  async function setupChildWithParentOwners(): Promise<{ proposalHash: Field }> {
    return deployAndSetupChildGuard(
      parentCtx,
      parentCtx.zkAppAddress,
      childZkApp,
      childKey,
      childAddress,
      parentCtx.owners.map((o) => o.pub),
      2,
      [0, 1],
    );
  }

  // -- executeSetupChild ------------------------------------------------------

  describe('executeSetupChild', () => {
    it('overwrites creator-weakened child permissions during reservation', async () => {
      const setupOwners = toFixedSetupOwners(
        parentCtx.owners.map((owner) => owner.pub),
      );

      const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
        AccountUpdate.fundNewAccount(parentCtx.deployerAccount);
        await childZkApp.deploy();
        childZkApp.account.permissions.set({
          ...GUARD_DEPLOY_PERMISSIONS,
          send: Permissions.proofOrSignature(),
        });
        await childZkApp.reserveForParent(
          parentCtx.zkAppAddress,
          Field(1234),
          Field(2),
          Field(3),
          new SetupOwnersInput({ owners: setupOwners }),
        );
      });
      const accountUpdates = (
        JSON.parse(txn.toJSON()) as { accountUpdates: any[] }
      ).accountUpdates.filter(
        (update) => update.body.publicKey === childAddress.toBase58(),
      );
      const signedDeploy = accountUpdates.find(
        (update) => update.body.authorizationKind.isSigned === true,
      );
      const provedReservation = accountUpdates.find(
        (update) => update.body.authorizationKind.isProved === true,
      );

      expect(accountUpdates).toHaveLength(2);
      expect(signedDeploy?.body.update.permissions.send).toBe('Either');
      expect(signedDeploy?.body.update.permissions.setPermissions).toBe(
        'Proof',
      );
      expect(provedReservation?.body.update.permissions.send).toBe('Proof');
      expect(
        provedReservation?.body.update.permissions.setPermissions,
      ).toBe('Impossible');
      await txn.prove();
      await txn.sign([parentCtx.deployerKey, childKey]).send();

      expect(Mina.getAccount(childAddress).permissions).toEqual(
        GUARD_PERMISSIONS,
      );
    });

    it('rejects a child creator blocking the reservation permission lock', async () => {
      const setupOwners = toFixedSetupOwners(
        parentCtx.owners.map((owner) => owner.pub),
      );

      await expect(async () => {
        const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
          AccountUpdate.fundNewAccount(parentCtx.deployerAccount);
          await childZkApp.deploy();
          childZkApp.account.permissions.set({
            ...GUARD_DEPLOY_PERMISSIONS,
            setPermissions: Permissions.impossible(),
          });
          await childZkApp.reserveForParent(
            parentCtx.zkAppAddress,
            Field(1234),
            Field(2),
            Field(3),
            new SetupOwnersInput({ owners: setupOwners }),
          );
        });
        await txn.prove();
        await txn.sign([parentCtx.deployerKey, childKey]).send();
      }).toThrow();

      expect(Mina.hasAccount(childAddress)).toBe(false);
    });

    it('initializes a child guard with parent approval', async () => {
      const { proposalHash } = await setupChildWithParentOwners();

      expect(childZkApp.parent.get()).toEqual(parentCtx.zkAppAddress);
      expect(childZkApp.childMultiSigEnabled.get()).toEqual(Field(1));
      expect(childZkApp.childExecutionRoot.get()).toEqual(EMPTY_MERKLE_MAP_ROOT);
      expect(childZkApp.threshold.get()).toEqual(Field(2));
      expect(childZkApp.numOwners.get()).toEqual(Field(3));
      expect(Mina.getAccount(childAddress).permissions).toEqual(
        GUARD_PERMISSIONS,
      );

      expect(proposalHash).toBeDefined();
    });

    it('rejects setup when parent approvals are below threshold', async () => {
      const childOwners = parentCtx.owners.map((o) => o.pub);
      const ownersCommitment = computeOwnerChain(childOwners);
      const proposal = createCreateChildProposal(
        childAddress,
        ownersCommitment,
        Field(2),
        Field(3),
        Field(0),
        Field(0),
        parentCtx.zkAppAddress,
        Field(0),
        parentCtx.networkId,
      );

      // Only the proposer signs on the parent — below the threshold of 2.
      const proposalHash = await proposeTransaction(parentCtx, proposal, 0);
      const { parentApprovalWitness, parentApprovalCount } = parentApprovalInputs(proposalHash);

      const setupOwners = toFixedSetupOwners(childOwners);

      // Reserve the child for the parent first.
      const reserveTxn = await Mina.transaction(parentCtx.deployerAccount, async () => {
        AccountUpdate.fundNewAccount(parentCtx.deployerAccount);
        await childZkApp.deploy();
        await childZkApp.reserveForParent(
          parentCtx.zkAppAddress,
          proposal.hash(),
          Field(2),
          Field(3),
          new SetupOwnersInput({ owners: setupOwners }),
        );
      });
      await reserveTxn.prove();
      await reserveTxn.sign([parentCtx.deployerKey, childKey]).send();

      await expect(async () => {
        const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await childZkApp.executeSetupChild(
            Field(2),
            Field(3),
            new SetupOwnersInput({ owners: setupOwners }),
            proposal,
            parentApprovalWitness,
            parentApprovalCount,
          );
        });
        await txn.prove();
        await txn.sign([parentCtx.deployerKey]).send();
      }).toThrow('Insufficient approvals');
    });

    it('rejects re-setup of an already-initialized child', async () => {
      const { proposalHash } = await setupChildWithParentOwners();

      const childOwners = parentCtx.owners.map((o) => o.pub);
      const ownersCommitment = computeOwnerChain(childOwners);
      const { parentApprovalWitness, parentApprovalCount } = parentApprovalInputs(proposalHash);
      const setupOwners = toFixedSetupOwners(childOwners);

      // Replay the same CREATE_CHILD proposal that was used for initial setup.
      // The child now has a non-zero ownersCommitment, so initializeState's
      // requireEquals(Field(0)) precondition fails.
      await expect(async () => {
        const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await childZkApp.executeSetupChild(
            Field(2),
            Field(3),
            new SetupOwnersInput({ owners: setupOwners }),
            createCreateChildProposal(
              childAddress,
              ownersCommitment,
              Field(2),
              Field(3),
              Field(0),
              Field(0),
              parentCtx.zkAppAddress,
              Field(0),
              parentCtx.networkId,
            ),
            parentApprovalWitness,
            parentApprovalCount,
          );
        });
        await txn.prove();
        await txn.sign([parentCtx.deployerKey]).send();
      }).toThrow();
    });

    it('rejects setup when proposal data does not match the child config hash', async () => {
      const childOwners = parentCtx.owners.map((o) => o.pub);
      const ownersCommitment = computeOwnerChain(childOwners);

      // Build a CREATE_CHILD proposal by hand with a wrong config-hash in `data`.
      const badProposal = new TransactionProposal({
        receivers: Array.from({ length: 9 }, () => Receiver.empty()),
        tokenId: Field(0),
        txType: TxType.CREATE_CHILD,
        data: Field(99999), // wrong — should be Poseidon([ownersCommitment, threshold, numOwners])
        memoHash: Field(0),
        nonce: Field(0),
        configNonce: Field(0),
        expirySlot: Field(0),
        networkId: parentCtx.networkId,
        guardAddress: parentCtx.zkAppAddress,
        destination: Destination.REMOTE,
        childAccount: childAddress,
      });

      const { parentApprovalWitness, parentApprovalCount } =
        await proposeAndApproveOnParent(parentCtx, badProposal, [0, 1]);

      const setupOwners = toFixedSetupOwners(childOwners);

      // Reserve the child for the parent first (deploy + reserveForParent).
      const reserveTxn = await Mina.transaction(parentCtx.deployerAccount, async () => {
        AccountUpdate.fundNewAccount(parentCtx.deployerAccount);
        await childZkApp.deploy();
        await childZkApp.reserveForParent(
          parentCtx.zkAppAddress,
          badProposal.hash(),
          Field(2),
          Field(3),
          new SetupOwnersInput({ owners: setupOwners }),
        );
      });
      await reserveTxn.prove();
      await reserveTxn.sign([parentCtx.deployerKey, childKey]).send();

      await expect(async () => {
        const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await childZkApp.executeSetupChild(
            Field(2),
            Field(3),
            new SetupOwnersInput({ owners: setupOwners }),
            badProposal,
            parentApprovalWitness,
            parentApprovalCount,
          );
        });
        await txn.prove();
        await txn.sign([parentCtx.deployerKey]).send();
      }).toThrow('Child config mismatch');
    });

    it('rejects execute with a config other than the one reserved (config-swap attack)', async () => {
      // Attack: reserve a benign config (what events/UI display) while the
      // approved proposal.data commits to a malicious config the executor then
      // supplies. The old `data == H(executor owners)` check passes; the
      // reservedConfigHash bind must reject it.
      const benignOwners = parentCtx.owners.map((o) => o.pub);       // config B — displayed
      const maliciousOwners = [                                       // config A — approved+executed
        PrivateKey.random().toPublicKey(),
        PrivateKey.random().toPublicKey(),
      ];
      const maliciousCommitment = computeOwnerChain(maliciousOwners);

      // Proposal.data commits to the MALICIOUS config; honest owners approve it.
      const maliciousProposal = createCreateChildProposal(
        childAddress,
        maliciousCommitment,
        Field(2),
        Field(maliciousOwners.length),
        Field(0),
        Field(0),
        parentCtx.zkAppAddress,
        Field(0),
        parentCtx.networkId,
      );
      const proposalHash = maliciousProposal.hash();

      // Tx 1: deploy child + reserve the BENIGN config + propose the malicious one.
      const proposer = parentCtx.owners[0];
      const ownerWitness = makeOwnerWitness(parentCtx.owners.map((o) => o.pub));
      const sig = Signature.create(proposer.key, [proposalHash]);
      const nullifierWitness = parentCtx.nullifierStore.getWitness(proposalHash, proposer.pub);
      const approvalWitness = parentCtx.approvalStore.getWitness(proposalHash);
      const parentContract = parentCtx.zkApp;

      const tx1 = await Mina.transaction(proposer.pub, async () => {
        AccountUpdate.fundNewAccount(proposer.pub);
        await childZkApp.deploy();
        await childZkApp.reserveForParent(
          parentCtx.zkAppAddress,
          proposalHash,
          Field(2),
          Field(benignOwners.length),
          new SetupOwnersInput({ owners: toFixedSetupOwners(benignOwners) }),
        );
        await parentContract.propose(
          maliciousProposal,
          ownerWitness,
          proposer.pub,
          sig,
          nullifierWitness,
          approvalWitness,
        );
      });
      await tx1.prove();
      await tx1.sign([proposer.key, childKey]).send();
      parentCtx.nullifierStore.nullify(proposalHash, proposer.pub);
      parentCtx.approvalStore.setCount(proposalHash, PROPOSED_MARKER.add(1));

      // Approve to threshold with a second honest owner.
      await approveTransaction(parentCtx, maliciousProposal, 1);

      const parentApprovalCount = parentCtx.approvalStore.getCount(proposalHash);
      const parentApprovalWitness = parentCtx.approvalStore.getWitness(proposalHash);

      // Execute with the MALICIOUS owners: data == H(malicious) passes the first
      // check, but reservedConfigHash (benign) != H(malicious) must revert here.
      await expect(async () => {
        const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await childZkApp.executeSetupChild(
            Field(2),
            Field(maliciousOwners.length),
            new SetupOwnersInput({ owners: toFixedSetupOwners(maliciousOwners) }),
            maliciousProposal,
            parentApprovalWitness,
            parentApprovalCount,
          );
        });
        await txn.prove();
        await txn.sign([parentCtx.deployerKey]).send();
      }).toThrow('Executed config must match reserved child config');
    });

    it('rejects grandchild creation (hierarchy capped at two levels)', async () => {
      // Set up a real child under the root first, then try to have it spawn
      // a grandchild. The child's propose() must reject CREATE_CHILD because
      // only root guards can raise REMOTE proposals.
      await setupChildWithParentOwners();

      const childCtx: TestContext = {
        zkApp: childZkApp,
        zkAppKey: childKey,
        zkAppAddress: childAddress,
        deployerKey: parentCtx.deployerKey,
        deployerAccount: parentCtx.deployerAccount,
        owners: parentCtx.owners,
        approvalStore: new ApprovalStore(),
        nullifierStore: new VoteNullifierStore(),
        networkId: parentCtx.networkId,
      };

      const grandchildAddress = PrivateKey.random().toPublicKey();
      const grandchildOwners = parentCtx.owners.map((o) => o.pub);
      const grandchildOwnersCommitment = computeOwnerChain(grandchildOwners);

      const proposal = createCreateChildProposal(
        grandchildAddress,
        grandchildOwnersCommitment,
        Field(2),
        Field(3),
        Field(0),
        Field(0),
        childAddress,
        Field(0),
        parentCtx.networkId,
      );

      await expect(
        proposeTransaction(childCtx, proposal, 0),
      ).rejects.toThrow('Remote destination proposals must be proposed on a root guard');
    });

    it('rejects reserveForParent with a parent address that is not a curve point', async () => {
      // no guard can ever live at such an address
      const proposer = parentCtx.owners[0];
      const setupOwners = toFixedSetupOwners(parentCtx.owners.map((o) => o.pub));

      await expect(async () => {
        const txn = await Mina.transaction(proposer.pub, async () => {
          AccountUpdate.fundNewAccount(proposer.pub);
          await childZkApp.deploy();
          await childZkApp.reserveForParent(
            nonCurvePublicKey(),
            Field(0),
            Field(2),
            Field(3),
            new SetupOwnersInput({ owners: setupOwners }),
          );
        });
        await txn.prove();
        await txn.sign([proposer.key, childKey]).send();
      }).toThrow(/Constraint unsatisfied|no square root/);
    });

    it('rejects reserveForParent on an already-initialized root vault', async () => {
      const attackerKey = PrivateKey.random();
      const attackerAddress = attackerKey.toPublicKey();
      const childOwners = parentCtx.owners.map((o) => o.pub);
      const ownersCommitment = computeOwnerChain(childOwners);
      const setupOwners = toFixedSetupOwners(childOwners);

      const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
        await parentCtx.zkApp.reserveForParent(
          attackerAddress,
          Field(999),
          Field(2),
          Field(3),
          new SetupOwnersInput({ owners: setupOwners }),
        );
      });
      await txn.prove();
      await expect(txn.sign([parentCtx.deployerKey]).send()).rejects.toThrow();
    });
  });

  // -- executeAllocateToChildren (on the parent) ------------------------------

  describe('executeAllocateToChildren', () => {
    it('sends MINA to multiple children with different amounts', async () => {
      await setupChildWithParentOwners();

      const childBKey = PrivateKey.random();
      const childBAddress = childBKey.toPublicKey();
      const childBZkApp = new MinaGuard(childBAddress);
      await deployAndSetupChildGuard(
        parentCtx,
        parentCtx.zkAppAddress,
        childBZkApp,
        childBKey,
        childBAddress,
        parentCtx.owners.map((o) => o.pub),
        2,
        [0, 1],
        Field(0),
      );

      const amountA = UInt64.from(500_000_000);
      const amountB = UInt64.from(1_250_000_000);
      const allocateProposal = createAllocateChildProposal(
        [
          new Receiver({ address: childAddress, amount: amountA }),
          new Receiver({ address: childBAddress, amount: amountB }),
        ],
        Field(1),
        Field(0),
        parentCtx.zkAppAddress,
        Field(0),
        parentCtx.networkId,
      );

      const proposalHash = await proposeTransaction(parentCtx, allocateProposal, 0);
      await approveTransaction(parentCtx, allocateProposal, 1);

      const childABefore = getBalance(childAddress);
      const childBBefore = getBalance(childBAddress);
      const approvalCount = parentCtx.approvalStore.getCount(proposalHash);
      const approvalWitness = parentCtx.approvalStore.getWitness(proposalHash);

      const executeTxn = await Mina.transaction(parentCtx.deployerAccount, async () => {
        await parentCtx.zkApp.executeAllocateToChildren(
          allocateProposal,
          approvalWitness,
          approvalCount,
        );
      });
      await executeTxn.prove();
      await executeTxn.sign([parentCtx.deployerKey]).send();

      expect(getBalance(childAddress).sub(childABefore)).toEqual(amountA);
      expect(getBalance(childBAddress).sub(childBBefore)).toEqual(amountB);
    });

    it('rejects replay of an already-executed allocate', async () => {
      await setupChildWithParentOwners();

      const allocateProposal = createAllocateChildProposal(
        [new Receiver({ address: childAddress, amount: UInt64.from(500_000_000) })],
        Field(1),
        Field(0),
        parentCtx.zkAppAddress,
        Field(0),
        parentCtx.networkId,
      );

      const proposalHash = await proposeTransaction(parentCtx, allocateProposal, 0);
      await approveTransaction(parentCtx, allocateProposal, 1);
      const approvalCount = parentCtx.approvalStore.getCount(proposalHash);
      const approvalWitness = parentCtx.approvalStore.getWitness(proposalHash);

      const txn1 = await Mina.transaction(parentCtx.deployerAccount, async () => {
        await parentCtx.zkApp.executeAllocateToChildren(
          allocateProposal,
          approvalWitness,
          approvalCount,
        );
      });
      await txn1.prove();
      await txn1.sign([parentCtx.deployerKey]).send();

      await expect(async () => {
        const txn2 = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await parentCtx.zkApp.executeAllocateToChildren(
            allocateProposal,
            approvalWitness,
            approvalCount,
          );
        });
        await txn2.prove();
        await txn2.sign([parentCtx.deployerKey]).send();
      }).toThrow('Approval root mismatch');
    });

    it('rejects allocate when parent approvals are below threshold', async () => {
      await setupChildWithParentOwners();

      const allocateProposal = createAllocateChildProposal(
        [new Receiver({ address: childAddress, amount: UInt64.from(500_000_000) })],
        Field(1),
        Field(0),
        parentCtx.zkAppAddress,
        Field(0),
        parentCtx.networkId,
      );

      const proposalHash = await proposeTransaction(parentCtx, allocateProposal, 0);
      const approvalCount = parentCtx.approvalStore.getCount(proposalHash);
      const approvalWitness = parentCtx.approvalStore.getWitness(proposalHash);

      await expect(async () => {
        const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await parentCtx.zkApp.executeAllocateToChildren(
            allocateProposal,
            approvalWitness,
            approvalCount,
          );
        });
        await txn.prove();
        await txn.sign([parentCtx.deployerKey]).send();
      }).toThrow('Insufficient approvals');
    });
  });

  // -- executeReclaimToParent -------------------------------------------------

  describe('executeReclaimToParent', () => {
    async function approveReclaim(amount: UInt64, nonce: Field) {
      const proposal = createReclaimChildProposal(
        amount,
        nonce,
        Field(0),
        parentCtx.zkAppAddress,
        Field(0),        childAddress,
      );
      const { parentApprovalWitness, parentApprovalCount, proposalHash } =
        await proposeAndApproveOnParent(parentCtx, proposal, [0, 1]);
      return { proposal, proposalHash, parentApprovalWitness, parentApprovalCount };
    }

    it('reclaims the specified amount to the parent', async () => {
      await setupChildWithParentOwners();

      const reclaimAmount = UInt64.from(1_000_000_000);
      const { proposal, proposalHash, parentApprovalWitness, parentApprovalCount } =
        await approveReclaim(reclaimAmount, Field(1));

      const parentBalanceBefore = getBalance(parentCtx.zkAppAddress);
      const childExecutionWitness = childExecutionWitnessFor(proposalHash);

      const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
        await childZkApp.executeReclaimToParent(
          proposal,
          parentApprovalWitness,
          parentApprovalCount,
          childExecutionWitness,
          reclaimAmount,
        );
      });
      await txn.prove();
      await txn.sign([parentCtx.deployerKey]).send();
      markChildExecutedOffChain(proposalHash);

      const parentBalanceAfter = getBalance(parentCtx.zkAppAddress);
      expect(parentBalanceAfter.sub(parentBalanceBefore)).toEqual(reclaimAmount);
    });

    it('rejects replay of an already-executed reclaim', async () => {
      await setupChildWithParentOwners();

      const amount = UInt64.from(500_000_000);
      const { proposal, proposalHash, parentApprovalWitness, parentApprovalCount } =
        await approveReclaim(amount, Field(1));

      // First execution succeeds.
      const childExecutionWitness = childExecutionWitnessFor(proposalHash);
      const txn1 = await Mina.transaction(parentCtx.deployerAccount, async () => {
        await childZkApp.executeReclaimToParent(
          proposal,
          parentApprovalWitness,
          parentApprovalCount,
          childExecutionWitness,
          amount,
        );
      });
      await txn1.prove();
      await txn1.sign([parentCtx.deployerKey]).send();
      markChildExecutedOffChain(proposalHash);

      // Second execution uses a stale (pre-execution) witness and should fail
      // because the child's on-chain childExecutionRoot has moved.
      await expect(async () => {
        const txn2 = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await childZkApp.executeReclaimToParent(
            proposal,
            parentApprovalWitness,
            parentApprovalCount,
            childExecutionWitness,
            amount,
          );
        });
        await txn2.prove();
        await txn2.sign([parentCtx.deployerKey]).send();
      }).toThrow('Child execution root mismatch');
    });

    it('rejects reclaim when parent approvals are below threshold', async () => {
      await setupChildWithParentOwners();

      const amount = UInt64.from(500_000_000);
      const proposal = createReclaimChildProposal(
        amount,
        Field(1),
        Field(0),
        parentCtx.zkAppAddress,
        Field(0),        childAddress,
      );
      const { parentApprovalWitness, parentApprovalCount, proposalHash } =
        await proposeAndApproveOnParent(parentCtx, proposal, [0]);

      const childExecutionWitness = childExecutionWitnessFor(proposalHash);

      await expect(async () => {
        const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await childZkApp.executeReclaimToParent(
            proposal,
            parentApprovalWitness,
            parentApprovalCount,
            childExecutionWitness,
            amount,
          );
        });
        await txn.prove();
        await txn.sign([parentCtx.deployerKey]).send();
      }).toThrow('Insufficient approvals');
    });

    it('works as a recovery path when childMultiSigEnabled is 0', async () => {
      await setupChildWithParentOwners();

      // Disable the child's multisig first.
      const disableProposal = createEnableChildMultiSigProposal(
        Field(0),
        Field(1),
        Field(0),
        parentCtx.zkAppAddress,
        Field(0),        childAddress,
      );
      {
        const { parentApprovalWitness, parentApprovalCount, proposalHash } =
          await proposeAndApproveOnParent(parentCtx, disableProposal, [0, 1]);
        const childExecutionWitness = childExecutionWitnessFor(proposalHash);
        const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await childZkApp.executeEnableChildMultiSig(
            disableProposal,
            parentApprovalWitness,
            parentApprovalCount,
            childExecutionWitness,
            Field(0),
          );
        });
        await txn.prove();
        await txn.sign([parentCtx.deployerKey]).send();
        markChildExecutedOffChain(proposalHash);
      }
      expect(childZkApp.childMultiSigEnabled.get()).toEqual(Field(0));

      // Reclaim should still work — child-lifecycle methods bypass the flag.
      const amount = UInt64.from(1_000_000_000);
      const { proposal, proposalHash, parentApprovalWitness, parentApprovalCount } =
        await approveReclaim(amount, Field(2));

      const parentBalanceBefore = getBalance(parentCtx.zkAppAddress);
      const childExecutionWitness = childExecutionWitnessFor(proposalHash);

      const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
        await childZkApp.executeReclaimToParent(
          proposal,
          parentApprovalWitness,
          parentApprovalCount,
          childExecutionWitness,
          amount,
        );
      });
      await txn.prove();
      await txn.sign([parentCtx.deployerKey]).send();
      markChildExecutedOffChain(proposalHash);

      expect(getBalance(parentCtx.zkAppAddress).sub(parentBalanceBefore)).toEqual(amount);
    });

    it('rejects reclaim when amount does not match proposal data', async () => {
      await setupChildWithParentOwners();

      const approvedAmount = UInt64.from(1_000_000_000);
      const wrongAmount = UInt64.from(2_000_000_000);
      const { proposal, proposalHash, parentApprovalWitness, parentApprovalCount } =
        await approveReclaim(approvedAmount, Field(1));

      const childExecutionWitness = childExecutionWitnessFor(proposalHash);

      await expect(async () => {
        const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await childZkApp.executeReclaimToParent(
            proposal,
            parentApprovalWitness,
            parentApprovalCount,
            childExecutionWitness,
            wrongAmount,
          );
        });
        await txn.prove();
        await txn.sign([parentCtx.deployerKey]).send();
      }).toThrow('Data does not match reclaim amount');
    });
  });

  // -- executeDestroy ---------------------------------------------------------

  describe('executeDestroy', () => {
    it('sends the full child balance to parent and disables multisig', async () => {
      await setupChildWithParentOwners();

      const destroyProposal = createDestroyChildProposal(
        Field(1),
        Field(0),
        parentCtx.zkAppAddress,
        Field(0),        childAddress,
      );
      const { parentApprovalWitness, parentApprovalCount, proposalHash } =
        await proposeAndApproveOnParent(parentCtx, destroyProposal, [0, 1]);

      const childBalanceBefore = getBalance(childAddress);
      const parentBalanceBefore = getBalance(parentCtx.zkAppAddress);
      const childExecutionWitness = childExecutionWitnessFor(proposalHash);

      const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
        await childZkApp.executeDestroy(
          destroyProposal,
          parentApprovalWitness,
          parentApprovalCount,
          childExecutionWitness,
        );
      });
      await txn.prove();
      await txn.sign([parentCtx.deployerKey]).send();
      markChildExecutedOffChain(proposalHash);

      const childBalanceAfter = getBalance(childAddress);
      const parentBalanceAfter = getBalance(parentCtx.zkAppAddress);

      expect(childBalanceAfter).toEqual(UInt64.from(0));
      expect(parentBalanceAfter.sub(parentBalanceBefore)).toEqual(childBalanceBefore);
      expect(childZkApp.childMultiSigEnabled.get()).toEqual(Field(0));
    });

    it('rejects replay of an already-executed destroy', async () => {
      await setupChildWithParentOwners();

      const destroyProposal = createDestroyChildProposal(
        Field(1),
        Field(0),
        parentCtx.zkAppAddress,
        Field(0),        childAddress,
      );
      const { parentApprovalWitness, parentApprovalCount, proposalHash } =
        await proposeAndApproveOnParent(parentCtx, destroyProposal, [0, 1]);

      const childExecutionWitness = childExecutionWitnessFor(proposalHash);
      const txn1 = await Mina.transaction(parentCtx.deployerAccount, async () => {
        await childZkApp.executeDestroy(
          destroyProposal,
          parentApprovalWitness,
          parentApprovalCount,
          childExecutionWitness,
        );
      });
      await txn1.prove();
      await txn1.sign([parentCtx.deployerKey]).send();
      markChildExecutedOffChain(proposalHash);

      await expect(async () => {
        const txn2 = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await childZkApp.executeDestroy(
            destroyProposal,
            parentApprovalWitness,
            parentApprovalCount,
            childExecutionWitness,
          );
        });
        await txn2.prove();
        await txn2.sign([parentCtx.deployerKey]).send();
      }).toThrow('Child execution root mismatch');
    });

    it('rejects destroy when parent approvals are below threshold', async () => {
      await setupChildWithParentOwners();

      const destroyProposal = createDestroyChildProposal(
        Field(1),
        Field(0),
        parentCtx.zkAppAddress,
        Field(0),        childAddress,
      );
      const { parentApprovalWitness, parentApprovalCount, proposalHash } =
        await proposeAndApproveOnParent(parentCtx, destroyProposal, [0]);

      const childExecutionWitness = childExecutionWitnessFor(proposalHash);

      await expect(async () => {
        const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await childZkApp.executeDestroy(
            destroyProposal,
            parentApprovalWitness,
            parentApprovalCount,
            childExecutionWitness,
          );
        });
        await txn.prove();
        await txn.sign([parentCtx.deployerKey]).send();
      }).toThrow('Insufficient approvals');
    });
  });

  // -- executeEnableChildMultiSig ---------------------------------------------

  describe('executeEnableChildMultiSig', () => {
    async function runEnable(enabled: Field, nonce: Field) {
      const proposal = createEnableChildMultiSigProposal(
        enabled,
        nonce,
        Field(0),
        parentCtx.zkAppAddress,
        Field(0),        childAddress,
      );
      const { parentApprovalWitness, parentApprovalCount, proposalHash } =
        await proposeAndApproveOnParent(parentCtx, proposal, [0, 1]);

      const childExecutionWitness = childExecutionWitnessFor(proposalHash);
      const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
        await childZkApp.executeEnableChildMultiSig(
          proposal,
          parentApprovalWitness,
          parentApprovalCount,
          childExecutionWitness,
          enabled,
        );
      });
      await txn.prove();
      await txn.sign([parentCtx.deployerKey]).send();
      markChildExecutedOffChain(proposalHash);
    }

    it('rejects when proposal data does not match the enabled arg', async () => {
      await setupChildWithParentOwners();

      const proposal = createEnableChildMultiSigProposal(
        Field(0), // data = disable
        Field(1),
        Field(0),
        parentCtx.zkAppAddress,
        Field(0),        childAddress,
      );
      const { parentApprovalWitness, parentApprovalCount, proposalHash } =
        await proposeAndApproveOnParent(parentCtx, proposal, [0, 1]);

      const childExecutionWitness = childExecutionWitnessFor(proposalHash);
      await expect(async () => {
        const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await childZkApp.executeEnableChildMultiSig(
            proposal,
            parentApprovalWitness,
            parentApprovalCount,
            childExecutionWitness,
            Field(1), // arg = enable, mismatched
          );
        });
        await txn.prove();
        await txn.sign([parentCtx.deployerKey]).send();
      }).toThrow('Data does not match enabled flag');
    });

    it('rejects replay of an already-executed enableChildMultiSig', async () => {
      await setupChildWithParentOwners();

      const proposal = createEnableChildMultiSigProposal(
        Field(0),
        Field(1),
        Field(0),
        parentCtx.zkAppAddress,
        Field(0),        childAddress,
      );
      const { parentApprovalWitness, parentApprovalCount, proposalHash } =
        await proposeAndApproveOnParent(parentCtx, proposal, [0, 1]);

      const childExecutionWitness = childExecutionWitnessFor(proposalHash);
      const txn1 = await Mina.transaction(parentCtx.deployerAccount, async () => {
        await childZkApp.executeEnableChildMultiSig(
          proposal,
          parentApprovalWitness,
          parentApprovalCount,
          childExecutionWitness,
          Field(0),
        );
      });
      await txn1.prove();
      await txn1.sign([parentCtx.deployerKey]).send();
      markChildExecutedOffChain(proposalHash);

      await expect(async () => {
        const txn2 = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await childZkApp.executeEnableChildMultiSig(
            proposal,
            parentApprovalWitness,
            parentApprovalCount,
            childExecutionWitness,
            Field(0),
          );
        });
        await txn2.prove();
        await txn2.sign([parentCtx.deployerKey]).send();
      }).toThrow('Child execution root mismatch');
    });

    // Generous per-test timeout: this drives ~13 prove calls end-to-end
    // (setup + disable + 6 gated methods + re-enable + 6 gated methods) and
    // routinely runs 90–120s, well beyond the suite's default 20s cap.
    it('disabling blocks every LOCAL multisig method; re-enabling restores them', async () => {
      await setupChildWithParentOwners();

      // Disable.
      await runEnable(Field(0), Field(1));
      expect(childZkApp.childMultiSigEnabled.get()).toEqual(Field(0));

      // assertChildMultiSigEnabledIfChild() is the first check in every gated
      // method, so the proof aborts before any approval/witness validation —
      // dummy approval state is enough to prove the gate fires on execute*.
      const childOwnerPubs = parentCtx.owners.map((o) => o.pub);
      const dummyApprovalWitness = new MerkleMap().getWitness(Field(0));
      const dummyApprovalCount = Field(0);
      const dummyOwnerWitness = makeOwnerWitness(childOwnerPubs);

      // Child uses parentCtx's owners as its initial owner set.
      const childCtx: TestContext = {
        ...parentCtx,
        zkApp: childZkApp,
        zkAppKey: childKey,
        zkAppAddress: childAddress,
        approvalStore: new ApprovalStore(),
        nullifierStore: new VoteNullifierStore(),
      };

      // propose
      const localTransfer = createTransferProposal(
        [new Receiver({ address: parentCtx.zkAppAddress, amount: UInt64.from(1) })],
        Field(100), Field(0), childAddress, Field(0), parentCtx.networkId,
      );
      await expect(
        proposeTransaction(childCtx, localTransfer, 0),
      ).rejects.toThrow('Child multi-sig disabled');

      // approveProposal
      await expect(
        approveTransaction(childCtx, localTransfer, 0),
      ).rejects.toThrow('Child multi-sig disabled');

      // executeTransfer
      await expect(async () => {
        const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await childZkApp.executeTransfer(localTransfer, dummyApprovalWitness, dummyApprovalCount);
        });
        await txn.prove();
        await txn.sign([parentCtx.deployerKey]).send();
      }).toThrow('Child multi-sig disabled');

      // executeOwnerChange (ADD_OWNER)
      {
        const newOwner = PrivateKey.random().toPublicKey();
        const ownerChange = createAddOwnerProposal(
          newOwner, childOwnerPubs, Field(101), Field(0), childAddress, Field(0), parentCtx.networkId,
        );
        const insertAfter = sortedInsertAfter(childOwnerPubs, newOwner);
        await expect(async () => {
          const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
            await childZkApp.executeOwnerChange(
              ownerChange, dummyApprovalWitness, dummyApprovalCount,
              dummyOwnerWitness, insertAfter,
            );
          });
          await txn.prove();
          await txn.sign([parentCtx.deployerKey]).send();
        }).toThrow('Child multi-sig disabled');
      }

      // executeThresholdChange
      {
        const thresholdChange = createThresholdProposal(
          Field(2), Field(102), Field(0), childAddress, Field(0), parentCtx.networkId,
        );
        await expect(async () => {
          const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
            await childZkApp.executeThresholdChange(
              thresholdChange, dummyApprovalWitness, dummyApprovalCount, Field(2),
            );
          });
          await txn.prove();
          await txn.sign([parentCtx.deployerKey]).send();
        }).toThrow('Child multi-sig disabled');
      }

      // executeDelegate
      {
        const delegateTarget = PrivateKey.random().toPublicKey();
        const delegate = createDelegateProposal(
          delegateTarget, Field(103), Field(0), childAddress, Field(0), parentCtx.networkId,
        );
        await expect(async () => {
          const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
            await childZkApp.executeDelegate(delegate, dummyApprovalWitness, dummyApprovalCount);
          });
          await txn.prove();
          await txn.sign([parentCtx.deployerKey]).send();
        }).toThrow('Child multi-sig disabled');
      }

      // Re-enable; every gated method must now reach past the disable check.
      await runEnable(Field(1), Field(2));
      expect(childZkApp.childMultiSigEnabled.get()).toEqual(Field(1));

      // Helper: calls `fn` and asserts any thrown error is NOT the gate error.
      // Not throwing at all (propose/approve succeed end-to-end) is also fine.
      const assertChildMultiSigEnabled = async (fn: () => Promise<unknown>) => {
        try { await fn(); } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          expect(msg).not.toContain('Child multi-sig disabled');
        }
      };

      // propose + approve now succeed end-to-end on the re-enabled child.
      await assertChildMultiSigEnabled(() => proposeTransaction(childCtx, localTransfer, 0));
      await assertChildMultiSigEnabled(() => approveTransaction(childCtx, localTransfer, 1));

      // executeTransfer with dummy witnesses fails downstream (approval root
      // mismatch), not at the gate — which is all we need to confirm here.
      await assertChildMultiSigEnabled(async () => {
        const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await childZkApp.executeTransfer(localTransfer, dummyApprovalWitness, dummyApprovalCount);
        });
        await txn.prove();
        await txn.sign([parentCtx.deployerKey]).send();
      });

      // executeOwnerChange
      {
        const newOwner = PrivateKey.random().toPublicKey();
        const ownerChange = createAddOwnerProposal(
          newOwner, childOwnerPubs, Field(110), Field(0), childAddress, Field(0), parentCtx.networkId,
        );
        const insertAfter = sortedInsertAfter(childOwnerPubs, newOwner);
        await assertChildMultiSigEnabled(async () => {
          const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
            await childZkApp.executeOwnerChange(
              ownerChange, dummyApprovalWitness, dummyApprovalCount,
              dummyOwnerWitness, insertAfter,
            );
          });
          await txn.prove();
          await txn.sign([parentCtx.deployerKey]).send();
        });
      }

      // executeThresholdChange
      {
        const thresholdChange = createThresholdProposal(
          Field(2), Field(111), Field(0), childAddress, Field(0), parentCtx.networkId,
        );
        await assertChildMultiSigEnabled(async () => {
          const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
            await childZkApp.executeThresholdChange(
              thresholdChange, dummyApprovalWitness, dummyApprovalCount, Field(2),
            );
          });
          await txn.prove();
          await txn.sign([parentCtx.deployerKey]).send();
        });
      }

      // executeDelegate
      {
        const delegateTarget = PrivateKey.random().toPublicKey();
        const delegate = createDelegateProposal(
          delegateTarget, Field(112), Field(0), childAddress, Field(0), parentCtx.networkId,
        );
        await assertChildMultiSigEnabled(async () => {
          const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
            await childZkApp.executeDelegate(delegate, dummyApprovalWitness, dummyApprovalCount);
          });
          await txn.prove();
          await txn.sign([parentCtx.deployerKey]).send();
        });
      }
    }, 180_000);
  });

  // -- Cross-child hash isolation ---------------------------------------------

  describe('cross-child isolation', () => {
    it('a reclaim proposal targeted at child A cannot execute on child B', async () => {
      await setupChildWithParentOwners();

      // Deploy + setup a second child (child B) under the same parent.
      const childBKey = PrivateKey.random();
      const childBAddress = childBKey.toPublicKey();
      const childBZkApp = new MinaGuard(childBAddress);
      await deployAndSetupChildGuard(
        parentCtx,
        parentCtx.zkAppAddress,
        childBZkApp,
        childBKey,
        childBAddress,
        parentCtx.owners.map((o) => o.pub),
        2,
        [0, 1],
        Field(0), // CREATE_CHILD always uses nonce 0; child address still changes the hash
      );
      const childBExecMap = new MerkleMap();

      // A RECLAIM_CHILD proposal targeted at child A.
      const amount = UInt64.from(1_000_000);
      const proposalForA = createReclaimChildProposal(
        amount,
        Field(1),
        Field(0),
        parentCtx.zkAppAddress,
        Field(0),        childAddress,
      );
      const { parentApprovalWitness, parentApprovalCount } =
        await proposeAndApproveOnParent(parentCtx, proposalForA, [0, 1]);

      // Try to execute it on child B — the child B contract asserts the
      // proposal's childAccount equals its own address, so this must fail.
      await expect(async () => {
        const childBExecutionWitness = childBExecMap.getWitness(proposalForA.hash());
        const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await childBZkApp.executeReclaimToParent(
            proposalForA,
            parentApprovalWitness,
            parentApprovalCount,
            childBExecutionWitness,
            amount,
          );
        });
        await txn.prove();
        await txn.sign([parentCtx.deployerKey]).send();
      }).toThrow('Proposal not for this child');
    });
  });

  // -- Parent state binding ---------------------------------------------------

  describe('parent state binding', () => {
    async function expectForgedParentStateRejected(
      maliciousProposal: TransactionProposal,
      execute: (
        parentApprovalWitness: MerkleMapWitness,
        parentApprovalCount: Field,
      ) => Promise<void>,
      realProof = false,
    ) {
      const maliciousHash = maliciousProposal.hash();
      const forgedApprovalCount = PROPOSED_MARKER.add(1);
      const forgedApprovals = new MerkleMap();
      forgedApprovals.set(maliciousHash, forgedApprovalCount);

      const realNetwork = Mina.activeInstance;
      if (realProof) realNetwork.proofsEnabled = true;
      const maliciousProverView = {
        ...realNetwork,
        getAccount(publicKey: PublicKey, tokenId?: Field) {
          const account = realNetwork.getAccount(publicKey, tokenId);
          if (!publicKey.equals(parentCtx.zkAppAddress).toBoolean()) return account;

          const appState = [...account.zkapp!.appState];
          appState[ROOT_STATE_SLOT.threshold] = Field(1);
          appState[ROOT_STATE_SLOT.approvalRoot] = forgedApprovals.getRoot();
          return { ...account, zkapp: { ...account.zkapp!, appState } };
        },
      };

      let attack: Awaited<ReturnType<typeof Mina.transaction>>;
      Mina.setActiveInstance(maliciousProverView);
      try {
        attack = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await execute(
            forgedApprovals.getWitness(maliciousHash),
            forgedApprovalCount,
          );
        });
        const provedAttack = await attack.prove();
        if (realProof) {
          expect(provedAttack.proofs.some((proof) => proof !== undefined)).toBe(true);
        }
      } finally {
        Mina.setActiveInstance(realNetwork);
      }

      const json = JSON.parse(attack.toJSON()) as {
        accountUpdates: Array<{
          body: {
            publicKey: string;
            callDepth: number;
            preconditions: { account: { state: unknown[] } };
          };
        }>;
      };
      const constrainedParentUpdateIndexes = json.accountUpdates.flatMap((update, index) =>
        update.body.publicKey === parentCtx.zkAppAddress.toBase58() &&
        update.body.preconditions.account.state.some((entry) => entry != null)
          ? [index]
          : [],
      );
      const proofUpdateIndex = json.accountUpdates.findIndex(
        (update) => update.body.publicKey === childAddress.toBase58(),
      );

      expect(constrainedParentUpdateIndexes).toHaveLength(1);
      expect(proofUpdateIndex).toBeGreaterThanOrEqual(0);

      const parentUpdateIndex = constrainedParentUpdateIndexes[0];
      const parentUpdate = json.accountUpdates[parentUpdateIndex];
      const proofUpdate = json.accountUpdates[proofUpdateIndex];

      // Account updates are serialized in preorder. Being immediately after
      // the SubVault proof at one greater callDepth proves that the RootVault
      // precondition update is its direct child, and therefore committed to by
      // the SubVault proof's call-forest hash rather than a removable sibling.
      expect(parentUpdateIndex).toBe(proofUpdateIndex + 1);
      expect(parentUpdate.body.callDepth).toBe(proofUpdate.body.callDepth + 1);

      const parentState = parentUpdate.body.preconditions.account.state;
      const constrainedSlots = parentState.flatMap((entry, index) =>
        entry == null ? [] : [index],
      );
      expect(constrainedSlots).toEqual(Object.values(ROOT_STATE_SLOT));

      // The proof was generated against Mallory's substituted parent view, but
      // the attached preconditions are checked against the real RootVault when
      // the transaction is applied and therefore must fail.
      await expect(attack.sign([parentCtx.deployerKey]).send()).rejects.toThrow(
        /Account_app_state_precondition_unsatisfied/,
      );
    }

    it('rejects forged parent state for executeSetupChild', async () => {
      const childOwners = parentCtx.owners.map((owner) => owner.pub);
      const setupOwners = toFixedSetupOwners(childOwners);
      const maliciousProposal = createCreateChildProposal(
        childAddress,
        computeOwnerChain(childOwners),
        Field(2),
        Field(childOwners.length),
        Field(0),
        Field(0),
        parentCtx.zkAppAddress,
        Field(0),
        parentCtx.networkId,
      );

      const reserveTxn = await Mina.transaction(parentCtx.deployerAccount, async () => {
        AccountUpdate.fundNewAccount(parentCtx.deployerAccount);
        await childZkApp.deploy();
        await childZkApp.reserveForParent(
          parentCtx.zkAppAddress,
          maliciousProposal.hash(),
          Field(2),
          Field(childOwners.length),
          new SetupOwnersInput({ owners: setupOwners }),
        );
      });
      await reserveTxn.prove();
      await reserveTxn.sign([parentCtx.deployerKey, childKey]).send();

      await expectForgedParentStateRejected(
        maliciousProposal,
        (parentApprovalWitness, parentApprovalCount) =>
          childZkApp.executeSetupChild(
            Field(2),
            Field(childOwners.length),
            new SetupOwnersInput({ owners: setupOwners }),
            maliciousProposal,
            parentApprovalWitness,
            parentApprovalCount,
          ),
      );
    });

    it('rejects forged parent state for executeReclaimToParent', async () => {
      await setupChildWithParentOwners();
      const amount = UInt64.from(1_000_000);
      const maliciousProposal = createReclaimChildProposal(
        amount, Field(1), Field(0), parentCtx.zkAppAddress,
        Field(0), childAddress,
      );

      await expectForgedParentStateRejected(
        maliciousProposal,
        (parentApprovalWitness, parentApprovalCount) =>
          childZkApp.executeReclaimToParent(
            maliciousProposal,
            parentApprovalWitness,
            parentApprovalCount,
            childExecutionWitnessFor(maliciousProposal.hash()),
            amount,
          ),
      );
    });

    it('rejects forged parent state for executeDestroy', async () => {
      await setupChildWithParentOwners();
      const maliciousProposal = createDestroyChildProposal(
        Field(1), Field(0), parentCtx.zkAppAddress,
        Field(0), childAddress,
      );

      await expectForgedParentStateRejected(
        maliciousProposal,
        (parentApprovalWitness, parentApprovalCount) =>
          childZkApp.executeDestroy(
            maliciousProposal,
            parentApprovalWitness,
            parentApprovalCount,
            childExecutionWitnessFor(maliciousProposal.hash()),
          ),
      );
    });

    it('rejects forged parent state for executeEnableChildMultiSig', async () => {
      await setupChildWithParentOwners();
      const enabled = Field(0);
      const maliciousProposal = createEnableChildMultiSigProposal(
        enabled, Field(1), Field(0), parentCtx.zkAppAddress,
        Field(0), childAddress,
      );

      await expectForgedParentStateRejected(
        maliciousProposal,
        (parentApprovalWitness, parentApprovalCount) =>
          childZkApp.executeEnableChildMultiSig(
            maliciousProposal,
            parentApprovalWitness,
            parentApprovalCount,
            childExecutionWitnessFor(maliciousProposal.hash()),
            enabled,
          ),
      );
    });

    realProofIt('rejects forged parent state with a genuine MinaGuard proof', async () => {
      await setupChildWithParentOwners();
      const maliciousProposal = createDestroyChildProposal(
        Field(1), Field(0), parentCtx.zkAppAddress,
        Field(0), childAddress,
      );

      await expectForgedParentStateRejected(
        maliciousProposal,
        (parentApprovalWitness, parentApprovalCount) =>
          childZkApp.executeDestroy(
            maliciousProposal,
            parentApprovalWitness,
            parentApprovalCount,
            childExecutionWitnessFor(maliciousProposal.hash()),
          ),
        true,
      );
    }, 15 * 60_000);
  });

  // -- Child state binding during parent proposal / approval ---------------

  describe('child nonce state binding', () => {
    async function expectForgedChildStateRejected(
      build: () => Promise<void>,
      realProof = false,
    ) {
      const realNetwork = Mina.activeInstance;
      if (realProof) realNetwork.proofsEnabled = true;
      const maliciousProverView = {
        ...realNetwork,
        getAccount(publicKey: PublicKey, tokenId?: Field) {
          const account = realNetwork.getAccount(publicKey, tokenId);
          if (!publicKey.equals(childAddress).toBoolean()) return account;

          const appState = [...account.zkapp!.appState];
          appState[CHILD_NONCE_STATE_SLOT.ownersCommitment] = Field(123456);
          return { ...account, zkapp: { ...account.zkapp!, appState } };
        },
      };

      let attack: Awaited<ReturnType<typeof Mina.transaction>>;
      Mina.setActiveInstance(maliciousProverView);
      try {
        attack = await Mina.transaction(parentCtx.deployerAccount, build);
        const provedAttack = await attack.prove();
        if (realProof) {
          expect(provedAttack.proofs.some((proof) => proof !== undefined)).toBe(true);
        }
      } finally {
        Mina.setActiveInstance(realNetwork);
      }

      const json = JSON.parse(attack.toJSON()) as {
        accountUpdates: Array<{
          body: {
            publicKey: string;
            callDepth: number;
            preconditions: { account: { state: unknown[] } };
          };
        }>;
      };
      const proofUpdateIndex = json.accountUpdates.findIndex(
        (update) => update.body.publicKey === parentCtx.zkAppAddress.toBase58(),
      );
      const constrainedChildUpdateIndexes = json.accountUpdates.flatMap((update, index) =>
        update.body.publicKey === childAddress.toBase58() &&
        update.body.preconditions.account.state.some((entry) => entry != null)
          ? [index]
          : [],
      );

      expect(proofUpdateIndex).toBeGreaterThanOrEqual(0);
      expect(constrainedChildUpdateIndexes).toHaveLength(1);

      const childUpdateIndex = constrainedChildUpdateIndexes[0];
      const proofUpdate = json.accountUpdates[proofUpdateIndex];
      const childUpdate = json.accountUpdates[childUpdateIndex];
      expect(childUpdateIndex).toBe(proofUpdateIndex + 1);
      expect(childUpdate.body.callDepth).toBe(proofUpdate.body.callDepth + 1);

      const constrainedSlots = childUpdate.body.preconditions.account.state.flatMap(
        (entry, index) => entry == null ? [] : [index],
      );
      expect(constrainedSlots).toEqual(Object.values(CHILD_NONCE_STATE_SLOT));

      await expect(attack.sign([parentCtx.deployerKey]).send()).rejects.toThrow(
        /Account_app_state_precondition_unsatisfied/,
      );
    }

    it('rejects forged child state during propose', async () => {
      await setupChildWithParentOwners();
      const proposal = createDestroyChildProposal(
        Field(1), Field(0), parentCtx.zkAppAddress,
        Field(0), childAddress,
      );
      const proposalHash = proposal.hash();
      const proposer = parentCtx.owners[0];

      await expectForgedChildStateRejected(() =>
        parentCtx.zkApp.propose(
          proposal,
          makeOwnerWitness(parentCtx.owners.map((owner) => owner.pub)),
          proposer.pub,
          Signature.create(proposer.key, [proposalHash]),
          parentCtx.nullifierStore.getWitness(proposalHash, proposer.pub),
          parentCtx.approvalStore.getWitness(proposalHash),
        ),
      );
    });

    it('rejects forged child state during approveProposal', async () => {
      await setupChildWithParentOwners();
      const proposal = createDestroyChildProposal(
        Field(1), Field(0), parentCtx.zkAppAddress,
        Field(0), childAddress,
      );
      const proposalHash = await proposeTransaction(parentCtx, proposal, 0);
      const approver = parentCtx.owners[1];

      await expectForgedChildStateRejected(() =>
        parentCtx.zkApp.approveProposal(
          proposal,
          Signature.create(approver.key, [proposalHash]),
          approver.pub,
          makeOwnerWitness(parentCtx.owners.map((owner) => owner.pub)),
          parentCtx.approvalStore.getWitness(proposalHash),
          parentCtx.approvalStore.getCount(proposalHash),
          parentCtx.nullifierStore.getWitness(proposalHash, approver.pub),
        ),
      );
    });

    realProofIt('rejects forged child state during propose with a genuine MinaGuard proof', async () => {
      await setupChildWithParentOwners();
      const proposal = createDestroyChildProposal(
        Field(1), Field(0), parentCtx.zkAppAddress,
        Field(0), childAddress,
      );
      const proposalHash = proposal.hash();
      const proposer = parentCtx.owners[0];

      await expectForgedChildStateRejected(
        () => parentCtx.zkApp.propose(
          proposal,
          makeOwnerWitness(parentCtx.owners.map((owner) => owner.pub)),
          proposer.pub,
          Signature.create(proposer.key, [proposalHash]),
          parentCtx.nullifierStore.getWitness(proposalHash, proposer.pub),
          parentCtx.approvalStore.getWitness(proposalHash),
        ),
        true,
      );
    }, 15 * 60_000);
  });

  // -- Parent config drift ----------------------------------------------------

  describe('parent config drift', () => {
    it('a REMOTE proposal approved under old parent configNonce is rejected after a threshold change', async () => {
      await setupChildWithParentOwners();

      // Build and approve a RECLAIM_CHILD proposal against parent configNonce=0.
      const amount = UInt64.from(500_000_000);
      const reclaim = createReclaimChildProposal(
        amount,
        Field(1),
        Field(0), // parent configNonce at time of propose
        parentCtx.zkAppAddress,
        Field(0),        childAddress,
      );
      const { parentApprovalWitness, parentApprovalCount, proposalHash } =
        await proposeAndApproveOnParent(parentCtx, reclaim, [0, 1]);

      // Bump the parent's configNonce by running a threshold change (2 -> 3).
      const thresholdChange = createThresholdProposal(
        Field(3),
        Field(1),
        Field(0),
        parentCtx.zkAppAddress,
        Field(0),
        parentCtx.networkId,
      );
      const changeHash = await proposeTransaction(parentCtx, thresholdChange, 0);
      await approveTransaction(parentCtx, thresholdChange, 1);
      const changeCount = parentCtx.approvalStore.getCount(changeHash);
      const changeWitness = parentCtx.approvalStore.getWitness(changeHash);
      const execTxn = await Mina.transaction(parentCtx.deployerAccount, async () => {
        await parentCtx.zkApp.executeThresholdChange(
          thresholdChange,
          changeWitness,
          changeCount,
          Field(3),
        );
      });
      await execTxn.prove();
      await execTxn.sign([parentCtx.deployerKey]).send();

      expect(parentCtx.zkApp.configNonce.get()).toEqual(Field(1));

      // The stale reclaim proposal should fail — its configNonce (0) no longer
      // matches the parent's current configNonce (1).
      const childExecutionWitness = childExecutionWitnessFor(proposalHash);
      await expect(async () => {
        const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await childZkApp.executeReclaimToParent(
            reclaim,
            parentApprovalWitness,
            parentApprovalCount,
            childExecutionWitness,
            amount,
          );
        });
        await txn.prove();
        await txn.sign([parentCtx.deployerKey]).send();
      }).toThrow('Config nonce mismatch');
    });
  });

  // -- Input validation on lifecycle methods ----------------------------------

  describe('executeEnableChildMultiSig input validation', () => {
    it('rejects enabled values outside {0, 1}', async () => {
      await setupChildWithParentOwners();

      // Propose with data = 2; propose-time validation allows arbitrary data
      // for ENABLE_CHILD_MULTI_SIG, so the proposal is accepted on the parent.
      const proposal = createEnableChildMultiSigProposal(
        Field(2),
        Field(1),
        Field(0),
        parentCtx.zkAppAddress,
        Field(0),        childAddress,
      );
      const { parentApprovalWitness, parentApprovalCount, proposalHash } =
        await proposeAndApproveOnParent(parentCtx, proposal, [0, 1]);

      const childExecutionWitness = childExecutionWitnessFor(proposalHash);
      await expect(async () => {
        const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await childZkApp.executeEnableChildMultiSig(
            proposal,
            parentApprovalWitness,
            parentApprovalCount,
            childExecutionWitness,
            Field(2),
          );
        });
        await txn.prove();
        await txn.sign([parentCtx.deployerKey]).send();
      }).toThrow('Enabled must be 0 or 1');
    });
  });

  // -- REMOTE execution leaves parent's approvalRoot intact -------------------

  describe('REMOTE execution leaves parent approvalRoot intact', () => {
    it('child reclaim does not write EXECUTED_MARKER to parent approvalRoot', async () => {
      await setupChildWithParentOwners();

      const amount = UInt64.from(1_000_000_000);
      const reclaim = createReclaimChildProposal(
        amount, Field(1), Field(0), parentCtx.zkAppAddress,
        Field(0), childAddress,
      );
      const { parentApprovalWitness, parentApprovalCount, proposalHash } =
        await proposeAndApproveOnParent(parentCtx, reclaim, [0, 1]);

      // Snapshot parent's approval root before the child executes, and confirm
      // it currently encodes parentApprovalCount at proposalHash.
      const parentApprovalRootBefore = parentCtx.zkApp.approvalRoot.get();
      {
        const [reconstructed] = parentApprovalWitness.computeRootAndKey(parentApprovalCount);
        expect(reconstructed).toEqual(parentApprovalRootBefore);
      }

      const childExecutionWitness = childExecutionWitnessFor(proposalHash);
      const txn = await Mina.transaction(parentCtx.deployerAccount, async () => {
        await childZkApp.executeReclaimToParent(
          reclaim, parentApprovalWitness, parentApprovalCount,
          childExecutionWitness, amount,
        );
      });
      await txn.prove();
      await txn.sign([parentCtx.deployerKey]).send();
      markChildExecutedOffChain(proposalHash);

      // Parent's approvalRoot must be byte-identical to before — REMOTE
      // execution never calls markExecuted on the parent. Replay protection
      // lives in the child's childExecutionRoot.
      const parentApprovalRootAfter = parentCtx.zkApp.approvalRoot.get();
      expect(parentApprovalRootAfter).toEqual(parentApprovalRootBefore);

      // The parent root still verifies against parentApprovalCount, NOT EXECUTED_MARKER.
      const [executedRoot] = parentApprovalWitness.computeRootAndKey(EXECUTED_MARKER);
      expect(parentApprovalRootAfter).not.toEqual(executedRoot);

      // The child's childExecutionRoot, on the other hand, did move and now
      // encodes EXECUTED_MARKER for this proposalHash.
      const expectedChildExecRoot = childExecutionMap.getRoot();
      expect(childZkApp.childExecutionRoot.get()).toEqual(expectedChildExecRoot);
      expect(childZkApp.childExecutionRoot.get()).not.toEqual(EMPTY_MERKLE_MAP_ROOT);
    });
  });

  // -- destroy disables LOCAL methods on the child ----------------------------

  describe('executeDestroy side effects on LOCAL methods', () => {
    it('destroying the child blocks subsequent LOCAL propose calls', async () => {
      await setupChildWithParentOwners();

      const destroyProposal = createDestroyChildProposal(
        Field(1), Field(0), parentCtx.zkAppAddress,
        Field(0), childAddress,
      );
      const { parentApprovalWitness, parentApprovalCount, proposalHash } =
        await proposeAndApproveOnParent(parentCtx, destroyProposal, [0, 1]);

      const childExecutionWitness = childExecutionWitnessFor(proposalHash);
      const destroyTxn = await Mina.transaction(parentCtx.deployerAccount, async () => {
        await childZkApp.executeDestroy(
          destroyProposal, parentApprovalWitness, parentApprovalCount, childExecutionWitness,
        );
      });
      await destroyTxn.prove();
      await destroyTxn.sign([parentCtx.deployerKey]).send();
      markChildExecutedOffChain(proposalHash);

      expect(childZkApp.childMultiSigEnabled.get()).toEqual(Field(0));

      // A LOCAL propose on the destroyed child must fail at assertChildMultiSigEnabledIfChild.
      const childCtx: TestContext = {
        ...parentCtx,
        zkApp: childZkApp,
        zkAppKey: childKey,
        zkAppAddress: childAddress,
        approvalStore: new ApprovalStore(),
        nullifierStore: new VoteNullifierStore(),
      };
      const localTransfer = createTransferProposal(
        [new Receiver({ address: parentCtx.zkAppAddress, amount: UInt64.from(1) })],
        Field(401), Field(0), childAddress, Field(0), parentCtx.networkId,
      );
      await expect(
        proposeTransaction(childCtx, localTransfer, 0),
      ).rejects.toThrow('Child multi-sig disabled');
    });
  });
});
