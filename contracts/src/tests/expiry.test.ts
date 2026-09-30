import { beforeEach, describe, expect, it } from 'bun:test';
import { Field, Mina, PrivateKey, Signature, UInt64 } from 'o1js';
import { Receiver, TransactionProposal } from '../MinaGuard.js';
import { proposalSigningMessage } from '../proposal-signing.js';
import {
  approveTransaction,
  createTransferProposal,
  deployAndSetup,
  fundAccount,
  makeOwnerWitness,
  proposeTransaction,
  setupLocalBlockchain,
  type TestContext,
} from './test-helpers.js';

// These tests use dummy proofs and never call MinaGuard.compile().
describe('proposal expiry across propose, approve and execute', () => {
  let ctx: TestContext;
  let local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
  let recipient: ReturnType<PrivateKey['toPublicKey']>;

  beforeEach(async () => {
    ctx = await setupLocalBlockchain();
    local = Mina.activeInstance as typeof local;
    await deployAndSetup(ctx, 2);
    recipient = PrivateKey.random().toPublicKey();
    await fundAccount(ctx, recipient);
    local.setGlobalSlot(10);
  });

  function proposal(expiry: bigint | number): TransactionProposal {
    return createTransferProposal(
      [new Receiver({ address: recipient, amount: UInt64.from(1_000_000) })],
      Field(1), Field(0), ctx.zkAppAddress, Field(expiry),
    );
  }

  type Phase = 'propose' | 'approve' | 'execute';

  async function prepare(phase: Phase, p: TransactionProposal) {
    if (phase !== 'propose') await proposeTransaction(ctx, p, 0);
    if (phase === 'execute') await approveTransaction(ctx, p, 1);
  }

  async function build(phase: Phase, p: TransactionProposal) {
    const hash = p.hash();
    const owner = ctx.owners[phase === 'approve' ? 1 : 0];
    const tx = await Mina.transaction(owner.pub, async () => {
      if (phase === 'execute') {
        await ctx.zkApp.executeTransfer(p, ctx.approvalStore.getWitness(hash), Field(3));
        return;
      }
      const witness = makeOwnerWitness(ctx.owners.map((o) => o.pub));
      const signature = Signature.create(owner.key, [proposalSigningMessage(hash, phase)]);
      const approvals = ctx.approvalStore.getWitness(hash);
      const nullifier = ctx.nullifierStore.getWitness(hash, owner.pub);
      if (phase === 'propose') {
        await ctx.zkApp.propose(p, witness, owner.pub, signature, nullifier, approvals);
      } else {
        await ctx.zkApp.approveProposal(
          p, signature, owner.pub, witness, approvals,
          ctx.approvalStore.getCount(hash), nullifier,
        );
      }
    });
    await tx.prove();
    return tx.sign([owner.key]);
  }

  for (const expiry of [0, 12, 0xffff_ffff]) {
    it(`allows all three stages at the deadline (expiry ${expiry})`, async () => {
      const p = proposal(expiry);
      local.setGlobalSlot(expiry === 0 ? 100 : expiry);
      await proposeTransaction(ctx, p, 0);
      await approveTransaction(ctx, p, 1);
      const tx = await build('execute', p);
      await tx.send();
      expect(ctx.zkApp.nonce.get().toString()).toBe('1');
    });
  }

  for (const expiry of [1n << 32n, -1n]) {
    it(`rejects expiry outside UInt32 (${expiry})`, async () => {
      const approvalsBefore = ctx.zkApp.approvalRoot.get().toString();
      await expect(proposeTransaction(ctx, proposal(expiry), 0)).rejects.toThrow();
      expect(ctx.zkApp.approvalRoot.get().toString()).toBe(approvalsBefore);
    });
  }

  for (const phase of ['propose', 'approve', 'execute'] as const) {
    it(`rejects ${phase} after expiry without changing state`, async () => {
      const p = proposal(12);
      await prepare(phase, p);
      const approvalsBefore = ctx.zkApp.approvalRoot.get().toString();
      const nullifiersBefore = ctx.zkApp.voteNullifierRoot.get().toString();
      local.setGlobalSlot(13);
      await expect(async () => {
        const tx = await build(phase, p);
        await tx.send();
      }).toThrow(/Protocol_state_precondition_unsatisfied/);
      expect(ctx.zkApp.approvalRoot.get().toString()).toBe(approvalsBefore);
      expect(ctx.zkApp.voteNullifierRoot.get().toString()).toBe(nullifiersBefore);
      expect(ctx.zkApp.nonce.get().toString()).toBe('0');
    });

    it(`rejects ${phase} built before expiry but included after it`, async () => {
      const p = proposal(12);
      await prepare(phase, p);
      const tx = await build(phase, p);
      local.setGlobalSlot(13);
      await expect(tx.send()).rejects.toThrow(/Protocol_state_precondition_unsatisfied/);
    });

    it(`allows ${phase} when the slot advances up to the deadline`, async () => {
      const p = proposal(12);
      await prepare(phase, p);
      const tx = await build(phase, p);
      local.setGlobalSlot(12);
      await tx.send();
    });
  }
});
