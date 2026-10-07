import { OFFLINE_RESPONSE_VERSION } from 'contracts/offline-format';

/** Requests are version 2 (`OFFLINE_BUNDLE_VERSION`); signed responses stay at version 1. */
export { OFFLINE_RESPONSE_VERSION };

export function assertOfflineResponseVersion(version: unknown): void {
  if (version !== OFFLINE_RESPONSE_VERSION) {
    throw new Error(`Unsupported signed response version (${version}). Expected ${OFFLINE_RESPONSE_VERSION}; export and sign a new request with matching UI and CLI releases.`);
  }
}
