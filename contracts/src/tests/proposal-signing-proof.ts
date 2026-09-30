import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Cache, Field, Mina, UInt64 } from 'o1js';
import { MinaGuard, Receiver } from '../MinaGuard.js';
import { NETWORK_DOMAIN_NAME } from '../constants.js';
import { createTransferProposal, setupLocalBlockchain, deployAndSetup, proposeTransaction, approveTransaction } from './test-helpers.js';

/** Shared by the Bun regression and resource-limited Node validation of the built package. */
export async function proveProposalSigning(options: { cachePath: string; vkHashPath: string }): Promise<void> {
  const { verificationKey } = await MinaGuard.compile({ cache: Cache.FileSystem(options.cachePath) });
  const expected = readFileSync(options.vkHashPath, 'utf8')
    .split('\n').find(line => line.startsWith(`${NETWORK_DOMAIN_NAME}=`))?.split('=')[1];
  assert.equal(verificationKey.hash.toString(), expected, 'Real-proof VK must match the pinned network VK');
  const ctx = await setupLocalBlockchain(3, true);
  await deployAndSetup(ctx, 2);
  const amount = UInt64.from(1000);
  const proposal = createTransferProposal(
    [new Receiver({ address: ctx.owners[2].pub, amount })], Field(1), Field(0), ctx.zkAppAddress,
  );
  const hash = await proposeTransaction(ctx, proposal, 0);
  await approveTransaction(ctx, proposal, 1);
  const before = Mina.getBalance(ctx.owners[2].pub);
  // The deployer is not an owner; only the fee-payer signature is required here.
  const tx = await Mina.transaction(ctx.deployerAccount, async () => {
    await ctx.zkApp.executeTransfer(proposal, ctx.approvalStore.getWitness(hash), ctx.approvalStore.getCount(hash));
  });
  await tx.prove();
  await tx.sign([ctx.deployerKey]).send();
  assert.equal(Mina.getBalance(ctx.owners[2].pub).toBigInt(), before.add(amount).toBigInt());
}
