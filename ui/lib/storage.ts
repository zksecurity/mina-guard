// -- UI Local Storage Utilities ---------------------------------------

const STORAGE_KEY_PREFIX = 'mina-guard-ui-';

/** Builds namespaced localStorage key names for UI preferences. */
function getKey(suffix: string): string {
  return `${STORAGE_KEY_PREFIX}${suffix}`;
}

/** Persists selected contract address for restoring UI context on reload. */
export function saveSelectedContract(address: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(getKey('selected-contract'), address);
}

/** Restores previously selected contract address preference if present. */
export function getSelectedContract(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(getKey('selected-contract'));
}

/** Clears all UI preference entries managed by this module. */
export function clearUiStorage(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(getKey('selected-contract'));
}
