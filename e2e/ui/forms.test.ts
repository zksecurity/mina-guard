/**
 * Proposal-form tests: fill each form against the seeded vaults and assert
 * the exact payload handed to the worker via the capture hook
 * (__e2eCaptureWorkerCalls in ui/lib/multisigClient.ts) — no compile, no
 * chain. Replaces the form halves of the cut chain-e2e steps and the ported
 * validation steps 41-49.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  connectWallet,
  openProposalForm,
  fillRecipients,
  setExpiry,
  enableWorkerCapture,
  submitAndCapture,
  submitExpectingRejection,
} from './ui-helpers';
import {
  WALLET,
  OWNER_2,
  RECIPIENT,
  TREASURY,
  OPS_CHILD,
  TREASURY_STATE,
  NEXT_LOCAL_NONCE,
  NEXT_REMOTE_NONCE,
} from './fixtures';

test.beforeEach(async ({ page }) => {
  await connectWallet(page);
});

async function openFormWithCapture(
  page: Page,
  type: string,
  vault: string = TREASURY
): Promise<void> {
  await openProposalForm(page, vault, type);
  await enableWorkerCapture(page);
}

/** Selects the OPS_CHILD row in a child-picker form (radio input is sr-only). */
async function selectChildRow(page: Page): Promise<void> {
  const childLabel = page.locator(`label:has-text("${OPS_CHILD.slice(0, 10)}")`);
  await childLabel.waitFor({ state: 'visible', timeout: 10_000 });
  await childLabel.click();
  await page.waitForTimeout(500); // nonce space re-derives after selection
}

/** Common assertions on every captured proposal call. */
function expectProposalCall(call: { method: string; params: any }): any {
  expect(call.method).toBe('createOnchainProposal');
  expect(call.params.contractAddress).toBe(TREASURY);
  expect(call.params.proposerAddress).toBe(WALLET);
  expect(call.params.configNonce).toBe(TREASURY_STATE.configNonce);
  return call.params.input;
}

// ---------------------------------------------------------------------------
// Payload construction per tx type
// ---------------------------------------------------------------------------

test('transfer form: recipients, memo, and next free nonce', async ({ page }) => {
  await openFormWithCapture(page, 'transfer');
  await fillRecipients(page, `${RECIPIENT},1\n${OWNER_2},0.5`);
  const memoInput = page.locator('input[placeholder*="memo"]').or(
    page.locator('input[placeholder*="Short note"]')
  );
  await memoInput.fill('ticket memo');
  await setExpiry(page, 0);

  const input = expectProposalCall(await submitAndCapture(page));
  expect(input.txType).toBe('transfer');
  expect(input.nonce).toBe(NEXT_LOCAL_NONCE);
  expect(input.memo).toBe('ticket memo');
  expect(input.receivers).toEqual([
    { address: RECIPIENT, amount: '1000000000' },
    { address: OWNER_2, amount: '500000000' },
  ]);
});

test('addOwner form: new owner address', async ({ page }) => {
  await openFormWithCapture(page, 'addOwner');
  await page.locator('input[placeholder*="B62"]').first().fill(RECIPIENT);

  const input = expectProposalCall(await submitAndCapture(page));
  expect(input.txType).toBe('addOwner');
  expect(input.newOwner).toBe(RECIPIENT);
  expect(input.nonce).toBe(NEXT_LOCAL_NONCE);
});

