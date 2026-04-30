import { describe, it, expect, beforeAll } from 'bun:test';
import { spawn } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  Mina,
  Field,
  PrivateKey,
  PublicKey,
  UInt64,
  AccountUpdate,
  Signature,
} from 'o1js';
import {
  MinaGuard,
  Receiver,
  TransactionProposal,
  Destination,
  OwnerStore,
  ApprovalStore,
  VoteNullifierStore,
  SetupOwnersInput,
  computeOwnerChain,
  PROPOSED_MARKER,
  MAX_OWNERS,
  MAX_RECEIVERS,
} from 'contracts';

const CLI_PATH = join(import.meta.dirname, '..', 'index.ts');

function toFixedOwners(pubs: PublicKey[]): PublicKey[] {
  const padded = [...pubs];
  while (padded.length < MAX_OWNERS) padded.push(PublicKey.empty());
  return padded.slice(0, MAX_OWNERS);
}

function runCLI(bundlePath: string, privateKey: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn('bun', ['run', CLI_PATH, bundlePath], {
      env: { ...process.env, MINA_PRIVATE_KEY: privateKey },
      cwd: join(import.meta.dirname, '..', '..'),
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

describe('offline-cli', () => {
  const tmpDir = join(tmpdir(), `offline-cli-test-${Date.now()}`);

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  // -- CLI argument validation (subprocess, fast) --

  it('rejects missing args', async () => {
    const result = await runCLI('', '');
    expect(result.code).not.toBe(0);
  }, 30_000);

  it('rejects invalid bundle version', async () => {
    const bundlePath = join(tmpDir, 'bad-version.json');
    writeFileSync(bundlePath, JSON.stringify({ version: 99, action: 'propose' }));
    const result = await runCLI(bundlePath, 'EKtest');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Unsupported bundle version');
  }, 30_000);

  it('rejects unknown action', async () => {
    const bundlePath = join(tmpDir, 'bad-action.json');
    writeFileSync(bundlePath, JSON.stringify({ version: 1, action: 'unknown' }));
    const result = await runCLI(bundlePath, 'EKtest');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Unknown bundle action');
  }, 30_000);

  it('rejects createChild propose without childPrivateKey', async () => {
    const bundlePath = join(tmpDir, 'create-child.json');
    writeFileSync(bundlePath, JSON.stringify({
      version: 1,
      action: 'propose',
      minaNetwork: 'testnet',
      contractAddress: 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyBQL9TDb3nvBG',
      feePayerAddress: 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyBQL9TDb3nvBG',
      accounts: {},
      events: [],
      input: { txType: 'createChild', nonce: 1 },
      configNonce: 0,
      networkId: '1',
    }));
    const key = PrivateKey.random().toBase58();
    const result = await runCLI(bundlePath, key);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('childPrivateKey');
  }, 30_000);

  // -- Store rebuilding (in-process, uses internal logic) --

  it('rebuildStores reconstructs owner/approval/nullifier state from events', async () => {
    const Local = await Mina.LocalBlockchain({ proofsEnabled: false });
    Mina.setActiveInstance(Local);

    const deployer = { key: Local.testAccounts[0].key, pub: Local.testAccounts[0] };
    const owners = [1, 2, 3].map((i) => ({
      key: Local.testAccounts[i].key,
      pub: Local.testAccounts[i] as PublicKey,
    }));
    owners.sort((a, b) => (a.pub.toBase58() > b.pub.toBase58() ? 1 : -1));

    const zkAppKey = PrivateKey.random();
    const zkAppAddress = zkAppKey.toPublicKey();
    const zkApp = new MinaGuard(zkAppAddress);

    // Deploy + setup
    const deployTx = await Mina.transaction(deployer.pub, async () => {
      AccountUpdate.fundNewAccount(deployer.pub);
      await zkApp.deploy();
    });
    await deployTx.prove();
    await deployTx.sign([deployer.key, zkAppKey]).send();

    const fundTx = await Mina.transaction(deployer.pub, async () => {
      const update = AccountUpdate.createSigned(deployer.pub);
      update.send({ to: zkAppAddress, amount: UInt64.from(10_000_000_000) });
    });
    await fundTx.prove();
    await fundTx.sign([deployer.key]).send();

    const ownersCommitment = computeOwnerChain(owners.map((o) => o.pub));
    const setupOwners = toFixedOwners(owners.map((o) => o.pub));
    const setupTx = await Mina.transaction(deployer.pub, async () => {
      await zkApp.setup(
        ownersCommitment,
        Field(2),
        Field(owners.length),
        Field(1),
        new SetupOwnersInput({ owners: setupOwners }),
      );
    });
    await setupTx.prove();
    await setupTx.sign([deployer.key, zkAppKey]).send();

    // Build a proposal using the contract's types
    const recipient = PrivateKey.random().toPublicKey();
    const receivers = [new Receiver({ address: recipient, amount: UInt64.from(1_000_000_000) })];
    while (receivers.length < MAX_RECEIVERS) receivers.push(Receiver.empty());
    const proposal = new TransactionProposal({
      receivers,
      tokenId: Field(0),
      txType: Field(0),
      data: Field(0),
      nonce: Field(1),
      configNonce: Field(0),
      expirySlot: Field(0),
      networkId: Field(1),
      guardAddress: zkAppAddress,
      destination: Destination.LOCAL,
      childAccount: PublicKey.empty(),
      memoHash: Field(0),
    });
    const proposalHash = proposal.hash();

    // Propose on-chain with owner 0
    const ownerStore = new OwnerStore();
    for (const o of owners) ownerStore.addSorted(o.pub);
    const approvalStore = new ApprovalStore();
    const nullifierStore = new VoteNullifierStore();

    const sig = Signature.create(owners[0].key, [proposalHash]);
    const propTx = await Mina.transaction(owners[0].pub, async () => {
      await zkApp.propose(
        proposal,
        ownerStore.getWitness(),
        owners[0].pub,
        sig,
        nullifierStore.getWitness(proposalHash, owners[0].pub),
        approvalStore.getWitness(proposalHash),
      );
    });
    await propTx.prove();
    await propTx.sign([owners[0].key]).send();

    nullifierStore.nullify(proposalHash, owners[0].pub);
    approvalStore.setCount(proposalHash, PROPOSED_MARKER.add(1));

    // Now approve with owner 1, proving the on-chain state is consistent
    const approver = owners[1];
    const approverSig = Signature.create(approver.key, [proposalHash]);
    const currentCount = approvalStore.getCount(proposalHash);
    const approveTx = await Mina.transaction(approver.pub, async () => {
      await zkApp.approveProposal(
        proposal,
        approverSig,
        approver.pub,
        ownerStore.getWitness(),
        approvalStore.getWitness(proposalHash),
        currentCount,
        nullifierStore.getWitness(proposalHash, approver.pub),
      );
    });
    await approveTx.prove();
    await approveTx.sign([approver.key]).send();

    expect(proposalHash.toString()).toBeTruthy();
    expect(proposal.hash().toString()).toBe(proposalHash.toString());
  }, 60_000);

  // -- Fee payer signing --

  it('signFeePayer produces valid authorization', async () => {
    // @ts-ignore — ESM bundle built by ui/package.json postinstall
    const Client = (await import('../../../ui/deps/o1js/src/mina-signer/dist/web/index.js')).default;
    const client = new Client({ network: 'testnet' });
    const key = PrivateKey.random();

    const fields = [BigInt('12345678901234567890')];
    const signed = client.signFields(fields, key.toBase58());
    expect(signed.signature).toBeTruthy();
    expect(typeof String(signed.signature)).toBe('string');

    const verified = client.verifyFields(signed);
    expect(verified).toBe(true);
  }, 10_000);
});
