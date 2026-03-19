import { PrismaClient } from '@prisma/client';

/** Singleton Prisma client used across routes and indexer workers. */
export const prisma = new PrismaClient();

/**
 * Enable WAL journal mode and set a busy timeout for SQLite so that
 * concurrent writes from the indexer and API routes don't collide with
 * "Cannot start new transaction within another transaction".
 */
await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
