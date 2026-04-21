import { prisma } from './db.js';
import type { BackendConfig } from './config.js';
import { PublicKey } from 'o1js';
import {
  configureNetwork,
  discoverCandidateAddresses,
  fetchDecodedContractEvents,
  fetchLatestBlockHeight,
  fetchOnChainState,
  fetchVerificationKeyHash,
  type ChainEvent,
} from './mina-client.js';

const EMPTY_PUBLIC_KEY = PublicKey.empty().toBase58();

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
        await this.setIndexedHeight(toHeight);
        this.status.indexedHeight = toHeight;
      }

      // Re-derive proposal lifecycle state on every tick, even when no new
      // blocks were ingested — expiry and nonce/config invalidation are all
      // functions of current on-chain state.
      await this.deriveProposalStatuses(latestHeight);

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

      const created = await prisma.contract.create({
        data: { address },
      });

      // Backfill events for the newly discovered contract. The contract was
      // deployed within the bestChain window (~290 blocks), so scanning from
      // a small margin before discovery is sufficient and stays cheap on mainnet.
      const indexedHeight = await this.getIndexedHeight();
      const backfillFrom = Math.max(0, indexedHeight - 300);
      if (indexedHeight > backfillFrom) {
        console.log(`[indexer] backfilling events for ${address} from block ${backfillFrom} to ${indexedHeight}`);
        await this.syncSingleContract(created.id, address, backfillFrom, indexedHeight);
      }
    }

    this.status.discoveredContracts = await prisma.contract.count();
  }

  /** Indexes events for all tracked contracts across the requested block range. */
  private async syncKnownContracts(fromHeight: number, toHeight: number): Promise<void> {
    const contracts = await prisma.contract.findMany();

    for (const contract of contracts) {
      try {
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
    const rawEvents = await fetchDecodedContractEvents(address, fromHeight, toHeight);

    // o1js fetchEvents returns events within a single tx in *reverse* emission
    // order (archive GraphQL returns them newest-first per tx). Reverse per-tx
    // groups so receiver events land in contract-emission slot order —
    // otherwise multi-receiver transfer proposals have receivers stored in
    // reversed idx, which breaks the proposal-hash recomputation on the UI
    // side and causes "Proposal not found" errors on approve.
    const events = reverseEventsWithinEachTx(rawEvents);

    // Stable sort so 'proposal' events are processed before 'approval' /
    // 'receiver' / 'execution' within the same batch. The per-tx reversal
    // above already aligned receiver events with their emission order; the
    // stable sort preserves that ordering since all receivers share a type.
    const eventOrder: Record<string, number> = {
      deployed: 0,
      setup: 1,
      setupOwner: 2,
      proposal: 3,
      approval: 4,
      receiver: 5,
      execution: 6,
      ownerChange: 7,
      thresholdChange: 8,
      delegate: 9,
      createChild: 10,
      reclaimChild: 11,
      enableChildMultiSig: 12,
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

    await this.refreshContractState(contractId, address);

    await prisma.contract.update({
      where: { id: contractId },
      data: { lastSyncedAt: new Date() },
    });
  }

  /** Applies event-specific state updates to proposal/owner/contract aggregate tables. */
  private async applyEvent(
    contractId: number,
    chainEvent: ChainEvent,
  ): Promise<void> {
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
      case 'createChild': {
        await this.applyCreateChildEvent(contractId, chainEvent.event);
        return;
      }
      case 'reclaimChild': {
        return;
      }
      case 'enableChildMultiSig': {
        await this.applyEnableChildMultiSigEvent(contractId, chainEvent.event);
        return;
      }
      case 'receiver': {
        await this.applyReceiverEvent(contractId, chainEvent.event);
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
      case 'delegate': {
        await this.applyDelegateEvent(contractId, chainEvent.event);
        return;
      }
      case 'createChild': {
        // Informational only; Contract row populated by applySetupEvent and
        // parent's CREATE_CHILD Proposal marked executed by applyExecutionEvent.
        return;
      }
      case 'reclaimChild': {
        // Informational only; MINA flowed child→parent on chain. Parent's
        // Proposal is marked executed by the sibling ExecutionEvent.
        return;
      }
      case 'enableChildMultiSig': {
        await this.applyEnableChildMultiSigEvent(contractId, chainEvent.event);
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
    const parent = asString(event.parent);
    const isRoot = parent === null || parent === EMPTY_PUBLIC_KEY;

    await prisma.contract.update({
      where: { id: contractId },
      data: {
        ownersCommitment: asString(event.ownersCommitment),
        threshold: asNumber(event.threshold),
        numOwners: asNumber(event.numOwners),
        networkId: asString(event.networkId),
        parent: isRoot ? null : parent,
        nonce: 0,
        configNonce: 0,
        parentNonce: 0,
        childMultiSigEnabled: true,
      },
    });
  }

  /** Upserts one owner entry from setup bootstrap events. */
  private async applySetupOwnerEvent(
    contractId: number,
    event: Record<string, unknown>
  ): Promise<void> {
    const ownerAddress = asString(event.owner);
    if (!ownerAddress || ownerAddress.length < 10 || ownerAddress === EMPTY_PUBLIC_KEY) return;

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
  }

  /**
   * Creates a proposal row from on-chain event data.
   * ProposalEvent includes all TransactionProposal fields so the indexer
   * can reconstruct full proposal details purely from on-chain events.
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
        tokenId: asString(event.tokenId),
        txType: asString(event.txType),
        data: asString(event.data),
        nonce: asString(event.nonce),
        configNonce: asString(event.configNonce),
        expiryBlock: asString(event.expiryBlock),
        networkId: asString(event.networkId),
        guardAddress: asString(event.guardAddress),
        destination: normalizeDestination(asString(event.destination)),
        childAccount: asNullableAddress(asString(event.childAccount)),
        createdAtBlock: chainEvent.blockHeight,
        status: 'pending',
        invalidReason: null,
      },
      update: {
        tokenId: asString(event.tokenId),
        txType: asString(event.txType),
        data: asString(event.data),
        nonce: asString(event.nonce),
        configNonce: asString(event.configNonce),
        expiryBlock: asString(event.expiryBlock),
        networkId: asString(event.networkId),
        guardAddress: asString(event.guardAddress),
        destination: normalizeDestination(asString(event.destination)),
        childAccount: asNullableAddress(asString(event.childAccount)),
      },
    });
  }

  /**
   * Persists receiver rows from propose-time receiver events.
   *
   * The contract emits exactly MAX_RECEIVERS receiver events at propose-time
   * (padded with empties). Empty-address slots are skipped; non-empty slots
   * become ProposalReceiver rows.
   *
   * Governance proposals (addOwner/removeOwner/setDelegate) carry the target
   * pubkey in slot 0 with amount=0 — only empty addresses indicate padding,
   * not zero amounts.
   */
  private async applyReceiverEvent(
    contractId: number,
    event: Record<string, unknown>,
  ): Promise<void> {
    const proposalHash = asString(event.proposalHash);
    if (!proposalHash) return;

    const address = asString(event.receiver);
    const amount = asString(event.amount);
    if (!address || !amount || address === EMPTY_PUBLIC_KEY) return;

    const proposal = await prisma.proposal.findUnique({
      where: {
        contractId_proposalHash: {
          contractId,
          proposalHash,
        },
      },
      select: { id: true, txType: true },
    });
    if (!proposal) return;

    const nextIndex = await prisma.proposalReceiver.count({
      where: { proposalId: proposal.id },
    });

    await prisma.proposalReceiver.create({
      data: {
        proposalId: proposal.id,
        idx: nextIndex,
        address,
        amount,
      },
    });

    // Governance proposals (addOwner=1, removeOwner=2, setDelegate=4) carry
    // the target pubkey in slot 0. Mirror onto Proposal.toAddress for API
    // shape. Skip for transfers (txType=0) where slot 0 is a real recipient,
    // and for changeThreshold (txType=3) which carries no pubkey.
    const isGovernanceWithTarget =
      proposal.txType === '1' || proposal.txType === '2' || proposal.txType === '4';
    if (nextIndex === 0 && isGovernanceWithTarget) {
      await prisma.proposal.update({
        where: { id: proposal.id },
        data: { toAddress: address },
      });
    }
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

  /**
   * Marks proposals executed when execution events are observed.
   *
   * LOCAL path: the Proposal row lives under the emitting contract, so
   * (contractId, proposalHash) resolves it directly.
   *
   * REMOTE path: child-lifecycle methods (executeSetupChild, executeReclaim,
   * executeDestroy, executeEnableChildMultiSig) emit ExecutionEvent on the
   * child guard, but the Proposal row lives under the parent's contractId.
   * On a local miss, walk to the child's `parent` and retry.
   */
  private async applyExecutionEvent(contractId: number, chainEvent: ChainEvent): Promise<void> {
    const proposalHash = asString(chainEvent.event.proposalHash);
    if (!proposalHash) return;

    const executedAtBlock = chainEvent.blockHeight;

    const local = await prisma.proposal.updateMany({
      where: { contractId, proposalHash },
      data: { status: 'executed', invalidReason: null, executedAtBlock },
    });
    if (local.count > 0) return;

    const child = await prisma.contract.findUnique({
      where: { id: contractId },
      select: { parent: true },
    });
    if (!child?.parent) return;

    const parent = await prisma.contract.findUnique({
      where: { address: child.parent },
      select: { id: true },
    });
    if (!parent) return;

    await prisma.proposal.updateMany({
      where: { contractId: parent.id, proposalHash },
      data: { status: 'executed', invalidReason: null, executedAtBlock },
    });
  }

  /** Persists child-parent linkage when a child finishes CREATE_CHILD setup. */
  private async applyCreateChildEvent(
    contractId: number,
    event: Record<string, unknown>
  ): Promise<void> {
    const parent = asString(event.parentAddress);
    if (parent === null) return;

    await prisma.contract.update({
      where: { id: contractId },
      data: {
        parent,
        childMultiSigEnabled: true,
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

    const configNonce = asNumber(event.configNonce);
    if (configNonce !== null) {
      await prisma.contract.update({
        where: { id: contractId },
        data: { configNonce },
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

    const configNonce = asNumber(event.configNonce);
    await prisma.contract.update({
      where: { id: contractId },
      data: {
        threshold: newThreshold,
        ...(configNonce !== null ? { configNonce } : {}),
      },
    });
  }

  /** Updates the delegate address on a contract when a delegate event is processed. */
  private async applyDelegateEvent(
    contractId: number,
    event: Record<string, unknown>
  ): Promise<void> {
    const delegate = asString(event.delegate);
    if (delegate === null) return;

    await prisma.contract.update({
      where: { id: contractId },
      data: { delegate },
    });
  }

  /**
   * Flips child.childMultiSigEnabled from EnableChildMultiSigEvent on the child guard.
   * Doubles as the destroy state-flip handler since executeDestroy emits the same
   * event with enabled=0.
   */
  private async applyEnableChildMultiSigEvent(
    contractId: number,
    event: Record<string, unknown>
  ): Promise<void> {
    const enabled = asNumber(event.enabled);
    if (enabled === null) return;

    await prisma.contract.update({
      where: { id: contractId },
      data: { childMultiSigEnabled: enabled === 1 },
    });
  }

  /** Refreshes one contract row from on-chain state when readable. */
  private async refreshContractState(contractId: number, address: string): Promise<void> {
    const onChain = await fetchOnChainState(address);
    if (!onChain) return;

    await prisma.contract.update({
      where: { id: contractId },
      data: {
        threshold: onChain.threshold,
        numOwners: onChain.numOwners,
        networkId: onChain.networkId,
        ownersCommitment: onChain.ownersCommitment,
        nonce: onChain.nonce,
        configNonce: onChain.configNonce,
        parent: onChain.parent,
        parentNonce: onChain.parentNonce,
        childMultiSigEnabled: onChain.childMultiSigEnabled,
      },
    });
  }

  /** Recomputes non-executed proposal status from expiry plus current contract nonce/config state. */
  private async deriveProposalStatuses(latestHeight: number): Promise<void> {
    const proposals = await prisma.proposal.findMany({
      where: {
        status: { not: 'executed' },
      },
      include: {
        contract: {
          select: {
            id: true,
            address: true,
            configNonce: true,
            nonce: true,
            parent: true,
            parentNonce: true,
          },
        },
      },
    });

    const contracts = await prisma.contract.findMany({
      select: {
        address: true,
        parent: true,
        nonce: true,
        parentNonce: true,
      },
    });
    const contractByAddress = new Map(contracts.map((contract) => [contract.address, contract]));

    for (const proposal of proposals) {
      let status = 'pending';
      let invalidReason: string | null = null;

      const expiry = Number(proposal.expiryBlock ?? '0');
      if (Number.isFinite(expiry) && expiry > 0 && latestHeight > expiry) {
        status = 'expired';
      } else if (this.isConfigNonceStale(proposal.configNonce, proposal.contract.configNonce)) {
        status = 'invalidated';
        invalidReason = 'config_nonce_stale';
      } else if (this.isProposalNonceStale(proposal, contractByAddress)) {
        status = 'invalidated';
        invalidReason = 'proposal_nonce_stale';
      }

      if (proposal.status !== status || proposal.invalidReason !== invalidReason) {
        await prisma.proposal.update({
          where: { id: proposal.id },
          data: { status, invalidReason },
        });
      }
    }
  }

  private isConfigNonceStale(
    proposalConfigNonce: string | null,
    currentConfigNonce: number | null,
  ): boolean {
    if (proposalConfigNonce === null || currentConfigNonce === null) return false;
    const parsed = Number(proposalConfigNonce);
    if (!Number.isFinite(parsed)) return false;
    // Strict-less-than: only invalidate when the proposal is behind the contract.
    // A proposal with a future configNonce (shouldn't happen) is left alone so
    // the on-chain configNonce check can surface the mismatch at execute time.
    return parsed < currentConfigNonce;
  }

  private isProposalNonceStale(
    proposal: {
      nonce: string | null;
      destination: string | null;
      txType: string | null;
      childAccount: string | null;
      contract: {
        nonce: number | null;
      };
    },
    contractByAddress: Map<string, { address: string; parent: string | null; nonce: number | null; parentNonce: number | null }>
  ): boolean {
    if (proposal.nonce === null) return false;
    const parsedNonce = Number(proposal.nonce);
    if (!Number.isFinite(parsedNonce)) return false;

    const isRemote = proposal.destination === '1';
    const isCreateChild = proposal.txType === '5';

    if (!isRemote) {
      return proposal.contract.nonce !== null && parsedNonce <= proposal.contract.nonce;
    }

    if (isCreateChild) return false;

    if (!proposal.childAccount) return false;
    const child = contractByAddress.get(proposal.childAccount);
    return child?.parentNonce !== null && child?.parentNonce !== undefined
      ? parsedNonce <= child.parentNonce
      : false;
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

/**
 * Reverses per-tx event groups to restore contract emission order.
 * o1js fetchEvents returns events within a single tx in newest-first order
 * (reverse of the contract's `this.emitEvent` sequence). Cross-tx ordering
 * (block height, tx index) is preserved; only within-tx groups are reversed.
 */
function reverseEventsWithinEachTx(events: ChainEvent[]): ChainEvent[] {
  const groups = new Map<string, ChainEvent[]>();
  const keyOrder: string[] = [];
  for (const e of events) {
    // Events without a txHash are rare (none in practice); keep them isolated
    // under a unique key so they pass through unreversed.
    const key = e.txHash ?? `__no_tx_${keyOrder.length}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      keyOrder.push(key);
    }
    groups.get(key)!.push(e);
  }
  return keyOrder.flatMap((k) => [...groups.get(k)!].reverse());
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

/** Maps Destination field values to human-readable "local"/"remote" strings. */
function normalizeDestination(value: string | null): string | null {
  if (value === null) return null;
  if (value === '0' || value === 'local') return 'local';
  if (value === '1' || value === 'remote') return 'remote';
  return value;
}

/** Returns null for empty-pubkey sentinels so child-lookup queries don't match LOCAL proposals. */
function asNullableAddress(value: string | null): string | null {
  if (!value || value === EMPTY_PUBLIC_KEY) return null;
  return value;
}
