// The CLI signs for mainnet unless MINA_NETWORK_DOMAIN says otherwise. A
// request for another network still fails closed: assertBundleNetwork compares
// the bundle with this domain before anything is built or signed. This module
// must load before 'contracts', which reads the domain when first imported.
if (process.env.MINA_NETWORK_DOMAIN === undefined && process.env.NEXT_PUBLIC_MINA_NETWORK === undefined) {
  process.env.MINA_NETWORK_DOMAIN = 'mainnet';
}

export {};
