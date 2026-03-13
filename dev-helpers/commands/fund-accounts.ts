import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AccountUpdate, Mina, PrivateKey, PublicKey, UInt64, fetchAccount } from 'o1js';

const ACCOUNT_MANAGER = process.env.LIGHTNET_ACCOUNT_MANAGER ?? 'http://127.0.0.1:8181';
const MINA_ENDPOINT = process.env.MINA_ENDPOINT ?? 'http://127.0.0.1:8080/graphql';

/** Reads dev-helpers/.env and extracts all public key values (B62...). */
function loadPublicKeys(): string[] {
  const envPath = resolve(import.meta.dirname, '../.env');
  const content = readFileSync(envPath, 'utf-8');
  const keys: string[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const value = trimmed.split('=', 2)[1]?.trim();
    if (value && value.startsWith('B62')) {
      keys.push(value);
    }
  }

  return keys;
}

/** Acquires a funded account from lightnet account manager. */
async function acquireFundedAccount(): Promise<{ publicKey: string; privateKey: string }> {
  const response = await fetch(`${ACCOUNT_MANAGER}/acquire-account`);

  if (!response.ok) {
    throw new Error(`Account manager returned ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as { pk: string; sk: string };
  return { publicKey: data.pk, privateKey: data.sk };
}

/** Funds all public keys from dev-helpers/.env in parallel, one funder per target. */
export async function runFundAccounts(): Promise<void> {
  const publicKeys = loadPublicKeys();

  if (publicKeys.length === 0) {
    console.log('No public keys found in .env');
    return;
  }

  console.log(`Found ${publicKeys.length} public key(s) to fund:`);
  publicKeys.forEach((k) => console.log(`  ${k}`));
  console.log();

  Mina.setActiveInstance(
    Mina.Network({
      mina: MINA_ENDPOINT,
      lightnetAccountManager: ACCOUNT_MANAGER,
    })
  );

  console.log(`Acquiring ${publicKeys.length} funded account(s) from lightnet...`);
  const funders = await Promise.all(publicKeys.map(() => acquireFundedAccount()));
  console.log('Acquired all funders. Building and sending transactions...\n');

  const FEE = UInt64.from(100_000_000); // 0.1 MINA

  // Build and send transactions sequentially (o1js doesn't allow parallel Mina.transaction)
  const pending: { targetKey: string; result: { wait(): Promise<unknown> }; sendAmount: number }[] = [];

  for (let i = 0; i < publicKeys.length; i++) {
    const targetKey = publicKeys[i];
    const funder = funders[i];
    const funderKey = PrivateKey.fromBase58(funder.privateKey);
    const funderPub = PublicKey.fromBase58(funder.publicKey);

    const { account: funderAccount } = await fetchAccount({ publicKey: funderPub });
    const balance = Number(funderAccount?.balance?.toBigInt() ?? 0n);
    const target = PublicKey.fromBase58(targetKey);
    const { account: targetAccount } = await fetchAccount({ publicKey: target });
    const isNew = !targetAccount;

    const sendAmount = Math.floor(balance - 1_100_000_000);
    if (sendAmount <= 0) {
      console.log(`Skipping ${targetKey} — funder has insufficient balance (${(balance / 1e9).toFixed(2)} MINA)`);
      continue;
    }

    const tx = await Mina.transaction({ sender: funderPub, fee: FEE }, async () => {
      if (isNew) AccountUpdate.fundNewAccount(funderPub);
      const update = AccountUpdate.createSigned(funderPub);
      update.send({ to: target, amount: UInt64.from(sendAmount) });
    });

    await tx.prove();
    tx.sign([funderKey]);
    const result = await tx.send();
    console.log(`Sent ${(sendAmount / 1e9).toFixed(2)} MINA to ${targetKey} — tx: ${result.hash}`);
    pending.push({ targetKey, result, sendAmount });
  }

  console.log('\nWaiting for all transactions to be included...');
  for (const entry of pending) {
    try {
      await entry.result.wait();
      console.log(`  Confirmed: ${entry.targetKey}`);
    } catch (error) {
      console.error(`  Failed: ${entry.targetKey} —`, error instanceof Error ? error.message : error);
    }
  }

  console.log('\nDone.');
}
