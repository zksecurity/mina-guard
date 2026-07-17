import { spyOn } from 'bun:test';
import * as minaClient from '../mina-client.js';

/**
 * Replaces the given mina-client exports with stubs via spyOn, so the
 * `mock.restore()` already in every file's afterEach undoes them
 * automatically.
 *
 * Deliberately NOT mock.module(): module-mock registrations are
 * process-global, survive mock.restore(), and whether a later test file's
 * import resolves to the real module or a stale stub is timing-dependent —
 * the source of the flaky 'pending'-instead-of-'unknown' failures in
 * mina-client-tx-status.test.ts.
 */
export function stubMinaClient(factory: () => Record<string, unknown>): void {
  for (const [name, impl] of Object.entries(factory())) {
    if (typeof impl !== 'function') continue;
    spyOn(minaClient, name as keyof typeof minaClient).mockImplementation(impl as never);
  }
}
