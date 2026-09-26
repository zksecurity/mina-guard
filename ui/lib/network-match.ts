/** Compare Auro's full chain ID; never treat zeko:testnet as Mina testnet. */
export function matchesDeploymentNetwork(walletNetwork: string | null, deploymentNetwork: string): boolean {
  if (deploymentNetwork === 'mainnet') return walletNetwork === 'mina:mainnet';
  if (deploymentNetwork === 'testnet' || deploymentNetwork === 'devnet') {
    return walletNetwork === 'mina:testnet' || walletNetwork === 'mina:devnet';
  }
  return false;
}
