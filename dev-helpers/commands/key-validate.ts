import { PrivateKey } from 'o1js';

/** Validates Mina private key format and prints the derived public key when valid. */
export async function runKeyValidate(privateKeyText: string): Promise<void> {
  const privateKey = PrivateKey.fromBase58(privateKeyText);
  console.log(`publicKey: ${privateKey.toPublicKey().toBase58()}`);
}
