import type { MinaGuardConfig, MinaGuardNetworkId } from '@/types/mina-guard-config';

interface CreateVaultBuildConfig {
  network: string | undefined;
  minaEndpoint: string | undefined;
  archiveEndpoint: string | undefined;
  expectedVkHash: string | undefined;
}

function isHttpsEndpoint(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Vault creation follows the build's proof domain; the displayed network is read-only. */
export function resolveCreateVaultNetwork(
  build: CreateVaultBuildConfig,
  runtimeNetwork: unknown,
): MinaGuardNetworkId | null {
  if (build.network === 'mainnet') {
    return runtimeNetwork === 'mainnet'
      && isHttpsEndpoint(build.minaEndpoint)
      && isHttpsEndpoint(build.archiveEndpoint)
      && /^[1-9][0-9]*$/.test(build.expectedVkHash ?? '')
      ? 'mainnet'
      : null;
  }
  // Testnet and devnet intentionally use the same circuit domain.
  if (build.network === 'testnet' || build.network === 'devnet') {
    return runtimeNetwork === 'testnet' || runtimeNetwork === 'devnet'
      ? runtimeNetwork
      : null;
  }
  return null;
}

/** Check the node itself before creating a vault, including a SubVault proposal. */
export async function assertMinaNodeNetwork(config: MinaGuardConfig): Promise<void> {
  let response: Response;
  try {
    response = await fetch(config.minaEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ networkID }' }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('Could not confirm the Mina node network. Check the endpoint and try again.');
  }
  if (!response.ok) {
    throw new Error('The Mina node did not answer the network check. Try again.');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('The Mina node did not return a valid network response.');
  }
  const result = body as { data?: { networkID?: unknown }; errors?: unknown } | null;
  const reported = result?.data?.networkID;
  const id = typeof reported === 'string' ? reported.trim().toLowerCase() : '';
  const nodeNetwork = id.startsWith('mina:') ? id.slice(5) : id;
  const graphqlError = result?.errors !== undefined &&
    (!Array.isArray(result.errors) || result.errors.length > 0);
  if (graphqlError || !['mainnet', 'testnet', 'devnet'].includes(nodeNetwork)) {
    throw new Error('The Mina node did not report a supported network ID.');
  }
  // Testnet and devnet share MinaGuard's existing proof domain. Mainnet does not.
  if ((nodeNetwork === 'mainnet') !== (config.networkId === 'mainnet')) {
    throw new Error(`Mina node network mismatch: this app expects ${config.networkId}, but the node reports ${nodeNetwork}.`);
  }
}
