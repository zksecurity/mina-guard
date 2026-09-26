export type NetworkDomainName = 'mainnet' | 'testnet' | 'devnet';

/** Require an explicit, unambiguous circuit domain before any contract import. */
export function resolveNetworkDomain(
  browserNetwork: string | undefined,
  nodeDomain: string | undefined,
): NetworkDomainName {
  if (browserNetwork !== undefined && nodeDomain !== undefined && browserNetwork !== nodeDomain) {
    throw new Error('NEXT_PUBLIC_MINA_NETWORK and MINA_NETWORK_DOMAIN disagree');
  }
  const domain = browserNetwork ?? nodeDomain;
  if (domain !== 'mainnet' && domain !== 'testnet' && domain !== 'devnet') {
    throw new Error('Set NEXT_PUBLIC_MINA_NETWORK or MINA_NETWORK_DOMAIN to mainnet, testnet, or devnet');
  }
  return domain;
}

export const NETWORK_DOMAIN_IDS: Record<NetworkDomainName, bigint> = {
  mainnet: 1n,
  testnet: 2n,
  devnet: 2n,
};
