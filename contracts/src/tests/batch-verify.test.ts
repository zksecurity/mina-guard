import { describe, it, expect } from 'bun:test';
import { Bool, Field, Poseidon, PrivateKey, Provable, Signature } from 'o1js';
import {
  batchVerify,
  SignatureInput,
  SignatureOption,
} from '../batch-verify.js';
import { INITIAL_SIGNER_CHAIN, MAX_OWNERS } from '../constants.js';

/** Pad a SignatureInput[] to MAX_OWNERS with isSome=false dummy entries. */
function padInputs(inputs: SignatureInput[]): SignatureInput[] {
  const dummyKey = PrivateKey.random().toPublicKey();
  const dummySig = Signature.create(PrivateKey.random(), [Field(0)]);
  while (inputs.length < MAX_OWNERS) {
    inputs.push(
      new SignatureInput({
        value: {
          signature: new SignatureOption({ value: dummySig, isSome: Bool(false) }),
          signer: dummyKey,
        },
        isSome: Bool(false),
      })
    );
  }
  return inputs;
}

/** Compute the expected signer chain by folding public keys into Poseidon hashes. */
function expectedSignerChain(signers: { x: Field; isOdd: Bool }[]): Field {
  let chain = INITIAL_SIGNER_CHAIN;
  for (const pk of signers) {
    chain = Poseidon.hash([chain, pk.x, pk.isOdd.toField()]);
  }
  return chain;
}

describe('batchVerify signerChain', () => {
  it('includes all signers when all signatures are valid', async () => {
    const message = Field(42);
    const sk0 = PrivateKey.random();
    const sk1 = PrivateKey.random();
    const sk2 = PrivateKey.random();
    const pk0 = sk0.toPublicKey();
    const pk1 = sk1.toPublicKey();
    const pk2 = sk2.toPublicKey();

    const sig0 = Signature.create(sk0, [message]);
    const sig1 = Signature.create(sk1, [message]);
    const sig2 = Signature.create(sk2, [message]);

    const inputs = padInputs([
      new SignatureInput({
        value: {
          signature: new SignatureOption({ value: sig0, isSome: Bool(true) }),
          signer: pk0,
        },
        isSome: Bool(true),
      }),
      new SignatureInput({
        value: {
          signature: new SignatureOption({ value: sig1, isSome: Bool(true) }),
          signer: pk1,
        },
        isSome: Bool(true),
      }),
      new SignatureInput({
        value: {
          signature: new SignatureOption({ value: sig2, isSome: Bool(true) }),
          signer: pk2,
        },
        isSome: Bool(true),
      }),
    ]);

    const expected = expectedSignerChain([pk0, pk1, pk2]);

    await Provable.runAndCheck(() => {
      const result = batchVerify(inputs, message);
      result.signerChain.assertEquals(expected);
      result.approvalCount.assertEquals(Field(3));
    });
  });

  it('excludes owners with invalid signatures', async () => {
    const message = Field(99);
    const sk0 = PrivateKey.random();
    const sk1 = PrivateKey.random();
    const skWrong = PrivateKey.random();
    const pk0 = sk0.toPublicKey();
    const pk1 = sk1.toPublicKey();

    const sig0 = Signature.create(sk0, [message]);
    // Sign with wrong key — signature won't verify against pk1
    const badSig = Signature.create(skWrong, [message]);

    const inputs = padInputs([
      new SignatureInput({
        value: {
          signature: new SignatureOption({ value: sig0, isSome: Bool(true) }),
          signer: pk0,
        },
        isSome: Bool(true),
      }),
      new SignatureInput({
        value: {
          signature: new SignatureOption({ value: badSig, isSome: Bool(true) }),
          signer: pk1,
        },
        isSome: Bool(true),
      }),
    ]);

    // Only pk0 should be in the signer chain
    const expected = expectedSignerChain([pk0]);

    await Provable.runAndCheck(() => {
      const result = batchVerify(inputs, message);
      result.signerChain.assertEquals(expected);
      result.approvalCount.assertEquals(Field(1));
    });
  });
});
