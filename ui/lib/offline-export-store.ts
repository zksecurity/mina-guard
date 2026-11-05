import { OFFLINE_MAX_FEE_NANOMINA, OFFLINE_MIN_FEE_NANOMINA } from 'contracts/offline-format';

/** The offline request an action last exported in this browser tab. */
export type OfflineExportAction = 'propose' | 'approve' | 'execute';

export interface OfflineExportState {
  selected: OfflineExportAction | null;
  exports: Partial<Record<OfflineExportAction, { filename: string; fee: number }>>;
}

const ACTIONS: OfflineExportAction[] = ['propose', 'approve', 'execute'];
// The names downloadOfflineBundle gives: action, an id and a timestamp.
const FILENAME = /^(propose|approve|execute)-[A-Za-z0-9-]{1,80}\.json$/;

export const EMPTY_OFFLINE_EXPORTS: OfflineExportState = { selected: null, exports: {} };

/** One key per network, vault and proposal (or the vault's new proposal). */
export function offlineExportKey(network: string, context: string): string {
  return `mina-guard-ui-offline-export:${network}:${context}`;
}

function tabStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function isAction(value: unknown): value is OfflineExportAction {
  return ACTIONS.includes(value as OfflineExportAction);
}

/** Reads a saved state, dropping any entry that is not one this page wrote. */
export function loadOfflineExports(key: string, storage = tabStorage()): OfflineExportState {
  let raw: unknown;
  try {
    raw = JSON.parse(storage?.getItem(key) ?? 'null');
  } catch {
    return EMPTY_OFFLINE_EXPORTS;
  }
  if (!raw || typeof raw !== 'object') return EMPTY_OFFLINE_EXPORTS;
  const saved = raw as { selected?: unknown; exports?: unknown };
  const exports: OfflineExportState['exports'] = {};
  if (saved.exports && typeof saved.exports === 'object') {
    for (const [action, entry] of Object.entries(saved.exports as Record<string, unknown>)) {
      const { filename, fee } = (entry ?? {}) as { filename?: unknown; fee?: unknown };
      if (isAction(action) && typeof filename === 'string' && FILENAME.test(filename) &&
          filename.startsWith(`${action}-`) && typeof fee === 'number' && Number.isSafeInteger(fee) &&
          fee >= OFFLINE_MIN_FEE_NANOMINA && fee <= OFFLINE_MAX_FEE_NANOMINA) {
        exports[action] = { filename, fee };
      }
    }
  }
  return { selected: isAction(saved.selected) ? saved.selected : null, exports };
}

/** Saves the state for this tab; an empty state removes the entry. */
export function saveOfflineExports(key: string, state: OfflineExportState, storage = tabStorage()): void {
  try {
    if (Object.keys(state.exports).length === 0) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(state));
  } catch {
    // With storage blocked or full, the export lasts until the page reloads.
  }
}
