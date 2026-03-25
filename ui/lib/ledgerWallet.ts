// -- Ledger Wallet Integration ---------------------------------------------

import TransportWebHID from '@ledgerhq/hw-transport-webhid';
import type Transport from '@ledgerhq/hw-transport';
import { MinaApp } from '@zondax/ledger-mina-js';

let transport: Transport | null = null;
let app: MinaApp | null = null;

/** Ledger network ID: 1 = mainnet, 0 = testnet/devnet. Defaults to mainnet. */
let ledgerNetworkId = 1;

/** Updates the network ID used for Ledger signing at runtime. */
export function setLedgerNetworkId(id: number): void {
  ledgerNetworkId = id;
}

const LEDGER_SUCCESS = 9000;

/** Maps Ledger status codes to user-friendly messages.
 *  Response `returnCode` values are decimal strings (e.g. "21781").
 *  Thrown exceptions contain hex codes (e.g. "0x6511").
 *  Both are converted to numbers for lookup. */
const LEDGER_ERROR_MESSAGES: Record<number, string> = {
  21781: 'Ledger device is locked — please unlock it',
  25873: 'Please open the Mina app on your Ledger',        // 0x6511
  26628: 'Please open the Mina app on your Ledger',        // 0x6804
  27014: 'Transaction rejected on Ledger device',          // 0x6986 (hex) — but returnCode is decimal
  27013: 'Transaction rejected on Ledger device',
  28160: 'Ledger device is locked or Mina app is not open',  // 0x6E00
  28161: 'Please open the Mina app on your Ledger',        // 0x6E01
  27904: 'Ledger device is locked or Mina app is not open', // 0x6D00
  25600: 'Ledger execution error',
  27911: 'Ledger device is not set up',
};

/** Extracts a hex status code from a string (e.g. "0x6511" from "Unknown Return Code: 0x6511"). */
function extractHexCode(text: string): number | null {
  const match = text.match(/0x[0-9a-fA-F]{4}/);
  return match ? parseInt(match[0], 16) : null;
}

/** Maps a Ledger status code or error string to a user-friendly message. */
function ledgerErrorMessage(codeOrText: number | string): string {
  const code = typeof codeOrText === 'number'
    ? codeOrText
    : extractHexCode(String(codeOrText)) ?? parseInt(String(codeOrText), 10);
  const mapped = Number.isFinite(code) ? LEDGER_ERROR_MESSAGES[code] : undefined;
  return mapped ?? `Ledger error (code ${typeof codeOrText === 'number' ? '0x' + codeOrText.toString(16) : codeOrText})`;
}

/** Converts a thrown Ledger exception into a friendly error.
 *  Also resets the transport — thrown exceptions (as opposed to returnCode errors)
 *  indicate the transport may be in a bad state. */
function toLedgerError(err: unknown): Error {
  const t = transport;
  transport = null;
  app = null;
  if (t) { void t.close().catch(() => {}); }
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(ledgerErrorMessage(msg));
}

/** Checks a Ledger response and throws a descriptive error if it indicates failure.
 *  Resets the transport so the next attempt starts with a fresh connection. */
function assertLedgerSuccess(result: { returnCode: string; message?: string }): void {
  const code = parseInt(result.returnCode, 10);
  if (code === LEDGER_SUCCESS) return;
  const t = transport;
  transport = null;
  app = null;
  if (t) { void t.close().catch(() => {}); }
  throw new Error(ledgerErrorMessage(code));
}

/** Returns true when WebHID is available in the current browser. */
export function isLedgerSupported(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as any).hid;
}

/** Opens a WebHID transport and initialises the Mina Ledger app. */
async function getApp(): Promise<MinaApp> {
  if (!app) {
    try {
      transport = await TransportWebHID.create();
      app = new MinaApp(transport);
    } catch (err) {
      if (transport) {
        try { await transport.close(); } catch { /* ignore */ }
      }
      transport = null;
      app = null;
      throw err;
    }
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
): Promise<string> {
  const ledger = await getApp();
  let result;
  try {
    result = await ledger.getAddress(accountIndex, false);
  } catch (err) {
    throw toLedgerError(err);
  }
  assertLedgerSuccess(result);
  return result.publicKey!;
}

/** Signs a transaction JSON string using the Ledger device. */
export async function signTransaction(
  transactionJson: string,
  _accountIndex = 0
): Promise<string> {
  const ledger = await getApp();
  let result;
  try {
    result = await ledger.signTransaction(JSON.parse(transactionJson));
  } catch (err) {
    throw toLedgerError(err);
  }
  assertLedgerSuccess(result);
  return result.signature!;
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
): Promise<{ field: string; scalar: string }> {
  const ledger = await getApp();
  const bytes = fieldToBytes(BigInt(commitment));
  let result;
  try {
    result = await ledger.signFieldElement(accountIndex, ledgerNetworkId, bytes);
  } catch (err) {
    throw toLedgerError(err);
  }
  assertLedgerSuccess(result);
  return { field: result.field!, scalar: result.scalar! };
}

/** Signs arbitrary fields using the Ledger device (for in-circuit signature verification).
 *  Returns the raw {field, scalar} decimal strings from the device. */
export async function signFields(
  fields: Array<string>,
  accountIndex = 0
): Promise<{ data: Array<string>; signature: { field: string; scalar: string } }> {
  const ledger = await getApp();

  // Convert the first field element to a 32-byte little-endian Uint8Array
  const fieldBigInt = BigInt(fields[0]);
  const bytes = fieldToBytes(fieldBigInt);

  let result;
  try {
    result = await ledger.signFieldElement(accountIndex, ledgerNetworkId, bytes);
  } catch (err) {
    throw toLedgerError(err);
  }
  assertLedgerSuccess(result);

  return { data: fields, signature: { field: result.field!, scalar: result.scalar! } };
}
