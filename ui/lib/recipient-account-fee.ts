import { MAX_RECEIVERS } from '@/lib/constants';
import { getMinaGuardConfig } from '@/lib/endpoints';
import { EMPTY_PUBKEY_B58 } from '@/lib/types';

function canonicalRecipientAddresses(
  receivers: ReadonlyArray<{ address: string }>,
): string[] {
  return receivers.slice(0, MAX_RECEIVERS)
    .map((receiver) => receiver.address)
    .filter((address) => address && address !== EMPTY_PUBKEY_B58);
}

/** Match the CLI's per-slot count; repeated new addresses still occupy repeated slots. */
export function countNewRecipientSlotsFromSnapshot(
  receivers: ReadonlyArray<{ address: string }>,
  receiverAccountExists: Readonly<Record<string, boolean>>,
): number {
  return canonicalRecipientAddresses(receivers)
    .filter((address) => receiverAccountExists[address] !== true).length;
}

/** Estimate the executor-funded creation cost immediately before online signing. */
export async function countNewRecipientSlots(
  receivers: ReadonlyArray<{ address: string }>,
): Promise<number> {
  const addresses = canonicalRecipientAddresses(receivers);
  const endpoint = getMinaGuardConfig().minaEndpoint;
  const missing = await Promise.all(addresses.map(async (address) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query($publicKey: PublicKey!) { account(publicKey: $publicKey) { publicKey } }',
        variables: { publicKey: address },
      }),
    });
    if (!response.ok) throw new Error('Could not check recipient accounts. Try again.');
    const result = await response.json();
    if (result.errors || !result.data || !('account' in result.data)) {
      throw new Error('Could not check recipient accounts. Try again.');
    }
    return result.data.account === null;
  }));
  // Count slots, as the transaction builder does, including repeated addresses.
  return missing.filter(Boolean).length;
}
