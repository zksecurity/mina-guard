export type NetworkDomainName = 'mainnet' | 'testnet' | 'devnet';

/** Require an explicit, unambiguous circuit domain before any contract import. */
export function resolveNetworkDomain(
  browserDomain: string | undefined,
  nodeDomain: string | undefined,
  browserNetwork?: string,
): NetworkDomainName {
  if (browserDomain !== undefined && nodeDomain !== undefined && browserDomain !== nodeDomain) {
    throw new Error('NEXT_PUBLIC_MINA_NETWORK_DOMAIN and MINA_NETWORK_DOMAIN disagree');
  }
  const domain = browserDomain ?? nodeDomain;
  if (domain !== 'mainnet' && domain !== 'testnet' && domain !== 'devnet') {
    throw new Error('Set MINA_NETWORK_DOMAIN or NEXT_PUBLIC_MINA_NETWORK_DOMAIN to mainnet, testnet, or devnet');
  }
  if (browserDomain !== undefined && browserNetwork === undefined) {
    throw new Error('Set NEXT_PUBLIC_MINA_NETWORK to the circuit network domain');
  }
  if (browserNetwork !== undefined && browserNetwork !== domain) {
    throw new Error('NEXT_PUBLIC_MINA_NETWORK and the circuit network domain disagree');
  }
  return domain;
}

export const NETWORK_DOMAIN_IDS: Record<NetworkDomainName, bigint> = {
  mainnet: 1n,
  testnet: 2n,
  devnet: 3n,
};
