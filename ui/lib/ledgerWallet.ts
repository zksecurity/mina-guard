// -- Ledger Wallet Integration ---------------------------------------------

import TransportWebHID from '@ledgerhq/hw-transport-webhid';
import type Transport from '@ledgerhq/hw-transport';
import { MinaApp } from '@zondax/ledger-mina-js';

let transport: Transport | null = null;
let app: MinaApp | null = null;

/** Returns true when WebHID is available in the current browser. */
export function isLedgerSupported(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as any).hid;
}

/** Opens a WebHID transport and initialises the Mina Ledger app. */
async function getApp(): Promise<MinaApp> {
  if (!app) {
    transport = await TransportWebHID.create();
    app = new MinaApp(transport);
  }
  return app;
}

/** Closes the active transport connection. */
export async function disconnectLedger(): Promise<void> {
  if (transport) {
    await transport.close();
    transport = null;
    app = null;
  }
}

/** Retrieves the Mina address at the given BIP44 path from the Ledger device. */
export async function getLedgerAddress(
  accountIndex = 0
): Promise<string | null> {
  try {
    const ledger = await getApp();
    console.log(await ledger.getAppName());
    console.log(await ledger.getAppVersion());
    const result = await ledger.getAddress(accountIndex, true);
    console.log('[Ledger] getAddress result:', result);
    return result.publicKey ?? null;
  } catch (error) {
    console.log(error);
    return null;
  }
}

/** Signs a transaction JSON string using the Ledger device. */
export async function signTransaction(
  transactionJson: string,
  _accountIndex = 0
): Promise<string | null> {
  try {
    const ledger = await getApp();
    const result = await ledger.signTransaction(JSON.parse(transactionJson));
    return result.signature ?? null;
  } catch {
    return null;
  }
}

/** Converts a bigint field element to a 32-byte little-endian Uint8Array for Ledger signing. */
function fieldToBytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number((value >> BigInt(i * 8)) & 0xffn);
  }
  return bytes;
}

/** Signs the fee payer commitment of a zkApp transaction using the Ledger device.
 *  Used to authorize the fee payer before direct GraphQL broadcast (no Auro). */
export async function signFeePayer(
  commitment: string,
  accountIndex = 0
): Promise<{ field: string; scalar: string } | null> {
  try {
    const ledger = await getApp();
    const bytes = fieldToBytes(BigInt(commitment));
    // networkId: 1 = mainnet, 0 = testnet (default to testnet)
    const result = await ledger.signFieldElement(accountIndex, 0, bytes);
    if (!result.field || !result.scalar) return null;
    return { field: result.field, scalar: result.scalar };
  } catch {
    return null;
  }
}

/** Signs arbitrary fields using the Ledger device (for in-circuit signature verification).
 *  Returns the raw {field, scalar} decimal strings from the device. */
export async function signFields(
  fields: Array<string>,
  accountIndex = 0
): Promise<{ data: Array<string>; signature: { field: string; scalar: string } } | null> {
  try {
    const ledger = await getApp();

    // Convert the first field element to a 32-byte little-endian Uint8Array
    const fieldBigInt = BigInt(fields[0]);
    const bytes = fieldToBytes(fieldBigInt);

    // networkId: 1 = mainnet, 0 = testnet (default to testnet)
    // TODO: change to real network ID
    const result = await ledger.signFieldElement(accountIndex, 0, bytes);

    if (!result.field || !result.scalar) return null;

    return { data: fields, signature: { field: result.field, scalar: result.scalar } };
  } catch {
    return null;
  }
}
