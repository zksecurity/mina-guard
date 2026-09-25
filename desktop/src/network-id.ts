export type NetworkId = 'mainnet' | 'devnet' | 'testnet';

/** Accept only a network explicitly reported by the Mina node. */
export function parseNodeNetworkId(value: unknown): NetworkId {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const network = id.startsWith('mina:') ? id.slice(5) : id;
  if (network === 'mainnet' || network === 'testnet' || network === 'devnet') {
    return network;
  }
  throw new Error('Mina endpoint did not report a supported networkID; refusing to infer it from the URL');
}
