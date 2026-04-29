import { Router } from 'express';
import { z } from 'zod';
import { existsSync, readdirSync, createReadStream } from 'fs';
import { join } from 'path';
import { PublicKey, fetchAccount } from 'o1js';

import { prisma } from './db.js';
import { deleteContract, type MinaGuardIndexer } from './indexer.js';
import type { BackendConfig } from './config.js';
import { fetchLatestBlockHeight, fetchVerificationKeyHash, fetchZkappTxStatus } from './mina-client.js';
import { serializeProposalRecord, type ContractState } from './proposal-record.js';
import {
  acquireLightnetAccount,
  computeFundingAmount,
  LightnetAcquireError,
  releaseLightnetAccount,
  sendSignedLightnetPayment,
  withLightnetAccount,
} from './lightnet.js';
import {
  clampedIntQuerySchema,
  nullableBlockQuerySchema,
  optionalBooleanQuerySchema,
  optionalNonEmptyStringQuerySchema,
  addressParamsSchema,
  proposalParamsSchema,
  addressParamsMiddleware,
  proposalParamsMiddleware,
  type AddressParams,
  type ProposalParams,
  validateQuery,
} from './request-validation.js';
import { wrapAsyncRoute } from './route-utils.js';

const ownersQuerySchema = z.object({
  active: optionalBooleanQuerySchema,
});

const proposalsQuerySchema = z.object({
  status: optionalNonEmptyStringQuerySchema,
  limit: clampedIntQuerySchema(50, 1, 200),
  offset: clampedIntQuerySchema(0, 0, 10_000),
});

const eventsQuerySchema = z.object({
  fromBlock: nullableBlockQuerySchema,
  toBlock: nullableBlockQuerySchema,
  limit: clampedIntQuerySchema(100, 1, 500),
  offset: clampedIntQuerySchema(0, 0, 50_000),
});

const submissionBodySchema = z.object({
  action: z.enum(['approve', 'execute']),
  txHash: z.string().min(1).max(200),
});

type OwnersQuery = z.infer<typeof ownersQuerySchema>;
type ProposalsQuery = z.infer<typeof proposalsQuerySchema>;
type EventsQuery = z.infer<typeof eventsQuerySchema>;

