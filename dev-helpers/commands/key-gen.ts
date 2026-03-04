import { PrivateKey } from 'o1js';

/** Generates a new private/public key pair and prints both as base58. */
export async function runKeyGen(): Promise<void> {
  const privateKey = PrivateKey.random();
  const publicKey = privateKey.toPublicKey();

  console.log(`privateKey: ${privateKey.toBase58()}`);
  console.log(`publicKey: ${publicKey.toBase58()}`);
}
