import { Router } from 'express';
import { prisma } from './db.js';
import type { MinaGuardIndexer } from './indexer.js';

/** Creates the read-only API router bound to shared indexer status and Prisma data. */
export function createApiRouter(indexer: MinaGuardIndexer): Router {
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
  router.get('/api/contracts/:address', safe(async (req, res) => {
    const contract = await prisma.contract.findUnique({
      where: { address: req.params.address },
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

  /** Lists owner records for a contract with optional active-state filter. */
  router.get('/api/contracts/:address/owners', safe(async (req, res) => {
    const contract = await prisma.contract.findUnique({
      where: { address: req.params.address },
      select: { id: true },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    const activeParam = req.query.active;
    const activeFilter =
      activeParam === 'true' ? true : activeParam === 'false' ? false : undefined;

    const owners = await prisma.owner.findMany({
      where: {
        contractId: contract.id,
        ...(activeFilter === undefined ? {} : { active: activeFilter }),
      },
      orderBy: [{ index: 'asc' }, { createdAt: 'asc' }],
    });

    res.json(owners);
  }));

  /** Lists proposals for a contract with optional status filter and pagination. */
  router.get('/api/contracts/:address/proposals', safe(async (req, res) => {
    const contract = await prisma.contract.findUnique({
      where: { address: req.params.address },
      select: { id: true },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    const status =
      typeof req.query.status === 'string' && req.query.status.length > 0
        ? req.query.status
        : undefined;
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const offset = clampInt(req.query.offset, 0, 0, 10_000);

    const proposals = await prisma.proposal.findMany({
      where: {
        contractId: contract.id,
        ...(status ? { status } : {}),
      },
      orderBy: [{ createdAtBlock: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      skip: offset,
    });

    res.json(proposals);
  }));

  /** Returns one proposal by contract + proposalHash identity. */
  router.get('/api/contracts/:address/proposals/:proposalHash', safe(async (req, res) => {
    const contract = await prisma.contract.findUnique({
      where: { address: req.params.address },
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
          proposalHash: req.params.proposalHash,
        },
      },
    });

    if (!proposal) {
      res.status(404).json({ error: 'Proposal not found' });
      return;
    }

    res.json(proposal);
  }));

  /** Lists per-approver records for a given proposal hash. */
  router.get('/api/contracts/:address/proposals/:proposalHash/approvals', safe(async (req, res) => {
    const contract = await prisma.contract.findUnique({
      where: { address: req.params.address },
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
          proposalHash: req.params.proposalHash,
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
  }));

  /** Returns raw indexed events for a contract with block and pagination filters. */
  router.get('/api/contracts/:address/events', safe(async (req, res) => {
    const contract = await prisma.contract.findUnique({
      where: { address: req.params.address },
      select: { id: true },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    const fromBlock = clampNullableInt(req.query.fromBlock);
    const toBlock = clampNullableInt(req.query.toBlock);
    const limit = clampInt(req.query.limit, 100, 1, 500);
    const offset = clampInt(req.query.offset, 0, 0, 50_000);

    const events = await prisma.eventRaw.findMany({
      where: {
        contractId: contract.id,
        ...(fromBlock === null ? {} : { blockHeight: { gte: fromBlock } }),
        ...(toBlock === null ? {} : { blockHeight: { lte: toBlock } }),
      },
      orderBy: [{ blockHeight: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      skip: offset,
    });

    res.json(events);
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

/** Wraps async route handlers so thrown errors are forwarded to Express error middleware. */
function wrapAsyncRoute() {
  return (handler: (req: any, res: any) => Promise<void>) => {
    return (req: any, res: any, next: any) => {
      void handler(req, res).catch(next);
    };
  };
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

/** Parses integer query params with bounds and defaults. */
function clampInt(input: unknown, fallback: number, min: number, max: number): number {
  if (typeof input !== 'string') return fallback;
  const value = Number(input);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/** Parses nullable integer query params used for optional block filters. */
function clampNullableInt(input: unknown): number | null {
  if (typeof input !== 'string') return null;
  const value = Number(input);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}
