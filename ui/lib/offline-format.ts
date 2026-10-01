/** Offline requests and signed responses both use format v1 after the pre-release reset. */
export const OFFLINE_RESPONSE_VERSION = 1;

export function assertOfflineResponseVersion(version: unknown): void {
  if (version !== OFFLINE_RESPONSE_VERSION) {
    throw new Error(`Unsupported signed response version (${version}). Expected ${OFFLINE_RESPONSE_VERSION}; export and sign a new request with matching UI and CLI releases.`);
  }
}