/** Creates the read-only API router bound to shared indexer status and Prisma data. */
export function createApiRouter(indexer: MinaGuardIndexer, config?: BackendConfig): Router {
  const router = Router();
  const safe = wrapAsyncRoute();
  router.use(requestLoggerMiddleware());

  /** Returns basic health and process liveness metadata. */
  router.get('/health', safe(async (_req, res) => {
    res.json({ ok: true, now: new Date().toISOString() });
  }));

  /** Returns current polling indexer status and latest sync metadata. */
  router.get('/api/indexer/status', safe(async (_req, res) => {
    res.json({ ...indexer.getStatus(), indexerMode: config?.indexerMode ?? 'full' });
  }));

  /** Looks up a submitted zkApp tx hash on the daemon's bestChain. Used by the
   *  UI to detect failed/dropped pending CREATE proposals (which have no
   *  Proposal row yet, so `pollPendingSubmissions` can't surface their state). */
  router.get('/api/tx-status', safe(async (req, res) => {
    if (!config) {
      res.status(503).json({ error: 'Backend config unavailable' });
      return;
    }
    const hash = typeof req.query.hash === 'string' ? req.query.hash.trim() : '';
    if (!hash) {
      res.status(400).json({ error: 'Missing or empty hash query param' });
      return;
    }
    const result = await fetchZkappTxStatus(config, hash);
    res.json(result);
  }));

  /** Lists tracked contracts with derived config + aggregate counts. */
  router.get('/api/contracts', safe(async (_req, res) => {
    const contracts = await prisma.contract.findMany({
      where: { ready: true },
      orderBy: { discoveredAt: 'desc' },
      include: {
        _count: {
          select: {
            proposals: true,
            events: true,
          },
        },
      },
    });

    const enriched = await Promise.all(
      contracts.map(async (contract) => {
        const [config, ownerCount] = await Promise.all([
          latestContractConfig(contract.id),
          currentOwnerCount(contract.id),
        ]);
        return decorateContract(contract, config, ownerCount);
      })
    );

    res.json(enriched);
  }));

  /** Returns one tracked contract by base58 address. */
  router.get('/api/contracts/:address', addressParamsMiddleware, safe(async (req, res) => {
    const { address } = addressParamsSchema.parse(req.params) as AddressParams;

    const contract = await prisma.contract.findUnique({
      where: { address },
      include: {
        _count: {
          select: {
            proposals: true,
            events: true,
          },
        },
      },
    });

    if (!contract || !contract.ready) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    const [config, ownerCount] = await Promise.all([
      latestContractConfig(contract.id),
      currentOwnerCount(contract.id),
    ]);
    res.json(decorateContract(contract, config, ownerCount));
  }));

  /** Lists child contracts (subaccounts) whose `parent` points at the given address. */
  router.get('/api/contracts/:address/children', addressParamsMiddleware, safe(async (req, res) => {
    const { address } = addressParamsSchema.parse(req.params) as AddressParams;

    const children = await prisma.contract.findMany({
      where: { parent: address, ready: true },
      orderBy: { discoveredAt: 'asc' },
    });

    const enriched = await Promise.all(
      children.map(async (child) => {
        const config = await latestContractConfig(child.id);
        return decorateContract(child, config, null);
      })
    );

    res.json(enriched);
  }));

  /** Lists owner records for a contract with optional active-state filter. */
  router.get(
    '/api/contracts/:address/owners',
    addressParamsMiddleware,
    validateQuery(ownersQuerySchema),
    safe(async (req, res) => {
      const { address } = addressParamsSchema.parse(req.params) as AddressParams;
      const { active } = ownersQuerySchema.parse(req.query) as OwnersQuery;

      const contract = await prisma.contract.findUnique({
        where: { address },
        select: { id: true, ready: true },
      });

      if (!contract || !contract.ready) {
        res.status(404).json({ error: 'Contract not found' });
        return;
      }

      const owners = await listOwners(contract.id, active);
      res.json(owners);
    })
  );

  /** Lists proposals for a contract with optional status filter and pagination. */
  router.get(
    '/api/contracts/:address/proposals',
    addressParamsMiddleware,
    validateQuery(proposalsQuerySchema),
    safe(async (req, res) => {
      const { address } = addressParamsSchema.parse(req.params) as AddressParams;
      const { status, limit, offset } = proposalsQuerySchema.parse(req.query) as ProposalsQuery;

      const contract = await prisma.contract.findUnique({
        where: { address },
        select: { id: true, ready: true },
      });

      if (!contract || !contract.ready) {
        res.status(404).json({ error: 'Contract not found' });
        return;
      }

      const latestHeight = indexer.getStatus().latestChainHeight;

      // Status is derived at read time from ProposalExecution existence +
      // expiry + nonce/config staleness vs current ContractConfig. The status
      // filter passes through to in-memory filtering after serialization.
      const dbFilter = buildProposalStatusWhere(status);

      const proposals = await prisma.proposal.findMany({
        where: {
          contractId: contract.id,
          ...dbFilter,
        },
        include: {
          receivers: { orderBy: { idx: 'asc' } },
          executions: { select: { blockHeight: true, txHash: true } },
          _count: { select: { approvals: true } },
        },
        orderBy: [{ createdAtBlock: 'desc' }, { createdAt: 'desc' }],
        // Over-fetch when status requires in-memory filtering; clamp after.
        take: needsInMemoryStatusFilter(status) ? undefined : limit,
        skip: needsInMemoryStatusFilter(status) ? undefined : offset,
      });

      const parentState = toContractState(await latestContractConfig(contract.id));
      const childStateByAddress = await buildChildStateMap(proposals);

      const serialized = proposals.map((p) =>
        serializeProposalRecord(
          p,
          latestHeight,
          parentState,
          p.childAccount ? childStateByAddress.get(p.childAccount) ?? null : null,
        ),
      );
      const filtered = status
        ? serialized.filter((s) => s.status === status)
        : serialized;
      const paged = needsInMemoryStatusFilter(status)
        ? filtered.slice(offset, offset + limit)
        : filtered;

      res.json(paged);
    })
  );

  /** Returns one proposal by contract + proposalHash identity. */
  router.get(
    '/api/contracts/:address/proposals/:proposalHash',
    proposalParamsMiddleware,
    safe(async (req, res) => {
      const { address, proposalHash } = proposalParamsSchema.parse(req.params) as ProposalParams;

      const contract = await prisma.contract.findUnique({
        where: { address },
        select: { id: true, ready: true },
      });

      if (!contract || !contract.ready) {
        res.status(404).json({ error: 'Contract not found' });
        return;
      }

      const proposal = await prisma.proposal.findUnique({
        where: {
          contractId_proposalHash: {
            contractId: contract.id,
            proposalHash,
          },
        },
        include: {
          receivers: { orderBy: { idx: 'asc' } },
          executions: { select: { blockHeight: true, txHash: true } },
          _count: { select: { approvals: true } },
        },
      });

      if (!proposal) {
        res.status(404).json({ error: 'Proposal not found' });
        return;
      }

      const latestHeight = indexer.getStatus().latestChainHeight;
      const parentState = toContractState(await latestContractConfig(contract.id));
      const childState =
        proposal.destination === 'remote' && proposal.txType !== '5' && proposal.childAccount
          ? await resolveChildState(proposal.childAccount)
          : null;

      res.json(serializeProposalRecord(proposal, latestHeight, parentState, childState));
    })
  );

  /** Records a freshly-submitted approve/execute tx hash for later status polling.
   *  Clears any prior error for that action so the UI banner disappears on retry. */
  router.post(
    '/api/contracts/:address/proposals/:proposalHash/submissions',
    proposalParamsMiddleware,
    safe(async (req, res) => {
      const { address, proposalHash } = proposalParamsSchema.parse(req.params) as ProposalParams;
      const parsed = submissionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid submission payload' });
        return;
      }
      const { action, txHash } = parsed.data;

      const contract = await prisma.contract.findUnique({
        where: { address },
        select: { id: true },
      });
      if (!contract) {
        res.status(404).json({ error: 'Contract not found' });
        return;
      }

      const update = action === 'approve'
        ? { lastApproveTxHash: txHash, lastApproveError: null }
        : { lastExecuteTxHash: txHash, lastExecuteError: null };

      const result = await prisma.proposal.updateMany({
        where: { contractId: contract.id, proposalHash },
        data: update,
      });

      if (result.count === 0) {
        res.status(404).json({ error: 'Proposal not found' });
        return;
      }
      res.json({ ok: true });
    })
  );

  /** Lists per-approver records for a given proposal hash. */
  router.get(
    '/api/contracts/:address/proposals/:proposalHash/approvals',
    proposalParamsMiddleware,
    safe(async (req, res) => {
      const { address, proposalHash } = proposalParamsSchema.parse(req.params) as ProposalParams;

      const contract = await prisma.contract.findUnique({
        where: { address },
        select: { id: true, ready: true },
      });

      if (!contract || !contract.ready) {
        res.status(404).json({ error: 'Contract not found' });
        return;
      }

      const proposal = await prisma.proposal.findUnique({
        where: {
          contractId_proposalHash: {
            contractId: contract.id,
            proposalHash,
          },
        },
        select: { id: true },
      });

      if (!proposal) {
        res.status(404).json({ error: 'Proposal not found' });
        return;
      }

      const approvals = await prisma.approval.findMany({
        where: { proposalId: proposal.id },
        orderBy: [{ blockHeight: 'asc' }, { createdAt: 'asc' }],
      });

      res.json(approvals);
    })
  );

  /** Returns raw indexed events for a contract with block and pagination filters. */
  router.get(
    '/api/contracts/:address/events',
    addressParamsMiddleware,
    validateQuery(eventsQuerySchema),
    safe(async (req, res) => {
      const { address } = addressParamsSchema.parse(req.params) as AddressParams;
      const { fromBlock, toBlock, limit, offset } = eventsQuerySchema.parse(req.query) as EventsQuery;

      const contract = await prisma.contract.findUnique({
        where: { address },
        select: { id: true, ready: true },
      });

      if (!contract || !contract.ready) {
        res.status(404).json({ error: 'Contract not found' });
        return;
      }

      const blockHeightFilter = {
        ...(fromBlock === null ? {} : { gte: fromBlock }),
        ...(toBlock === null ? {} : { lte: toBlock }),
      };

      const events = await prisma.eventRaw.findMany({
        where: {
          contractId: contract.id,
          ...(Object.keys(blockHeightFilter).length === 0 ? {} : { blockHeight: blockHeightFilter }),
        },
        orderBy: [{ blockHeight: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        skip: offset,
      });

      res.json(events);
    })
  );

  /** Returns MINA token balance for an account address via daemon GraphQL. */
  router.get('/api/account/:address/balance', addressParamsMiddleware, safe(async (req, res) => {
    const { address } = addressParamsSchema.parse(req.params) as AddressParams;

    const endpoint = config?.minaEndpoint;
    if (!endpoint) {
      res.status(503).json({ error: 'Mina endpoint not configured' });
      return;
    }

    const query = `query($publicKey: PublicKey!) { account(publicKey: $publicKey) { balance { total } } }`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { publicKey: address } }),
    });

    if (!response.ok) {
      res.status(502).json({ error: 'Daemon request failed' });
      return;
    }

    const json = (await response.json()) as {
      data?: { account?: { balance?: { total?: string } } };
    };

    const totalNano = json.data?.account?.balance?.total ?? '0';
    res.json({ balance: totalNano });
  }));

  /** Funds an account on lightnet by acquiring a pre-funded keypair from the account manager. */
  router.post('/api/fund', safe(async (req, res) => {
    const accountManagerUrl = config?.lightnetAccountManager;
    if (!accountManagerUrl) {
      res.status(503).json({ error: 'LIGHTNET_ACCOUNT_MANAGER not configured' });
      return;
    }

    const { address } = req.body as { address?: string };
    if (!address || typeof address !== 'string') {
      res.status(400).json({ error: 'address is required' });
      return;
    }

    try {
      PublicKey.fromBase58(address);
    } catch {
      res.status(400).json({ error: 'Invalid Mina public key' });
      return;
    }

    try {
      const result = await withLightnetAccount(accountManagerUrl, async (acquired) => {
        const funderPub = PublicKey.fromBase58(acquired.pk);
        const { account: funderAccount } = await fetchAccount({ publicKey: funderPub });
        const funderBalance = BigInt(funderAccount?.balance?.toBigInt() ?? 0n);
        const amountNano = computeFundingAmount(funderBalance);
        if (amountNano <= 0n) {
          return null;
        }
        const nonce = String(funderAccount?.nonce.toBigint() ?? 0n);

        const txHash = await sendSignedLightnetPayment({
          minaEndpoint: config.minaEndpoint,
          from: acquired.pk,
          to: address,
          amount: amountNano.toString(),
          fee: '100000000',
          nonce,
          privateKey: acquired.sk,
        });

        return { txHash };
      }, {
        acquireLightnetAccount,
        releaseLightnetAccount,
      });

      if (!result) {
        res.status(503).json({ error: 'No funded Lightnet accounts are currently available' });
        return;
      }

      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to acquire funded account';
      const status = error instanceof LightnetAcquireError ? 502 : 500;
      res.status(status).json({ error: message });
    }
  }));

  /**
   * Subscribes the indexer to a contract address. Lite mode only — full
   * mode auto-discovers contracts on every tick. Idempotent: re-subscribing
   * an already-tracked address returns the existing row unchanged (the
   * original discoveredAtBlock is preserved).
   *
   * The address is not required to be deployed on-chain yet. The contract
   * row is inserted with ready=false; the indexer tick's unready-rescan
   * loop then scans [discoveredAtBlock, latestHeight] every tick until
   * events are ingested and ready flips to true.
   *
   * Body: { address: string, fromBlock?: number }
   *   - fromBlock, when supplied, sets discoveredAtBlock directly. Use
   *     this for historical subscribes (e.g. fromBlock: 0 for full
   *     history). When supplied, the address MUST already resolve to a
   *     deployed zkApp on-chain — this path is the manual "add existing
   *     account" flow, where a typo or wrong-network address would
   *     otherwise silently backfill an empty address forever.
   *   - When omitted, discoveredAtBlock defaults to
   *     `latestHeight - SUBSCRIBE_MARGIN` so a block landing between
   *     submitTx and this handler doesn't push the lower bound past the
   *     deploy. The zkApp existence check is intentionally skipped here:
   *     the auto-subscribe after a fresh deploy races the tx landing
   *     on-chain.
   */
  router.post('/api/subscribe', safe(async (req, res) => {
    if (config?.indexerMode !== 'lite') {
      res.status(404).json({ error: 'Subscribe API is only available in lite mode' });
      return;
    }

    const { address, fromBlock } = req.body as {
      address?: string;
      fromBlock?: unknown;
    };
    if (!address || typeof address !== 'string') {
      res.status(400).json({ error: 'address is required' });
      return;
    }

    try {
      PublicKey.fromBase58(address);
    } catch {
      res.status(400).json({ error: 'Invalid Mina public key' });
      return;
    }

    let fromBlockNum: number | null = null;
    if (fromBlock !== undefined) {
      if (
        typeof fromBlock !== 'number' ||
        !Number.isInteger(fromBlock) ||
        fromBlock < 0
      ) {
        res.status(400).json({ error: 'fromBlock must be a non-negative integer' });
        return;
      }
      fromBlockNum = fromBlock;
    }

    const existing = await prisma.contract.findUnique({ where: { address } });
    if (existing) {
      res.json(existing);
      return;
    }

    if (fromBlockNum !== null) {
      const verificationKeyHash = await fetchVerificationKeyHash(address);
      if (!verificationKeyHash) {
        res.status(404).json({ error: 'Account not found on-chain or not a zkApp' });
        return;
      }
    }

    // Safety margin on the default path: the UI calls subscribe right
    // after submitTx, but a block may land between submitTx and this
    // handler's fetchLatestBlockHeight. Without the margin, the unready
    // rescan's lower bound could sit one block past the deploy and
    // permanently miss it. Mirrors DISCOVERY_MARGIN in tick().
    const SUBSCRIBE_MARGIN = 5;
    const discoveredAtBlock =
      fromBlockNum ??
      Math.max(0, (await fetchLatestBlockHeight(config)) - SUBSCRIBE_MARGIN);

    const created = await prisma.contract.create({
      data: { address, discoveredAtBlock },
    });

    res.json(created);
  }));

  /**
   * Unsubscribes from a contract and deletes all of its tracked history
   * (events, configs, memberships, proposals, approvals, executions).
   * Lite mode only.
   */
  router.delete('/api/subscribe/:address', addressParamsMiddleware, safe(async (req, res) => {
    if (config?.indexerMode !== 'lite') {
      res.status(404).json({ error: 'Subscribe API is only available in lite mode' });
      return;
    }

    const { address } = addressParamsSchema.parse(req.params) as AddressParams;

    const contract = await prisma.contract.findUnique({ where: { address } });
    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    // Cascade to children: the MinaGuard hierarchy is capped at two levels, so
    // one layer of child deletion is sufficient (no recursion needed).
    const children = await prisma.contract.findMany({
      where: { parent: contract.address },
      select: { id: true },
    });
    for (const child of children) {
      await deleteContract(child.id);
    }
    await deleteContract(contract.id);
    res.json({ ok: true });
  }));

  const CLI_DIST_DIR = join(process.cwd(), '..', 'offline-cli', 'dist');

  router.get('/api/offline-cli/platforms', safe(async (_req, res) => {
    if (!existsSync(CLI_DIST_DIR)) {
      res.json([]);
      return;
    }
    const files = readdirSync(CLI_DIST_DIR).filter((f) => f.startsWith('mina-guard-cli-'));
    const platforms = files.map((f) => f.replace('mina-guard-cli-', ''));
    res.json(platforms);
  }));

  router.get('/api/offline-cli/:platform', safe(async (req, res) => {
    const platform = req.params.platform;
    if (!platform || /[/\\]/.test(platform)) {
      res.status(400).json({ error: 'Invalid platform' });
      return;
    }
    const filePath = join(CLI_DIST_DIR, `mina-guard-cli-${platform}`);
    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'Platform binary not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="mina-guard-cli-${platform}"`);
    createReadStream(filePath).pipe(res);
  }));

  router.use((error: unknown, req: any, res: any, _next: any) => {
    const requestId = getRequestId(res);
    console.error(
      `[api:${requestId}] !! ${req.method} ${req.originalUrl}`,
      error instanceof Error ? error.stack ?? error.message : error
    );

    if ((error as { code?: string })?.code === 'P2021') {
      res.status(503).json({
        error: 'Database schema not initialized',
        hint: 'Run `bun run --filter backend prisma:push` or restart backend to auto-sync schema.',
      });
      return;
    }

    const message =
      error instanceof Error ? error.message : 'Unknown backend error';
    res.status(500).json({ error: message });
  });

  return router;
}

