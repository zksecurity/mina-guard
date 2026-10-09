import { AccountUpdate, Cache, Field, Mina, PrivateKey, PublicKey, UInt32, UInt64, addCachedAccount, TokenId } from 'o1js';
import { MinaGuard, NETWORK_DOMAIN_NAME, GUARD_PERMISSION_KINDS, GUARD_PERMISSION_NAMES, GUARD_SET_VERIFICATION_KEY_TXN_VERSION } from 'contracts';
import { assertBundleNetwork, signChildAccount, signFeePayer, ZKAPP_TX_FEE } from './build-tx.js';
import { escapeTerminalText } from './terminal-safe.js';

type Snapshot = {
  nonce: string;
  balance: { total: string };
  token: string;
  zkappState: string[] | null;
  verificationKey: { verificationKey: string; hash: string } | null;
  permissions: Record<string, unknown> | null;
};

export interface MigrationBundle {
  version: 2;
  action: 'migrate-verification-key';
  minaNetwork: 'mainnet' | 'testnet';
  contractAddress: string;
  feePayerAddress: string;
  accounts: Record<string, Snapshot>;
  sourceVerificationKeyHash: string;
  sourceTxnVersion: string;
  targetVerificationKeyHash: string;
  targetTxnVersion: string;
}

export function validateMigrationBundle(bundle: MigrationBundle): void {
  assertBundleNetwork(bundle.minaNetwork, NETWORK_DOMAIN_NAME);
  if (bundle.version !== 2 || bundle.action !== 'migrate-verification-key') throw new Error('Unsupported migration format');
  const vault = bundle.accounts?.[bundle.contractAddress];
  const payer = bundle.accounts?.[bundle.feePayerAddress];
  if (!vault || !payer || !vault.verificationKey || !vault.zkappState ||
      vault.verificationKey.hash !== bundle.sourceVerificationKeyHash) {
    throw new Error('Migration request has no matching vault and fee payer snapshots');
  }
  const permissions = vault.permissions;
  if (!permissions) throw new Error('Migration request is missing vault permissions');
  for (const name of GUARD_PERMISSION_NAMES) {
    const actual = name === 'setVerificationKey'
      ? (permissions[name] as { auth?: unknown } | undefined)?.auth
      : permissions[name];
    if (actual !== GUARD_PERMISSION_KINDS[name]) throw new Error(`Noncanonical vault permission: ${name}`);
  }
  if (String((permissions.setVerificationKey as { txnVersion?: unknown }).txnVersion) !== bundle.sourceTxnVersion ||
      bundle.targetTxnVersion !== GUARD_SET_VERIFICATION_KEY_TXN_VERSION ||
      !/^\d+$/.test(bundle.sourceTxnVersion) ||
      Number(bundle.sourceTxnVersion) >= Number(bundle.targetTxnVersion)) {
    throw new Error('This vault does not have an older transaction version');
  }
  if (bundle.sourceVerificationKeyHash === bundle.targetVerificationKeyHash) {
    throw new Error('Replacement key is identical to the installed key');
  }
}

export function renderMigrationSummary(bundle: MigrationBundle): string {
  validateMigrationBundle(bundle);
  return [
    'MIGRATE VAULT VERIFICATION KEY — deploy-key authority',
    `Network: ${bundle.minaNetwork}`,
    `Vault: ${bundle.contractAddress}`,
    `Fee payer: ${bundle.feePayerAddress}`,
    `Installed VK hash: ${bundle.sourceVerificationKeyHash}`,
    `Replacement VK hash: ${bundle.targetVerificationKeyHash}`,
    `Stored transaction version: ${bundle.sourceTxnVersion}`,
    `Replacement release version: ${bundle.targetTxnVersion}`,
    'This bypasses owner voting. Verify this CLI release and replacement VK hash independently.',
    'Never use a saved deploy key on a connected machine.',
  ].map(escapeTerminalText).join('\n');
}

export async function handleMigration(bundle: MigrationBundle, deployKeyBase58: string, feeKeyBase58: string, log: (message: string) => void) {
  validateMigrationBundle(bundle);
  const deployKey = PrivateKey.fromBase58(deployKeyBase58);
  const feeKey = PrivateKey.fromBase58(feeKeyBase58);
  if (deployKey.toPublicKey().toBase58() !== bundle.contractAddress) throw new Error('Deploy key does not match the vault address');
  if (feeKey.toPublicKey().toBase58() !== bundle.feePayerAddress) throw new Error('Fee payer key does not match the request');
  const network = Mina.Network({ networkId: bundle.minaNetwork, mina: 'http://localhost:0', archive: 'http://localhost:0' });
  Mina.setActiveInstance(network);
  for (const address of new Set([bundle.contractAddress, bundle.feePayerAddress])) {
    const snapshot = bundle.accounts[address];
    addCachedAccount({
      publicKey: PublicKey.fromBase58(address),
      tokenId: snapshot.token ? TokenId.fromBase58(snapshot.token) : TokenId.default,
      nonce: UInt32.from(snapshot.nonce),
      balance: UInt64.from(snapshot.balance.total),
      ...(snapshot.zkappState ? { zkapp: {
        appState: snapshot.zkappState.map((value) => Field(value)),
        ...(snapshot.verificationKey ? { verificationKey: {
          data: snapshot.verificationKey.verificationKey,
          hash: Field(snapshot.verificationKey.hash),
        } } : {}),
      } } : {}),
    });
  }
  log('Compiling this release’s replacement verification key...');
  const { verificationKey } = await MinaGuard.compile({ cache: Cache.FileSystem('./cache') });
  if (verificationKey.hash.toString() !== bundle.targetVerificationKeyHash) {
    throw new Error('This CLI release does not compile to the requested replacement VK hash');
  }
  const tx = await Mina.transaction({ sender: feeKey.toPublicKey(), fee: ZKAPP_TX_FEE }, async () => {
    AccountUpdate.createSigned(deployKey.toPublicKey()).account.verificationKey.set(verificationKey);
  });
  const raw = tx.toJSON();
  const json = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const signedPayer = signFeePayer(json, feeKeyBase58, bundle.minaNetwork);
  const signedBoth = signChildAccount(signedPayer, deployKey, bundle.minaNetwork);
  return {
    version: 2 as const, type: 'offline-signed-tx' as const,
    action: 'migrate-verification-key' as const,
    contractAddress: bundle.contractAddress,
    feePayerAddress: bundle.feePayerAddress,
    sourceVerificationKeyHash: bundle.sourceVerificationKeyHash,
    targetVerificationKeyHash: bundle.targetVerificationKeyHash,
    transaction: JSON.parse(signedBoth),
  };
}
