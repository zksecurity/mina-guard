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
  indexerMode: 'full' | 'lite';
  /** Test-harness knob: boot the API without starting the polling indexer
   *  (UI tests run against a pre-seeded DB with no chain behind it). */
  indexerDisabled: boolean;
  /** Test-harness knob: with the indexer disabled there is no genesis to
   *  derive slots from, so status.latestSlot (used for read-time expiry
   *  derivation) is primed with this fixed value instead. */
  fixedLatestSlot: number | null;
  /** Where to source candidate addresses for contract discovery.
   *  - 'daemon': scan daemon's bestChain — capped at 290 blocks back.
   *  - 'archive': query Mina archive postgres directly — unbounded history. */
  discoveryBackend: 'daemon' | 'archive';
  /** Read-only Mina archive postgres connection (required when discoveryBackend='archive').
   *  Discrete parts so reserved characters in the password don't need URL-encoding. */
  archiveDb: ArchiveDbConfig | null;
}

/** Discrete postgres connection params for the Mina archive read replica. */
export interface ArchiveDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Throws if a required environment variable is missing or empty. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}. Check your .env file.`);
  return value;
}

/** Parses a numeric env var, throwing if the value is not a valid finite number. */
function numericEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Env var ${name} must be a valid number, got: "${raw}"`);
  }
  return value;
}

/** Reads and validates environment variables. Requires MINA_ENDPOINT and ARCHIVE_ENDPOINT. */
export function loadConfig(): BackendConfig {
  const port = numericEnv('PORT', 4000);
  const databaseUrl = requireEnv('DATABASE_URL');
  const minaEndpoint = requireEnv('MINA_ENDPOINT');
  const archiveEndpoint = requireEnv('ARCHIVE_ENDPOINT');
  const lightnetAccountManager = process.env.LIGHTNET_ACCOUNT_MANAGER;

  const rawMode = process.env.INDEXER_MODE ?? 'full';
  if (rawMode !== 'full' && rawMode !== 'lite') {
    throw new Error(`Env var INDEXER_MODE must be 'full' or 'lite', got: "${rawMode}"`);
  }
  const indexerMode: 'full' | 'lite' = rawMode;

  const rawDiscoveryBackend = process.env.DISCOVERY_BACKEND ?? 'daemon';
  if (rawDiscoveryBackend !== 'daemon' && rawDiscoveryBackend !== 'archive') {
    throw new Error(
      `Env var DISCOVERY_BACKEND must be 'daemon' or 'archive', got: "${rawDiscoveryBackend}"`,
    );
  }
  const discoveryBackend: 'daemon' | 'archive' = rawDiscoveryBackend;
  let archiveDb: ArchiveDbConfig | null = null;
  if (discoveryBackend === 'archive') {
    if (!process.env.MINAGUARD_VK_HASH) {
      throw new Error(
        "DISCOVERY_BACKEND=archive requires MINAGUARD_VK_HASH to be set — the archive postgres query filters on the VK hash to keep results bounded. Without it, the indexer would silently fall back to the 290-block daemon scan, defeating the point of switching backends.",
      );
    }
    archiveDb = {
      host: requireEnv('ARCHIVE_DB_HOST'),
      port: numericEnv('ARCHIVE_DB_PORT', 5432),
      user: requireEnv('ARCHIVE_DB_USER'),
      password: requireEnv('ARCHIVE_DB_PASSWORD'),
      database: requireEnv('ARCHIVE_DB_NAME'),
    };
  }

  return {
    port,
    databaseUrl,
    minaEndpoint,
    archiveEndpoint,
    lightnetAccountManager,
    minaFallbackEndpoint: process.env.MINA_FALLBACK_ENDPOINT ?? null,
    archiveFallbackEndpoint: process.env.ARCHIVE_FALLBACK_ENDPOINT ?? null,
    indexPollIntervalMs: numericEnv('INDEX_POLL_INTERVAL_MS', 15000),
    indexStartHeight: numericEnv('INDEX_START_HEIGHT', 0),
    minaguardVkHash: process.env.MINAGUARD_VK_HASH ?? null,
    indexerMode,
    indexerDisabled: process.env.INDEXER_DISABLED === 'true',
    fixedLatestSlot:
      process.env.INDEXER_FIXED_LATEST_SLOT === undefined
        ? null
        : numericEnv('INDEXER_FIXED_LATEST_SLOT', 0),
    discoveryBackend,
    archiveDb,
  };
}
