/**
 * Barrel for desktop embedding. Exposes the four names the Electron main
 * process imports to bootstrap an in-process backend:
 * {@link prisma}, {@link loadConfig}, {@link MinaGuardIndexer}, {@link createApiRouter}.
 *
 * Bundled by desktop/scripts/bundle-backend.mjs into a single artifact that
 * ships in the Electron asar.
 */
export { prisma } from './db.js';
export { loadConfig } from './config.js';
export { MinaGuardIndexer } from './indexer.js';
export { createApiRouter } from './routes.js';
