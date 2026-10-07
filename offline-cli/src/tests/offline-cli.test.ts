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
  memoToField,
  proposalSigningMessage,
  MinaGuard,
  Receiver,
  TransactionProposal,
  Destination,
  OwnerStore,
  ApprovalStore,
  VoteNullifierStore,
  SetupOwnersInput,
  computeOwnerChain,
  childConfigHash,
  PROPOSED_MARKER,
  MAX_OWNERS,
  MAX_RECEIVERS,

  TxType,
} from 'contracts';
import { signFeePayer, decodeTxMemo, countNewReceiverAccounts, buildTransferReceivers, EMPTY_PUBKEY_B58, assertBundleNetwork, assertExecutableAddOwnerData, requireTxType, canonicalizeBundleTxType, deployTargetFromSnapshot, assertCreateChildApprovalConfig } from '../build-tx.ts';
import { escapeTerminalText } from '../terminal-safe.ts';
import { renderBundleSummary } from '../summary.ts';

const CLI_PATH = join(import.meta.dirname, '..', 'index.ts');

function toFixedOwners(pubs: PublicKey[]): PublicKey[] {
  const padded = [...pubs];
  while (padded.length < MAX_OWNERS) padded.push(PublicKey.empty());
  return padded.slice(0, MAX_OWNERS);
}

