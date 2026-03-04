import { Field, MerkleMapWitness, Poseidon, PublicKey, SelfProof, Signature, Struct, ZkProgram } from "o1js";

import { ownerKey } from "./utils";

class BatchVerifyInput extends Struct({ proposalHash: Field, ownersRoot: Field }) {
  assertEquals(other: BatchVerifyInput) {
    this.proposalHash.assertEquals(other.proposalHash);
    this.ownersRoot.assertEquals(other.ownersRoot);
  }

  toFields(): Field[] {
    return [this.proposalHash, this.ownersRoot];
  }
}
class BatchVerifyOutput extends Struct({ approvalCount: Field, approverHash: Field, approverChain: Field }) { }

function verifyApproval(
  input: BatchVerifyInput,
  sig: Signature,
  approver: PublicKey,
  ownerWitness: MerkleMapWitness
): Field {
  let approverHash = ownerKey(approver);

  // Verify that approver is in the owner set
  const [computedRoot, computedKey] = ownerWitness.computeRootAndKey(Field(1));
  computedRoot.assertEquals(input.ownersRoot, 'Not an owner');
  computedKey.assertEquals(approverHash, 'Owner key mismatch');

  sig.verify(approver, input.toFields()).assertTrue('Invalid signature');

  return approverHash;
}


/**
 * Recursively verifies owner approval signatures.
 * Each step verifies one signatures, and enforces ascending order of hashes of owner public keys
 * to prevent duplicate signatures.
 * 
 * IMPORTANT: Contract must check the approval count output to match the expected.
 * Hash of last approver's public key is made public.
 * 
 */
const BatchVerifySigs = ZkProgram({
  name: 'batch-verify-sigs',
  publicInput: BatchVerifyInput,
  publicOutput: BatchVerifyOutput,

  methods: {
    firstVerification: {
      privateInputs: [Signature, PublicKey, MerkleMapWitness],
      async method(input: BatchVerifyInput, sig: Signature, approver: PublicKey,
        ownerWitness: MerkleMapWitness) {

        const approverHash = verifyApproval(input, sig, approver, ownerWitness);

        return {
          publicOutput: new BatchVerifyOutput({
            approvalCount: Field(1),
            approverHash: approverHash,
            // First signer inits the chain.
            approverChain: approverHash
          })
        }
      }
    },
    addVerification: {
      privateInputs: [SelfProof, Signature, PublicKey, MerkleMapWitness],
      async method(input: BatchVerifyInput, prev: SelfProof<BatchVerifyInput, BatchVerifyOutput>,
        sig: Signature, approver: PublicKey, ownerWitness: MerkleMapWitness) {

        prev.verify();

        prev.publicInput.assertEquals(input);

        const approverHash = verifyApproval(input, sig, approver, ownerWitness);

        // To prevent duplicate signatures, enforce ascending order of hashes of public keys
        prev.publicOutput.approverHash.assertLessThan(approverHash);

        return {
          publicOutput: new BatchVerifyOutput({
            approvalCount: prev.publicOutput.approvalCount.add(Field(1)),
            approverHash: approverHash,
            // Chain will be c_{i+1} = H(c_i, H(p_{i+1}))
            approverChain: Poseidon.hash([prev.publicOutput.approverChain, approverHash])
          })
        };
      }
    }
  }
});

export class BatchVerifySigsProof extends ZkProgram.Proof(BatchVerifySigs) { }

export { BatchVerifyInput, BatchVerifyOutput, BatchVerifySigs };