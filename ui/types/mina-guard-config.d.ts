export type MinaGuardNetworkId = 'mainnet' | 'devnet' | 'testnet';

export interface MinaGuardConfig {
  minaEndpoint: string;
  archiveEndpoint: string;
  networkId: MinaGuardNetworkId;
}

declare global {
  interface Window {
    __minaGuardConfig?: MinaGuardConfig;
    minaGuardConfig?: {
      setEndpoints: (cfg: { minaEndpoint: string; archiveEndpoint: string }) => Promise<void>;
    };
  }
}