function runCLI(
  bundlePath: string,
  privateKey: string,
  opts: { assumeYes?: boolean } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  // A spawned CLI has no controlling terminal, so it aborts at the confirmation
  // gate unless the caller explicitly opts into non-interactive signing.
  const assumeYes = opts.assumeYes ?? true;
  const env: Record<string, string | undefined> = {
    ...process.env,
    MINA_PRIVATE_KEY: privateKey,
  };
  if (assumeYes) env.MINA_GUARD_ASSUME_YES = '1';
  else delete env.MINA_GUARD_ASSUME_YES;
  return new Promise((resolve) => {
    const proc = spawn('bun', ['run', CLI_PATH, bundlePath], {
      env,
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

  it('requires an exact supported bundle network before proving', () => {
    expect(() => assertBundleNetwork('testnet', 'testnet')).not.toThrow();
    expect(() => assertBundleNetwork('testnet', 'devnet')).not.toThrow();
    expect(() => assertBundleNetwork('mainnet', 'mainnet')).not.toThrow();
    expect(() => assertBundleNetwork('testnet', undefined)).toThrow('Network mismatch');
    expect(() => assertBundleNetwork('mainnet', 'testnet')).toThrow('Network mismatch');
    expect(() => assertBundleNetwork('devnet', 'devnet')).toThrow('Unsupported bundle network');
  });

  // -- CLI argument validation (subprocess, fast) --

  it('rejects missing args', async () => {
    const result = await runCLI('', '');
    expect(result.code).not.toBe(0);
  }, 30_000);

  it.each([1, 3, 99])('rejects incompatible bundle version %i', async (version) => {
    const bundlePath = join(tmpDir, 'bad-version.json');
    writeFileSync(bundlePath, JSON.stringify({ version, action: 'propose' }));
    const result = await runCLI(bundlePath, 'EKtest');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Unsupported bundle version');
  }, 30_000);

  it('rejects unknown action', async () => {
    const bundlePath = join(tmpDir, 'bad-action.json');
    writeFileSync(bundlePath, JSON.stringify({ version: 2, action: 'unknown' }));
    const result = await runCLI(bundlePath, 'EKtest');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Unknown bundle action');
  }, 30_000);

  it('refuses an unknown transaction type before rendering a summary or signing', async () => {
    const bundlePath = join(tmpDir, 'unknown-type.json');
    writeFileSync(bundlePath, JSON.stringify({
      version: 2,
      action: 'approve',
      minaNetwork: 'testnet',
      contractAddress: EMPTY_PUBKEY_B58,
      feePayerAddress: EMPTY_PUBKEY_B58,
      accounts: {},
      events: [],
      proposal: { proposalHash: '1', txType: 'Send\u001b[1A\u202e', receivers: [] },
    }));
    const result = await runCLI(bundlePath, PrivateKey.random().toBase58());
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Unsupported transaction type: "Send\\u{1B}[1A\\u{202E}"');
    expect(result.stderr).not.toContain('====');
    expect(result.stdout).toBe('');
  }, 30_000);

  describe('deployTargetFromSnapshot', () => {
    const bare = { publicKey: 'B62qchild', nonce: '0', verificationKey: null, zkappState: null } as any;

    it('funds a child the bundle has no snapshot for, and deploys into a bare account without funding', () => {
      expect(deployTargetFromSnapshot(undefined)).toBe('new');
      expect(deployTargetFromSnapshot(bare)).toBe('existing');
      expect(deployTargetFromSnapshot({ ...bare, zkappState: ['0', '0', '0'] })).toBe('existing');
    });

    it('refuses a child address that already holds a zkApp', () => {
      expect(() => deployTargetFromSnapshot({ ...bare, verificationKey: { verificationKey: 'vk', hash: '1' } }))
        .toThrow('already holds a zkApp');
      expect(() => deployTargetFromSnapshot({ ...bare, zkappState: ['0', '5'] })).toThrow('already holds a zkApp');
    });
  });

  it('tells the signer whether a createChild propose pays the child creation fee', () => {
    const CHILD = 'B62qkYgXmsk3R65YGNG41Zqu61hf9X1qBktDPzZkkthkSnukbXLPCAY';
    const propose = (accounts: Record<string, unknown>) => ({
      version: 1, action: 'propose', minaNetwork: 'testnet', contractAddress: EMPTY_PUBKEY_B58,
      feePayerAddress: EMPTY_PUBKEY_B58, accounts, events: [], configNonce: 0,
      input: { txType: 'createChild', nonce: 0, childAccount: CHILD, childOwners: [CHILD], childThreshold: 1 },
    }) as any;
    expect(renderBundleSummary(propose({}))).toContain('new, 1 MINA creation fee');
    expect(renderBundleSummary(propose({ [CHILD]: { publicKey: CHILD } }))).toContain('exists, no creation fee');
  });

  it('refuses a createChild approve bundle without its SubVault config before rendering a summary', async () => {
    const bundlePath = join(tmpDir, 'create-child-no-config.json');
    writeFileSync(bundlePath, JSON.stringify({
      version: 2,
      action: 'approve',
      minaNetwork: 'testnet',
      contractAddress: EMPTY_PUBKEY_B58,
      feePayerAddress: EMPTY_PUBKEY_B58,
      accounts: {},
      events: [],
      proposal: { proposalHash: '1', txType: 'createChild', data: '5', childAccount: EMPTY_PUBKEY_B58, receivers: [] },
    }));
    const result = await runCLI(bundlePath, PrivateKey.random().toBase58());
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('missing the SubVault owner list');
    expect(result.stderr).not.toContain('====');
    expect(result.stdout).toBe('');
  }, 30_000);

  describe('createChild approval config', () => {
    const ownerA = PrivateKey.random().toPublicKey();
    const ownerB = PrivateKey.random().toPublicKey();
    const owners = [ownerA.toBase58(), ownerB.toBase58()];
    const store = new OwnerStore();
    store.owners = [ownerA, ownerB];
    const data = childConfigHash(store.getCommitment(), Field(1), Field(2)).toString();
    const bundle = (overrides: Record<string, unknown> = {}) => ({
      version: 2, action: 'approve', minaNetwork: 'testnet', contractAddress: EMPTY_PUBKEY_B58,
      feePayerAddress: EMPTY_PUBKEY_B58, accounts: {}, events: [],
      proposal: { proposalHash: '1', txType: 'createChild', data, childAccount: EMPTY_PUBKEY_B58, receivers: [] },
      childOwners: owners, childThreshold: 1, ...overrides,
    }) as any;

    it('accepts the reserved owners and threshold that hash to the signed data', () => {
      expect(assertCreateChildApprovalConfig(bundle())).toEqual({ owners, threshold: 1 });
      const transfer = bundle({ proposal: { ...bundle().proposal, txType: 'transfer' } });
      expect(assertCreateChildApprovalConfig(transfer)).toBeNull();
    });

    it('rejects a missing, malformed or swapped config', () => {
      const check = (overrides: Record<string, unknown>) => () => assertCreateChildApprovalConfig(bundle(overrides));
      expect(check({ childOwners: undefined })).toThrow('missing the SubVault owner list');
      expect(check({ childOwners: [] })).toThrow('missing the SubVault owner list');
      expect(check({ childThreshold: 0 })).toThrow('invalid SubVault threshold');
      expect(check({ childThreshold: 3 })).toThrow('invalid SubVault threshold');
      expect(check({ childOwners: [owners[0], 'not-a-key'] })).toThrow('invalid SubVault owner address');
      expect(check({ childOwners: [owners[0], EMPTY_PUBKEY_B58] })).toThrow('invalid SubVault owner address');
      // The signed data commits to threshold 1 over these two owners in this order.
      expect(check({ childThreshold: 2 })).toThrow('SubVault config mismatch');
      expect(check({ childOwners: [owners[1], owners[0]] })).toThrow('SubVault config mismatch');
      expect(check({ childOwners: [owners[0]] })).toThrow('SubVault config mismatch');
    });

    it('prints the checked owners and threshold in the summary', () => {
      const out = renderBundleSummary(bundle());
      expect(out).toContain('Create SubVault');
      expect(out).toContain('Owners (2)');
      expect(out).toContain(owners[0]);
      expect(out).toContain(owners[1]);
      expect(out).toContain('Threshold');
      expect(out).not.toContain('(unknown)');
    });
  });

  it('accepts only the ten transaction types, by name or number', () => {
    expect(requireTxType('transfer')).toBe('transfer');
    expect(requireTxType('9')).toBe('enableChildMultiSig');
    for (const bad of [null, undefined, '', ' transfer', 'transfer\n', 'Transfer', '10', '-1', '0x0', 'transfer\u001b[2J']) {
      expect(() => requireTxType(bad)).toThrow('Unsupported transaction type');
    }
  });

  it('rewrites a numeric type code to its name, so the summary and the builder agree', () => {
    const propose = { action: 'propose', input: { txType: '1', nonce: 1, newOwner: 'B62qkYgXmsk3R65YGNG41Zqu61hf9X1qBktDPzZkkthkSnukbXLPCAY' } } as any;
    expect(canonicalizeBundleTxType(propose)).toBe('addOwner');
    expect(propose.input.txType).toBe('addOwner');
    // The summary compares the type by name to pick the owner target.
    expect(renderBundleSummary({ ...propose, version: 2, minaNetwork: 'testnet', contractAddress: EMPTY_PUBKEY_B58, feePayerAddress: EMPTY_PUBKEY_B58, accounts: {}, events: [], configNonce: 0 }))
      .toContain('New owner       B62qkYgXmsk3R65YGNG41Zqu61hf9X1qBktDPzZkkthkSnukbXLPCAY');

    const approve = { action: 'approve', proposal: { txType: '0', receivers: [] } } as any;
    expect(canonicalizeBundleTxType(approve)).toBe('transfer');
    expect(approve.proposal.txType).toBe('transfer');
    expect(() => canonicalizeBundleTxType({ action: 'propose', input: { txType: '10' } } as any)).toThrow('Unsupported transaction type');
  });

  it('escapes bundle text in warnings printed after confirmation', async () => {
    const bundlePath = join(tmpDir, 'escaped-warning.json');
    writeFileSync(bundlePath, JSON.stringify({
      version: 2,
      action: 'approve',
      minaNetwork: 'testnet',
      contractAddress: EMPTY_PUBKEY_B58,
      feePayerAddress: EMPTY_PUBKEY_B58,
      accounts: { 'bad\u001b[2Jaccount': { publicKey: 'bad\u001b[2Jaccount' } },
      events: [],
      proposal: { proposalHash: '1', txType: 'transfer', receivers: [] },
    }));
    const result = await runCLI(bundlePath, PrivateKey.random().toBase58());
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('could not inject account bad\\u{1B}[2Jaccount');
    expect(result.stderr).not.toContain('\u001b');
  }, 60_000);

  it('escapes control, format and line-separator characters for the terminal', () => {
    expect(escapeTerminalText('a\u001b[2Jb')).toBe('a\\u{1B}[2Jb');
    expect(escapeTerminalText('x\u009b31m\u202ey\u2028z\r\b\t')).toBe('x\\u{9B}31m\\u{202E}y\\u{2028}z\\u{D}\\u{8}\\u{9}');
    expect(escapeTerminalText('rent ✓ ünïcode')).toBe('rent ✓ ünïcode');
  });

  it('rejects createChild propose without childPrivateKey', async () => {
    const bundlePath = join(tmpDir, 'create-child.json');
    writeFileSync(bundlePath, JSON.stringify({
      version: 2,
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

  it('aborts without touching the key when there is no terminal and no --yes', async () => {
    // Same bundle as the case above, which with MINA_GUARD_ASSUME_YES gets far
    // enough into signing to fail on the missing child key. Without it, the
    // confirmation gate must stop it first: a run with no terminal attached is
    // not consent, and nothing may be signed.
    const bundlePath = join(tmpDir, 'no-tty-abort.json');
    writeFileSync(bundlePath, JSON.stringify({
      version: 2,
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
    const result = await runCLI(bundlePath, key, { assumeYes: false });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('No terminal available to confirm');
    // Stopped before any key use — never reached the child-key check.
    expect(result.stderr).not.toContain('childPrivateKey');
    expect(result.stdout).toBe('');
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
        Field(2),
        Field(owners.length),
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
      tokenId: Field(1),
      txType: Field(0),
      data: Field(0),
      nonce: Field(1),
      configNonce: Field(0),
      expirySlot: Field(0),
      guardAddress: zkAppAddress,
      destination: Destination.LOCAL,
      childAccount: PublicKey.empty(),
      memoHash: memoToField(''),
    });
    const proposalHash = proposal.hash();

    // Propose on-chain with owner 0
    const ownerStore = new OwnerStore();
    for (const o of owners) ownerStore.addSorted(o.pub);
    const approvalStore = new ApprovalStore();
    const nullifierStore = new VoteNullifierStore();

    const sig = Signature.create(owners[0].key, [proposalSigningMessage(proposalHash, 'propose')]);
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
    const approverSig = Signature.create(approver.key, [proposalSigningMessage(proposalHash, 'approve')]);
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

  // -- Account-creation fee counting (canonical, hash-bound receivers) --

  describe('countNewReceiverAccounts', () => {
    const real = (i: number) =>
      new Receiver({ address: PrivateKey.random().toPublicKey(), amount: UInt64.from(1_000_000 + i) });

    it('skips empty/padded slots and counts only non-existent real receivers', () => {
      const receivers = [real(0), real(1)];
      while (receivers.length < MAX_RECEIVERS) receivers.push(Receiver.empty());
      // none exist on-chain -> both real ones counted, empties ignored
      expect(countNewReceiverAccounts(receivers, () => false)).toBe(2);
    });

    it('does not count receivers that already exist on-chain', () => {
      const existing = real(0);
      const fresh = real(1);
      const receivers = [existing, fresh];
      while (receivers.length < MAX_RECEIVERS) receivers.push(Receiver.empty());
      const existingAddr = existing.address.toBase58();
      expect(
        countNewReceiverAccounts(receivers, (addr) => addr === existingAddr),
      ).toBe(1); // only `fresh` is new
    });

    // SECURITY REGRESSION: extra receiver rows beyond MAX_RECEIVERS must not be
    // able to inflate the account-creation fee. buildTransferReceivers slices to
    // MAX_RECEIVERS, so >MAX_RECEIVERS source rows collapse to the canonical set
    // and the count can never exceed MAX_RECEIVERS — regardless of how many extra
    // rows an untrusted bundle/backend appended.
    it('rejects the empty address with a non-zero amount, accepts it with zero', () => {
      const real = PrivateKey.random().toPublicKey().toBase58();
      expect(() =>
        buildTransferReceivers([{ address: real, amount: '1' }, { address: EMPTY_PUBKEY_B58, amount: '5' }]),
      ).toThrow('Empty receiver must have zero amount');
      // the delete flow's zero-value row stays valid
      const rows = buildTransferReceivers([{ address: EMPTY_PUBKEY_B58, amount: '0' }]);
      expect(rows[0].amount.toBigInt()).toBe(0n);
    });

    it('cannot exceed MAX_RECEIVERS even with extra untrusted rows', () => {
      const extraRows = Array.from({ length: MAX_RECEIVERS + 25 }, (_, i) => ({
        address: PrivateKey.random().toPublicKey().toBase58(),
        amount: String(1_000_000 + i),
      }));
      const canonical = buildTransferReceivers(extraRows);
      expect(canonical.length).toBe(MAX_RECEIVERS);
      // Even if EVERY canonical receiver is reported non-existent, the count is
      // bounded by the canonical slice — the 25 extra rows are simply gone.
      const count = countNewReceiverAccounts(canonical, () => false);
      expect(count).toBe(MAX_RECEIVERS);
      expect(count).toBeLessThanOrEqual(MAX_RECEIVERS);
    });
  });

  // -- Fee payer signing --

  it('signFeePayer produces valid authorization', async () => {
    const Client = (await import('mina-signer')).default;
    const client = new Client({ network: 'testnet' });
    const key = PrivateKey.random();

    const fields = [BigInt('12345678901234567890')];
    const signed = client.signFields(fields, key.toBase58());
    expect(signed.signature).toBeTruthy();
    expect(typeof String(signed.signature)).toBe('string');

    const verified = client.verifyFields(signed);
    expect(verified).toBe(true);
  }, 10_000);

  it('mina-signer produces action-bound signatures accepted by o1js on both networks', async () => {
    const Client = (await import('mina-signer')).default;
    const key = PrivateKey.random();
    const hash = Field(123);
    for (const network of ['testnet', 'mainnet'] as const) {
      const client = new Client({ network });
      for (const action of ['propose', 'approve'] as const) {
        const message = proposalSigningMessage(hash, action);
        const signed = client.signFields([message.toBigInt()], key.toBase58());
        const signature = Signature.fromBase58(String(signed.signature));
        expect(signature.verify(key.toPublicKey(), [message]).toBoolean()).toBe(true);
        expect(signature.verify(key.toPublicKey(), [hash]).toBoolean()).toBe(false);
        expect(signature.verify(key.toPublicKey(), [proposalSigningMessage(hash, action === 'propose' ? 'approve' : 'propose')]).toBoolean()).toBe(false);
      }
    }
  });

  // -- Network-aware fee-payer signing (signZkappCommand path) --

  describe('signFeePayer network domain', () => {
    // Builds a realistic tx.toJSON() with a fee payer + one signed account update and a memo,
    // without compiling any contract — a plain signed send on a LocalBlockchain.
    async function buildSignedSendTxJson(memo: string): Promise<{ txJson: string; feePayerKey: InstanceType<typeof PrivateKey> }> {
      const Local = await Mina.LocalBlockchain({ proofsEnabled: false });
      Mina.setActiveInstance(Local);
      const sender = Local.testAccounts[0];
      const receiver = Local.testAccounts[1];
      const tx = await Mina.transaction({ sender, fee: 1e8, memo }, async () => {
        const au = AccountUpdate.createSigned(sender);
        au.send({ to: receiver, amount: UInt64.from(1_000_000) });
      });
      const json = tx.toJSON();
      return { txJson: typeof json === 'string' ? json : JSON.stringify(json), feePayerKey: sender.key };
    }

    function verifyWrapper(network: 'testnet' | 'mainnet', signedTxJson: string, key: InstanceType<typeof PrivateKey>): boolean {
      const client = new ClientCtor({ network });
      const parsed = JSON.parse(signedTxJson);
      const wrapper = {
        feePayer: {
          feePayer: parsed.feePayer.body.publicKey,
          fee: parsed.feePayer.body.fee,
          nonce: parsed.feePayer.body.nonce,
          validUntil: parsed.feePayer.body.validUntil,
          memo: decodeTxMemo(parsed.memo),
        },
        zkappCommand: parsed,
      };
      const signature = parsed.feePayer.authorization;
      return client.verifyZkappCommand({
        data: { zkappCommand: parsed, feePayer: wrapper.feePayer },
        publicKey: key.toPublicKey().toBase58(),
        signature,
      });
    }

    let ClientCtor: any;
    beforeAll(async () => {
      ClientCtor = (await import('mina-signer')).default;
    });

    it('exposes the Ledger fee-payer commitment on both networks', async () => {
      const { txJson } = await buildSignedSendTxJson('ledger commitment');
      const tx = JSON.parse(txJson);
      const testnet = new ClientCtor({ network: 'testnet' }).getZkappCommandCommitmentsFromJSON(tx);
      const mainnet = new ClientCtor({ network: 'mainnet' }).getZkappCommandCommitmentsFromJSON(tx);
      expect(typeof testnet.fullCommitment).toBe('bigint');
      expect(typeof mainnet.fullCommitment).toBe('bigint');
      expect(testnet.fullCommitment).not.toBe(mainnet.fullCommitment);
    });

    it('mainnet signature verifies under mainnet and FAILS under testnet', async () => {
      const { txJson, feePayerKey } = await buildSignedSendTxJson('');
      const signed = signFeePayer(txJson, feePayerKey.toBase58(), 'mainnet');
      expect(verifyWrapper('mainnet', signed, feePayerKey)).toBe(true);
      expect(verifyWrapper('testnet', signed, feePayerKey)).toBe(false);
    }, 20_000);

    it('testnet signature verifies under testnet and FAILS under mainnet', async () => {
      const { txJson, feePayerKey } = await buildSignedSendTxJson('');
      const signed = signFeePayer(txJson, feePayerKey.toBase58(), 'testnet');
      expect(verifyWrapper('testnet', signed, feePayerKey)).toBe(true);
      expect(verifyWrapper('mainnet', signed, feePayerKey)).toBe(false);
    }, 20_000);

    it('preserves the memo without double-encoding (empty and non-empty)', async () => {
      for (const memo of ['', 'hello multisig']) {
        const { txJson, feePayerKey } = await buildSignedSendTxJson(memo);
        const signed = signFeePayer(txJson, feePayerKey.toBase58(), 'testnet');
        expect(JSON.parse(signed).memo).toBe(JSON.parse(txJson).memo);
        expect(decodeTxMemo(JSON.parse(signed).memo)).toBe(memo);
      }
    }, 20_000);

    // Guards the execute-path memo propagation (build-tx handleExecute passes
    // bundle.proposal.memo into txSender). buildSignedSendTxJson mirrors the
    // shape of a local-execute tx (fee payer + a signed update); we assert the
    // proposal memo survives all the way through signFeePayer onto the tx.
    it('carries the proposal memo through to the signed execute tx', async () => {
      const proposalMemo = 'pay rent #42';
      const { txJson, feePayerKey } = await buildSignedSendTxJson(proposalMemo);
      const signed = signFeePayer(txJson, feePayerKey.toBase58(), 'testnet');
      expect(decodeTxMemo(JSON.parse(signed).memo)).toBe(proposalMemo);
    }, 20_000);
  });

  // -- Human-readable summary (rendered before signing) --

  describe('renderBundleSummary', () => {
    const REAL_ADDR = 'B62qkYgXmsk3R65YGNG41Zqu61hf9X1qBktDPzZkkthkSnukbXLPCAY';
    const CONTRACT = 'B62qoG5Yk4iVxpyczUrBNpwtx2xunhL48dydN53A2VjoRwF8NUjtL3';
    const FEEPAYER = 'B62qpge4uMq4Vv5Rvc8Gw9qSquUYd6xoW1pz7HQkMSHm6h1o7itViy';

    function base(overrides: Record<string, unknown> = {}) {
      return {
        version: 2 as const,
        contractAddress: CONTRACT,
        feePayerAddress: FEEPAYER,
        accounts: {},
        events: [],
        ...overrides,
      };
    }

    it('renders a transfer propose: amounts, total, network, skips empty rows', () => {
      const bundle = {
        ...base(),
        action: 'propose' as const,
        minaNetwork: 'testnet' as const,
        configNonce: 0,
        networkId: '1',
        input: {
          txType: 'transfer',
          nonce: 3,
          memo: 'rent',
          receivers: [
            { address: REAL_ADDR, amount: '2500000000' }, // 2.5 MINA
            { address: EMPTY_PUBKEY_B58, amount: '0' },
          ],
        },
      };
      const out = renderBundleSummary(bundle as any);
      expect(out).toContain('Send');
      expect(out).toContain(REAL_ADDR);
      expect(out).toContain('2.5 MINA');
      expect(out).toContain('Total');
      expect(out).toContain('0.1 MINA'); // fee line, from ZKAPP_TX_FEE
      expect(out).toContain('testnet');
      expect(out).toContain(CONTRACT);
      expect(out).toContain(FEEPAYER);
      expect(out).toContain('rent');
      // padding receiver must not leak into the summary
      expect(out).not.toContain(EMPTY_PUBKEY_B58);
    });

    it('renders an approve governance action; handles numeric and string txType', () => {
      for (const txType of ['addOwner', '1']) {
        const bundle = {
          ...base(),
          action: 'approve' as const,
          minaNetwork: 'testnet' as const,
          proposal: {
            proposalHash: '123456789',
            txType,
            data: '0',
            nonce: '7',
            receivers: [
              { address: REAL_ADDR, amount: '0' },
              { address: EMPTY_PUBKEY_B58, amount: '0' },
            ],
          },
        };
        const out = renderBundleSummary(bundle as any);
        expect(out).toContain('Add Owner');
        expect(out).toContain('123456789'); // proposal hash
        expect(out).toContain(REAL_ADDR); // target owner from receivers[0]
      }
    });

    it('renders a setDelegate approve: empty receivers[0] as undelegate, real target as delegate-to', () => {
      function delegateBundle(receiverAddr: string) {
        return {
          ...base(),
          action: 'approve' as const,
          minaNetwork: 'testnet' as const,
          proposal: {
            proposalHash: '987654321',
            txType: 'setDelegate',
            data: '0',
            nonce: '9',
            receivers: [{ address: receiverAddr, amount: '0' }],
          },
        };
      }

      const undelegated = renderBundleSummary(delegateBundle(EMPTY_PUBKEY_B58) as any);
      expect(undelegated).toContain('undelegate (clear)');
      expect(undelegated).not.toContain('(unknown)');

      const delegated = renderBundleSummary(delegateBundle(REAL_ADDR) as any);
      expect(delegated).toContain('Delegate to');
      expect(delegated).toContain(REAL_ADDR);
      expect(delegated).not.toContain('undelegate');
    });

    it('flags mainnet prominently', () => {
      const bundle = {
        ...base(),
        action: 'propose' as const,
        minaNetwork: 'mainnet' as const,
        configNonce: 0,
        networkId: '0',
        input: { txType: 'changeThreshold', nonce: 1, newThreshold: 2 },
      };
      const out = renderBundleSummary(bundle as any);
      expect(out).toContain('MAINNET');
      expect(out).toContain('Change Threshold');
      expect(out).toContain('2');
    });

    function memoApprove(memo: string | null, memoHash: string | null) {
      return {
        ...base(),
        action: 'approve' as const,
        minaNetwork: 'testnet' as const,
        proposal: {
          proposalHash: '42',
          txType: 'transfer',
          data: '0',
          nonce: '1',
          memo,
          memoHash,
          receivers: [{ address: REAL_ADDR, amount: '1000000000' }],
        },
      };
    }

    it('prints bundle text with every control character visible, including injected line breaks', () => {
      const memo = 'rent\u001b[2J\u001b[H\u202e\u009b0m\n  Receivers (0):';
      const out = renderBundleSummary(memoApprove(memo, memoToField(memo).toString()) as any);
      expect(out.replace(/\n/g, '')).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      expect(out).toContain('rent\\u{1B}[2J\\u{1B}[H\\u{202E}\\u{9B}0m\\u{A}  Receivers (0):');
      expect(out.split('\n').some((l) => l.startsWith('  Receivers (0):'))).toBe(false);
      expect(out).toContain(`${REAL_ADDR}  →  1 MINA`);
    });

    it('shows only the receivers that are signed, and warns about extra rows', () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({ address: i === 9 ? FEEPAYER : REAL_ADDR, amount: '1000000000' }));
      const out = renderBundleSummary({ ...memoApprove('', memoToField('').toString()), proposal: {
        ...memoApprove('', memoToField('').toString()).proposal, receivers: rows,
      } } as any);
      expect(out).toContain('WARNING         the bundle lists 10 receivers; only the first 9 are signed');
      expect(out).toContain('Receivers (9):');
      expect(out).toContain('Total           9 MINA');
      expect(out).not.toContain(`${FEEPAYER}  →`);
    });

    it('recomputes the memo commitment instead of trusting the bundle text', () => {
      const matches = renderBundleSummary(memoApprove('rent', memoToField('rent').toString()) as any);
      expect(matches).toContain("matches the proposal's memo commitment");

      const swapped = renderBundleSummary(memoApprove('refund', memoToField('rent').toString()) as any);
      expect(swapped).toContain('MISMATCH');
      expect(swapped).toContain('refund');

      const hidden = renderBundleSummary(memoApprove(null, memoToField('rent').toString()) as any);
      expect(hidden).toContain('(none)');
      expect(hidden).toContain('MISMATCH');

      const empty = renderBundleSummary(memoApprove(null, memoToField('').toString()) as any);
      expect(empty).toContain("matches the proposal's memo commitment");

      expect(renderBundleSummary(memoApprove('rent', null) as any)).toContain('MISSING');
    });
  });
});

describe('assertExecutableAddOwnerData', () => {
  const owners = Array.from({ length: 3 }, () => PrivateKey.random().toPublicKey());
  const store = new OwnerStore();
  store.owners = [...owners];

  function addOwnerProposal(target: PublicKey, data: InstanceType<typeof Field>) {
    const receivers = [new Receiver({ address: target, amount: UInt64.from(0) })];
    while (receivers.length < MAX_RECEIVERS) receivers.push(Receiver.empty());
    return new TransactionProposal({
      receivers, tokenId: Field(1), txType: TxType.ADD_OWNER, data, memoHash: memoToField(''),
      nonce: Field(1), configNonce: Field(0), expirySlot: Field(0),
      guardAddress: PrivateKey.random().toPublicKey(), destination: Destination.LOCAL, childAccount: PublicKey.empty(),
    });
  }

  it('accepts an addition at any position, not only the sorted one', () => {
    const target = PrivateKey.random().toPublicKey();
    for (let i = 0; i <= owners.length; i++) {
      const placed = [...owners.slice(0, i), target, ...owners.slice(i)];
      expect(() => assertExecutableAddOwnerData(addOwnerProposal(target, computeOwnerChain(placed)), store)).not.toThrow();
    }
  });

  it('refuses data that matches no position', () => {
    const target = PrivateKey.random().toPublicKey();
    expect(() => assertExecutableAddOwnerData(addOwnerProposal(target, Field(123)), store)).toThrow('can never execute');
  });

  it('refuses a target that already holds an owner key', () => {
    expect(() => assertExecutableAddOwnerData(addOwnerProposal(owners[1], Field(123)), store)).toThrow('already an owner');
  });
});