/** Emits request start/end logs with request id, status code, and duration. */
function requestLoggerMiddleware() {
  return (req: any, res: any, next: any) => {
    const startedAt = Date.now();
    const requestId = createRequestId();
    res.locals.requestId = requestId;

    console.info(
      `[api:${requestId}] -> ${req.method} ${req.originalUrl}`,
      compactMeta({
        query: req.query,
      })
    );

    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      console.info(
        `[api:${requestId}] <- ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`
      );
    });

    next();
  };
}

/** Returns request id from response locals or a fallback label. */
function getRequestId(res: any): string {
  return typeof res?.locals?.requestId === 'string' ? res.locals.requestId : 'no-id';
}

/** Generates a short random request id for log correlation. */
function createRequestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Removes empty metadata fields to keep logs compact and readable. */
function compactMeta(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => {
      if (value === null || value === undefined) return false;
      if (typeof value === 'object') {
        return Object.keys(value as object).length > 0;
      }
      return true;
    })
  );
}

/** Returns the latest ContractConfig snapshot for a contract, or null. */
async function latestContractConfig(contractId: number) {
  return prisma.contractConfig.findFirst({
    where: { contractId },
    orderBy: [{ validFromBlock: 'desc' }, { eventOrder: 'desc' }],
  });
}

