import { prisma } from './db.js';
import type { BackendConfig } from './config.js';
import {
  configureNetwork,
  discoverCandidateAddresses,
  fetchDecodedContractEvents,
  fetchLatestBlockHeight,
  fetchOnChainState,
  fetchVerificationKeyHash,
  type ChainEvent,
} from './mina-client.js';

/** Runtime status exposed over API for monitoring indexer health and lag. */
export interface IndexerStatus {
  running: boolean;
  lastRunAt: string | null;
  lastSuccessfulRunAt: string | null;
  latestChainHeight: number;
  indexedHeight: number;
  lastError: string | null;
  discoveredContracts: number;
}

/** Polling indexer that discovers MinaGuard contracts and ingests lifecycle events. */
export class MinaGuardIndexer {
  private readonly config: BackendConfig;
  private intervalHandle: NodeJS.Timeout | null = null;
  private status: IndexerStatus = {
    running: false,
    lastRunAt: null,
    lastSuccessfulRunAt: null,
    latestChainHeight: 0,
    indexedHeight: 0,
    lastError: null,
    discoveredContracts: 0,
  };

  /** Creates a new indexer with network configuration and poll settings. */
  constructor(config: BackendConfig) {
    this.config = config;
    configureNetwork(config);
  }

  /** Starts periodic indexing and performs an immediate first sync pass. */
  async start(): Promise<void> {
    if (this.intervalHandle) return;
    this.status.running = true;
    await this.tick();
    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, this.config.indexPollIntervalMs);
  }

  /** Stops periodic indexing without mutating current cursor state. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.status.running = false;
  }

  /** Returns the latest in-memory indexer status snapshot. */
  getStatus(): IndexerStatus {
    return { ...this.status };
  }

  /** Runs one complete indexing loop: discovery, ingestion, and cursor advancement. */
  private async tick(): Promise<void> {
    this.status.lastRunAt = new Date().toISOString();

    try {
      const latestHeight = await fetchLatestBlockHeight(this.config);
      this.status.latestChainHeight = latestHeight;

      const indexedHeight = await this.getIndexedHeight();
      this.status.indexedHeight = indexedHeight;

      const fromHeight = indexedHeight + 1;
      const toHeight = latestHeight;

      // Scan bestChain for new contract deployments
      await this.discoverContracts(Math.max(1, Math.min(290, latestHeight)));

      if (toHeight >= fromHeight) {
        await this.syncKnownContracts(fromHeight, toHeight);
        await this.deriveExpiredProposals(latestHeight);
        await this.setIndexedHeight(toHeight);
        this.status.indexedHeight = toHeight;
      }

      this.status.lastSuccessfulRunAt = new Date().toISOString();
      this.status.lastError = null;
    } catch (error) {
      this.status.lastError = error instanceof Error ? error.message : 'Unknown indexer error';
    }
  }

  /** Discovers candidate contracts and stores verified MinaGuard addresses. */
  private async discoverContracts(blockWindow: number): Promise<void> {
    const candidates = await discoverCandidateAddresses(this.config, blockWindow);

    for (const address of candidates) {
      const existing = await prisma.contract.findUnique({ where: { address } });
      if (existing) continue;

      const verificationKeyHash = await fetchVerificationKeyHash(address);
      if (!verificationKeyHash) continue;

      if (
        this.config.minaguardVkHash &&
        verificationKeyHash !== this.config.minaguardVkHash
      ) {
        continue;
      }

      await prisma.contract.create({
        data: { address },
      });
    }

    this.status.discoveredContracts = await prisma.contract.count();
  }

  /** Indexes events for all tracked contracts across the requested block range. */
  private async syncKnownContracts(fromHeight: number, toHeight: number): Promise<void> {
    const contracts = await prisma.contract.findMany();

    for (const contract of contracts) {
      try {
        console.log(`[indexer] syncing ${contract.address} blocks ${fromHeight}–${toHeight}`);
        await this.syncSingleContract(contract.id, contract.address, fromHeight, toHeight);
      } catch (error) {
        // Re-throw so the tick() caller does NOT advance the global cursor
        // past blocks that failed to sync.
        console.error(
          `[indexer] sync failed for ${contract.address}:`,
          error instanceof Error ? error.stack : error
        );
        throw error;
      }
    }
  }

  /** Fetches, stores, and applies decoded events for a single contract address. */
  private async syncSingleContract(
    contractId: number,
    address: string,
    fromHeight: number,
    toHeight: number
  ): Promise<void> {
    const events = await fetchDecodedContractEvents(address, fromHeight, toHeight);

    // Sort so 'proposal' events are processed before 'approval'/'execution' within
    // the same batch. The contract's propose() emits both proposal and approval events
    // in a single tx, but the archive may return them in arbitrary order. Processing
    // proposal first ensures the Proposal row exists when the approval is applied.
    const eventOrder: Record<string, number> = {
      deployed: 0,
      setup: 1,
      setupOwner: 2,
      ownerChange: 3,
      thresholdChange: 4,
      proposal: 5,
      approval: 6,
      execution: 7,
    };
    events.sort((a, b) => (eventOrder[a.type] ?? 99) - (eventOrder[b.type] ?? 99));

    for (const chainEvent of events) {
      const fingerprint = this.fingerprintEvent(address, chainEvent);
      const existingRaw = await prisma.eventRaw.findUnique({ where: { fingerprint } });
      if (existingRaw) continue;

      await prisma.eventRaw.create({
        data: {
          contractId,
          blockHeight: chainEvent.blockHeight,
          txHash: chainEvent.txHash,
          eventType: chainEvent.type,
          payload: JSON.stringify(chainEvent.event),
          fingerprint,
        },
      });

      await this.applyEvent(contractId, chainEvent);
    }

    await prisma.contract.update({
      where: { id: contractId },
      data: { lastSyncedAt: new Date() },
    });
  }

  /** Applies event-specific state updates to proposal/owner/contract aggregate tables. */
  private async applyEvent(contractId: number, chainEvent: ChainEvent): Promise<void> {
    switch (chainEvent.type) {
      case 'setup': {
        await this.applySetupEvent(contractId, chainEvent.event);
        return;
      }
      case 'setupOwner': {
        await this.applySetupOwnerEvent(contractId, chainEvent.event);
        return;
      }
      case 'proposal': {
        await this.applyProposalEvent(contractId, chainEvent);
        return;
      }
      case 'approval': {
        await this.applyApprovalEvent(contractId, chainEvent);
        return;
      }
      case 'execution': {
        await this.applyExecutionEvent(contractId, chainEvent);
        return;
      }
      case 'ownerChange': {
        await this.applyOwnerChangeEvent(contractId, chainEvent.event);
        return;
      }
      case 'thresholdChange': {
        await this.applyThresholdChangeEvent(contractId, chainEvent.event);
        return;
      }
      default:
        return;
    }
  }

  /** Applies setup summary fields to contract metadata if the event is emitted. */
  private async applySetupEvent(
    contractId: number,
    event: Record<string, unknown>
  ): Promise<void> {
    await prisma.contract.update({
      where: { id: contractId },
      data: {
        ownersCommitment: asString(event.ownersCommitment),
        threshold: asNumber(event.threshold),
        numOwners: asNumber(event.numOwners),
        networkId: asString(event.networkId),
      },
    });
  }

  /** Upserts one owner entry from setup bootstrap events. */
  private async applySetupOwnerEvent(
    contractId: number,
    event: Record<string, unknown>
  ): Promise<void> {
    const ownerAddress = asString(event.owner);
    if (!ownerAddress || ownerAddress.length < 10) return;

    await prisma.owner.upsert({
      where: {
        contractId_address: {
          contractId,
          address: ownerAddress,
        },
      },
      create: {
        contractId,
        address: ownerAddress,
        index: asNumber(event.index),
        active: true,
      },
      update: {
        index: asNumber(event.index),
        active: true,
      },
    });

    // Derive threshold/numOwners from on-chain state when no setup event was emitted.
    {
      const contract = await prisma.contract.findUnique({ where: { id: contractId } });
      if (contract && contract.threshold == null) {
        const onChain = await fetchOnChainState(contract.address);
        if (onChain) {
          await prisma.contract.update({
            where: { id: contractId },
            data: {
              threshold: onChain.threshold,
              numOwners: onChain.numOwners,
              networkId: onChain.networkId,
              ownersCommitment: onChain.ownersCommitment,
            },
          });
        }
      }
    }
  }

  /**
   * Creates a proposal row from on-chain event data.
   * ProposalEvent only contains proposalHash, proposer, and uid.
   * Remaining proposal detail fields (to, amount, etc.) are populated
   * via the POST /api/contracts/:address/proposals submission endpoint.
   */
  private async applyProposalEvent(contractId: number, chainEvent: ChainEvent): Promise<void> {
    const event = chainEvent.event;
    const proposalHash = asString(event.proposalHash);
    if (!proposalHash) return;

    await prisma.proposal.upsert({
      where: {
        contractId_proposalHash: {
          contractId,
          proposalHash,
        },
      },
      create: {
        contractId,
        proposalHash,
        proposer: asString(event.proposer),
        createdAtBlock: chainEvent.blockHeight,
        status: 'pending',
      },
      update: {},
    });
  }

  /** Stores per-approver records and updates aggregate approval count on proposal rows. */
  private async applyApprovalEvent(contractId: number, chainEvent: ChainEvent): Promise<void> {
    const event = chainEvent.event;
    const proposalHash = asString(event.proposalHash);
    const approver = asString(event.approver);

    if (!proposalHash || !approver) return;

    const proposal = await prisma.proposal.findUnique({
      where: {
        contractId_proposalHash: {
          contractId,
          proposalHash,
        },
      },
    });

    if (!proposal) return;

    await prisma.approval.upsert({
      where: {
        proposalId_approver: {
          proposalId: proposal.id,
          approver,
        },
      },
      create: {
        proposalId: proposal.id,
        approver,
        approvalRaw: asString(event.approvalCount),
        blockHeight: chainEvent.blockHeight,
      },
      update: {
        approvalRaw: asString(event.approvalCount),
        blockHeight: chainEvent.blockHeight,
      },
    });

    const approvals = await prisma.approval.count({ where: { proposalId: proposal.id } });
    await prisma.proposal.update({
      where: { id: proposal.id },
      data: {
        approvalCount: approvals,
      },
    });
  }

  /** Marks proposals executed when execution events are observed. */
  private async applyExecutionEvent(contractId: number, chainEvent: ChainEvent): Promise<void> {
    const proposalHash = asString(chainEvent.event.proposalHash);
    if (!proposalHash) return;

    await prisma.proposal.updateMany({
      where: {
        contractId,
        proposalHash,
      },
      data: {
        status: 'executed',
        executedAtBlock: chainEvent.blockHeight,
      },
    });
  }

  /** Applies owner add/remove governance results to owner table state. */
  private async applyOwnerChangeEvent(
    contractId: number,
    event: Record<string, unknown>
  ): Promise<void> {
    const owner = asString(event.owner);
    if (!owner) return;

    const added = asString(event.added) === '1';

    await prisma.owner.upsert({
      where: {
        contractId_address: {
          contractId,
          address: owner,
        },
      },
      create: {
        contractId,
        address: owner,
        active: added,
      },
      update: {
        active: added,
      },
    });

    const newNumOwners = asNumber(event.newNumOwners);
    if (newNumOwners !== null) {
      await prisma.contract.update({
        where: { id: contractId },
        data: { numOwners: newNumOwners },
      });
    }
  }

  /** Applies threshold change governance results to contract metadata. */
  private async applyThresholdChangeEvent(
    contractId: number,
    event: Record<string, unknown>
  ): Promise<void> {
    const newThreshold = asNumber(event.newThreshold);
    if (newThreshold === null) return;

    await prisma.contract.update({
      where: { id: contractId },
      data: { threshold: newThreshold },
    });
  }

  /** Marks pending proposals as expired once their expiryBlock is below latest chain height. */
  private async deriveExpiredProposals(latestHeight: number): Promise<void> {
    const pending = await prisma.proposal.findMany({
      where: { status: 'pending' },
      select: {
        id: true,
        expiryBlock: true,
      },
    });

    for (const proposal of pending) {
      const expiry = Number(proposal.expiryBlock ?? '0');
      if (!Number.isFinite(expiry) || expiry <= 0) continue;
      if (latestHeight > expiry) {
        await prisma.proposal.update({
          where: { id: proposal.id },
          data: { status: 'expired' },
        });
      }
    }
  }

  /** Returns current indexed block height cursor from DB or configured default start. */
  private async getIndexedHeight(): Promise<number> {
    const cursor = await prisma.indexerCursor.findUnique({ where: { key: 'indexed_height' } });
    if (!cursor) return this.config.indexStartHeight;
    return Number(cursor.value);
  }

  /** Persists indexed block height cursor after a successful loop. */
  private async setIndexedHeight(height: number): Promise<void> {
    await prisma.indexerCursor.upsert({
      where: { key: 'indexed_height' },
      create: { key: 'indexed_height', value: String(height) },
      update: { value: String(height) },
    });
  }

  /** Builds a deterministic unique key for raw event idempotency. */
  private fingerprintEvent(address: string, chainEvent: ChainEvent): string {
    return [
      address,
      chainEvent.type,
      chainEvent.blockHeight,
      chainEvent.txHash ?? 'no-hash',
      JSON.stringify(chainEvent.event),
    ].join('::');
  }
}

/** Converts unknown values into nullable string form for DB persistence. */
function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

/** Converts unknown values into nullable number form for DB integer columns. */
function asNumber(value: unknown): number | null {
  const asText = asString(value);
  if (!asText) return null;
  const parsed = Number(asText);
  return Number.isFinite(parsed) ? parsed : null;
}
