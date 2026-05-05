// Type stub for mina-signer resolved via webpack alias to the o1js submodule
// web bundle. Only covers the subset used by multisigClient.worker.ts.
declare module 'mina-signer' {
  export default class Client {
    constructor(options: { network: 'mainnet' | 'testnet' | 'devnet' });
    genKeys(): { privateKey: string; publicKey: string };
    getZkappCommandCommitmentsFromJSON(zkappCommand: unknown): { commitment: bigint; fullCommitment: bigint };
  }
}
