import 'dotenv/config'

import type { Server } from 'http';
import cors from 'cors';
import express from 'express';
import { prisma } from './db.js';
import { loadConfig } from './config.js';
import { MinaGuardIndexer } from './indexer.js';
import { createApiRouter } from './routes.js';

/** Boots the Express API server and starts the polling chain indexer. */
async function main(): Promise<void> {
  const config = loadConfig();

  await prisma.$connect();
  const indexer = new MinaGuardIndexer(config);
  await indexer.start();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(createApiRouter(indexer, config));

  const server = app.listen(config.port, () => {
    console.log(`[backend] listening on http://localhost:${config.port}`);
  });
  const shutdown = createGracefulShutdown(server, indexer);

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('uncaughtException', (error) => {
    console.error('[backend] uncaught exception', error);
    void shutdown('uncaughtException', 1);
  });
  process.once('unhandledRejection', (error) => {
    console.error('[backend] unhandled rejection', error);
    void shutdown('unhandledRejection', 1);
  });
}

/** Builds an idempotent graceful shutdown handler for process signal/error exits. */
function createGracefulShutdown(server: Server, indexer: MinaGuardIndexer) {
  let shutdownPromise: Promise<void> | null = null;

  return (reason: string, exitCode = 0): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      console.log(`[backend] shutdown started (${reason})`);
      indexer.stop();

      await closeHttpServer(server);
      await prisma.$disconnect();

      console.log('[backend] shutdown complete');
      process.exit(exitCode);
    })().catch((error) => {
      console.error('[backend] shutdown failed', error);
      process.exit(1);
    });

    return shutdownPromise;
  };
}

/** Closes the HTTP server and force-closes lingering keepalive sockets if needed. */
async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });

    // Node 18+ keeps this method on net.Server for forced keepalive cleanup.
    const closeAll = (server as { closeAllConnections?: () => void }).closeAllConnections;
    if (typeof closeAll === 'function') {
      closeAll.call(server);
    }
  });
}

void main().catch(async (error) => {
  console.error('[backend] startup failed', error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
