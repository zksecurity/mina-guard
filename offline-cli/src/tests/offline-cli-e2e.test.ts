import { describe, it, expect, beforeAll } from 'bun:test';
import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  Mina,
  Field,
  PrivateKey,
  PublicKey,
  UInt64,
  AccountUpdate,
  TokenId,
  Signature,
} from 'o1js';
import {
  MinaGuard,
  Receiver,
  TransactionProposal,
  SetupOwnersInput,
  computeOwnerChain,
  OwnerStore,
  ApprovalStore,
  VoteNullifierStore,
  Destination,
  PROPOSED_MARKER,
  MAX_OWNERS,
  MAX_RECEIVERS,
} from 'contracts';

const CLI_PATH = join(import.meta.dirname, '..', 'index.ts');
const BINARY_PATH = join(import.meta.dirname, '..', '..', 'dist',
  process.platform === 'darwin'
    ? `mina-guard-cli-macos-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
    : `mina-guard-cli-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
);
const tmpDir = join(tmpdir(), `offline-cli-e2e-${Date.now()}`);

function safeStringify(obj: unknown): string {
  return JSON.stringify(obj, (_, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (v === undefined) return null;
    return v;
  });
}

function toFixedOwners(pubs: PublicKey[]): PublicKey[] {
  const padded = [...pubs];
  while (padded.length < MAX_OWNERS) padded.push(PublicKey.empty());
  return padded.slice(0, MAX_OWNERS);
}

