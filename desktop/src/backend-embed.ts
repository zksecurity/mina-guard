import { existsSync, readFileSync, mkdirSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RequestHandler } from 'express';
import type { NetworkId } from './config-store.js';

/**
 * Fingerprint of the bundled schema.sql, stamped into the DB as user_version so
 * a build whose schema changed can spot a stale DB. Derived from the file rather
 * than hand-bumped, so it tracks schema edits with no step to forget. Folded to
 * 31 bits since user_version is a signed int32; 0 is remapped as it doubles as
 * "never stamped".
 */
function schemaVersionOf(schemaSql: string): number {
  const v = createHash('sha256').update(schemaSql).digest().readUInt32BE(0) & 0x7fffffff;
  return v === 0 ? 1 : v;
}

/**
 * Reads user_version from the SQLite header (bytes 60..63, big-endian) instead
 * of opening a connection, so the check runs before Prisma pins the file and a
 * stale DB can just be deleted. Returns null when unreadable, i.e. missing or
 * truncated, which callers treat as a mismatch.
 */
function readUserVersion(dbPath: string): number | null {
  let fd: number | undefined;
  try {
    fd = openSync(dbPath, 'r');
    const buf = Buffer.alloc(4);
    if (readSync(fd, buf, 0, 4, 60) < 4) return null;
    return buf.readInt32BE(0);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Removes the DB file and its journal/WAL sidecars. */
function removeDbFiles(dbPath: string): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    rmSync(dbPath + suffix, { force: true });
  }
}

export interface EmbeddedBackendHandle {
  /** Mount on the shared HTTP server; delegates to next() when no route matches. */
  middleware: RequestHandler;
  stop: () => Promise<void>;
}

export interface EmbeddedBackendOptions {
  dbPath: string;
  minaEndpoint: string;
  archiveEndpoint: string;
  /** Configured network — selects which line of .vk-hash applies. */
  networkId: NetworkId;
  indexStartHeight?: number;
  /** Path to the bundled schema.sql used to bootstrap a fresh SQLite file. */
  schemaSqlPath: string;
  /**
   * Path to the bundled contracts/.vk-hash (MinaGuard verification-key hashes,
   * one per network). The configured network's hash is read into
   * MINAGUARD_VK_HASH so the subscribe route can reject contracts built with a
   * different MinaGuard release. Optional: when absent or unparseable, the VK
   * match check becomes a no-op (older behavior).
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
 *   2. Ensure the SQLite file + schema exist and match this build's schema.sql
 *      (schema.sql is plain CREATE TABLE, not IF NOT EXISTS, since prisma
 *      migrate diff emits it that way, so we gate on file existence plus the
 *      user_version stamp instead of running it idempotently).
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
  // MinaGuard VK hash → MINAGUARD_VK_HASH, so the subscribe route can reject
  // contracts from a different release. contracts/.vk-hash carries one hash
  // per network (`testnet=…` / `mainnet=…` lines): the compile-time
  // NETWORK_DOMAIN gives each network a structurally distinct VK, so the
  // configured network selects which line applies — devnet shares the testnet
  // circuit (anything except mainnet does, mirroring contracts/src/constants.ts).
  // Files predating the per-network format (a comment header + one bare
  // decimal) parse via the legacy fallback. Left unset if the file is missing
  // or yields no usable value — the VK match check then no-ops rather than the
  // backend failing to start.
  if (opts.vkHashPath && existsSync(opts.vkHashPath)) {
    const lines = readFileSync(opts.vkHashPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    const keyed = new Map<string, string>();
    for (const line of lines) {
      const eq = line.indexOf('=');
      if (eq > 0) keyed.set(line.slice(0, eq).trim(), line.slice(eq + 1).replace(/\s/g, ''));
    }
    const vkHash = keyed.size > 0
      ? keyed.get(opts.networkId === 'mainnet' ? 'mainnet' : 'testnet') ?? ''
      : lines.join('').replace(/\s/g, ''); // legacy single-number format
    if (vkHash) {
      process.env.MINAGUARD_VK_HASH = vkHash;
    }
  }
  // loadConfig() requireEnv's DATABASE_URL, MINA_ENDPOINT, ARCHIVE_ENDPOINT.
  // All set above.

  const schemaSql = readFileSync(opts.schemaSqlPath, 'utf8');
  const schemaVersion = schemaVersionOf(schemaSql);

  // The DB is a re-derivable index of chain state, so a schema change is handled
  // by rebuilding rather than migrating: cheaper than maintaining SQLite
  // migrations, and the indexer refills it from INDEX_START_HEIGHT. Subscribed
  // contracts go with it and must be re-added. DBs predating the stamp read 0,
  // so they rebuild once.
  let freshDb = !existsSync(opts.dbPath);
  if (!freshDb && readUserVersion(opts.dbPath) !== schemaVersion) {
    console.log('[desktop] schema.sql changed since this DB was built, rebuilding index');
    removeDbFiles(opts.dbPath);
    freshDb = true;
  }
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
      // Prisma's $executeRawUnsafe accepts multi-statement SQL on SQLite.
      for (const statement of schemaSql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
        await prisma.$executeRawUnsafe(statement);
      }
      // Stamp last: a crash mid-schema leaves user_version at 0, so the next
      // boot rebuilds rather than trusting a half-built DB. PRAGMA takes no bind
      // params, and schemaVersion is a locally computed int.
      await prisma.$executeRawUnsafe(`PRAGMA user_version = ${schemaVersion}`);
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
      // The DB was absent or stale when we started, so whatever exists now is a
      // partial artifact of this failed attempt (possibly with an incomplete
      // schema), remove it so the next attempt bootstraps cleanly.
      removeDbFiles(opts.dbPath);
    }
    throw err;
  }
}
