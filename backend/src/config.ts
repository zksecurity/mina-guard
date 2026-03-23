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

/** Throws if a required environment variable is missing or empty. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}. Check your .env file.`);
  return value;
}

/** Reads and validates environment variables. Requires MINA_ENDPOINT and ARCHIVE_ENDPOINT. */
export function loadConfig(): BackendConfig {
  const port = Number(process.env.PORT ?? '4000');
  const databaseUrl = requireEnv('DATABASE_URL');
  const minaEndpoint = requireEnv('MINA_ENDPOINT');
  const archiveEndpoint = requireEnv('ARCHIVE_ENDPOINT');
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
