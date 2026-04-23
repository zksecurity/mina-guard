// -- Auro Wallet Integration ------------------------------------------

declare global {
  interface Window {
    mina?: MinaProvider;
  }
}

interface MinaProvider {
  requestAccounts(): Promise<string[]>;
  getAccounts(): Promise<string[]>;
  requestNetwork(): Promise<{ networkID: string }>;
  sendTransaction(params: {
    transaction: string;
    feePayer?: { fee?: number; memo?: string };
  }): Promise<{ hash: string }>;
  signMessage(params: { message: string }): Promise<{
    publicKey: string;
    data: string;
    signature: { field: string; scalar: string };
  }>;
  signFields(params: { message: Array<string | number> }): Promise<{
    data: Array<string | number>;
    signature: string;
  }>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  removeListener(event: string, handler: (...args: unknown[]) => void): void;
}

/** Returns true when Auro provider is injected into the browser window. */
export function isAuroInstalled(): boolean {
  return typeof window !== 'undefined' && !!window.mina;
}

/** Prompts user account connection and returns the first selected address. */
export async function connectAuro(): Promise<string | null> {
  if (!isAuroInstalled()) return null;
  try {
    const accounts = await window.mina!.requestAccounts();
    return accounts[0] ?? null;
  } catch {
    return null;
  }
}

/** Returns currently connected accounts without opening a new connect prompt. */
export async function getAuroAccounts(): Promise<string[]> {
  if (!isAuroInstalled()) return [];
  try {
    return await window.mina!.getAccounts();
  } catch {
    return [];
  }
}

/** Reads active wallet network name (devnet/mainnet/etc.) from Auro provider. */
export async function getAuroNetwork(): Promise<string | null> {
  if (!isAuroInstalled()) return null;
  try {
    const network = await window.mina!.requestNetwork();
    // networkID format: "mina:testnet", "mina:mainnet", "mina:devnet"
    return network.networkID.split(':')[1] ?? null;
  } catch {
    return null;
  }
}

/** Sends serialized zkApp transaction JSON via Auro wallet transport. */
export async function sendTransaction(
  transaction: string,
  fee?: number,
  memo?: string
): Promise<string | null> {
  if (!isAuroInstalled()) return null;
  // Only include feePayer when fee or memo are explicitly provided.
  // Passing { fee: undefined } causes Auro to override the fee embedded in
  // the transaction JSON, which changes the commitment and invalidates any
  // pre-existing signatures (e.g. the zkApp key signature on deploy).
  const params: Parameters<MinaProvider['sendTransaction']>[0] = { transaction };
  if (fee !== undefined || memo !== undefined) {
    params.feePayer = { fee, memo };
  }
  try {
    const result = await window.mina!.sendTransaction(params);
    return result.hash;
  } catch (err) {
    // User cancellation in Auro reports as { code: 1002, message: 'User rejected' }.
    // Treat cancellation as a benign null (no banner); re-throw other failures so
    // the submit-rejection banner surfaces the real reason.
    const code = (err as { code?: number } | null)?.code;
    if (code === 1002) return null;
    const message = (err as { message?: string } | null)?.message;
    throw new Error(message ? `Wallet rejected transaction: ${message}` : 'Wallet rejected transaction');
  }
}

/** Requests off-circuit wallet message signature for plain string payloads. */
export async function signMessage(message: string): Promise<{
  publicKey: string;
  signature: { field: string; scalar: string };
} | null> {
  if (!isAuroInstalled()) return null;
  try {
    const result = await window.mina!.signMessage({ message });
    return {
      publicKey: result.publicKey,
      signature: result.signature,
    };
  } catch {
    return null;
  }
}

/** Requests wallet field signature used for MinaGuard in-circuit signature verification. */
export async function getAuroSignFields(
  fields: Array<string>
): Promise<{ data: Array<string>; signature: string } | null> {
  if (!isAuroInstalled()) return null;
  try {
    const result = await window.mina!.signFields({ message: fields });
    return { data: result.data.map(String), signature: result.signature };
  } catch {
    return null;
  }
}

/** Subscribes to wallet account-change events and returns an unsubscribe callback. */
export function onAccountChange(
  handler: (accounts: string[]) => void
): () => void {
  if (!isAuroInstalled()) return () => {};
  const wrappedHandler = (...args: unknown[]) =>
    handler(args[0] as string[]);
  window.mina!.on('accountsChanged', wrappedHandler);
  return () => window.mina!.removeListener('accountsChanged', wrappedHandler);
}

/** Subscribes to wallet network-change events and returns an unsubscribe callback. */
export function onNetworkChange(
  handler: (network: { networkID: string }) => void
): () => void {
  if (!isAuroInstalled()) return () => {};
  const wrappedHandler = (...args: unknown[]) =>
    handler(args[0] as { networkID: string });
  window.mina!.on('chainChanged', wrappedHandler);
  return () => window.mina!.removeListener('chainChanged', wrappedHandler);
}