/** Projects a ContractConfig row (or null) to the slim shape the proposal
 *  invalidation check consumes. */
function toContractState(
  config: Awaited<ReturnType<typeof latestContractConfig>>,
): ContractState | null {
  if (!config) return null;
  return {
    nonce: config.nonce,
    parentNonce: config.parentNonce,
    configNonce: config.configNonce,
  };
}

/** One-shot lookup of a child's current state by address, used by the
 *  single-proposal route. */
async function resolveChildState(address: string): Promise<ContractState | null> {
  const child = await prisma.contract.findUnique({
    where: { address },
    select: { id: true },
  });
  if (!child) return null;
  return toContractState(await latestContractConfig(child.id));
}

/** Batches child-state lookups for a list of proposals. Only REMOTE
 *  non-CREATE_CHILD proposals target a child guard; the rest map to null. */
async function buildChildStateMap(
  proposals: ReadonlyArray<{ destination: string | null; txType: string | null; childAccount: string | null }>,
): Promise<Map<string, ContractState>> {
  const childAddresses = [
    ...new Set(
      proposals
        .filter((p) => p.destination === 'remote' && p.txType !== '5' && p.childAccount)
        .map((p) => p.childAccount as string),
    ),
  ];
  if (childAddresses.length === 0) return new Map();

  const childContracts = await prisma.contract.findMany({
    where: { address: { in: childAddresses } },
    select: { id: true, address: true },
  });
  if (childContracts.length === 0) return new Map();

  const configs = await prisma.contractConfig.findMany({
    where: { contractId: { in: childContracts.map((c) => c.id) } },
    orderBy: [{ validFromBlock: 'desc' }, { eventOrder: 'desc' }],
  });

  // Pick the first (latest) row per contract — configs is already sorted desc.
  const latestByContractId = new Map<number, typeof configs[number]>();
  for (const row of configs) {
    if (!latestByContractId.has(row.contractId)) latestByContractId.set(row.contractId, row);
  }

  const result = new Map<string, ContractState>();
  for (const child of childContracts) {
    const state = toContractState(latestByContractId.get(child.id) ?? null);
    if (state) result.set(child.address, state);
  }
  return result;
}

