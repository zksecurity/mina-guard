import { PrismaClient } from './generated/prisma/index.js';

/** Singleton Prisma client used across routes and indexer workers. */
export const prisma = new PrismaClient();
