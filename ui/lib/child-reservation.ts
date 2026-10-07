import { fetchAllEvents, parseChildConfigFromEvents } from './api';
import { computeCreateChildConfigHash } from './multisigClient';

export type ChildReservation =
  | { status: 'missing' }
  | { status: 'invalid'; reason: string }
  | {
      status: 'match' | 'mismatch';
      owners: string[];
      threshold: number;
      events: Array<{ eventType: string; payload: unknown; blockHeight: number | null }>;
    };

/**
 * Loads a SubVault's reservation from its own events and compares its hash,
 * in the reserved slot order, with the parent-approved proposal data. A
 * reservation that cannot be parsed is reported as invalid, with the reason,
 * rather than as missing: the two call for different advice. Network errors
 * propagate, so callers can retry them.
 */
export async function loadChildReservation(
  childAddress: string,
  proposalData: string | null,
): Promise<ChildReservation> {
  const events = await fetchAllEvents(childAddress);
  let config: { owners: string[]; threshold: number } | null;
  try {
    config = parseChildConfigFromEvents(events, childAddress);
  } catch (err) {
    return { status: 'invalid', reason: err instanceof Error ? err.message : String(err) };
  }
  if (!config) return { status: 'missing' };
  const { configHash } = await computeCreateChildConfigHash({
    childOwners: config.owners,
    childThreshold: config.threshold,
    // The reserved slot order is what the signed data binds.
    preserveOrder: true,
  });
  return { status: configHash === proposalData ? 'match' : 'mismatch', owners: config.owners, threshold: config.threshold, events };
}

/** The reservation the proposal commits to, or an error saying why it cannot be used. */
export async function fetchVerifiedChildConfig(childAddress: string, proposalData: string | null) {
  const reservation = await loadChildReservation(childAddress, proposalData);
  if (reservation.status === 'missing') {
    throw new Error(
      'SubVault config events not found for this proposal. ' +
      'The createChildConfig events may not have been indexed yet — try again shortly.',
    );
  }
  if (reservation.status === 'invalid') throw new Error(`SubVault reservation is invalid: ${reservation.reason}`);
  if (reservation.status === 'mismatch') throw new Error('SubVault reservation does not match the parent-approved proposal data');
  return { events: reservation.events, owners: reservation.owners, threshold: reservation.threshold };
}