/** Returns the count of currently-active owners for a contract. */
async function currentOwnerCount(contractId: number): Promise<number> {
  const owners = await listOwners(contractId, true);
  return owners.length;
}

type ContractRow = { id: number; address: string; parent: string | null };

/** Merges a Contract row with its latest config snapshot and an owners count for the API shape. */
function decorateContract<T extends ContractRow & { _count?: Record<string, number> }>(
  contract: T,
  config: Awaited<ReturnType<typeof latestContractConfig>>,
  ownerCount: number | null,
) {
  const { _count, ...rest } = contract;
  return {
    ...rest,
    threshold: config?.threshold ?? null,
    numOwners: config?.numOwners ?? null,
    nonce: config?.nonce ?? null,
    parentNonce: config?.parentNonce ?? null,
    configNonce: config?.configNonce ?? null,
    delegate: config?.delegate ?? null,
    childMultiSigEnabled: config?.childMultiSigEnabled ?? null,
    ownersCommitment: config?.ownersCommitment ?? null,
    networkId: config?.networkId ?? null,
    ...(_count !== undefined || ownerCount !== null
      ? {
          _count: {
            ...(_count ?? {}),
            ...(ownerCount !== null ? { owners: ownerCount } : {}),
          },
        }
      : {}),
  };
}

