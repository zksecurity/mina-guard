import { Field, Mina, AccountUpdate, Permissions, UInt64, PublicKey } from 'o1js';
import { EMPTY_MERKLE_MAP_ROOT } from '../constants.js';
import {
  GUARD_DEPLOY_PERMISSIONS,
  GUARD_PERMISSIONS,
} from '../guard-permissions.js';
import { SetupOwnersInput } from '../MinaGuard.js';
import {
  setupLocalBlockchain,
  deployAndSetup,
  getOwnersCommitment,
  toFixedSetupOwners,
  type TestContext,
  negatePublicKey,
  nonCurvePublicKey,
} from './test-helpers.js';
import { computeOwnerChain } from '../list-commitment.js';
import { beforeEach, describe, expect, it } from 'bun:test';

describe('MinaGuard - Setup', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupLocalBlockchain();
  });

  it('should deploy and setup with owners and threshold', async () => {
    await deployAndSetup(ctx, 2);

    expect(ctx.zkApp.ownersCommitment.get()).toEqual(getOwnersCommitment(ctx));
    expect(ctx.zkApp.threshold.get()).toEqual(Field(2));
    expect(ctx.zkApp.numOwners.get()).toEqual(Field(3));
    expect(ctx.zkApp.nonce.get()).toEqual(Field(0));
    expect(ctx.zkApp.parentNonce.get()).toEqual(Field(0));
    expect(ctx.zkApp.configNonce.get()).toEqual(Field(0));
    expect(ctx.zkApp.approvalRoot.get()).toEqual(EMPTY_MERKLE_MAP_ROOT);
    expect(ctx.zkApp.voteNullifierRoot.get()).toEqual(EMPTY_MERKLE_MAP_ROOT);
    expect(Mina.getAccount(ctx.zkAppAddress).permissions).toEqual(
      GUARD_PERMISSIONS,
    );
  });

  it('should overwrite creator-weakened deploy permissions during setup', async () => {
    const { zkApp, zkAppKey, deployerKey, deployerAccount, owners } = ctx;
    const setupOwners = toFixedSetupOwners(owners.map((owner) => owner.pub));

    const txn = await Mina.transaction(deployerAccount, async () => {
      AccountUpdate.fundNewAccount(deployerAccount);
      await zkApp.deploy();

      // A malicious creator controls the signed deployment update. setup() is
      // a separate proof-authorized update and must replace this weakened send.
      zkApp.account.permissions.set({
        ...GUARD_DEPLOY_PERMISSIONS,
        send: Permissions.proofOrSignature(),
      });
      await zkApp.setup(
        Field(2),
        Field(owners.length),
        new SetupOwnersInput({ owners: setupOwners }),
      );
    });
    const accountUpdates = (
      JSON.parse(txn.toJSON()) as { accountUpdates: any[] }
    ).accountUpdates.filter(
      (update) => update.body.publicKey === ctx.zkAppAddress.toBase58(),
    );
    const signedDeploy = accountUpdates.find(
      (update) => update.body.authorizationKind.isSigned === true,
    );
    const provedSetup = accountUpdates.find(
      (update) => update.body.authorizationKind.isProved === true,
    );

    expect(accountUpdates).toHaveLength(2);
    expect(signedDeploy?.body.update.permissions.send).toBe('Either');
    expect(signedDeploy?.body.update.permissions.setPermissions).toBe('Proof');
    expect(provedSetup?.body.update.permissions.send).toBe('Proof');
    expect(provedSetup?.body.update.permissions.setPermissions).toBe(
      'Impossible',
    );
    await txn.prove();
    await txn.sign([deployerKey, zkAppKey]).send();

    expect(Mina.getAccount(ctx.zkAppAddress).permissions).toEqual(
      GUARD_PERMISSIONS,
    );
  });

  it('should reject a creator blocking the proof-authorized permission lock', async () => {
    const { zkApp, zkAppKey, deployerKey, deployerAccount, owners } = ctx;
    const setupOwners = toFixedSetupOwners(owners.map((owner) => owner.pub));

    await expect(async () => {
      const txn = await Mina.transaction(deployerAccount, async () => {
        AccountUpdate.fundNewAccount(deployerAccount);
        await zkApp.deploy();

        // This prevents setup() from writing GUARD_PERMISSIONS. Atomicity must
        // make the complete deployment fail rather than leave an unsafe vault.
        zkApp.account.permissions.set({
          ...GUARD_DEPLOY_PERMISSIONS,
          setPermissions: Permissions.impossible(),
        });
        await zkApp.setup(
          Field(2),
          Field(owners.length),
          new SetupOwnersInput({ owners: setupOwners }),
        );
      });
      await txn.prove();
      await txn.sign([deployerKey, zkAppKey]).send();
    }).toThrow();

    expect(Mina.hasAccount(ctx.zkAppAddress)).toBe(false);
  });

  it('should emit deploy and setup bootstrap events', async () => {
    await deployAndSetup(ctx, 2);

    const events = await ctx.zkApp.fetchEvents();
    const deployed = events.filter((e) => e.type === 'deployed');
    const setupOwner = events.filter((e) => e.type === 'setupOwner');

    expect(deployed.length).toBe(1);
    expect(setupOwner.length).toBe(20);
  });

  it('should reject double setup', async () => {
    await deployAndSetup(ctx, 2);

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.setup(
          Field(2),
          Field(3),
          new SetupOwnersInput({
            owners: toFixedSetupOwners(ctx.owners.map((o) => o.pub)),
          })
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow();
  });

  it('should reject threshold = 0', async () => {
    const { zkApp, zkAppKey, deployerKey, deployerAccount } = ctx;

    // Deploy only
    const deployTxn = await Mina.transaction(deployerAccount, async () => {
      AccountUpdate.fundNewAccount(deployerAccount);
      await zkApp.deploy();
    });
    await deployTxn.prove();
    await deployTxn.sign([deployerKey, zkAppKey]).send();

    await expect(async () => {
      const txn = await Mina.transaction(deployerAccount, async () => {
        await zkApp.setup(
          Field(0),
          Field(3),
          new SetupOwnersInput({
            owners: toFixedSetupOwners(ctx.owners.map((o) => o.pub)),
          })
        );
      });
      await txn.prove();
      await txn.sign([deployerKey, zkAppKey]).send();
    }).toThrow('Threshold must be > 0');
  });

  it('should reject numOwners < threshold', async () => {
    const { zkApp, zkAppKey, deployerKey, deployerAccount } = ctx;

    const deployTxn = await Mina.transaction(deployerAccount, async () => {
      AccountUpdate.fundNewAccount(deployerAccount);
      await zkApp.deploy();
    });
    await deployTxn.prove();
    await deployTxn.sign([deployerKey, zkAppKey]).send();

    await expect(async () => {
      const txn = await Mina.transaction(deployerAccount, async () => {
        await zkApp.setup(
          Field(5),
          Field(3),
          new SetupOwnersInput({
            owners: toFixedSetupOwners(ctx.owners.map((o) => o.pub)),
          })
        );
      });
      await txn.prove();
      await txn.sign([deployerKey]).send();
    }).toThrow('Owners must be >= threshold');
  });

  describe('owner identity checks', () => {
    async function deployOnly() {
      const { zkApp, zkAppKey, deployerKey, deployerAccount } = ctx;
      const deployTxn = await Mina.transaction(deployerAccount, async () => {
        AccountUpdate.fundNewAccount(deployerAccount);
        await zkApp.deploy();
      });
      await deployTxn.prove();
      await deployTxn.sign([deployerKey, zkAppKey]).send();
    }

    async function trySetup(owners: PublicKey[], threshold: number) {
      const { zkApp, zkAppKey, deployerKey, deployerAccount } = ctx;
      const txn = await Mina.transaction(deployerAccount, async () => {
        await zkApp.setup(
          Field(threshold),
          Field(owners.length),
          new SetupOwnersInput({ owners: toFixedSetupOwners(owners) })
        );
      });
      await txn.prove();
      await txn.sign([deployerKey, zkAppKey]).send();
    }

    it('should reject an owner list containing a key and its negation', async () => {
      await deployOnly();
      const [a, b] = ctx.owners.map((o) => o.pub);
      // [a, -a, b] with threshold 2 is really 1-of-2 for a's holder
      await expect(trySetup([a, negatePublicKey(a), b], 2)).rejects.toThrow(
        'Duplicate owner in setup list'
      );
      expect(ctx.zkApp.ownersCommitment.get()).toEqual(Field(0));
    });

    it('should reject an empty key in an active owner slot', async () => {
      await deployOnly();
      const [a, b] = ctx.owners.map((o) => o.pub);
      await expect(trySetup([PublicKey.empty(), a, b], 2)).rejects.toThrow(
        'Active owner must be non-empty'
      );
    });

    it('should reject an owner that is not a curve point', async () => {
      await deployOnly();
      const [a, b] = ctx.owners.map((o) => o.pub);
      await expect(trySetup([a, b, nonCurvePublicKey()], 2)).rejects.toThrow(/Constraint unsatisfied|no square root/);
      expect(ctx.zkApp.ownersCommitment.get()).toEqual(Field(0));
    });
  });

  // TODO: fix
  it.skip('should allow wallet to receive MINA', async () => {
    await deployAndSetup(ctx, 2);

    const balanceBefore = Mina.getBalance(ctx.zkAppAddress);

    const sendTxn = await Mina.transaction(ctx.deployerAccount, async () => {
      const update = AccountUpdate.createSigned(ctx.deployerAccount);
      update.send({ to: ctx.zkAppAddress, amount: UInt64.from(1_000_000) });
    });
    await sendTxn.prove();
    await sendTxn.sign([ctx.deployerKey]).send();

    const balanceAfter = Mina.getBalance(ctx.zkAppAddress);
    expect(balanceAfter.sub(balanceBefore)).toEqual(UInt64.from(1_000_000));
  });
});
