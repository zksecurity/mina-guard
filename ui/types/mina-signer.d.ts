// Type stub for mina-signer resolved via webpack alias to the o1js submodule
// web bundle. Only covers the subset used by multisigClient.worker.ts.
declare module 'mina-signer' {
  export default class Client {
    constructor(options: { network: 'mainnet' | 'testnet' | 'devnet' });
    getZkappCommandCommitmentsNoCheck(command: {
      feePayer: unknown;
      zkappCommand: unknown;
    }): { fullCommitment: bigint };
  }
}
