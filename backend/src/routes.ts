import { Router } from 'express';
import { z } from 'zod';
import { PublicKey, fetchAccount } from 'o1js';

import { prisma } from './db.js';
import type { MinaGuardIndexer } from './indexer.js';
import type { BackendConfig } from './config.js';
import { serializeProposalRecord } from './proposal-record.js';
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
    res.json(indexer.getStatus());
  }));

  /** Lists tracked contracts with owner/proposal aggregate counts. */
  router.get('/api/contracts', safe(async (_req, res) => {
    const contracts = await prisma.contract.findMany({
      orderBy: { discoveredAt: 'desc' },
      include: {
        _count: {
          select: {
            owners: true,
            proposals: true,
            events: true,
          },
        },
      },
    });

    res.json(contracts);
  }));

  /** Returns one tracked contract by base58 address. */
  router.get('/api/contracts/:address', addressParamsMiddleware, safe(async (req, res) => {
    const { address } = addressParamsSchema.parse(req.params) as AddressParams;

    const contract = await prisma.contract.findUnique({
      where: { address },
      include: {
        _count: {
          select: {
            owners: true,
            proposals: true,
            events: true,
          },
        },
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    res.json(contract);
  }));

  /** Lists child contracts (subaccounts) whose `parent` points at the given address. */
  router.get('/api/contracts/:address/children', addressParamsMiddleware, safe(async (req, res) => {
    const { address } = addressParamsSchema.parse(req.params) as AddressParams;

    const children = await prisma.contract.findMany({
      where: { parent: address },
      orderBy: { discoveredAt: 'asc' },
    });

    res.json(children);
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
        select: { id: true },
      });

      if (!contract) {
        res.status(404).json({ error: 'Contract not found' });
        return;
      }

      const owners = await prisma.owner.findMany({
        where: {
          contractId: contract.id,
          ...(active === undefined ? {} : { active }),
        },
        orderBy: [{ index: 'asc' }, { createdAt: 'asc' }],
      });

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
        select: { id: true },
      });

      if (!contract) {
        res.status(404).json({ error: 'Contract not found' });
        return;
      }

      const proposals = await prisma.proposal.findMany({
        where: {
          contractId: contract.id,
          ...(status ? { status } : {}),
        },
        include: {
          receivers: {
            orderBy: { idx: 'asc' },
          },
        },
        orderBy: [{ createdAtBlock: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        skip: offset,
      });

      res.json(proposals.map((proposal) => serializeProposalRecord(proposal)));
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
        select: { id: true },
      });

      if (!contract) {
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
          receivers: {
            orderBy: { idx: 'asc' },
          },
        },
      });

      if (!proposal) {
        res.status(404).json({ error: 'Proposal not found' });
        return;
      }

      res.json(serializeProposalRecord(proposal));
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
        select: { id: true },
      });

      if (!contract) {
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
        select: { id: true },
      });

      if (!contract) {
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
