/**
 * UI scaling fixtures — seeds bulk synthetic data straight into Postgres so the
 * vault list, search, pagination, and proposal filtering can be exercised at
 * realistic counts without spinning up a chain. Bypasses the indexer entirely.
 *
 * Usage:
 *   bun run scripts/seed-fixtures.ts --wallet <base58-pubkey> [--clean]
 *
 * `--wallet` is added as an active owner on every seeded vault, so it shows up
 * in the connected user's vault list. `--clean` wipes Contract/ContractConfig/
 * OwnerMembership/Proposal/Approval/ProposalReceiver/EventRaw rows first.
 *
 * NOTE: this script is for the UI scaling PR only — remove before merging.
 */

import { PrivateKey, PublicKey } from 'o1js';
import { prisma } from '../src/db.js';

interface Args {
  wallet: string;
  clean: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let wallet: string | null = null;
  let clean = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--wallet') {
      wallet = argv[++i] ?? null;
    } else if (arg === '--clean') {
      clean = true;
    } else {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }
  if (!wallet) throw new Error('Missing required --wallet <base58-pubkey>');
  // Validate base58 pubkey eagerly so we fail fast.
  PublicKey.fromBase58(wallet);
  return { wallet, clean };
}

function randomPubkey(): string {
  return PrivateKey.random().toPublicKey().toBase58();
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const MEMO_PHRASES = [
  'Q4 vendor invoice',
  'October payroll',
  'September payroll',
  'devops infra renewal',
  'legal retainer',
  'audit fees',
  'office lease',
  'security review',
  'grant disbursement',
  'gas top-up',
  'team offsite',
  'marketing buyback',
  'oracle subscription',
  'bug bounty payout',
  'contributor reward',
  'protocol upgrade',
  'treasury rebalance',
  'liquidity provision',
  'staking rewards',
  'partnership stipend',
];

const TX_TYPES = ['0', '1', '2', '3', '4'];

async function clean(): Promise<void> {
  console.log('[seed] cleaning existing data');
  await prisma.approval.deleteMany();
  await prisma.proposalExecution.deleteMany();
  await prisma.proposalReceiver.deleteMany();
  await prisma.eventRaw.deleteMany();
  await prisma.proposal.deleteMany();
  await prisma.ownerMembership.deleteMany();
  await prisma.contractConfig.deleteMany();
  await prisma.contract.deleteMany();
}

interface VaultSpec {
  address: string;
  parent: string | null;
  ownerCount: number;
  proposalCount: number;
  childMultiSigEnabled: boolean;
  threshold: number;
}

async function seedVault(spec: VaultSpec, walletAddress: string): Promise<void> {
  const contract = await prisma.contract.create({
    data: {
      address: spec.address,
      parent: spec.parent,
      ready: true,
      discoveredAtBlock: 1,
    },
  });

  await prisma.contractConfig.create({
    data: {
      contractId: contract.id,
      validFromBlock: 1,
      networkId: '0',
      threshold: spec.threshold,
      numOwners: spec.ownerCount,
      nonce: 0,
      parentNonce: 0,
      configNonce: 0,
      childMultiSigEnabled: spec.childMultiSigEnabled,
      ownersCommitment: PrivateKey.random().toPublicKey().toBase58(),
    },
  });

  // Wallet first so its index=0; remaining slots filled with random owners.
  const ownerRows = [
    { contractId: contract.id, address: walletAddress, action: 'added', index: 0, validFromBlock: 1 },
    ...Array.from({ length: spec.ownerCount - 1 }, (_, i) => ({
      contractId: contract.id,
      address: randomPubkey(),
      action: 'added',
      index: i + 1,
      validFromBlock: 1,
    })),
  ];
  await prisma.ownerMembership.createMany({ data: ownerRows });

  if (spec.proposalCount === 0) return;

  const otherOwnerAddresses = ownerRows.slice(1).map((o) => o.address);
  const recipients = Array.from({ length: 8 }, () => randomPubkey());
  const proposalRows = Array.from({ length: spec.proposalCount }, (_, i) => {
    const memoIdx = i % MEMO_PHRASES.length;
    const memo = `${MEMO_PHRASES[memoIdx]} #${1000 + i}`;
    const proposer = i % 3 === 0 ? walletAddress : pick(otherOwnerAddresses);
    const toAddress = pick(recipients);
    return {
      contractId: contract.id,
      proposalHash: `${spec.address.slice(3, 11)}-${i}`,
      proposer,
      toAddress,
      txType: pick(TX_TYPES),
      data: '0',
      nonce: String(i + 1),
      configNonce: '0',
      expirySlot: '0',
      networkId: '0',
      guardAddress: spec.address,
      memo,
      destination: 'local',
      createdAtBlock: 1000 + i,
      // Skew createdAt so newest-first sort is meaningful; older ones first.
      createdAt: new Date(Date.now() - (spec.proposalCount - i) * 60_000),
    };
  });

  // createMany has a row-count cap on some Postgres setups; chunk to be safe.
  const CHUNK = 100;
  for (let i = 0; i < proposalRows.length; i += CHUNK) {
    await prisma.proposal.createMany({ data: proposalRows.slice(i, i + CHUNK) });
  }

  // Mark ~25% of proposals as executed by inserting a ProposalExecution row.
  const created = await prisma.proposal.findMany({
    where: { contractId: contract.id },
    select: { id: true, proposalHash: true },
  });
  const executedRows = created
    .filter((_, i) => i % 4 === 0)
    .map((p) => ({ proposalId: p.id, blockHeight: 2000, txHash: `tx-${p.proposalHash}` }));
  if (executedRows.length > 0) {
    await prisma.proposalExecution.createMany({ data: executedRows });
  }

  // A few approvals on pending proposals so the approval count is non-zero in the UI.
  const pendingIds = created.filter((_, i) => i % 4 !== 0).map((p) => p.id);
  const approvalRows = pendingIds.slice(0, Math.min(pendingIds.length, 30)).flatMap((proposalId, i) => {
    const approverCount = (i % 2) + 1; // 1 or 2 approvals
    return Array.from({ length: approverCount }, (_, j) => ({
      proposalId,
      approver: j === 0 ? walletAddress : pick(otherOwnerAddresses),
      blockHeight: 1500 + i,
      eventOrder: j,
    }));
  });
  if (approvalRows.length > 0) {
    await prisma.approval.createMany({ data: approvalRows, skipDuplicates: true });
  }
}

async function main(): Promise<void> {
  const { wallet, clean: shouldClean } = parseArgs();
  console.log(`[seed] wallet: ${wallet}`);

  if (shouldClean) await clean();

  const ROOT_COUNT = 30;
  const PARENTS_WITH_CHILDREN = 5;
  const HEAVY_PROPOSAL_VAULTS = 2;
  const HEAVY_PROPOSAL_COUNT = 150;
  const TEN_OWNER_VAULT_INDEX = 0;

  const rootSpecs: VaultSpec[] = Array.from({ length: ROOT_COUNT }, (_, i) => ({
    address: randomPubkey(),
    parent: null,
    ownerCount: i === TEN_OWNER_VAULT_INDEX ? 10 : 3,
    proposalCount: i < HEAVY_PROPOSAL_VAULTS ? HEAVY_PROPOSAL_COUNT : 3 + (i % 5),
    childMultiSigEnabled: true,
    threshold: i === TEN_OWNER_VAULT_INDEX ? 6 : 2,
  }));

  console.log(`[seed] inserting ${ROOT_COUNT} root vaults`);
  for (const spec of rootSpecs) {
    await seedVault(spec, wallet);
  }

  const childSpecs: VaultSpec[] = [];
  for (let p = 0; p < PARENTS_WITH_CHILDREN; p++) {
    const parentAddress = rootSpecs[p].address;
    const childCount = 6 + (p % 3); // 6..8 children per parent
    for (let c = 0; c < childCount; c++) {
      childSpecs.push({
        address: randomPubkey(),
        parent: parentAddress,
        ownerCount: 3,
        proposalCount: c % 3 === 0 ? 12 : 0,
        childMultiSigEnabled: c !== 0, // first child has multi-sig disabled
        threshold: 2,
      });
    }
  }

  console.log(`[seed] inserting ${childSpecs.length} child vaults`);
  for (const spec of childSpecs) {
    await seedVault(spec, wallet);
  }

  const totalVaults = ROOT_COUNT + childSpecs.length;
  const totalProposals =
    HEAVY_PROPOSAL_VAULTS * HEAVY_PROPOSAL_COUNT +
    (ROOT_COUNT - HEAVY_PROPOSAL_VAULTS) * 5 + // upper bound
    childSpecs.filter((c) => c.proposalCount > 0).length * 12;
  console.log(`[seed] done — ${totalVaults} vaults, ~${totalProposals} proposals`);
}

main()
  .catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
