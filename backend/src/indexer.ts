import { prisma } from './db.js';
import type { BackendConfig } from './config.js';
import { PublicKey } from 'o1js';
import {
  configureNetwork,
  discoverCandidateAddresses,
  fetchBestChainHeaders,
  fetchDecodedContractEvents,
  fetchLatestBlockHeight,
  fetchOnChainState,
  fetchVerificationKeyHash,
  fetchZkappTxStatus,
  type ChainEvent,
} from './mina-client.js';

const REORG_DETECTION_WINDOW = 290;

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
  indexerMode: 'full' | 'lite';
}

/** Fields describing a single ContractConfig row — subset used when merging deltas. */
type ContractConfigFields = {
  threshold: number | null;
  numOwners: number | null;
  nonce: number | null;
  parentNonce: number | null;
  configNonce: number | null;
  delegate: string | null;
  childMultiSigEnabled: boolean | null;
  ownersCommitment: string | null;
  networkId: string | null;
};

/** Partial change set for a config-mutating event. Fields left undefined are copied from the latest row. */
type ContractConfigChanges = Partial<ContractConfigFields>;

/** Polling indexer that discovers MinaGuard contracts and ingests lifecycle events. */
export class MinaGuardIndexer {
  private readonly config: BackendConfig;
  private intervalHandle: NodeJS.Timeout | null = null;
  private status: Omit<IndexerStatus, 'indexerMode'> = {
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

  /** Returns the latest in-memory indexer status snapshot. Does not include `indexerMode` — the route layer adds it from config. */
  getStatus(): Omit<IndexerStatus, 'indexerMode'> {
    return { ...this.status };
  }

  /** Runs one complete indexing loop: discovery, ingestion, and cursor advancement. */
  private async tick(): Promise<void> {
    this.status.lastRunAt = new Date().toISOString();

    try {
      const latestHeight = await fetchLatestBlockHeight(this.config);
      this.status.latestChainHeight = latestHeight;

      // Detect a chain reorg before doing any new work. If detected, rollback
      // has rewound the cursor and deleted all rows above the fork; bail out
      // of this tick and let the next one resume syncing from the new cursor.
      const rolledBackTo = await this.detectAndRollbackReorg();
      if (rolledBackTo !== null) {
        this.status.indexedHeight = rolledBackTo;
        this.status.lastSuccessfulRunAt = new Date().toISOString();
        this.status.lastError = null;
        return;
      }

      const indexedHeight = await this.getIndexedHeight();
      this.status.indexedHeight = indexedHeight;

      const fromHeight = indexedHeight + 1;
      const toHeight = latestHeight;

      // Scan bestChain for new contract deployments. Only look at the
      // un-indexed delta plus a small margin for the race where a block lands
      // between the latestHeight read and the bestChain call. Clamped to 290
      // (Mina's bestChain cap); reorg safety is handled by detectAndRollbackReorg
      // above, which rewinds IndexerCursor on fork — the next tick's window
      // naturally re-covers the reorged range. Lite mode skips discovery
      // entirely and tracks only contracts added via the /subscribe route.
      if (this.config.indexerMode === 'full') {
        const DISCOVERY_MARGIN = 5;
        const discoveryWindow = Math.max(
          1,
          Math.min(290, latestHeight - indexedHeight + DISCOVERY_MARGIN),
        );
        await this.discoverContracts(discoveryWindow, latestHeight);
      }

      // Rescan contracts that haven't yet seen a MinaGuard event. Runs
      // every tick until events land; syncSingleContract flips ready=true
      // on first ingestion, after which the contract joins the forward
      // sweep below.
      await this.rescanUnreadyContracts(latestHeight);

      if (toHeight >= fromHeight) {
        await this.syncKnownContracts(fromHeight, toHeight);
        await this.setIndexedHeight(toHeight);
        this.status.indexedHeight = toHeight;
      }

      // Check in-flight approve/execute submissions and surface any on-chain
      // failures (e.g. insufficient fee-payer balance, account update errors).
      await this.pollPendingSubmissions();

      this.status.lastSuccessfulRunAt = new Date().toISOString();
      this.status.lastError = null;
    } catch (error) {
      this.status.lastError = error instanceof Error ? error.message : 'Unknown indexer error';
    }
  }

  /** Instance wrapper around {@link detectAndRollbackReorg} for use inside tick(). */
  private async detectAndRollbackReorg(): Promise<number | null> {
    return detectAndRollbackReorg(this.config);
  }

  /** Discovers candidate contracts and stores verified MinaGuard addresses. */
  private async discoverContracts(blockWindow: number, latestHeight: number): Promise<void> {
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
        data: { address, discoveredAtBlock: latestHeight },
      });

