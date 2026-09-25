/** Proposal domains are distinct even where Mina fee-payer signatures share a prefix. */
export function matchesDeploymentNetwork(walletNetwork: string | null, deploymentNetwork: string): boolean {
  return walletNetwork !== null && walletNetwork === deploymentNetwork;
}
