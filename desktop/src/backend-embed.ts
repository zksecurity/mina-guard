import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RequestHandler } from 'express';

export interface EmbeddedBackendHandle {
  /** Mount on the shared HTTP server; delegates to next() when no route matches. */
  middleware: RequestHandler;
  stop: () => Promise<void>;
}

export interface EmbeddedBackendOptions {
  dbPath: string;
  minaEndpoint: string;
  archiveEndpoint: string;
  indexStartHeight?: number;
  /** Path to the bundled schema.sql used to bootstrap a fresh SQLite file. */
  schemaSqlPath: string;
  /**
   * Absolute path to the esbuild-produced backend bundle (a single .js file
   * exporting prisma/loadConfig/MinaGuardIndexer/createApiRouter). Same path
   * in dev and packaged builds — sits under packaging-stage/backend-bundle.js
   * inside desktop/ or inside app.asar/.
   */
  backendBundlePath: string;
}

/**
 * Boots the backend indexer + API router inside the Electron main process.
 *
 * Order matters:
 *   1. Set every env var loadConfig() expects BEFORE importing backend modules.
 *      backend/src/db.ts instantiates PrismaClient at import time, which reads
 *      DATABASE_URL immediately.
 *   2. Ensure the SQLite file + schema exist (idempotent via CREATE TABLE IF
 *      NOT EXISTS in the bundled schema.sql... except prisma migrate diff
 *      emits plain CREATE TABLE. We check file existence instead.)
 *   3. Dynamically import backend modules, build an Express app around the
 *      router, start the indexer.
 */
export async function startEmbeddedBackend(
  opts: EmbeddedBackendOptions,
): Promise<EmbeddedBackendHandle> {
  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${opts.dbPath}`;
  process.env.INDEXER_MODE = 'lite';
  process.env.MINA_ENDPOINT = opts.minaEndpoint;
  process.env.ARCHIVE_ENDPOINT = opts.archiveEndpoint;
  process.env.INDEX_START_HEIGHT = String(opts.indexStartHeight ?? 0);
  // loadConfig() requireEnv's DATABASE_URL, MINA_ENDPOINT, ARCHIVE_ENDPOINT.
  // All set above.

  const freshDb = !existsSync(opts.dbPath);
  if (freshDb) {
    mkdirSync(dirname(opts.dbPath), { recursive: true });
  }

  const [bundle, expressMod, corsMod] = await Promise.all([
    import(pathToFileURL(opts.backendBundlePath).href),
    import('express'),
    import('cors'),
  ]);
  const { prisma, loadConfig, MinaGuardIndexer, createApiRouter } = bundle;

  if (freshDb) {
    console.log(`[desktop] creating SQLite schema at ${opts.dbPath}`);
    const schemaSql = readFileSync(opts.schemaSqlPath, 'utf8');
    // Prisma's $executeRawUnsafe accepts multi-statement SQL on SQLite.
    for (const statement of schemaSql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
      await prisma.$executeRawUnsafe(statement);
    }
  }

  await prisma.$connect();

  const config = loadConfig();
  const indexer = new MinaGuardIndexer(config);

  const express = (expressMod as unknown as { default: typeof import('express') }).default ?? expressMod;
  const cors = (corsMod as unknown as { default: typeof import('cors') }).default ?? corsMod;
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(createApiRouter(indexer, config));

  await indexer.start();
  console.log(`[desktop] backend embedded; DB=${opts.dbPath} mode=lite`);

  return {
    middleware: app as unknown as RequestHandler,
    stop: async () => {
      indexer.stop();
      await prisma.$disconnect();
    },
  };
}