      await this.backfillContract(created.id, address);
    }

    this.status.discoveredContracts = await prisma.contract.count();
  }

  /**
   * Backfills events for a newly tracked contract. In full mode the backfill
   * spans 300 blocks (bestChain window — the contract was just discovered there,
   * so any earlier events are out of reorg range anyway). In lite mode the
   * backfill starts at config.indexStartHeight (default 0) so a cold-started
   * indexer pulls full history for any user-subscribed contract.
   *
   * Readiness is flipped by syncSingleContract on first event ingestion —
   * a subscribed-before-deploy contract returns from here with ready=false
   * and becomes ready once its deploy tx lands and the next sync picks up
   * events for it.
   *
   * Exposed for use by the subscribe API route and the auto-subscribe path.
   */
  async backfillContract(contractId: number, address: string): Promise<void> {
    const indexedHeight = await this.getIndexedHeight();
    const backfillFrom =
      this.config.indexerMode === 'lite'
        ? this.config.indexStartHeight
        : Math.max(0, indexedHeight - 300);
    if (indexedHeight > backfillFrom) {
      console.log(`[indexer] backfilling events for ${address} from block ${backfillFrom} to ${indexedHeight}`);
      await this.syncSingleContract(contractId, address, backfillFrom, indexedHeight);
    }
  }

  /**
   * Re-scans every unready contract over its persisted lower bound
   * (`discoveredAtBlock`) up to the current chain tip. The subscribe
   * route records `discoveredAtBlock` at insert time; the tick rescans
   * that range each run until `syncSingleContract` ingests a first event
   * and flips `ready=true`. This is what makes subscribe-before-deploy
   * self-healing: the first tick after the deploy lands (and the archive
   * indexes it) picks up the events.
   */
  private async rescanUnreadyContracts(latestHeight: number): Promise<void> {
    const unready = await prisma.contract.findMany({
      where: { ready: false },
      select: { id: true, address: true, discoveredAtBlock: true },
    });
    for (const c of unready) {
      const from = c.discoveredAtBlock ?? this.config.indexStartHeight;
      if (from > latestHeight) continue;
      await this.syncSingleContract(c.id, c.address, from, latestHeight);
    }
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

  /**
   * Fetches, stores, and applies decoded events for a single contract address.
   * Public so tests can drive the event-apply pipeline with mocked chain data
   * (used by the reorg-reconstruction test).
   */
  async syncSingleContract(
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

    let ingested = false;
    for (let seq = 0; seq < events.length; seq++) {
      const chainEvent = events[seq];
      const fingerprint = this.fingerprintEvent(address, chainEvent);
      const existingRaw = await prisma.eventRaw.findUnique({ where: { fingerprint } });
      if (existingRaw) continue;

      // Record the block identity before applying the event. Many events may
      // share a height — upsert so the first writer wins and subsequent ones
      // are no-ops. If hashes disagree across events at the same height, the
      // reorg detector will catch that on the next tick.
      if (chainEvent.blockHash) {
        await prisma.blockHeader.upsert({
          where: { height: chainEvent.blockHeight },
          create: {
            height: chainEvent.blockHeight,
            blockHash: chainEvent.blockHash,
            parentHash: chainEvent.parentHash,
          },
          update: {},
        });
      }

      const eventRaw = await prisma.eventRaw.create({
        data: {
          contractId,
          blockHeight: chainEvent.blockHeight,
          txHash: chainEvent.txHash,
          eventType: chainEvent.type,
          payload: JSON.stringify(chainEvent.event),
          fingerprint,
        },
      });
      ingested = true;

      await this.applyEvent(contractId, chainEvent, seq, eventRaw.id);
    }

    // Any MinaGuard event other than setup/setupOwner can only fire after
    // the contract was initialized on-chain, so event presence is proof of
    // a real, set-up contract. Flipping ready here gates a subscribed-before-
    // deploy contract from appearing in API read routes until its first
    // event actually lands.
    await prisma.contract.update({
      where: { id: contractId },
      data: ingested
        ? { lastSyncedAt: new Date(), ready: true }
        : { lastSyncedAt: new Date() },
    });
  }

  /** Applies event-specific state updates to proposal/owner/contract aggregate tables. */
  private async applyEvent(
    contractId: number,
    chainEvent: ChainEvent,
    eventOrder: number,
    sourceEventId: number,
  ): Promise<void> {
    switch (chainEvent.type) {
      case 'setup': {
        await this.applySetupEvent(contractId, chainEvent, eventOrder, sourceEventId);
        return;
      }
      case 'setupOwner': {
        await this.applySetupOwnerEvent(contractId, chainEvent, eventOrder, sourceEventId);
        return;
      }
      case 'proposal': {
        await this.applyProposalEvent(contractId, chainEvent);
        return;
      }
      case 'approval': {
        await this.applyApprovalEvent(contractId, chainEvent, eventOrder);
        return;
      }
      case 'execution': {
        await this.applyExecutionEvent(contractId, chainEvent, eventOrder);
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
        await this.applyEnableChildMultiSigEvent(contractId, chainEvent, eventOrder, sourceEventId);
        return;
      }
      case 'receiver': {
        await this.applyReceiverEvent(contractId, chainEvent.event);
        return;
      }
      case 'ownerChange': {
        await this.applyOwnerChangeEvent(contractId, chainEvent, eventOrder, sourceEventId);
        return;
      }
      case 'thresholdChange': {
        await this.applyThresholdChangeEvent(contractId, chainEvent, eventOrder, sourceEventId);
        return;
      }
      case 'delegate': {
        await this.applyDelegateEvent(contractId, chainEvent, eventOrder, sourceEventId);
        return;
      }
      default:
        return;
    }
  }

  /** Reads the latest ContractConfig row for a contract, or null if none exists yet. */
  private async getLatestConfig(contractId: number) {
    return prisma.contractConfig.findFirst({
      where: { contractId },
      orderBy: [{ validFromBlock: 'desc' }, { eventOrder: 'desc' }],
    });
  }

  /**
   * Inserts a full-snapshot ContractConfig row by copying the latest row
   * forward and overlaying the partial `changes`. Fields not present in
   * `changes` are copied from the latest row (or null if no prior row exists).
   */
  private async appendContractConfigSnapshot(
    contractId: number,
    validFromBlock: number,
    eventOrder: number,
    sourceEventId: number | null,
    changes: ContractConfigChanges,
  ): Promise<void> {
    const latest = await this.getLatestConfig(contractId);
    await prisma.contractConfig.create({
      data: {
        contractId,
        validFromBlock,
        eventOrder,
        sourceEventId,
        threshold:            changes.threshold            ?? latest?.threshold            ?? null,
        numOwners:            changes.numOwners            ?? latest?.numOwners            ?? null,
        nonce:                changes.nonce                ?? latest?.nonce                ?? null,
        parentNonce:          changes.parentNonce          ?? latest?.parentNonce          ?? null,
        configNonce:          changes.configNonce          ?? latest?.configNonce          ?? null,
        delegate:             changes.delegate             ?? latest?.delegate             ?? null,
        childMultiSigEnabled: changes.childMultiSigEnabled ?? latest?.childMultiSigEnabled ?? null,
        ownersCommitment:     changes.ownersCommitment     ?? latest?.ownersCommitment     ?? null,
        networkId:            changes.networkId            ?? latest?.networkId            ?? null,
      },
    });
  }

  /** Applies setup summary fields: writes parent onto Contract, inserts ContractConfig snapshot. */
  private async applySetupEvent(
    contractId: number,
    chainEvent: ChainEvent,
    eventOrder: number,
    sourceEventId: number,
  ): Promise<void> {
    const event = chainEvent.event;
    const parent = asString(event.parent);
    const isRoot = parent === null || parent === EMPTY_PUBLIC_KEY;

    await prisma.contract.update({
      where: { id: contractId },
      data: { parent: isRoot ? null : parent },
    });

    await this.appendContractConfigSnapshot(
      contractId,
      chainEvent.blockHeight,
      eventOrder,
      sourceEventId,
      {
        threshold: asNumber(event.threshold),
        numOwners: asNumber(event.numOwners),
        nonce: 0,
        parentNonce: 0,
        configNonce: 0,
        networkId: asString(event.networkId),
        ownersCommitment: asString(event.ownersCommitment),
        childMultiSigEnabled: true,
      },
    );
  }

  /** Inserts an OwnerMembership row for a setup owner and backfills config from on-chain if needed. */
  private async applySetupOwnerEvent(
    contractId: number,
    chainEvent: ChainEvent,
    eventOrder: number,
    sourceEventId: number,
  ): Promise<void> {
    const event = chainEvent.event;
    const ownerAddress = asString(event.owner);
    if (!ownerAddress || ownerAddress.length < 10 || ownerAddress === EMPTY_PUBLIC_KEY) return;

    await prisma.ownerMembership.create({
      data: {
        contractId,
        address: ownerAddress,
        action: 'added',
        index: asNumber(event.index),
        ownerHash: null,
        validFromBlock: chainEvent.blockHeight,
        eventOrder,
        sourceEventId,
      },
    });

    // Derive threshold/numOwners from on-chain state when no setup event was emitted.
    const latest = await this.getLatestConfig(contractId);
    if (latest && latest.threshold != null) return;

    const contract = await prisma.contract.findUnique({ where: { id: contractId } });
    if (!contract) return;

    const onChain = await fetchOnChainState(contract.address);
    if (!onChain) return;

    await this.appendContractConfigSnapshot(
      contractId,
      chainEvent.blockHeight,
      eventOrder,
      sourceEventId,
      {
        threshold: onChain.threshold,
        numOwners: onChain.numOwners,
        networkId: onChain.networkId,
        ownersCommitment: onChain.ownersCommitment,
      },
    );
  }

  /**
   * Creates a proposal row from on-chain event data.
   * ProposalEvent includes all TransactionProposal fields so the indexer
   * can reconstruct full proposal details purely from on-chain events.
   *
   * For CREATE_CHILD proposals in lite mode, eagerly inserts the child's
   * Contract row so the indexer starts tracking its address immediately.
   * This is required because `executeSetupChild` emits its execution event
   * on the child, not the parent — if the child weren't tracked, the
   * REMOTE path in applyExecutionEvent could never walk back to upsert
   * ProposalExecution, and the proposal would stay pending forever.
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

    if (this.config.indexerMode === 'lite' && asString(event.txType) === '5') {
      const childAddress = asNullableAddress(asString(event.childAccount));
      if (childAddress) {
        const parent = await prisma.contract.findUnique({
          where: { id: contractId },
          select: { address: true },
        });
        if (parent) {
          const existing = await prisma.contract.findUnique({
            where: { address: childAddress },
          });
          if (!existing) {
            await prisma.contract.create({
              data: {
                address: childAddress,
                parent: parent.address,
                discoveredAtBlock: chainEvent.blockHeight,
              },
            });
            console.log(
              `[indexer] eager-subscribing child ${childAddress} of parent ${parent.address} on CREATE_CHILD proposal`,
            );
          }
        }
      }
    }
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

  /** Upserts per-approver approval rows. Approval count is derived at read time. */
  private async applyApprovalEvent(
    contractId: number,
    chainEvent: ChainEvent,
    eventOrder: number,
  ): Promise<void> {
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
        eventOrder,
      },
      update: {
        approvalRaw: asString(event.approvalCount),
        blockHeight: chainEvent.blockHeight,
        eventOrder,
      },
    });

    // Clear in-flight approve tracking when the arriving event matches the
    // hash the frontend last submitted for this proposal.
    if (chainEvent.txHash !== null && proposal.lastApproveTxHash === chainEvent.txHash) {
      await prisma.proposal.update({
        where: { id: proposal.id },
        data: { lastApproveTxHash: null, lastApproveError: null },
      });
    }
  }

  /**
   * Records a proposal execution by upserting a ProposalExecution row.
   *
   * LOCAL path: the Proposal row lives under the emitting contract, so
   * (contractId, proposalHash) resolves it directly.
   *
   * REMOTE path: child-lifecycle methods (executeSetupChild, executeReclaim,
   * executeDestroy, executeEnableChildMultiSig) emit ExecutionEvent on the
   * child guard, but the Proposal row lives under the parent's contractId.
   * On a local miss, walk to the child's `parent` and retry.
   */
  private async applyExecutionEvent(
    contractId: number,
    chainEvent: ChainEvent,
    eventOrder: number,
  ): Promise<void> {
    const proposalHash = asString(chainEvent.event.proposalHash);
    if (!proposalHash) return;

    const blockHeight = chainEvent.blockHeight;
    const txHash = chainEvent.txHash;

    const local = await prisma.proposal.findUnique({
      where: { contractId_proposalHash: { contractId, proposalHash } },
      select: { id: true, nonce: true, lastExecuteTxHash: true },
    });
    if (local) {
      await this.upsertProposalExecution(local.id, blockHeight, txHash, eventOrder);
      const localNonce = local.nonce === null ? null : Number(local.nonce);
      if (localNonce !== null && Number.isFinite(localNonce)) {
        await this.appendContractConfigSnapshot(
          contractId,
          blockHeight,
          eventOrder,
          null,
          { nonce: localNonce },
        );
      }
      if (txHash !== null && local.lastExecuteTxHash === txHash) {
        await prisma.proposal.update({
          where: { id: local.id },
          data: { lastExecuteTxHash: null, lastExecuteError: null },
        });
      }
      return;
    }

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

    const remote = await prisma.proposal.findUnique({
      where: { contractId_proposalHash: { contractId: parent.id, proposalHash } },
      select: { id: true, nonce: true, lastExecuteTxHash: true },
    });
    if (!remote) return;

    await this.upsertProposalExecution(remote.id, blockHeight, txHash, eventOrder);
    const remoteNonce = remote.nonce === null ? null : Number(remote.nonce);
    if (remoteNonce !== null && Number.isFinite(remoteNonce)) {
      await this.appendContractConfigSnapshot(
        contractId,
        blockHeight,
        eventOrder,
        null,
        { parentNonce: remoteNonce },
      );
    }
    if (txHash !== null && remote.lastExecuteTxHash === txHash) {
      await prisma.proposal.update({
        where: { id: remote.id },
        data: { lastExecuteTxHash: null, lastExecuteError: null },
      });
    }
  }

  private async upsertProposalExecution(
    proposalId: number,
    blockHeight: number,
    txHash: string | null,
    eventOrder: number,
  ): Promise<void> {
    await prisma.proposalExecution.upsert({
      where: { proposalId },
      create: { proposalId, blockHeight, txHash, eventOrder },
      update: { blockHeight, txHash, eventOrder },
    });
  }

  /** Records an owner add/remove governance result and appends a ContractConfig snapshot. */
  private async applyOwnerChangeEvent(
    contractId: number,
    chainEvent: ChainEvent,
    eventOrder: number,
    sourceEventId: number,
  ): Promise<void> {
    const event = chainEvent.event;
    const owner = asString(event.owner);
    if (!owner) return;

    const added = asString(event.added) === '1';

    await prisma.ownerMembership.create({
      data: {
        contractId,
        address: owner,
        action: added ? 'added' : 'removed',
        index: null,
        ownerHash: null,
        validFromBlock: chainEvent.blockHeight,
        eventOrder,
        sourceEventId,
      },
    });

    const newNumOwners = asNumber(event.newNumOwners);
    const configNonce = asNumber(event.configNonce);

    const changes: ContractConfigChanges = {};
    if (newNumOwners !== null) changes.numOwners = newNumOwners;
    if (configNonce !== null) changes.configNonce = configNonce;

    if (Object.keys(changes).length > 0) {
      await this.appendContractConfigSnapshot(
        contractId,
        chainEvent.blockHeight,
        eventOrder,
        sourceEventId,
        changes,
      );
    }
  }

  /** Applies threshold change governance results to a ContractConfig snapshot. */
  private async applyThresholdChangeEvent(
    contractId: number,
    chainEvent: ChainEvent,
    eventOrder: number,
    sourceEventId: number,
  ): Promise<void> {
    const event = chainEvent.event;
    const newThreshold = asNumber(event.newThreshold);
    if (newThreshold === null) return;

    const configNonce = asNumber(event.configNonce);
    const changes: ContractConfigChanges = { threshold: newThreshold };
    if (configNonce !== null) changes.configNonce = configNonce;

    await this.appendContractConfigSnapshot(
      contractId,
      chainEvent.blockHeight,
      eventOrder,
      sourceEventId,
      changes,
    );
  }

  /** Appends a ContractConfig snapshot updating the delegate address. */
  private async applyDelegateEvent(
    contractId: number,
    chainEvent: ChainEvent,
    eventOrder: number,
    sourceEventId: number,
  ): Promise<void> {
    const delegate = asString(chainEvent.event.delegate);
    if (delegate === null) return;

    await this.appendContractConfigSnapshot(
      contractId,
      chainEvent.blockHeight,
      eventOrder,
      sourceEventId,
      { delegate },
    );
  }

  /**
   * Appends a ContractConfig snapshot flipping childMultiSigEnabled on the child guard.
   * Doubles as the destroy state-flip handler since executeDestroy emits the same
   * event with enabled=0.
   */
  private async applyEnableChildMultiSigEvent(
    contractId: number,
    chainEvent: ChainEvent,
    eventOrder: number,
    sourceEventId: number,
  ): Promise<void> {
    const enabled = asNumber(chainEvent.event.enabled);
    if (enabled === null) return;

    await this.appendContractConfigSnapshot(
      contractId,
      chainEvent.blockHeight,
      eventOrder,
      sourceEventId,
      { childMultiSigEnabled: enabled === 1 },
    );
  }

  /** Polls each in-flight approve/execute submission's tx status and records
   *  failures. Successful txs clear via matching Approval/Execution events in
   *  applyApprovalEvent / applyExecutionEvent, so nothing to do here on success.
   *
   *  Execute tracking uses `executions: { none: {} }` as the equivalent of
   *  "not executed" (this branch uses the normalized ProposalExecution table
   *  instead of a denormalized status column). */
  private async pollPendingSubmissions(): Promise<void> {
    const proposals = await prisma.proposal.findMany({
      where: {
        OR: [
          { AND: [{ lastExecuteTxHash: { not: null } }, { lastExecuteError: null }, { executions: { none: {} } }] },
          { AND: [{ lastApproveTxHash: { not: null } }, { lastApproveError: null }] },
        ],
      },
      select: {
        id: true,
        lastApproveTxHash: true,
        lastApproveError: true,
        lastExecuteTxHash: true,
        lastExecuteError: true,
        executions: { select: { blockHeight: true }, take: 1 },
      },
    });

    for (const proposal of proposals) {
      const alreadyExecuted = proposal.executions.length > 0;
      if (proposal.lastExecuteTxHash && !proposal.lastExecuteError && !alreadyExecuted) {
        const result = await fetchZkappTxStatus(this.config, proposal.lastExecuteTxHash);
        if (result.status === 'failed') {
          await prisma.proposal.update({
            where: { id: proposal.id },
            data: { lastExecuteError: result.reason ?? 'Execution transaction failed on-chain' },
          });
        }
      }
      if (proposal.lastApproveTxHash && !proposal.lastApproveError) {
        const result = await fetchZkappTxStatus(this.config, proposal.lastApproveTxHash);
        if (result.status === 'failed') {
          await prisma.proposal.update({
            where: { id: proposal.id },
            data: { lastApproveError: result.reason ?? 'Approval transaction failed on-chain' },
          });
        }
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

/**
 * Compares stored BlockHeader hashes against the daemon's current bestChain.
 * On mismatch, rolls back all history above the fork point and returns the
 * fork height. Returns null when stored state agrees with the chain, no
 * stored headers overlap the detection window, or the daemon is unreachable.
 *
 * Exported so tests can drive reorg handling directly without the rest of tick().
 */
export async function detectAndRollbackReorg(config: BackendConfig): Promise<number | null> {
  let headers: Awaited<ReturnType<typeof fetchBestChainHeaders>>;
  try {
    headers = await fetchBestChainHeaders(config, REORG_DETECTION_WINDOW);
  } catch (error) {
    console.warn(
      '[indexer] reorg detection skipped: bestChain fetch failed:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
  if (headers.length === 0) return null;

  const minHeight = headers[0].height;
  const maxHeight = headers[headers.length - 1].height;

  const stored = await prisma.blockHeader.findMany({
    where: { height: { gte: minHeight, lte: maxHeight } },
    orderBy: { height: 'asc' },
  });
  if (stored.length === 0) return null;

  const chainByHeight = new Map(headers.map((h) => [h.height, h]));

  // Walk descending. The fork point is the highest stored height whose hash
  // matches the chain — every stored row above it is non-canonical and must
  // be rolled back. We can't stop at the first mismatch: a multi-block reorg
  // may have a run of mismatches before hitting the last agreed height below.
  let forkHeight: number | null = null;
  let highestMismatch: { height: number; stored: string; chain: string } | null = null;
  for (let i = stored.length - 1; i >= 0; i--) {
    const s = stored[i];
    const c = chainByHeight.get(s.height);
    if (!c) continue;
    if (c.blockHash === s.blockHash) {
      forkHeight = s.height;
      break;
    }
    if (highestMismatch === null) {
      highestMismatch = { height: s.height, stored: s.blockHash, chain: c.blockHash };
    }
  }

  if (highestMismatch === null) {
    // No mismatches anywhere in the overlap — stored state is a prefix of the
    // chain, nothing to do.
    return null;
  }

  if (forkHeight === null) {
    // Every stored row in the detection window disagrees with the chain. The
    // reorg is deeper than our visibility; we can't pinpoint the fork safely.
    // Log loudly and bail — operator intervention needed (Mina finality is
    // ~290 blocks, so this effectively shouldn't happen in practice).
    console.error(
      `[indexer] reorg deeper than detection window (${REORG_DETECTION_WINDOW} blocks); ` +
      `all overlapping stored headers disagree with chain. Skipping rollback.`,
    );
    return null;
  }

  console.warn(
    `[indexer] reorg detected: highest mismatch at ${highestMismatch.height} ` +
    `(stored=${highestMismatch.stored} chain=${highestMismatch.chain}); ` +
    `rolling back to last agreed height ${forkHeight}`,
  );
  await rollbackAboveFork(forkHeight);
  return forkHeight;
}

/**
 * Atomically deletes a single contract and all of its tracked history
 * (events, configs, memberships, proposals and their executions/approvals).
 * Used by the unsubscribe API route in lite mode.
 *
 * Relation cascades cover everything except EventRaw (SetNull), so we delete
 * events explicitly up front.
 */
export async function deleteContract(contractId: number): Promise<void> {
  await prisma.$transaction([
    prisma.eventRaw.deleteMany({ where: { contractId } }),
    prisma.contract.delete({ where: { id: contractId } }),
  ]);
}

/**
 * Atomically deletes all append-only history rows above `forkHeight` and
 * rewinds the indexer cursor. The next tick resumes syncing from fork + 1.
 * Exported for testing.
 */
export async function rollbackAboveFork(forkHeight: number): Promise<void> {
  await prisma.$transaction([
    prisma.blockHeader.deleteMany({ where: { height: { gt: forkHeight } } }),
    prisma.eventRaw.deleteMany({ where: { blockHeight: { gt: forkHeight } } }),
    prisma.contractConfig.deleteMany({ where: { validFromBlock: { gt: forkHeight } } }),
    prisma.ownerMembership.deleteMany({ where: { validFromBlock: { gt: forkHeight } } }),
    prisma.proposalExecution.deleteMany({ where: { blockHeight: { gt: forkHeight } } }),
    prisma.approval.deleteMany({ where: { blockHeight: { gt: forkHeight } } }),
    prisma.proposal.deleteMany({ where: { createdAtBlock: { gt: forkHeight } } }),
    prisma.contract.deleteMany({ where: { discoveredAtBlock: { gt: forkHeight } } }),
    prisma.indexerCursor.upsert({
      where: { key: 'indexed_height' },
      create: { key: 'indexed_height', value: String(forkHeight) },
      update: { value: String(forkHeight) },
    }),
  ]);
}
