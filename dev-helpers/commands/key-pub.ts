import { PrivateKey } from 'o1js';

/** Derives the public key from a provided Mina private key. */
export async function runKeyPub(privateKeyText: string): Promise<void> {
  let privateKey;
  try {
    privateKey = PrivateKey.fromBase58(privateKeyText);
  } catch {
    throw new Error('Invalid --private-key value.');
  }

  console.log(`publicKey: ${privateKey.toPublicKey().toBase58()}`);
}
