// -- Auro Wallet Integration ------------------------------------------

declare global {
  interface Window {
    mina?: MinaProvider;
  }
}

interface MinaProvider {
  requestAccounts(): Promise<string[]>;
  getAccounts(): Promise<string[]>;
  requestNetwork(): Promise<{ chainId: string; name: string }>;
  sendTransaction(params: {
    transaction: string;
    feePayer?: { fee?: number; memo?: string };
  }): Promise<{ hash: string }>;
  signMessage(params: { message: string }): Promise<{
    publicKey: string;
    data: string;
    signature: { field: string; scalar: string };
  }>;
  signFields(params: { message: number[] }): Promise<{
    data: number[];
    signature: string;
  }>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  removeListener(event: string, handler: (...args: unknown[]) => void): void;
}

export function isAuroInstalled(): boolean {
  return typeof window !== 'undefined' && !!window.mina;
}

export async function connectAuro(): Promise<string | null> {
  if (!isAuroInstalled()) return null;
  try {
    const accounts = await window.mina!.requestAccounts();
    return accounts[0] ?? null;
  } catch {
    return null;
  }
}

export async function getAuroAccounts(): Promise<string[]> {
  if (!isAuroInstalled()) return [];
  try {
    return await window.mina!.getAccounts();
  } catch {
    return [];
  }
}

export async function getAuroNetwork(): Promise<string | null> {
  if (!isAuroInstalled()) return null;
  try {
    const network = await window.mina!.requestNetwork();
    return network.name;
  } catch {
    return null;
  }
}

export async function sendTransaction(
  transaction: string,
  fee?: number,
  memo?: string
): Promise<string | null> {
  if (!isAuroInstalled()) return null;
  try {
    const result = await window.mina!.sendTransaction({
      transaction,
      feePayer: { fee, memo },
    });
    return result.hash;
  } catch {
    return null;
  }
}

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

export function onAccountChange(
  handler: (accounts: string[]) => void
): () => void {
  if (!isAuroInstalled()) return () => { };
  const wrappedHandler = (...args: unknown[]) =>
    handler(args[0] as string[]);
  window.mina!.on('accountsChanged', wrappedHandler);
  return () =>
    window.mina!.removeListener('accountsChanged', wrappedHandler);
}

export function onNetworkChange(
  handler: (network: { chainId: string; name: string }) => void
): () => void {
  if (!isAuroInstalled()) return () => { };
  const wrappedHandler = (...args: unknown[]) =>
    handler(args[0] as { chainId: string; name: string });
  window.mina!.on('chainChanged', wrappedHandler);
  return () =>
    window.mina!.removeListener('chainChanged', wrappedHandler);
}
