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

/** Saves a user-assigned display name for a contract address. */
export function saveAccountName(address: string, name: string): void {
  if (typeof window === 'undefined') return;
  const trimmed = name.trim();
  if (trimmed) {
    localStorage.setItem(getKey(`name:${address}`), trimmed);
  } else {
    localStorage.removeItem(getKey(`name:${address}`));
  }
}

/** Returns the user-assigned display name for a contract address, if any. */
export function getAccountName(address: string): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(getKey(`name:${address}`));
}

/**
 * Pending subaccount deployment record persisted between the wizard's
 * "submit CREATE_CHILD proposal" step and the later "Finalize deployment"
 * step that runs `executeSetupChild` on the new child.
 */
export interface PendingSubaccount {
  parentAddress: string;
  childAddress: string;
  childPrivateKey: string;
  childOwners: string[];
  childThreshold: number;
  childName: string;
  proposalHash: string;
  expiryBlock: number | null;
  createdAt: string;
}

const PENDING_SUBACCOUNTS_KEY = getKey('pending-subaccounts');

/** Reads all pending subaccount records (across all parents) from localStorage. */
export function getPendingSubaccounts(): PendingSubaccount[] {
  if (typeof window === 'undefined') return [];
  const raw = localStorage.getItem(PENDING_SUBACCOUNTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingSubaccount[]) : [];
  } catch {
    return [];
  }
}

/** Writes the full pending-subaccount list, replacing prior contents. */
function writePendingSubaccounts(records: PendingSubaccount[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(PENDING_SUBACCOUNTS_KEY, JSON.stringify(records));
}

/** Custom event name dispatched on save/clear so banners can refresh in the same tab.
 *  The native `storage` event only fires across tabs, so we use a custom event. */
export const PENDING_SUBACCOUNTS_CHANGED = 'mina-guard-pending-subaccounts-changed';

function notifyPendingSubaccountsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PENDING_SUBACCOUNTS_CHANGED));
}

/** Inserts or replaces a pending subaccount record keyed by (parent, child). */
export function savePendingSubaccount(record: PendingSubaccount): void {
  const all = getPendingSubaccounts().filter(
    (r) =>
      !(r.parentAddress === record.parentAddress && r.childAddress === record.childAddress),
  );
  all.push(record);
  writePendingSubaccounts(all);
  notifyPendingSubaccountsChanged();
}

/** Removes any pending subaccount records matching the given parent+child pair. */
export function clearPendingSubaccount(parentAddress: string, childAddress: string): void {
  const all = getPendingSubaccounts().filter(
    (r) => !(r.parentAddress === parentAddress && r.childAddress === childAddress),
  );
  writePendingSubaccounts(all);
  notifyPendingSubaccountsChanged();
}

/** Lists pending subaccount records for a single parent address. */
export function getPendingSubaccountsForParent(parentAddress: string): PendingSubaccount[] {
  return getPendingSubaccounts().filter((r) => r.parentAddress === parentAddress);
}
