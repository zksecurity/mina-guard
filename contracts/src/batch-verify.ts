import {
  Field,
  Option,
  Poseidon,
  Provable,
  PublicKey,
  Signature,
  Struct,
} from 'o1js';

class SignatureOption extends Option(Signature) { }

class SignatureInput extends Option(
  Struct({ signature: SignatureOption, signer: PublicKey })
) { }

import { MAX_OWNERS, INITIAL_SIGNER_CHAIN, INITIAL_OWNER_CHAIN } from './constants';


type SignatureInputs = SignatureInput[];
const SignatureInputs = Provable.Array(SignatureInput, MAX_OWNERS);

type BatchVerifyResult = { approvalCount: Field; signerChain: Field, ownerChain: Field };

/**
 * Circuit to verify a batch of signatures, against a list of signers with a known Merkle list hash.
 * The pair could be:
 * - None: Empty owner slot
 * - (None, PublicKey): Owner exists but has not provided signature.
 * - (Signature, PublicKey): Owner exists and has provided signature
 * 
 * IMPORTANT: Caller must check the returned ownerChain against the current commitment, and
 * must handle approvalCount check.
 * 
 * NOTE: In practice, None values should have a dummy non-zero value (isSome still set to false),
 * to avoid assertion errors during proof generation. See relevant test for details.
 */
function batchVerify(
  signatures: SignatureInputs,
  message: Field
): BatchVerifyResult {
  let approvalCount = Field(0);
  let signerChain = INITIAL_SIGNER_CHAIN;
  let ownerChain = INITIAL_OWNER_CHAIN;

  signatures.forEach(({ value: { signature: sigOpt, signer: pk }, isSome }) => {

    let {value: sig, isSome: isSigSome} = sigOpt;

    // confirm this is a (Signature, PublicKey) case
    let didSign = isSigSome.and(isSome);

    // Verify the signature
    let ok = sig.verify(pk, [message]);

    // update approval count if (Signature, PublicKey) was provided and verified
    let newCount = approvalCount.add(ok.toField());
    approvalCount = Provable.if(didSign, newCount, approvalCount);

    // hash public key in the owner chain if not None, to check that owner list is correct
    let ownerChainTemp = Poseidon.hash([ownerChain, pk.x, pk.isOdd.toField()]);
    ownerChain = Provable.if(isSome, ownerChainTemp, ownerChain);

    // hash public key in the signer chain if didSign, to have an auditable trail of who signed
    // NOTE: owners who provided an INVALID signature are also included in the signerChain audit trail
    let signerChainTemp = Poseidon.hash([signerChain, pk.x, pk.isOdd.toField()]);
    signerChain = Provable.if(didSign, signerChainTemp, signerChain);
  });
  return { approvalCount, signerChain, ownerChain };
}

export { batchVerify, BatchVerifyResult, SignatureInputs, SignatureInput, SignatureOption };