test('removeOwner form: selected owner', async ({ page }) => {
  await openFormWithCapture(page, 'removeOwner');
  await expect(page.getByText(OWNER_2, { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.locator(`label:has-text("${OWNER_2}")`).click();

  const input = expectProposalCall(await submitAndCapture(page));
  expect(input.txType).toBe('removeOwner');
  expect(input.removeOwnerAddress).toBe(OWNER_2);
});

test('changeThreshold form: new threshold', async ({ page }) => {
  await openFormWithCapture(page, 'changeThreshold');
  await expect(page.getByText(`out of ${TREASURY_STATE.numOwners}`)).toBeVisible({ timeout: 10_000 });
  await page.locator('input[type="number"]').first().fill('3');

  const input = expectProposalCall(await submitAndCapture(page));
  expect(input.txType).toBe('changeThreshold');
  expect(input.newThreshold).toBe(3);
});

test('setDelegate form: delegate address', async ({ page }) => {
  await openFormWithCapture(page, 'setDelegate');
  await page.locator('input[placeholder*="B62"]').first().fill(RECIPIENT);

  const input = expectProposalCall(await submitAndCapture(page));
  expect(input.txType).toBe('setDelegate');
  expect(input.delegate).toBe(RECIPIENT);
  expect(input.undelegate).toBe(false);
});

test('setDelegate form: undelegate checkbox', async ({ page }) => {
  await openFormWithCapture(page, 'setDelegate');
  const undelegateCheckbox = page.locator('input[type="checkbox"]').first();
  await undelegateCheckbox.waitFor({ state: 'visible', timeout: 5_000 });
  await undelegateCheckbox.check();

  const input = expectProposalCall(await submitAndCapture(page));
  expect(input.txType).toBe('setDelegate');
  expect(input.undelegate).toBe(true);
  expect(input.delegate).toBeUndefined();
});

test('allocateChild form: child recipient in the local nonce space', async ({ page }) => {
  await openFormWithCapture(page, 'allocateChild');
  await fillRecipients(page, `${OPS_CHILD},2`);

  const input = expectProposalCall(await submitAndCapture(page));
  expect(input.txType).toBe('allocateChild');
  expect(input.nonce).toBe(NEXT_LOCAL_NONCE);
  expect(input.receivers).toEqual([{ address: OPS_CHILD, amount: '2000000000' }]);
});

test('reclaimChild form: child + amount in the remote nonce space', async ({ page }) => {
  await openFormWithCapture(page, 'reclaimChild');
  await selectChildRow(page);
  const amountInput = page.locator('input[placeholder="1.0"]');
  await amountInput.waitFor({ state: 'visible', timeout: 5_000 });
  await amountInput.fill('1');

  const input = expectProposalCall(await submitAndCapture(page));
  expect(input.txType).toBe('reclaimChild');
  expect(input.childAccount).toBe(OPS_CHILD);
  expect(input.reclaimAmount).toBe('1000000000');
  expect(input.nonce).toBe(NEXT_REMOTE_NONCE);
});

test('enableChildMultiSig form: proposes disabling the enabled child', async ({ page }) => {
  await openFormWithCapture(page, 'enableChildMultiSig');
  await selectChildRow(page);

  const input = expectProposalCall(await submitAndCapture(page));
  expect(input.txType).toBe('enableChildMultiSig');
  expect(input.childAccount).toBe(OPS_CHILD);
  expect(input.childMultiSigEnable).toBe(false); // seeded child is enabled
  expect(input.nonce).toBe(NEXT_REMOTE_NONCE);
});

test('destroyChild form: child + confirmation', async ({ page }) => {
  await openFormWithCapture(page, 'destroyChild');
  await selectChildRow(page);
  const confirmCheckbox = page.locator('input[type="checkbox"]').first();
  await confirmCheckbox.waitFor({ state: 'visible', timeout: 5_000 });
  await confirmCheckbox.check();

  const input = expectProposalCall(await submitAndCapture(page));
  expect(input.txType).toBe('destroyChild');
  expect(input.childAccount).toBe(OPS_CHILD);
  expect(input.nonce).toBe(NEXT_REMOTE_NONCE);
});

// ---------------------------------------------------------------------------
// Validation (ported chain-e2e steps 41-43, 45-49): the form must reject
// bad input client-side — asserted as an error message AND zero worker calls.
// ---------------------------------------------------------------------------

test('transfer form rejects an invalid address', async ({ page }) => {
  await openFormWithCapture(page, 'transfer');
  await fillRecipients(page, 'invalidaddress,1');
  await submitExpectingRejection(page, /invalid|error|address/i);
});

test('addOwner form rejects an existing owner', async ({ page }) => {
  await openFormWithCapture(page, 'addOwner');
  await page.locator('input[placeholder*="B62"]').first().fill(WALLET);
  await submitExpectingRejection(page, /already.*owner/i);
});

test('changeThreshold form rejects the current threshold', async ({ page }) => {
  await openFormWithCapture(page, 'changeThreshold');
  await expect(page.getByText(`out of ${TREASURY_STATE.numOwners}`)).toBeVisible({ timeout: 10_000 });
  await page.locator('input[type="number"]').first().fill(String(TREASURY_STATE.threshold));
  await submitExpectingRejection(page, /same.*current/i);
});

test('transfer form flags malformed recipient rows', async ({ page }) => {
  await openFormWithCapture(page, 'transfer');

  const cases: Array<{ label: string; input: string; error: RegExp }> = [
    // Missing comma → address-only row with empty amount
    { label: 'missing comma', input: 'B62qooZ8LNHjSomething', error: /(invalid mina address|amount required)/i },
    { label: 'zero amount', input: `${RECIPIENT},0`, error: /invalid amount/i },
    { label: 'negative amount', input: `${RECIPIENT},-1`, error: /invalid amount/i },
    { label: 'duplicate recipient', input: `${OWNER_2},1\n${OWNER_2},2`, error: /duplicate recipient/i },
    // Extra commas → amount "1,extra" fails the numeric regex
    { label: 'extra commas', input: `${RECIPIENT},1,extra`, error: /invalid amount/i },
  ];
  for (const c of cases) {
    await fillRecipients(page, c.input);
    await page.waitForTimeout(400);
    expect(await page.textContent('body'), c.label).toMatch(c.error);
  }
  const calls = await page.evaluate(() => ((window as any).__e2eWorkerCalls ?? []).length);
  expect(calls).toBe(0);
});

test('removeOwner form blocks removal that would go below threshold', async ({ page }) => {
  // OPS_CHILD has 1 owner and threshold 1 — removal would leave 0 < 1.
  await openFormWithCapture(page, 'removeOwner', OPS_CHILD);
  await expect(
    page.locator('text=Cannot remove an owner while it would go below the threshold')
  ).toBeVisible({ timeout: 10_000 });
});

test('setDelegate form rejects an invalid delegate address', async ({ page }) => {
  await openFormWithCapture(page, 'setDelegate');
  await page.locator('input[placeholder*="B62"]').first().fill('notavalidaddress');
  await submitExpectingRejection(page, /invalid delegate/i);
});

test('destroyChild form requires the confirmation checkbox', async ({ page }) => {
  await openFormWithCapture(page, 'destroyChild');
  await selectChildRow(page);
  await submitExpectingRejection(page, /confirm.*destroy|drains.*subvault/i);
});

test('nonce input rejects zero, negative, decimal, and non-numeric values', async ({ page }) => {
  await openFormWithCapture(page, 'transfer');
  await fillRecipients(page, `${RECIPIENT},1`);
  const nonceInput = page.locator('input').first();
  await nonceInput.waitFor({ state: 'visible', timeout: 5_000 });

  for (const value of ['0', '-1', '1.5', 'abc']) {
    await nonceInput.fill(value);
    await submitExpectingRejection(page, /positive integer|must be greater/i);
  }
});