/**
 * Returns current owners for a contract by collapsing OwnerMembership history
 * to the latest row per address. If `active` is defined, filters to `added`
 * (true) or `removed` (false); otherwise returns every address ever present.
 */
async function listOwners(contractId: number, active?: boolean) {
  const memberships = await prisma.ownerMembership.findMany({
    where: { contractId },
    orderBy: [{ validFromBlock: 'desc' }, { eventOrder: 'desc' }, { id: 'desc' }],
  });

  const latestByAddress = new Map<string, typeof memberships[number]>();
  for (const m of memberships) {
    if (!latestByAddress.has(m.address)) latestByAddress.set(m.address, m);
  }

  const shaped = [...latestByAddress.values()]
    .map((m) => ({
      contractId: m.contractId,
      address: m.address,
      index: m.index,
      ownerHash: m.ownerHash,
      active: m.action === 'added',
      createdAt: m.createdAt,
    }))
    .sort((a, b) => {
      const ai = a.index ?? Number.MAX_SAFE_INTEGER;
      const bi = b.index ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

  if (active === undefined) return shaped;
  return shaped.filter((o) => o.active === active);
}

/**
 * Maps a status filter to a Prisma `where` fragment where possible. Only
 * `executed` is expressible directly via the `executions` relation; `pending`,
 * `expired`, and `invalidated` require an additional in-memory pass (they
 * depend on `latestHeight` and the latest ContractConfig snapshot).
 */
function buildProposalStatusWhere(status: string | undefined) {
  if (status === 'executed') return { executions: { some: {} } };
  return {};
}

function needsInMemoryStatusFilter(status: string | undefined): boolean {
  return status === 'pending' || status === 'expired' || status === 'invalidated';
}
