/** Runtime configuration for the Express API and chain indexer. */
export interface BackendConfig {
  port: number;
  databaseUrl: string;
  minaEndpoint: string;
  archiveEndpoint: string;
  lightnetAccountManager: string | undefined;
  minaFallbackEndpoint: string | null;
  archiveFallbackEndpoint: string | null;
  indexPollIntervalMs: number;
  indexStartHeight: number;
  minaguardVkHash: string | null;
}

/** Reads and validates environment variables with safe development defaults. */
export function loadConfig(): BackendConfig {
  const port = Number(process.env.PORT ?? '4000');
  const databaseUrl = process.env.DATABASE_URL ?? 'file:./dev.db';
  const minaEndpoint = process.env.MINA_ENDPOINT ?? 'https://api.minascan.io/node/devnet/v1/graphql';
  const archiveEndpoint = process.env.ARCHIVE_ENDPOINT ?? 'https://api.minascan.io/archive/devnet/v1/graphql';
  const lightnetAccountManager = process.env.LIGHTNET_ACCOUNT_MANAGER;

  return {
    port,
    databaseUrl,
    minaEndpoint,
    archiveEndpoint,
    lightnetAccountManager,
    minaFallbackEndpoint: process.env.MINA_FALLBACK_ENDPOINT ?? null,
    archiveFallbackEndpoint: process.env.ARCHIVE_FALLBACK_ENDPOINT ?? null,
    indexPollIntervalMs: Number(process.env.INDEX_POLL_INTERVAL_MS ?? '15000'),
    indexStartHeight: Number(process.env.INDEX_START_HEIGHT ?? '0'),
    minaguardVkHash: process.env.MINAGUARD_VK_HASH ?? null,
  };
}
