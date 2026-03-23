import { PrismaClient } from '@prisma/client';

/** Singleton Prisma client used across routes and indexer workers. */
export const prisma = new PrismaClient();
