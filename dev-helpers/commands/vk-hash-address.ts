import { Mina, PublicKey, fetchAccount } from 'o1js';
import { resolveMinaEndpoint } from '../lib/network.ts';

/** Runtime options for reading a verification key hash from a deployed address. */
export interface VkHashAddressOptions {
  address: string;
  minaEndpoint?: string;
}

/** Fetches MinaGuard verification key hash from a deployed address on chain. */
export async function runVkHashAddress(options: VkHashAddressOptions): Promise<void> {
  const endpoint = resolveMinaEndpoint(options.minaEndpoint);
  Mina.setActiveInstance(
    Mina.Network({
      mina: endpoint,
    })
  );

  let publicKey;
  try {
    publicKey = PublicKey.fromBase58(options.address);
  } catch {
    throw new Error(`Invalid --address value: ${options.address}`);
  }

  const accountResult = await fetchAccount({ publicKey });
  if ((accountResult as { error?: unknown }).error) {
    throw new Error(`Account fetch failed: ${(accountResult as { error?: unknown }).error}`);
  }

  const hash =
    (accountResult.account as any)?.zkapp?.verificationKey?.hash ??
    (accountResult.account as any)?.verificationKey?.hash;

  if (!hash) {
    throw new Error(
      `No verification key hash found at ${options.address}. Ensure the account is a deployed zkApp with a verification key.`
    );
  }

  console.log(`address: ${options.address}`);
  console.log(`minaEndpoint: ${endpoint}`);
  console.log(`vkHash: ${hash.toString()}`);
}
