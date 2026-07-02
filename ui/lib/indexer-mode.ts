import type { IndexerStatus } from './types';

export type IndexerMode = 'full' | 'lite';

const BUILD_MODE: IndexerMode = process.env.NEXT_PUBLIC_INDEXER_MODE === 'lite' ? 'lite' : 'full';

/** Resolves indexer mode synchronously. Build-time env var wins; falls back to live status, then 'full'. */
export function resolveIndexerMode(status: IndexerStatus | null): IndexerMode {
  if (BUILD_MODE === 'lite') return 'lite';
  return status?.indexerMode ?? 'full';
}

export const buildIndexerMode: IndexerMode = BUILD_MODE;
