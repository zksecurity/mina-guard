/**
 * The submission-check limiter decides which reported transactions get
 * checked with the Mina node right now. The backend cannot tell callers
 * apart, so it limits checks per proposal and in total instead.
 */
import { describe, expect, test } from 'bun:test';
import { createSubmissionCheckLimiter } from '../submission-check.js';

/** A check that finishes when `finish` is called. */
function heldCheck() {
  let finish!: (result: boolean) => void;
  let fail!: (error: Error) => void;
  const done = new Promise<boolean>((resolve, reject) => { finish = resolve; fail = reject; });
  let calls = 0;
  return { check: () => { calls++; return done; }, finish, fail, calls: () => calls };
}

const report = (proposalId: number, txHash: string, action = 'approve') => ({ proposalId, action, txHash });

describe('submission check limiter', () => {
  test('a repeated report waits for the running check instead of starting one', async () => {
    const limiter = createSubmissionCheckLimiter({ total: 4, perProposal: 1 });
    const held = heldCheck();
    const first = limiter.run(report(1, 'a'), held.check);
    const again = limiter.run(report(1, 'a'), held.check);
    expect(again).toBe(first);
    expect(limiter.inFlight()).toBe(1);
    held.finish(true);
    expect(await again).toBe(true);
    expect(held.calls()).toBe(1);
  });

  test('a different hash or action is a different report', () => {
    const limiter = createSubmissionCheckLimiter({ total: 4, perProposal: 3 });
    const held = heldCheck();
    limiter.run(report(1, 'a'), held.check);
    expect(limiter.run(report(1, 'b'), held.check)).not.toBeNull();
    expect(limiter.run(report(1, 'a', 'execute'), held.check)).not.toBeNull();
    expect(limiter.inFlight()).toBe(3);
    held.finish(false);
  });

  test('refuses a proposal over its own limit, but not other proposals', () => {
    const limiter = createSubmissionCheckLimiter({ total: 4, perProposal: 2 });
    const held = heldCheck();
    limiter.run(report(1, 'a'), held.check);
    limiter.run(report(1, 'b'), held.check);
    expect(limiter.run(report(1, 'c'), held.check)).toBeNull();
    expect(limiter.run(report(2, 'c'), held.check)).not.toBeNull();
    held.finish(false);
  });

  test('refuses every proposal over the total limit', () => {
    const limiter = createSubmissionCheckLimiter({ total: 2, perProposal: 2 });
    const held = heldCheck();
    limiter.run(report(1, 'a'), held.check);
    limiter.run(report(2, 'a'), held.check);
    expect(limiter.run(report(3, 'a'), held.check)).toBeNull();
    held.finish(false);
  });

  test('frees the slot when a check finishes or fails', async () => {
    const limiter = createSubmissionCheckLimiter({ total: 1, perProposal: 1 });
    const ok = heldCheck();
    const first = limiter.run(report(1, 'a'), ok.check);
    ok.finish(false);
    await first;
    expect(limiter.inFlight()).toBe(0);

    const broken = heldCheck();
    const second = limiter.run(report(1, 'a'), broken.check);
    broken.fail(new Error('node unreachable'));
    await expect(second).rejects.toThrow('node unreachable');
    expect(limiter.inFlight()).toBe(0);
    // The same report can be checked again once its check has ended.
    const third = heldCheck();
    expect(limiter.run(report(1, 'a'), third.check)).not.toBeNull();
    third.finish(true);
  });
});
