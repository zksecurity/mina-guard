import type { MinaGuardConfig, MinaGuardNetworkId } from '@/types/mina-guard-config';

/** Returns the effective config for the UI. Prefers the value injected by the
 *  Electron preload (`window.__minaGuardConfig`); falls back to NEXT_PUBLIC_*
 *  env vars so `next dev` outside Electron still works. */
export function getMinaGuardConfig(): MinaGuardConfig {
  if (typeof window !== 'undefined' && window.__minaGuardConfig) {
    return window.__minaGuardConfig;
  }
  const minaEndpoint = process.env.NEXT_PUBLIC_MINA_ENDPOINT ?? 'https://api.minascan.io/node/devnet/v1/graphql';
  const archiveEndpoint = process.env.NEXT_PUBLIC_ARCHIVE_ENDPOINT ?? 'https://api.minascan.io/archive/devnet/v1/graphql';
  const networkId = (process.env.NEXT_PUBLIC_MINA_NETWORK as MinaGuardNetworkId) || 'testnet';
  return { minaEndpoint, archiveEndpoint, networkId };
}