function runCLI(
  bundlePath: string,
  privateKey: string,
  timeoutMs = 600_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn('bun', ['run', CLI_PATH, bundlePath], {
      env: { ...process.env, MINA_PRIVATE_KEY: privateKey, SKIP_PROOFS: process.env.SKIP_PROOFS ?? '1' },
      cwd: join(import.meta.dirname, '..', '..'),
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ stdout, stderr: stderr + '\n[test] process killed after timeout', code: 1 });
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

function runBinary(
  binaryPath: string,
  bundlePath: string,
  privateKey: string,
  cwd: string,
  timeoutMs = 600_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(binaryPath, [bundlePath], {
      env: { MINA_PRIVATE_KEY: privateKey, SKIP_PROOFS: '1' },
      cwd,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ stdout, stderr: stderr + '\n[test] process killed after timeout', code: 1 });
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

function snapshotAccount(addr: PublicKey): unknown {
  const account = Mina.getAccount(addr);
  const zkapp = (account as any).zkapp;
  return {
    publicKey: account.publicKey.toBase58(),
    token: TokenId.toBase58(account.tokenId),
    nonce: account.nonce.toString(),
    balance: { total: account.balance.toString() },
    tokenSymbol: account.tokenSymbol?.toString() ?? null,
    receiptChainHash: account.receiptChainHash?.toString() ?? null,
    timing: {
      initialMinimumBalance: account.timing?.initialMinimumBalance?.toString() ?? null,
      cliffTime: account.timing?.cliffTime?.toString() ?? null,
      cliffAmount: account.timing?.cliffAmount?.toString() ?? null,
      vestingPeriod: account.timing?.vestingPeriod?.toString() ?? null,
      vestingIncrement: account.timing?.vestingIncrement?.toString() ?? null,
    },
    permissions: null,
    delegateAccount: account.delegate ? { publicKey: account.delegate.toBase58() } : null,
    votingFor: account.votingFor?.toString() ?? null,
    zkappState: zkapp?.appState ? zkapp.appState.map((f: any) => f.toString()) : null,
    verificationKey: zkapp?.verificationKey ? {
      verificationKey: zkapp.verificationKey.data,
      hash: zkapp.verificationKey.hash.toString(),
    } : null,
    actionState: zkapp?.actionState ? zkapp.actionState.map((f: any) => f.toString()) : null,
    provedState: zkapp?.provedState?.toBoolean() ?? null,
    zkappUri: zkapp?.zkappUri ?? null,
  };
}


let owners: Array<{ key: PrivateKey; pub: PublicKey }>;
let zkAppAddress: PublicKey;
let zkApp: MinaGuard;
let deployer: { key: PrivateKey; pub: PublicKey };

const recipient = PrivateKey.random().toPublicKey();
const proposalReceivers = [{ address: recipient.toBase58(), amount: '1000000000' }];
const proposalInput = { txType: 'transfer', nonce: 1, receivers: proposalReceivers };

let proposalHash: string;
let ownerStore: OwnerStore;
let approvalStore: ApprovalStore;
let nullifierStore: VoteNullifierStore;

describe('offline-cli e2e', () => {
  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });

    const Local = await Mina.LocalBlockchain({ proofsEnabled: false });
    Mina.setActiveInstance(Local);

    deployer = { key: Local.testAccounts[0].key, pub: Local.testAccounts[0] as PublicKey };
    owners = [1, 2, 3].map((i) => ({
      key: Local.testAccounts[i].key,
      pub: Local.testAccounts[i] as PublicKey,
    }));
    owners.sort((a, b) => (a.pub.toBase58() > b.pub.toBase58() ? 1 : -1));

    const zkAppKey = PrivateKey.random();
    zkAppAddress = zkAppKey.toPublicKey();
    zkApp = new MinaGuard(zkAppAddress);

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

    const setupTx = await Mina.transaction(deployer.pub, async () => {
      await zkApp.setup(
        computeOwnerChain(owners.map((o) => o.pub)),
        Field(2),
        Field(owners.length),
        Field(1),
        new SetupOwnersInput({ owners: toFixedOwners(owners.map((o) => o.pub)) }),
      );
    });
    await setupTx.prove();
    await setupTx.sign([deployer.key, zkAppKey]).send();

    ownerStore = new OwnerStore();
    for (const o of owners) ownerStore.addSorted(o.pub);
    approvalStore = new ApprovalStore();
    nullifierStore = new VoteNullifierStore();
  }, 600_000);

  it('propose', async () => {
    const proposer = owners[0];

    const rawEvents = await zkApp.fetchEvents();
    const bundleEvents = rawEvents.map((e) => ({
      eventType: e.type,
      payload: JSON.parse(safeStringify(e.event.data)),
    }));

    const bundle = {
      version: 1,
      action: 'propose',
      minaNetwork: 'testnet',
      contractAddress: zkAppAddress.toBase58(),
      feePayerAddress: proposer.pub.toBase58(),
      accounts: {
        [zkAppAddress.toBase58()]: snapshotAccount(zkAppAddress),
        [proposer.pub.toBase58()]: snapshotAccount(proposer.pub),
      },
      events: bundleEvents,
      input: proposalInput,
      configNonce: 0,
      networkId: '1',
    };

    const bundlePath = join(tmpDir, 'propose-bundle.json');
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));

    console.log('[e2e] Running CLI: propose...');
    const result = await runCLI(bundlePath, proposer.key.toBase58());
    console.log('[e2e] CLI stderr:', result.stderr);
    if (result.code !== 0) console.log('[e2e] CLI stdout:', result.stdout);

    expect(result.stderr).toContain('Action: propose');
    expect(result.stderr).toContain('Proposal hash:');
    expect(result.stderr).toContain('Proof generated');
    expect(result.code).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output.version).toBe(1);
    expect(output.type).toBe('offline-signed-tx');
    expect(output.action).toBe('propose');
    expect(output.contractAddress).toBe(zkAppAddress.toBase58());
    expect(output.proposalHash).toBeTruthy();
    expect(output.transaction).toBeTruthy();
    expect(output.transaction.feePayer.authorization).toBeTruthy();

    proposalHash = output.proposalHash;

    // Execute propose on LocalBlockchain to advance state for the next test
    const receivers = [new Receiver({ address: recipient, amount: UInt64.from(1_000_000_000) })];
    while (receivers.length < MAX_RECEIVERS) receivers.push(Receiver.empty());
    const proposal = new TransactionProposal({
      receivers,
      tokenId: Field(0),
      txType: Field(0),
      data: Field(0),
      nonce: Field(1),
      configNonce: Field(0),
      expiryBlock: Field(0),
      networkId: Field(1),
      guardAddress: zkAppAddress,
      destination: Destination.LOCAL,
      childAccount: PublicKey.empty(),
      memoHash: Field(0),
    });
    const pHash = proposal.hash();

    const sig = Signature.create(proposer.key, [pHash]);
    const propTx = await Mina.transaction(proposer.pub, async () => {
      await zkApp.propose(
        proposal,
        ownerStore.getWitness(),
        proposer.pub,
        sig,
        nullifierStore.getWitness(pHash, proposer.pub),
        approvalStore.getWitness(pHash),
      );
    });
    await propTx.prove();
    await propTx.sign([proposer.key]).send();
    nullifierStore.nullify(pHash, proposer.pub);
    approvalStore.setCount(pHash, PROPOSED_MARKER.add(1));

    console.log('[e2e] Propose OK, hash:', proposalHash);
  }, 600_000);

  it('approve', async () => {
    expect(proposalHash).toBeTruthy();
    const approver = owners[1];

    const rawEvents = await zkApp.fetchEvents();
    const bundleEvents = rawEvents.map((e) => ({
      eventType: e.type,
      payload: JSON.parse(safeStringify(e.event.data)),
    }));

    const bundle = {
      version: 1,
      action: 'approve',
      minaNetwork: 'testnet',
      contractAddress: zkAppAddress.toBase58(),
      feePayerAddress: approver.pub.toBase58(),
      accounts: {
        [zkAppAddress.toBase58()]: snapshotAccount(zkAppAddress),
        [approver.pub.toBase58()]: snapshotAccount(approver.pub),
      },
      events: bundleEvents,
      proposal: {
        proposalHash,
        proposer: owners[0].pub.toBase58(),
        toAddress: null,
        tokenId: '0',
        txType: 'transfer',
        data: '0',
        nonce: '1',
        configNonce: '0',
        expiryBlock: '0',
        networkId: '1',
        guardAddress: zkAppAddress.toBase58(),
        destination: 'local',
        childAccount: null,
        receivers: proposalReceivers,
      },
    };

    const bundlePath = join(tmpDir, 'approve-bundle.json');
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));

    console.log('[e2e] Running CLI: approve...');
    const result = await runCLI(bundlePath, approver.key.toBase58());
    console.log('[e2e] CLI stderr:', result.stderr);
    if (result.code !== 0) console.log('[e2e] CLI stdout:', result.stdout);

    expect(result.stderr).toContain('Action: approve');
    expect(result.stderr).toContain('Proposal hash:');
    expect(result.stderr).toContain('Proof generated');
    expect(result.code).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output.version).toBe(1);
    expect(output.type).toBe('offline-signed-tx');
    expect(output.action).toBe('approve');
    expect(output.proposalHash).toBe(proposalHash);
    expect(output.transaction.feePayer.authorization).toBeTruthy();

    // Execute approve on LocalBlockchain to advance state
    const receivers = [new Receiver({ address: recipient, amount: UInt64.from(1_000_000_000) })];
    while (receivers.length < MAX_RECEIVERS) receivers.push(Receiver.empty());
    const proposal = new TransactionProposal({
      receivers,
      tokenId: Field(0),
      txType: Field(0),
      data: Field(0),
      nonce: Field(1),
      configNonce: Field(0),
      expiryBlock: Field(0),
      networkId: Field(1),
      guardAddress: zkAppAddress,
      destination: Destination.LOCAL,
      childAccount: PublicKey.empty(),
      memoHash: Field(0),
    });
    const pHash = proposal.hash();
    const approverSig = Signature.create(approver.key, [pHash]);
    const currentCount = approvalStore.getCount(pHash);
    const approveTx = await Mina.transaction(approver.pub, async () => {
      await zkApp.approveProposal(
        proposal,
        approverSig,
        approver.pub,
        ownerStore.getWitness(),
        approvalStore.getWitness(pHash),
        currentCount,
        nullifierStore.getWitness(pHash, approver.pub),
      );
    });
    await approveTx.prove();
    await approveTx.sign([approver.key]).send();
    nullifierStore.nullify(pHash, approver.pub);
    approvalStore.setCount(pHash, currentCount.add(1));

    console.log('[e2e] Approve OK');
  }, 600_000);

  it('execute transfer', async () => {
    expect(proposalHash).toBeTruthy();
    const executor = owners[2];

    const rawEvents = await zkApp.fetchEvents();
    const bundleEvents = rawEvents.map((e) => ({
      eventType: e.type,
      payload: JSON.parse(safeStringify(e.event.data)),
    }));

    const bundle = {
      version: 1,
      action: 'execute',
      minaNetwork: 'testnet',
      contractAddress: zkAppAddress.toBase58(),
      feePayerAddress: executor.pub.toBase58(),
      accounts: {
        [zkAppAddress.toBase58()]: snapshotAccount(zkAppAddress),
        [executor.pub.toBase58()]: snapshotAccount(executor.pub),
      },
      events: bundleEvents,
      proposal: {
        proposalHash,
        proposer: owners[0].pub.toBase58(),
        toAddress: null,
        tokenId: '0',
        txType: 'transfer',
        data: '0',
        nonce: '1',
        configNonce: '0',
        expiryBlock: '0',
        networkId: '1',
        guardAddress: zkAppAddress.toBase58(),
        destination: 'local',
        childAccount: null,
        receivers: proposalReceivers,
      },
      receiverAccountExists: {
        [recipient.toBase58()]: false,
      },
    };

    const bundlePath = join(tmpDir, 'execute-bundle.json');
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));

    console.log('[e2e] Running CLI: execute...');
    const result = await runCLI(bundlePath, executor.key.toBase58());
    console.log('[e2e] CLI stderr:', result.stderr);
    if (result.code !== 0) console.log('[e2e] CLI stdout:', result.stdout);

    expect(result.stderr).toContain('Action: execute');
    expect(result.stderr).toContain('Proposal hash:');
    expect(result.stderr).toContain('Proof generated');
    expect(result.code).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output.version).toBe(1);
    expect(output.type).toBe('offline-signed-tx');
    expect(output.action).toBe('execute');
    expect(output.proposalHash).toBe(proposalHash);
    expect(output.transaction.feePayer.authorization).toBeTruthy();

    console.log('[e2e] Execute OK');
  }, 600_000);

  it('compiled binary works from isolated directory', async () => {
    if (!existsSync(BINARY_PATH)) {
      console.log('[e2e] Skipping binary test — not built. Run: bun build --compile ...');
      return;
    }

    const isolatedDir = join(tmpDir, 'isolated');
    mkdirSync(isolatedDir, { recursive: true });

    const binaryDest = join(isolatedDir, 'mina-guard-cli');
    copyFileSync(BINARY_PATH, binaryDest);
    const { chmodSync } = await import('fs');
    chmodSync(binaryDest, 0o755);

    const proposer = owners[0];

    const rawEvents = await zkApp.fetchEvents();
    const bundleEvents = rawEvents.map((e) => ({
      eventType: e.type,
      payload: JSON.parse(safeStringify(e.event.data)),
    }));

    const bundle = {
      version: 1,
      action: 'propose',
      minaNetwork: 'testnet',
      contractAddress: zkAppAddress.toBase58(),
      feePayerAddress: proposer.pub.toBase58(),
      accounts: {
        [zkAppAddress.toBase58()]: snapshotAccount(zkAppAddress),
        [proposer.pub.toBase58()]: snapshotAccount(proposer.pub),
      },
      events: bundleEvents,
      input: { txType: 'transfer', nonce: 99, receivers: proposalReceivers },
      configNonce: 0,
      networkId: '1',
    };

    const bundlePath = join(isolatedDir, 'propose-bundle.json');
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));

    console.log('[e2e] Running compiled binary from isolated dir...');
    const result = await runBinary(binaryDest, bundlePath, proposer.key.toBase58(), isolatedDir);
    console.log('[e2e] Binary stderr:', result.stderr);
    if (result.code !== 0) console.log('[e2e] Binary stdout:', result.stdout);

    expect(result.stderr).toContain('Action: propose');
    expect(result.stderr).toContain('Proof generated');
    expect(result.code).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output.version).toBe(1);
    expect(output.type).toBe('offline-signed-tx');
    expect(output.action).toBe('propose');
    expect(output.transaction.feePayer.authorization).toBeTruthy();

    console.log('[e2e] Compiled binary OK');
  }, 600_000);
});
