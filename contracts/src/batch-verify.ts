import {
  Field,
  Option,
  Poseidon,
  Provable,
  PublicKey,
  Signature,
  Struct,
} from 'o1js';

class SignatureInput extends Option(
  Struct({ signature: Signature, signer: PublicKey })
) {}

const MAX_SIGNERS = 20;

type SignatureInputs = SignatureInput[];
const SignatureInputs = Provable.Array(SignatureInput, MAX_SIGNERS);

type BatchVerifyResult = { approvalCount: Field; signerChain: Field };

const INITIAL_CHAIN = Poseidon.hashWithPrefix('signer-chain', []);

/**
 * Circuit to verify a batch of signatures, against a list of signers with a known Merkle list hash
 */
function batchVerify(
  signatures: SignatureInputs,
  messageHash: Field
): BatchVerifyResult {
  let approvalCount = Field(0);
  let signerChain = INITIAL_CHAIN;

  signatures.forEach(({ value: { signature: sig, signer: pk }, isSome }) => {
    // Verify the signature
    let ok = sig.verify(pk, [messageHash]);

    // update approval count (if not None)
    let newCount = approvalCount.add(ok.toField());
    approvalCount = Provable.if(isSome, newCount, approvalCount);

    // update signer chain (if not None)
    let newChain = Poseidon.hash([signerChain, pk.x, pk.isOdd.toField()]);
    signerChain = Provable.if(isSome, newChain, signerChain);
  });
  return { approvalCount, signerChain };
}

// test circuit size

let info = await Provable.constraintSystem(() => {
  let signatures: SignatureInputs = Provable.witness(SignatureInputs, () =>
    SignatureInputs.empty()
  );
  let messageHash = Provable.witness(Field, () => Field(0));
  batchVerify(signatures, messageHash);
});

console.log(info.summary());
