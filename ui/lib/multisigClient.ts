// ── Multisig Contract Client ─────────────────────────────────────────
// Bridges the o1js smart contract with the web UI.
// o1js is lazily loaded due to its large WASM bundle (~40MB).

let o1jsLoaded = false;
let o1js: typeof import('o1js') | null = null;

export async function loadO1js() {
  if (o1jsLoaded && o1js) return o1js;
  // Dynamic import — only loads when needed
  o1js = await import('o1js');
  o1jsLoaded = true;
  return o1js;
}

export interface ContractState {
  ownersRoot: string;
  threshold: number;
  numOwners: number;
  txNonce: number;
  pendingTxRoot: string;
  approvalRoot: string;
  guardRoot: string;
  configNonce: number;
}

/**
 * Fetch the on-chain state of the MultisigWallet contract.
 * In production, this connects to the Mina network and reads account state.
 */
export async function fetchContractState(
  contractAddress: string
): Promise<ContractState | null> {
  try {
    const { PublicKey, Mina, fetchAccount } = await loadO1js();
    const address = PublicKey.fromBase58(contractAddress);

    // Fetch account from the network
    await fetchAccount({ publicKey: address });

    // In production, we'd instantiate the contract and read state:
    // const contract = new MultisigWallet(address);
    // return {
    //   ownersRoot: contract.ownersRoot.get().toString(),
    //   threshold: Number(contract.threshold.get().toBigInt()),
    //   ...
    // };

    // For MVP, return null (use localStorage state instead)
    return null;
  } catch {
    return null;
  }
}

/**
 * Compile the MultisigWallet contract.
 * This is expensive (~1-2 min) and should be done once.
 */
export async function compileContract(): Promise<boolean> {
  try {
    // In production:
    // const { MultisigWallet } = await import('contracts');
    // await MultisigWallet.compile();
    console.log('[MultisigClient] Contract compilation simulated');
    return true;
  } catch (err) {
    console.error('[MultisigClient] Compilation failed:', err);
    return false;
  }
}

/**
 * Create a propose transaction.
 * Returns the serialized transaction for Auro Wallet submission.
 */
export async function createProposeTx(params: {
  contractAddress: string;
  proposerAddress: string;
  to: string;
  amount: string; // nanomina
  txType: number;
  data: string;
}): Promise<string | null> {
  try {
    // In production:
    // 1. Load o1js and contract
    // 2. Build TransactionProposal
    // 3. Create Mina.transaction with zkApp.propose()
    // 4. Generate proof
    // 5. Return serialized transaction
    console.log('[MultisigClient] Propose tx created (simulated)', params);
    return 'simulated-tx-json';
  } catch (err) {
    console.error('[MultisigClient] Failed to create propose tx:', err);
    return null;
  }
}

/**
 * Create an approve transaction.
 */
export async function createApproveTx(params: {
  contractAddress: string;
  approverAddress: string;
  txId: string;
  txHash: string;
}): Promise<string | null> {
  try {
    console.log('[MultisigClient] Approve tx created (simulated)', params);
    return 'simulated-tx-json';
  } catch (err) {
    console.error('[MultisigClient] Failed to create approve tx:', err);
    return null;
  }
}

/**
 * Create an execute transaction.
 */
export async function createExecuteTx(params: {
  contractAddress: string;
  executorAddress: string;
  txId: string;
  proposal: {
    to: string;
    amount: string;
    tokenId: string;
    txType: number;
    data: string;
    nonce: string;
  };
}): Promise<string | null> {
  try {
    console.log('[MultisigClient] Execute tx created (simulated)', params);
    return 'simulated-tx-json';
  } catch (err) {
    console.error('[MultisigClient] Failed to create execute tx:', err);
    return null;
  }
}
