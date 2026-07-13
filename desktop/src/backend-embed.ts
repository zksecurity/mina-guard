import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
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
   * Path to the bundled contracts/.vk-hash (canonical MinaGuard verification-key
   * hash). Read into MINAGUARD_VK_HASH so the subscribe route can reject
   * contracts built with a different MinaGuard release. Optional: when absent or
   * unparseable, the VK match check becomes a no-op (older behavior).
   */
  vkHashPath?: string;
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
  // Canonical MinaGuard VK hash → MINAGUARD_VK_HASH, so the subscribe route can
  // reject contracts from a different release. The file (contracts/.vk-hash) is
  // a comment header followed by a bare decimal number; strip '#' lines and all
  // whitespace, matching deploy/deploy-trail.sh. Left unset if the file is
  // missing or parses empty — the VK match check then no-ops rather than the
  // backend failing to start.
  if (opts.vkHashPath && existsSync(opts.vkHashPath)) {
    const vkHash = readFileSync(opts.vkHashPath, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('')
      .replace(/\s/g, '');
    if (vkHash) {
      process.env.MINAGUARD_VK_HASH = vkHash;
    }
  }
  // loadConfig() requireEnv's DATABASE_URL, MINA_ENDPOINT, ARCHIVE_ENDPOINT.
  // All set above.

  const freshDb = !existsSync(opts.dbPath);
  if (freshDb) {
    mkdirSync(dirname(opts.dbPath), { recursive: true });
  }

  const [bundle, expressMod] = await Promise.all([
    import(pathToFileURL(opts.backendBundlePath).href),
    import('express'),
  ]);
  const { prisma, loadConfig, MinaGuardIndexer, createApiRouter } = bundle;

  let indexer: { start: () => Promise<void>; stop: () => void } | null = null;
  try {
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
    indexer = new MinaGuardIndexer(config) as { start: () => Promise<void>; stop: () => void };
    const runningIndexer = indexer;

    const express = (expressMod as unknown as { default: typeof import('express') }).default ?? expressMod;
    const app = express();
    // No CORS: same-origin API (behind 127.0.0.1:5050). Cross-origin defense is
    // the Host-header allowlist in main.ts, which also covers /auro/* and DNS
    // rebinding.
    app.use(express.json({ limit: '1mb' }));
    app.use(createApiRouter(indexer, config));

    await indexer.start();
    console.log(`[desktop] backend embedded; DB=${opts.dbPath} mode=lite`);

    return {
      middleware: app as unknown as RequestHandler,
      stop: async () => {
        runningIndexer.stop();
        await prisma.$disconnect();
      },
    };
  } catch (err) {
    // Leave no half-started state behind: the setup-window recovery flow may
    // retry with corrected endpoints in this same process, reusing the cached
    // bundle and its prisma instance.
    try {
      indexer?.stop();
    } catch { /* best effort */ }
    await Promise.resolve(prisma.$disconnect()).catch(() => {});
    if (freshDb) {
      // The DB did not exist when we started, so whatever exists now is a
      // partial artifact of this failed attempt (possibly with an incomplete
      // schema) — remove it so the next attempt bootstraps cleanly.
      for (const suffix of ['', '-journal', '-wal', '-shm']) {
        rmSync(opts.dbPath + suffix, { force: true });
      }
    }
    throw err;
  }
}
